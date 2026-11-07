//! Electron's `shell` (W4): openExternal, openPath, showItemInFolder, trashItem, beep, and `BrowserWindow.flashFrame` on
//! Windows. Each call is what Electron 45 does on that OS, so a file opens in the same program and Explorer selects the same
//! item as in 1.1.4.

use std::path::Path;

/// `isPathArg` of src/main/index.ts: a non-empty string without NUL.
pub fn is_path_arg(path: &str) -> bool {
    !path.is_empty() && !path.contains('\0')
}

/// `shell.openExternal(url)` for an already checked http(s) URL: the default browser.
pub fn open_external(url: &str) {
    crate::open_url(url);
}

/// Windows types that run code or launch something when opened with the default verb (security review 2026-11-06,
/// PLAN.md "W4 (open path)"): executables, scripts, installers, shortcuts and shell command files. PATHEXT is added at run
/// time. Lower case, with the dot.
pub const WINDOWS_PROGRAM_TYPES: &[&str] = &[
    ".exe",
    ".com",
    ".bat",
    ".cmd",
    ".pif",
    ".scr",
    ".cpl",
    ".msc",
    ".msi",
    ".msp",
    ".mst",
    ".msix",
    ".msixbundle",
    ".appx",
    ".appxbundle",
    ".appinstaller",
    ".application",
    ".appref-ms",
    ".lnk",
    ".url",
    ".website",
    ".scf",
    ".hta",
    ".chm",
    ".vb",
    ".vbs",
    ".vbe",
    ".js",
    ".jse",
    ".ws",
    ".wsf",
    ".wsc",
    ".wsh",
    ".sct",
    ".ps1",
    ".ps1xml",
    ".ps2",
    ".ps2xml",
    ".psc1",
    ".psc2",
    ".psd1",
    ".psm1",
    ".pssc",
    ".msh",
    ".msh1",
    ".msh2",
    ".mshxml",
    ".msh1xml",
    ".msh2xml",
    ".reg",
    ".inf",
    ".ins",
    ".isp",
    ".jar",
    ".gadget",
    ".shb",
    ".shs",
    ".xbap",
    ".xll",
    ".diagcab",
    ".settingcontent-ms",
    ".library-ms",
    ".search-ms",
    ".searchconnector-ms",
    ".theme",
    ".themepack",
    ".desktopthemepackfile",
    ".mof",
    ".job",
    ".rdp",
    ".py",
    ".pyw",
    ".pyz",
    ".pyzw",
    ".pl",
    ".rb",
    ".hlp",
];

/// macOS types that `open` would run or install: applications and other bundles, Terminal commands, installers, scripts
/// and location files.
pub const MAC_PROGRAM_TYPES: &[&str] = &[
    ".app",
    ".command",
    ".terminal",
    ".tool",
    ".pkg",
    ".mpkg",
    ".workflow",
    ".action",
    ".scpt",
    ".scptd",
    ".applescript",
    ".sh",
    ".zsh",
    ".bash",
    ".csh",
    ".ksh",
    ".jar",
    ".webloc",
    ".inetloc",
    ".fileloc",
    ".prefpane",
    ".saver",
    ".qlgenerator",
    ".mobileconfig",
    ".kext",
    ".plugin",
    ".bundle",
    ".py",
    ".pl",
    ".rb",
];

/// The type of a file name as the OS sees it, lower case with the dot (`""` when it has none). Windows drops trailing dots
/// and spaces of a name (`run.bat.` opens `run.bat`), so they are dropped here too.
fn file_type(name: &str, windows: bool) -> String {
    let name = if windows { name.trim_end_matches(['.', ' ']) } else { name };
    match name.rfind('.') {
        Some(at) => name[at..].to_ascii_lowercase(),
        None => String::new(),
    }
}

