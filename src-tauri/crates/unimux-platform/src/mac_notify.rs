//! macOS notifications (W4): UNUserNotificationCenter. Buttons need a category; one is registered per distinct set of
//! button titles (the titles are translated, and the switch offer names an account). A delegate shows the notification
//! while the app is active too (like 1.1.4) and reports the response: the default action is a click, `button:<i>` a
//! button. Needs an app bundle (UNUserNotificationCenter throws without one), so a bare binary has no notifications, as
//! `Notification.isSupported()` would say. Compile-checked only so far (no Mac; see PROGRESS.md W4).

use std::collections::VecDeque;
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{ClassType, define_class, msg_send};
use objc2_foundation::{NSArray, NSBundle, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction, UNNotificationActionOptions,
    UNNotificationCategory, UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
    UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use parking_lot::Mutex;

use crate::notify::{ToastCallback, ToastEvent, ToastSpec};

const BUTTON: &str = "button:";
/// Callbacks of delivered notifications kept for their responses (the app's registry limits what acts on them).
const CALLBACK_LIMIT: usize = 200;

static CALLBACKS: Mutex<VecDeque<(String, ToastCallback)>> = Mutex::new(VecDeque::new());
/// Registered categories: (identifier, button titles).
static CATEGORIES: Mutex<Vec<(String, Vec<String>)>> = Mutex::new(Vec::new());
static SETUP: OnceLock<Option<Shared>> = OnceLock::new();

struct Shared {
    center: Retained<UNUserNotificationCenter>,
    _delegate: Retained<Delegate>,
}
// SAFETY: UNUserNotificationCenter is thread-safe; the delegate has no state of its own.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

fn respond(id: &str, event: ToastEvent) {
    let callback = {
        let mut callbacks = CALLBACKS.lock();
        let at = callbacks.iter().position(|(i, _)| i == id);
        at.and_then(|at| callbacks.remove(at)).map(|(_, cb)| cb)
    };
    if let Some(cb) = callback {
        cb(event);
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "UnimuxNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            let action = response.actionIdentifier();
            // SAFETY: immutable static NSStrings of the framework.
            let (default, dismiss) = unsafe { (UNNotificationDefaultActionIdentifier, UNNotificationDismissActionIdentifier) };
            let event = if action.isEqualToString(default) {
                Some(ToastEvent::Click)
            } else if action.isEqualToString(dismiss) {
                Some(ToastEvent::Closed)
            } else {
                action.to_string().strip_prefix(BUTTON).and_then(|i| i.parse().ok()).map(ToastEvent::Button)
            };
            if let Some(event) = event {
                respond(&id, event);
            }
            handler.call(());
        }
    }
);

/// Only an app bundle with an identifier may use UNUserNotificationCenter.
pub fn is_supported() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

fn shared() -> Option<&'static Shared> {
    SETUP
        .get_or_init(|| {
            if !is_supported() {
                return None;
            }
            let center = UNUserNotificationCenter::currentNotificationCenter();
            // SAFETY: a plain NSObject subclass without ivars.
            let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::class(), new] };
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            // Asked once, when the first notification is shown (1.1.4 asked at the same moment).
            let done = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Badge,
                &done,
            );
            Some(Shared { center, _delegate: delegate })
        })
        .as_ref()
}

/// The category for this set of button titles (registered on first use).
fn category_for(shared: &Shared, buttons: &[String]) -> String {
    let mut categories = CATEGORIES.lock();
    if let Some((id, _)) = categories.iter().find(|(_, titles)| titles.as_slice() == buttons) {
        return id.clone();
    }
    let id = format!("unimux.buttons.{}", categories.len() + 1);
    categories.push((id.clone(), buttons.to_vec()));
    let all: Vec<Retained<UNNotificationCategory>> = categories
        .iter()
        .map(|(cid, titles)| {
            let actions: Vec<Retained<UNNotificationAction>> = titles
                .iter()
                .enumerate()
                .map(|(i, title)| {
                    UNNotificationAction::actionWithIdentifier_title_options(
                        &NSString::from_str(&format!("{BUTTON}{i}")),
                        &NSString::from_str(title),
                        UNNotificationActionOptions::empty(),
                    )
                })
                .collect();
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(cid),
                &NSArray::from_retained_slice(&actions),
                &NSArray::new(),
                UNNotificationCategoryOptions::empty(),
            )
        })
        .collect();
    shared.center.setNotificationCategories(&NSSet::from_retained_slice(&all));
    id
}

pub fn show(spec: &ToastSpec, on_event: ToastCallback) -> Result<String, String> {
    let shared = shared().ok_or_else(|| "notifications need the app bundle".to_string())?;
    let id = uuid_like();
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&spec.title));
    content.setBody(&NSString::from_str(&spec.body));
    // No sound: the app plays the one the user chose.
    if !spec.buttons.is_empty() {
        content.setCategoryIdentifier(&NSString::from_str(&category_for(shared, &spec.buttons)));
    }
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
    {
        let mut callbacks = CALLBACKS.lock();
        callbacks.push_back((id.clone(), on_event));
        while callbacks.len() > CALLBACK_LIMIT {
            callbacks.pop_front();
        }
    }
    let failed_id = id.clone();
    let done = RcBlock::new(move |error: *mut NSError| {
        if !error.is_null() {
            respond(&failed_id, ToastEvent::Failed);
        }
    });
    shared.center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
    Ok(id)
}

fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("unimux-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed) + 1)
}
