//! OS notifications (W4). The pure part ports src/main/notifyOptions.ts (always silent, title / body cut, the 1.0.9 buttons)
//! and stability.ts trimNotifications (the newest 50 keep their handlers). The native part shows them:
//! Windows: a WinRT `ToastNotification` under the app's AUMID, its Activated / Dismissed / Failed events wired to one
//! callback; macOS: `UNUserNotificationCenter` with a category per button set (mac_notify.rs).
//!
//! The toast object is kept by the caller (the registry) for as long as its handlers may run, like Electron kept the
//! `Notification` objects in a Set; a trimmed toast stays in the Action Center but its click does nothing.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

/// Live notifications kept for their click handlers; the oldest go first.
pub const NOTIFICATION_LIMIT: usize = 50;

/// `String(x).slice(0, n)` on UTF-16 code units (a pair cut in half leaves U+FFFD, as the toast text is UTF-16 anyway).
pub fn slice_utf16(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `notificationOptions(n)`: title cut at 200 and body at 500 code units; always silent (the app plays the sound the user
/// chose for the event itself, so the OS sound would double it, and "sound off" must really be silent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToastSpec {
    pub title: String,
    pub body: String,
    /// Button labels, in the order the activation index maps.
    pub buttons: Vec<String>,
}

impl ToastSpec {
    pub fn new(title: &str, body: &str, buttons: Vec<String>) -> Self {
        Self { title: slice_utf16(title, 200), body: slice_utf16(body, 500), buttons }
    }
}

/// A notification button and the permission answer it gives (`NoticeButton`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeButton {
    pub text: String,
    pub answer: Option<&'static str>,
}

/// `notificationActions(kind, platform, t)`: 'answer' = Zezwól, Odrzuć, Pokaż; 'show' = Pokaż only. Windows and macOS only.
pub fn notification_actions(kind: &str, platform: &str, t: &dyn Fn(&str) -> String) -> Vec<NoticeButton> {
    if platform != "win32" && platform != "darwin" {
        return vec![];
    }
    let show = NoticeButton { text: t("Pokaż"), answer: None };
    match kind {
        "answer" => vec![
            NoticeButton { text: t("Zezwól"), answer: Some("allow") },
            NoticeButton { text: t("Odrzuć"), answer: Some("deny") },
            show,
        ],
        "show" => vec![show],
        _ => vec![],
    }
}

/// `isPermissionToken`: `/^[\w.:-]{1,80}$/`.
pub fn is_permission_token(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty() && s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    })
}

/// `isPermissionAnswer`.
pub fn is_permission_answer(value: Option<&str>) -> bool {
    matches!(value, Some("allow" | "deny"))
}

/// What the user did with a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastEvent {
    /// The body was clicked.
    Click,
    /// Button `i` (index into [`ToastSpec::buttons`]).
    Button(usize),
    /// Dismissed by the user or removed by the app: gone, its handlers can be dropped.
    Closed,
    /// The banner timed out and the toast is parked in the Action Center (Windows `ToastDismissalReason::TimedOut`): it is
    /// still there and clickable, so its handlers stay (1.1.4: "Toasts parked in the Action Center never close by
    /// themselves").
    TimedOut,
    Failed,
}

/// `ToastDismissalReason` of a WinRT Dismissed event to what it means here: UserCanceled (0) and ApplicationHidden (1)
/// close the toast; TimedOut (2), and any reason a later Windows adds, leave it in the Action Center.
pub fn dismissal_event(reason: i32) -> ToastEvent {
    match reason {
        0 | 1 => ToastEvent::Closed,
        _ => ToastEvent::TimedOut,
    }
}

pub type ToastCallback = Arc<dyn Fn(ToastEvent) + Send + Sync>;

/// `trimNotifications(set, limit)`: drops the oldest until `limit` are left; returns the dropped ones in order.
pub fn trim<T>(items: &mut VecDeque<T>, limit: usize) -> Vec<T> {
    let mut dropped = Vec::new();
    while items.len() > limit {
        if let Some(item) = items.pop_front() {
            dropped.push(item);
        }
    }
    dropped
}

