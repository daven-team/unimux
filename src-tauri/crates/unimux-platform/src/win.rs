//! Windows pieces of the platform crate.

use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MessageBoxW};
use windows::core::{HSTRING, PCWSTR};

pub fn set_app_user_model_id(id: &str) {
    // SAFETY: a plain Win32 call with a valid string.
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(id));
    }
}

pub fn windows_build() -> u32 {
    let mut info = OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    // SAFETY: RtlGetVersion fills the struct whose size we set.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status.is_ok() { info.dwBuildNumber } else { 0 }
}

pub fn open_url(url: &str) {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let url = HSTRING::from(url);
    // SAFETY: valid strings; ShellExecute hands the URL to the default browser.
    unsafe {
        ShellExecuteW(None, &HSTRING::from("open"), &url, None, None, SW_SHOWNORMAL);
    }
}

pub fn user_locale() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85];
    // SAFETY: the buffer has LOCALE_NAME_MAX_LENGTH units.
    let n = unsafe { GetUserDefaultLocaleName(&mut buf) };
    (n > 1).then(|| String::from_utf16_lossy(&buf[..(n as usize - 1)]))
}

pub fn error_box(title: &str, text: &str) {
    let title = HSTRING::from(title);
    let text = HSTRING::from(text);
    // SAFETY: valid strings; no owner window.
    unsafe {
        MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    }
}