/// Whether opening a file of this name would launch a program. Windows: the list above plus every PATHEXT entry, case
/// insensitive; a name with a stream (`x.txt:y`) counts too. macOS: the list above. Pure, for the tests.
pub fn is_program_name(name: &str, windows: bool, pathext: &str) -> bool {
    if windows {
        if name.contains(':') {
            return true;
        }
        let ty = file_type(name, true);
        if ty.is_empty() {
            return false;
        }
        WINDOWS_PROGRAM_TYPES.contains(&ty.as_str())
            || pathext.split(';').map(|e| e.trim().to_ascii_lowercase()).any(|e| !e.is_empty() && e == ty)
    } else {
        let ty = file_type(name, false);
        !ty.is_empty() && MAC_PROGRAM_TYPES.contains(&ty.as_str())
    }
}

/// Whether `shell:openPath` must reveal this path instead of opening it: a program, script, installer or shortcut by its
/// type (macOS: an `.app` bundle too, which is a folder). A folder on Windows still opens in Explorer, as in 1.1.4.
pub fn launches_program(path: &str) -> bool {
    #[cfg(windows)]
    {
        if Path::new(path).is_dir() {
            return false;
        }
        let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
        // The drive of a bare `C:x` path is not a stream.
        let name = if name.len() >= 2 && name.as_bytes()[1] == b':' && name.as_bytes()[0].is_ascii_alphabetic() {
            &name[2..]
        } else {
            name
        };
        is_program_name(name, true, &std::env::var("PATHEXT").unwrap_or_default())
    }
    #[cfg(not(windows))]
    {
        let trimmed = path.trim_end_matches('/');
        let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
        is_program_name(name, false, "")
    }
}

/// `shell.openPath(path)`: the default program of a file, Explorer / Finder for a folder. A program, script, installer or
/// shortcut ([`launches_program`]) is never run: it is revealed in Explorer / Finder instead (PLAN.md, W4 open path; 1.1.4
/// had that gap). An error text like Electron's (1.1.4 ignored it).
pub fn open_path(path: &str) -> Result<(), String> {
    if !is_path_arg(path) {
        return Err("Invalid path".into());
    }
    if launches_program(path) {
        if !Path::new(path).exists() {
            return Err("Failed to open path".into());
        }
        show_item_in_folder(path);
        return Ok(());
    }
    #[cfg(windows)]
    {
        win::open_path(path)
    }
    #[cfg(target_os = "macos")]
    {
        mac_open(&["--", path])
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("not supported".into())
    }
}

/// `shell.showItemInFolder(path)`: Explorer with the item selected (the folder itself when the item cannot be selected);
/// Finder reveals it on macOS.
pub fn show_item_in_folder(path: &str) {
    if !is_path_arg(path) {
        return;
    }
    #[cfg(windows)]
    win::show_item_in_folder(path);
    #[cfg(target_os = "macos")]
    {
        let _ = mac_open(&["-R", "--", path]);
    }
}

/// `shell.trashItem(path)`: moves a file or folder to the Recycle Bin / Trash.
pub fn trash_item(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

/// `shell.beep()`: the system's default sound.
pub fn beep() {
    #[cfg(windows)]
    {
        use windows::Win32::System::Diagnostics::Debug::MessageBeep;
        use windows::Win32::UI::WindowsAndMessaging::MB_OK;
        // SAFETY: plain Win32 call.
        unsafe {
            let _ = MessageBeep(MB_OK);
        }
    }
    #[cfg(target_os = "macos")]
    {
        objc2_app_kit::NSBeep();
    }
}

/// `BrowserWindow.flashFrame(flash)` on Windows (Chromium's HWNDMessageHandler::FlashFrame): four flashes of the caption
/// and the taskbar button, which then stays highlighted until the window is activated or the flash is stopped.
#[cfg(windows)]
pub fn flash_window(hwnd: isize, flash: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{FLASHW_ALL, FLASHW_STOP, FLASHWINFO, FlashWindowEx};
    let info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: HWND(hwnd as *mut _),
        dwFlags: if flash { FLASHW_ALL } else { FLASHW_STOP },
        uCount: if flash { 4 } else { 0 },
        dwTimeout: 0,
    };
    // SAFETY: the window's own handle.
    unsafe {
        let _ = FlashWindowEx(&info);
    }
}