/// The live notifications: an id per notification (its handlers look themselves up, so a trimmed one does nothing) and
/// the native object `H` that keeps the OS handlers alive.
pub struct Registry<H> {
    next: AtomicU64,
    live: Mutex<VecDeque<(u64, Option<H>)>>,
    limit: usize,
}

impl<H> Default for Registry<H> {
    fn default() -> Self {
        Self::with_limit(NOTIFICATION_LIMIT)
    }
}

impl<H> Registry<H> {
    pub fn with_limit(limit: usize) -> Self {
        Self { next: AtomicU64::new(0), live: Mutex::new(VecDeque::new()), limit }
    }
    /// Reserves an id (before the native toast exists, so its handlers can name it).
    pub fn reserve(&self) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let dropped = {
            let mut live = self.live.lock();
            live.push_back((id, None));
            trim(&mut live, self.limit)
        };
        drop(dropped);
        id
    }
    /// Attaches the native object to a reserved id (dropped at once when the id is already gone).
    pub fn attach(&self, id: u64, handle: H) {
        let mut live = self.live.lock();
        if let Some(slot) = live.iter_mut().find(|(i, _)| *i == id) {
            slot.1 = Some(handle);
        }
    }
    /// Removes the notification; true when it was still live (its handler may act).
    pub fn forget(&self, id: u64) -> bool {
        let removed = {
            let mut live = self.live.lock();
            live.iter().position(|(i, _)| *i == id).and_then(|at| live.remove(at))
        };
        removed.is_some()
    }
    pub fn contains(&self, id: u64) -> bool {
        self.live.lock().iter().any(|(i, _)| *i == id)
    }
    pub fn len(&self) -> usize {
        self.live.lock().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn ids(&self) -> Vec<u64> {
        self.live.lock().iter().map(|(i, _)| *i).collect()
    }
}

const XML_CLICK: &str = "unimux:click";
const XML_BUTTON: &str = "unimux:button:";

/// Text for XML: escaped, and characters XML 1.0 cannot carry (control characters) dropped, so a stray escape sequence in
/// an agent's message never makes the whole toast fail.
pub fn xml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// The toast XML (ToastGeneric: the title, the body, no sound, the buttons in order). A body click activates with
/// `unimux:click`, button `i` with `unimux:button:<i>`; every activation brings the app to the front.
pub fn toast_xml(spec: &ToastSpec) -> String {
    let mut xml = format!(
        "<toast launch=\"{XML_CLICK}\" activationType=\"foreground\"><visual><binding template=\"ToastGeneric\"><text>{}</text>",
        xml_text(&spec.title)
    );
    if !spec.body.is_empty() {
        xml.push_str(&format!("<text>{}</text>", xml_text(&spec.body)));
    }
    xml.push_str("</binding></visual><audio silent=\"true\"/>");
    if !spec.buttons.is_empty() {
        xml.push_str("<actions>");
        for (i, text) in spec.buttons.iter().enumerate() {
            xml.push_str(&format!(
                "<action content=\"{}\" arguments=\"{XML_BUTTON}{i}\" activationType=\"foreground\"/>",
                xml_text(text)
            ));
        }
        xml.push_str("</actions>");
    }
    xml.push_str("</toast>");
    xml
}

/// The activation arguments of a toast back to what was pressed (`None` for arguments we never set).
pub fn parse_activation(arguments: &str) -> Option<ToastEvent> {
    if arguments == XML_CLICK || arguments.is_empty() {
        return Some(ToastEvent::Click);
    }
    arguments.strip_prefix(XML_BUTTON).and_then(|i| i.parse().ok()).map(ToastEvent::Button)
}

/// Shows a notification under `app_id` (Windows: the AUMID). The returned object must be kept while its events matter.
#[cfg(windows)]
pub fn show(app_id: &str, spec: &ToastSpec, on_event: ToastCallback) -> Result<Native, String> {
    win::show(app_id, spec, on_event).map(Native).map_err(|e| e.to_string())
}

