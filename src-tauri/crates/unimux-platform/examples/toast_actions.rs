//! W4 acceptance example: a toast with the 1.0.9 buttons Allow / Deny / Show reports the pressed button's index.
//!
//!   cargo run -p unimux-platform --example toast_actions
//!
//! By default nothing is shown on the desktop: the toast is built through WinRT exactly as the app builds it, the
//! activation arguments are read back from the parsed `ToastNotification` document, and each one goes through the same
//! callback path (`parse_activation` -> `ToastEvent`) the Activated handler uses. Exit code 0 when the body maps to
//! `Click` and the buttons to `Button(0)`, `Button(1)`, `Button(2)`.
//!
//! With `UNIMUX_W4_SHOW_TOAST=1` the toast is really shown (under the development AUMID `com.unimux.app.dev`, registered in
//! HKCU like a development run does) and the example waits up to 120 s for a click, then prints what the OS reported. That
//! mode shows a notification on the desktop, so it is for a person at the machine only, never for automated runs.

#[cfg(windows)]
fn main() {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Duration;

    use unimux_platform::notify::{ToastEvent, ToastSpec, built_activations, parse_activation, register_app_id, show};

    let spec = ToastSpec::new("unimux", "Reviewer needs you", vec!["Allow".into(), "Deny".into(), "Show".into()]);
    let (tx, rx) = mpsc::channel::<ToastEvent>();
    let tx = Arc::new(parking_lot::Mutex::new(tx));
    let on_event: unimux_platform::notify::ToastCallback = {
        let tx = tx.clone();
        Arc::new(move |event| {
            let _ = tx.lock().send(event);
        })
    };

    if std::env::var("UNIMUX_W4_SHOW_TOAST").as_deref() == Ok("1") {
        let app_id = "com.unimux.app.dev";
        register_app_id(app_id, "unimux (dev)", None).expect("register the development AUMID");
        let _toast = show(app_id, &spec, on_event).expect("show the toast");
        println!("toast shown; press Allow, Deny or Show (or click the body) within 120 s");
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(event) => println!("on_activated: {event:?}"),
            Err(_) => {
                println!("no activation within 120 s");
                std::process::exit(1);
            }
        }
        return;
    }

    let arguments = built_activations(&spec).expect("WinRT builds the toast");
    println!("activation arguments in the built toast: {arguments:?}");
    for argument in &arguments {
        match parse_activation(argument) {
            Some(event) => on_event(event),
            None => panic!("unknown activation argument {argument}"),
        }
    }
    let got: Vec<ToastEvent> = rx.try_iter().collect();
    println!("on_activated: {got:?}");
    let want = vec![ToastEvent::Click, ToastEvent::Button(0), ToastEvent::Button(1), ToastEvent::Button(2)];
    if got != want {
        eprintln!("expected {want:?}");
        std::process::exit(1);
    }
    println!("ok: body -> Click, Allow -> Button(0), Deny -> Button(1), Show -> Button(2)");
}

#[cfg(not(windows))]
fn main() {
    // macOS: UNUserNotificationCenter needs an app bundle and a Mac (W4 open issue).
    println!("toast_actions: Windows only");
}