#[cfg(target_os = "macos")]
fn mac_open(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("Failed to open path ({status})")) }
}

#[cfg(windows)]
mod win {
    use std::path::Path;

    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        ILFree, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, SHOpenFolderAndSelectItems, SHParseDisplayName,
        ShellExecuteExW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, PCWSTR};

    /// COM for the shell calls (STA, like Chromium's worker for these calls).
    struct Com(bool);
    impl Com {
        fn init() -> Self {
            // SAFETY: balanced by Drop when it succeeded.
            Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok())
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: matches the successful CoInitializeEx.
                unsafe { CoUninitialize() };
            }
        }
    }

    /// ui::win::OpenFileViaShell / OpenFolderViaShell: ShellExecuteEx with the default verb and the parent as the working
    /// directory (a folder: `explore` in itself), never an error box of the shell.
    fn shell_execute(file: &str, verb: Option<&str>, dir: Option<&str>) -> Result<(), String> {
        let _com = Com::init();
        let file = HSTRING::from(file);
        let verb = verb.map(HSTRING::from);
        let dir = dir.map(HSTRING::from);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: verb.as_ref().map_or(PCWSTR::null(), |v| PCWSTR(v.as_ptr())),
            lpFile: PCWSTR(file.as_ptr()),
            lpDirectory: dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        // SAFETY: the struct and its strings live for the call.
        unsafe { ShellExecuteExW(&mut info) }.map_err(|e| e.message())
    }

    pub fn open_path(path: &str) -> Result<(), String> {
        let p = Path::new(path);
        if !p.exists() {
            return Err("Failed to open path".into());
        }
        if p.is_dir() {
            return shell_execute(path, Some("explore"), Some(path));
        }
        let parent = p.parent().map(|d| d.to_string_lossy().into_owned());
        shell_execute(path, None, parent.as_deref())
    }

    /// platform_util::ShowItemInFolder (Electron, Windows): select the item in its folder; when the shell cannot (an item
    /// it does not know, ERROR_FILE_NOT_FOUND), open the folder instead.
    pub fn show_item_in_folder(path: &str) {
        let p = Path::new(path);
        let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) else { return };
        if !dir.is_dir() {
            return;
        }
        let path = path.to_string();
        let dir = dir.to_string_lossy().into_owned();
        // The shell call may block (network folders): on its own thread, like Electron's blocking worker.
        std::thread::spawn(move || {
            let _com = Com::init();
            let parse = |s: &str| -> Option<*mut ITEMIDLIST> {
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                // SAFETY: out pointer to a PIDL freed with ILFree below.
                unsafe { SHParseDisplayName(&HSTRING::from(s), None, &mut pidl, 0, None) }.ok()?;
                (!pidl.is_null()).then_some(pidl)
            };
            let Some(folder) = parse(&dir) else { return };
            let selected = match parse(&path) {
                Some(item) => {
                    let items = [item as *const ITEMIDLIST];
                    // SAFETY: valid PIDLs for the call.
                    let r = unsafe { SHOpenFolderAndSelectItems(folder, Some(&items), 0) };
                    // SAFETY: allocated by SHParseDisplayName.
                    unsafe { ILFree(Some(item)) };
                    r.map_err(|e| e.code())
                }
                None => Err(ERROR_FILE_NOT_FOUND.to_hresult()),
            };
            // SAFETY: allocated by SHParseDisplayName.
            unsafe { ILFree(Some(folder)) };
            if selected.is_err() {
                let _ = shell_execute(&dir, Some("explore"), Some(&dir));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_args_are_non_empty_without_nul() {
        assert!(is_path_arg("C:\\x"));
        assert!(!is_path_arg(""));
        assert!(!is_path_arg("C:\\x\0y"));
    }

    /// PLAN.md "W4 (open path, security review 2026-11-06)": programs, scripts, installers and shortcuts are revealed, never
    /// opened; documents and media still open.
    #[test]
    fn open_path_refusal_list() {
        let pathext = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL;.FOO";
        for name in [
            "evil.exe",
            "EVIL.EXE",
            "run.bat",
            "run.Cmd",
            "x.com",
            "link.lnk",
            "site.url",
            "app.hta",
            "e.scf",
            "s.scr",
            "c.cpl",
            "setup.msi",
            "p.ps1",
            "v.vbs",
            "j.js",
            "j.jse",
            "w.wsf",
            "r.reg",
            "x.pif",
            "x.msc",
            "x.jar",
            "x.appref-ms",
            "x.settingcontent-ms",
            "x.chm",
            "x.inf",
            "x.application",
            "custom.foo",
            "run.bat.",
            "run.bat . .",
            "a.txt:b",
            "a.txt:evil.exe",
            ".exe",
        ] {
            assert!(is_program_name(name, true, pathext), "{name} must not be opened on Windows");
        }
        for name in ["notes.txt", "alert.wav", "photo.PNG", "doc.pdf", "README", "archive.zip", "page.html", "a.foo.txt"] {
            assert!(!is_program_name(name, true, pathext), "{name} opens on Windows");
        }
        // PATHEXT is read at run time: without it the fixed list still holds.
        assert!(is_program_name("x.exe", true, ""));
        assert!(!is_program_name("x.foo", true, ""));
        for name in ["Calc.app", "run.command", "x.terminal", "setup.pkg", "s.sh", "a.scpt", "l.webloc", "p.mobileconfig"] {
            assert!(is_program_name(name, false, ""), "{name} must not be opened on macOS");
        }
        for name in ["notes.txt", "alert.aiff", "photo.png", "doc.pdf", "folder", "x.exe:y"] {
            assert!(!is_program_name(name, false, ""), "{name} opens on macOS");
        }
    }

    /// An existing script is revealed (Explorer opens on its folder), never run: openPath returns Ok without launching it.
    /// The script would write a marker file if it ran.
    #[cfg(windows)]
    #[test]
    fn open_path_reveals_a_script_instead_of_running_it() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran.txt");
        let script = dir.path().join("run.bat");
        std::fs::write(&script, format!("echo x > \"{}\"\r\n", marker.display())).unwrap();
        assert!(launches_program(&script.to_string_lossy()));
        assert!(!launches_program(&dir.path().to_string_lossy()), "a folder opens in Explorer");
        assert!(!launches_program(&dir.path().join("a.txt").to_string_lossy()));
        assert!(launches_program("C:run.bat"));
        // Not opened for real here (that would show an Explorer window); the decision above is what open_path checks first.
        assert!(open_path(&dir.path().join("missing.exe").to_string_lossy()).is_err());
        assert!(!marker.exists());
    }

    #[test]
    fn open_path_refuses_what_does_not_exist_without_opening_anything() {
        let dir = tempfile::tempdir().unwrap();
        assert!(open_path(&dir.path().join("missing.txt").to_string_lossy()).is_err());
        assert!(open_path("").is_err());
    }

    /// A file goes to the Recycle Bin and is then removed from it again (so the test leaves nothing behind).
    #[cfg(windows)]
    #[test]
    fn trash_item_moves_a_file_to_the_recycle_bin() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("unimux-w4-trash-{}.txt", std::process::id());
        let file = dir.path().join(&name);
        std::fs::write(&file, b"x").unwrap();
        trash_item(&file).unwrap();
        assert!(!file.exists());
        if let Ok(items) = trash::os_limited::list() {
            let mine: Vec<_> = items.into_iter().filter(|i| i.name == std::ffi::OsStr::new(&name)).collect();
            assert!(!mine.is_empty(), "the file is in the Recycle Bin");
            let _ = trash::os_limited::purge_all(mine);
        }
        assert!(trash_item(&dir.path().join("missing")).is_err());
    }
}