/// Shows a notification (macOS: the app's bundle identifier is used by the OS; `app_id` is ignored).
#[cfg(target_os = "macos")]
pub fn show(app_id: &str, spec: &ToastSpec, on_event: ToastCallback) -> Result<Native, String> {
    let _ = app_id;
    crate::mac_notify::show(spec, on_event).map(Native)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn show(_app_id: &str, _spec: &ToastSpec, _on_event: ToastCallback) -> Result<Native, String> {
    Err("notifications are not supported on this platform".into())
}

/// `Notification.isSupported()`: Windows 10+ always; macOS only from an app bundle (UNUserNotificationCenter needs one).
pub fn is_supported() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(target_os = "macos")]
    {
        crate::mac_notify::is_supported()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        false
    }
}

/// The native notification object (Windows: the `ToastNotification`; macOS: the request identifier).
pub struct Native(
    #[cfg(windows)] pub windows::UI::Notifications::ToastNotification,
    #[cfg(target_os = "macos")] pub String,
    #[cfg(not(any(windows, target_os = "macos")))] pub (),
);

// SAFETY: WinRT notification objects are agile (free-threaded); the macOS variant is a String.
unsafe impl Send for Native {}
unsafe impl Sync for Native {}

/// Checks the toast XML with the WinRT parser and builds the notification object without showing it (tests).
#[cfg(windows)]
pub fn validate(spec: &ToastSpec) -> Result<(), String> {
    win::build(spec).map(|_| ()).map_err(|e| e.to_string())
}

/// The activation arguments a built toast carries, read back from the WinRT document of the `ToastNotification` (nothing
/// is shown): the body's `launch` first, then each button's `arguments` in order. [`parse_activation`] maps them back.
#[cfg(windows)]
pub fn built_activations(spec: &ToastSpec) -> Result<Vec<String>, String> {
    win::activations(spec).map_err(|e| e.to_string())
}

