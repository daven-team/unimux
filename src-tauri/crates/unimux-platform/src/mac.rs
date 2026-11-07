//! macOS integration of the WKWebView app (PLAN W2): App Nap off, WebKit's automatic text substitutions off, and the
//! editing actions of the app menu that Tauri has no predefined item for. Compile-checked on Windows
//! (`node scripts/mac-check.mjs`); the run on a real Mac is R3.

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::{MainThreadMarker, sel};
use objc2_app_kit::NSApplication;
use objc2_foundation::{NSActivityOptions, NSDictionary, NSNumber, NSProcessInfo, NSString, NSUserDefaults};

/// The NSUserDefaults keys WebKit's TextChecker (UI process) reads for editable web content. Each one set to NO in the
/// registration domain: an explicit value there wins over the system-wide "Use smart quotes and dashes" etc., which WebKit
/// only falls back to while the key is absent. Electron 1.1.4 (Chromium, `spellcheck: false`) did none of these, so
/// `--` stays `--` (no em dash), quotes stay straight, nothing is auto-corrected, underlined or turned into a link.
pub const WEBKIT_TEXT_DEFAULTS_OFF: [&str; 7] = [
    "WebAutomaticDashSubstitutionEnabled",
    "WebAutomaticQuoteSubstitutionEnabled",
    "WebAutomaticTextReplacementEnabled",
    "WebAutomaticSpellingCorrectionEnabled",
    "WebContinuousSpellCheckingEnabled",
    "WebGrammarCheckingEnabled",
    "WebAutomaticLinkDetectionEnabled",
];

/// Registers the WebKit text defaults (volatile: nothing is written to the app's preferences file). Must run before the
/// first webview is created, since WebKit reads them once per process.
pub fn disable_text_substitutions() {
    let keys: Vec<Retained<NSString>> = WEBKIT_TEXT_DEFAULTS_OFF.iter().map(|k| NSString::from_str(k)).collect();
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<Retained<AnyObject>> = WEBKIT_TEXT_DEFAULTS_OFF
        .iter()
        .map(|_| {
            // NSNumber -> NSValue -> NSObject -> AnyObject.
            let number: Retained<NSNumber> = NSNumber::numberWithBool(false);
            Retained::into_super(Retained::into_super(Retained::into_super(number)))
        })
        .collect();
    let defaults: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_retained_objects(&key_refs, &values);
    // SAFETY: a dictionary of NSString keys and NSNumber values, the property-list types registerDefaults: takes.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&defaults) };
}

/// What WebKit will read for each of WEBKIT_TEXT_DEFAULTS_OFF: `None` while the key is absent (WebKit then follows the
/// system-wide setting), else its value. For the eval-bridge smoke (all must be `Some(false)`).
pub fn text_defaults() -> Vec<(&'static str, Option<bool>)> {
    let defaults = NSUserDefaults::standardUserDefaults();
    WEBKIT_TEXT_DEFAULTS_OFF
        .iter()
        .map(|key| {
            let name = NSString::from_str(key);
            let value = defaults.objectForKey(&name).map(|_| defaults.boolForKey(&name));
            (*key, value)
        })
        .collect()
}

/// Opts the process out of App Nap for its whole life, the macOS half of `backgroundThrottling: false`: a minimized or covered
/// window keeps the 400 ms status tick, alerts and pty output on time. Idle system sleep stays allowed (no battery cost when
/// the user walks away). The activity token is never ended.
pub fn disable_app_nap() {
    let reason = NSString::from_str("unimux keeps its agent terminals, alerts and timers running while in the background");
    let token = NSProcessInfo::processInfo()
        .beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason);
    // Ending the activity would let App Nap back in: keep it for the life of the process.
    std::mem::forget(token);
}

/// An editing action of the Edit menu that Tauri has no predefined item for (Electron's macOS `editMenu` roles).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditAction {
    /// "Paste and Match Style" (WebKit's `pasteAsPlainText:`, the selector muda uses for this item).
    PasteAndMatchStyle,
    /// "Delete" (`delete:`).
    Delete,
    /// Speech > "Start Speaking" (`startSpeaking:`).
    StartSpeaking,
    /// Speech > "Stop Speaking" (`stopSpeaking:`).
    StopSpeaking,
}

impl EditAction {
    pub fn selector(self) -> Sel {
        match self {
            EditAction::PasteAndMatchStyle => sel!(pasteAsPlainText:),
            EditAction::Delete => sel!(delete:),
            EditAction::StartSpeaking => sel!(startSpeaking:),
            EditAction::StopSpeaking => sel!(stopSpeaking:),
        }
    }
}

/// Sends `action` down the responder chain (target nil: the first responder, i.e. the focused WKWebView), like a native menu
/// item without a target. Returns whether some responder handled it; false off the main thread.
pub fn send_edit_action(action: EditAction) -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: the selectors are standard NSResponder / NSText actions taking one sender argument; a nil target and sender are
    // what AppKit itself passes for menu items without a target.
    unsafe { app.sendAction_to_from(action.selector(), None, None) }
}

/// The user's title-bar double-click setting, read on every click like AppKit does, so a change applies at once.
pub fn title_double_click() -> crate::TitleDoubleClick {
    let defaults = NSUserDefaults::standardUserDefaults();
    let action = defaults.stringForKey(&NSString::from_str("AppleActionOnDoubleClick")).map(|s| s.to_string());
    let miniaturize_key = NSString::from_str("AppleMiniaturizeOnDoubleClick");
    let miniaturize = defaults.objectForKey(&miniaturize_key).map(|_| defaults.boolForKey(&miniaturize_key));
    crate::TitleDoubleClick::from_defaults(action.as_deref(), miniaturize)
}