/// Development runs use their own AUMID (`com.unimux.app.dev`), which no Start menu shortcut carries; Windows shows toasts
/// of such an id only when it is registered under `HKCU\Software\Classes\AppUserModelId\<id>` (display name, icon).
/// Written once when the first notification of a development run is shown; the installed app's id comes from its shortcut.
#[cfg(windows)]
pub fn register_app_id(app_id: &str, display_name: &str, icon: Option<&std::path::Path>) -> Result<(), String> {
    win::register_app_id(app_id, display_name, icon).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod win {
    use std::path::Path;

    use windows::Data::Xml::Dom::{XmlDocument, XmlElement};
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager,
    };
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey, RegCreateKeyExW,
        RegQueryValueExW, RegSetValueExW,
    };
    use windows::core::{HSTRING, IInspectable, Interface, PCWSTR, Result};

    use super::{ToastCallback, ToastEvent, ToastSpec, parse_activation, toast_xml};

    pub fn build(spec: &ToastSpec) -> Result<ToastNotification> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(spec)))?;
        ToastNotification::CreateToastNotification(&doc)
    }

    pub fn activations(spec: &ToastSpec) -> Result<Vec<String>> {
        let doc = build(spec)?.Content()?;
        let mut out = vec![doc.DocumentElement()?.GetAttribute(&HSTRING::from("launch"))?.to_string_lossy()];
        let actions = doc.GetElementsByTagName(&HSTRING::from("action"))?;
        for i in 0..actions.Length()? {
            let action: XmlElement = actions.Item(i)?.cast()?;
            out.push(action.GetAttribute(&HSTRING::from("arguments"))?.to_string_lossy());
        }
        Ok(out)
    }

    pub fn show(app_id: &str, spec: &ToastSpec, on_event: ToastCallback) -> Result<ToastNotification> {
        let toast = build(spec)?;
        let cb = on_event.clone();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
            let arguments = args
                .as_ref()
                .and_then(|a| a.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|a| a.Arguments().ok())
                .map(|h| h.to_string_lossy())
                .unwrap_or_default();
            if let Some(event) = parse_activation(&arguments) {
                cb(event);
            }
            Ok(())
        }))?;
        let cb = on_event.clone();
        toast.Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, args| {
            // Without readable args the toast is treated as parked: a later click must still work.
            let reason = args.as_ref().and_then(|a| a.Reason().ok()).map_or(2, |r| r.0);
            cb(super::dismissal_event(reason));
            Ok(())
        }))?;
        let cb = on_event;
        toast.Failed(&TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
            cb(ToastEvent::Failed);
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)?;
        Ok(toast)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn read_sz(key: HKEY, name: &str) -> Option<String> {
        let name = wide(name);
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: the buffer and its byte size are passed.
        let r =
            unsafe { RegQueryValueExW(key, PCWSTR(name.as_ptr()), None, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) };
        if r.is_err() {
            return None;
        }
        let units = (size as usize / 2).min(buf.len());
        let s = String::from_utf16_lossy(&buf[..units]);
        Some(s.trim_end_matches('\0').to_string())
    }

    fn write_sz(key: HKEY, name: &str, value: &str) -> Result<()> {
        if read_sz(key, name).as_deref() == Some(value) {
            return Ok(());
        }
        let name = wide(name);
        let data: Vec<u8> = wide(value).iter().flat_map(|u| u.to_le_bytes()).collect();
        // SAFETY: valid key, name and data.
        unsafe { RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&data)).ok() }
    }

    pub fn register_app_id(app_id: &str, display_name: &str, icon: Option<&Path>) -> Result<()> {
        let path = wide(&format!("Software\\Classes\\AppUserModelId\\{app_id}"));
        let mut key = HKEY::default();
        // SAFETY: creates or opens a key under HKCU; closed below.
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_READ | KEY_WRITE,
                None,
                &mut key,
                None,
            )
            .ok()?;
        }
        let mut result = write_sz(key, "DisplayName", display_name);
        if result.is_ok()
            && let Some(icon) = icon
        {
            result = write_sz(key, "IconUri", &icon.to_string_lossy());
        }
        // SAFETY: the key we opened.
        unsafe {
            let _ = RegCloseKey(key);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    //! Ports of the notification cases of test/permission-action.test.ts and test/stability.test.ts, plus the toast XML.
    use super::*;
    use serde_json::json;

    #[test]
    fn labels_the_buttons_on_windows_and_macos_only_in_the_order_the_action_index_maps() {
        let t = |k: &str| format!("[{k}]");
        let b = |text: &str, answer| NoticeButton { text: text.into(), answer };
        assert_eq!(
            notification_actions("answer", "win32", &t),
            vec![b("[Zezwól]", Some("allow")), b("[Odrzuć]", Some("deny")), b("[Pokaż]", None)]
        );
        assert_eq!(notification_actions("show", "darwin", &t), vec![b("[Pokaż]", None)]);
        assert_eq!(notification_actions("answer", "linux", &t), vec![]);
    }

    #[test]
    fn validates_what_comes_over_ipc() {
        assert!(is_permission_token(&json!("k3j4.12")));
        assert!(!is_permission_token(&json!("")));
        assert!(!is_permission_token(&json!("x".repeat(81))));
        assert!(is_permission_token(&json!("x".repeat(80))));
        assert!(!is_permission_token(&json!("a b")));
        assert!(!is_permission_token(&json!(42)));
        assert!(!is_permission_token(&json!("ą")));
        assert!(is_permission_answer(Some("allow")));
        assert!(!is_permission_answer(Some("yes")));
        assert!(!is_permission_answer(None));
    }

    #[test]
    fn keeps_only_the_newest_ones() {
        let mut set: VecDeque<i32> = [1, 2, 3, 4, 5].into_iter().collect();
        assert_eq!(trim(&mut set, 3), vec![1, 2]);
        assert_eq!(set.iter().copied().collect::<Vec<_>>(), vec![3, 4, 5]);
        assert_eq!(trim(&mut set, 3), Vec::<i32>::new());
    }

    #[test]
    fn the_registry_keeps_fifty_and_forgets_once() {
        let r: Registry<()> = Registry::default();
        let ids: Vec<u64> = (0..51).map(|_| r.reserve()).collect();
        assert_eq!(r.len(), 50);
        assert!(!r.contains(ids[0]));
        assert!(r.contains(ids[1]));
        assert!(r.forget(ids[50]));
        assert!(!r.forget(ids[50]));
        r.attach(ids[0], ());
        assert_eq!(r.len(), 49);
    }

    #[test]
    fn options_are_silent_and_cut_like_string_slice() {
        let spec = ToastSpec::new(&"t".repeat(300), &"b".repeat(600), vec![]);
        assert_eq!(spec.title.len(), 200);
        assert_eq!(spec.body.len(), 500);
        // A pair cut in half: the lone surrogate becomes U+FFFD.
        let emoji = format!("{}😀", "x".repeat(199));
        assert_eq!(ToastSpec::new(&emoji, "", vec![]).title, format!("{}\u{FFFD}", "x".repeat(199)));
        assert!(toast_xml(&spec).contains("<audio silent=\"true\"/>"));
    }

    #[test]
    fn toast_xml_escapes_and_maps_activation() {
        let spec = ToastSpec::new("A & <B>", "line\u{1b}[0m \"q\"", vec!["Zezwól".into(), "Odrzuć".into(), "Pokaż".into()]);
        let xml = toast_xml(&spec);
        assert!(xml.contains("<text>A &amp; &lt;B&gt;</text>"));
        assert!(xml.contains("<text>line[0m &quot;q&quot;</text>"));
        assert!(xml.contains("<action content=\"Odrzuć\" arguments=\"unimux:button:1\" activationType=\"foreground\"/>"));
        assert_eq!(parse_activation("unimux:click"), Some(ToastEvent::Click));
        assert_eq!(parse_activation(""), Some(ToastEvent::Click));
        assert_eq!(parse_activation("unimux:button:2"), Some(ToastEvent::Button(2)));
        assert_eq!(parse_activation("unimux:button:x"), None);
        assert_eq!(parse_activation("other"), None);
        assert!(!toast_xml(&ToastSpec::new("t", "", vec![])).contains("<actions>"));
    }

    #[test]
    fn only_a_user_or_app_dismissal_closes_a_toast_a_timed_out_one_stays_clickable() {
        assert_eq!(dismissal_event(0), ToastEvent::Closed, "UserCanceled");
        assert_eq!(dismissal_event(1), ToastEvent::Closed, "ApplicationHidden");
        assert_eq!(dismissal_event(2), ToastEvent::TimedOut, "TimedOut: parked in the Action Center");
        assert_eq!(dismissal_event(7), ToastEvent::TimedOut);
    }

    /// The numbers above are the WinRT enum's.
    #[cfg(windows)]
    #[test]
    fn dismissal_reasons_match_winrt() {
        use windows::UI::Notifications::ToastDismissalReason;
        assert_eq!(dismissal_event(ToastDismissalReason::UserCanceled.0), ToastEvent::Closed);
        assert_eq!(dismissal_event(ToastDismissalReason::ApplicationHidden.0), ToastEvent::Closed);
        assert_eq!(dismissal_event(ToastDismissalReason::TimedOut.0), ToastEvent::TimedOut);
    }

    /// The XML is accepted by the WinRT parser and a ToastNotification is built from it (nothing is shown).
    #[cfg(windows)]
    #[test]
    fn winrt_accepts_the_toast_xml() {
        validate(&ToastSpec::new("unimux", "Reviewer needs you", vec!["Allow".into(), "Deny".into(), "Show".into()])).unwrap();
        validate(&ToastSpec::new("a\u{0}b & c", "\u{7}", vec![])).unwrap();
    }
}
