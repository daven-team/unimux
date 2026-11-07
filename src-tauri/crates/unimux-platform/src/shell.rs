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

/// Windows types that run code or launch something when opened with the default verb (security reviews 2026-11-06 and
/// 2026-11-07, PLAN.md "W4 (open path)"): executables, scripts, installers, shortcuts, shell command files, Access databases
/// (macros, VBA), provisioning and sandbox configs, and disk images and cabinets (mounted, attached or expanded). PATHEXT and
/// `AssocIsDangerous` are consulted at run time on top of it; this list is the floor a misconfigured registry cannot lower.
/// Lower case, with the dot.
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
    ".msu",
    ".ppkg",
    ".wsb",
    ".jnlp",
    ".mdb",
    ".mde",
    ".accdb",
    ".accde",
    ".accdr",
    ".accda",
    ".accdu",
    ".ade",
    ".adp",
    ".mda",
    ".mam",
    ".maf",
    ".maq",
    ".mar",
    ".mat",
    ".maw",
    ".iso",
    ".img",
    ".vhd",
    ".vhdx",
    ".cab",
];

/// macOS types that `open` would run, install or mount: applications and other bundles, Terminal commands, installers,
/// scripts, location files and disk images. An extra check on top of the content checks ([`unix_content_launches`]).
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
    ".xpc",
    ".appex",
    ".framework",
    ".service",
    ".systemextension",
    ".mdimporter",
    ".wdgt",
    ".dext",
    ".osax",
    ".component",
    ".dmg",
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

/// Whether `shell:openPath` must reveal this path instead of opening it (PLAN.md, W4 open path, both security reviews). The
/// path the renderer sent and the target it resolves to (a symlink `notes.txt` -> `evil.exe` or `Calculator.app`) are both
/// judged, and either one being a program is enough.
/// - Windows: the type list, PATHEXT and `AssocIsDangerous`. A folder still opens in Explorer, as in 1.1.4.
/// - macOS: the type list, and the content of the target: a regular file with an execute bit, a `#!` or Mach-O / fat
///   header, a bundle folder (`Contents/Info.plist`), or anything that is neither a regular file nor a folder.
///
/// Every caller (the `shell:openPath` decision, the re-check in [`open_path`] right before ShellExecute / `open`, the
/// openInEditor fallback) goes through here, so they all share every check.
pub fn launches_program(path: &str) -> bool {
    let target = std::fs::canonicalize(path).ok();
    #[cfg(windows)]
    {
        if Path::new(path).is_dir() {
            return false;
        }
        windows_name_launches(path) || target.is_some_and(|t| windows_name_launches(&t.to_string_lossy()))
    }
    #[cfg(not(windows))]
    {
        unix_name_launches(path)
            || unix_content_launches(Path::new(path))
            || target.is_some_and(|t| unix_name_launches(&t.to_string_lossy()) || unix_content_launches(&t))
    }
}

/// The last component of a Windows path, without the drive of a bare `C:x` path (which is not a stream).
#[cfg(windows)]
fn windows_file_name(path: &str) -> &str {
    let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
    if name.len() >= 2 && name.as_bytes()[1] == b':' && name.as_bytes()[0].is_ascii_alphabetic() { &name[2..] } else { name }
}

/// Windows: the fixed list, PATHEXT, or the OS's own verdict on the type.
#[cfg(windows)]
fn windows_name_launches(path: &str) -> bool {
    let name = windows_file_name(path);
    if is_program_name(name, true, &std::env::var("PATHEXT").unwrap_or_default()) {
        return true;
    }
    let ty = file_type(name, true);
    !ty.is_empty() && win::assoc_is_dangerous(&ty)
}

#[cfg(not(windows))]
fn unix_name_launches(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    is_program_name(name, false, "")
}

/// Mach-O (32 and 64 bit, both byte orders) and fat / universal headers (CAFEBABE is also a Java class file, refused too).
const MACH_O_MAGICS: &[[u8; 4]] = &[
    [0xFE, 0xED, 0xFA, 0xCE],
    [0xFE, 0xED, 0xFA, 0xCF],
    [0xCE, 0xFA, 0xED, 0xFE],
    [0xCF, 0xFA, 0xED, 0xFE],
    [0xCA, 0xFE, 0xBA, 0xBE],
    [0xBE, 0xBA, 0xFE, 0xCA],
    [0xCA, 0xFE, 0xBA, 0xBF],
    [0xBF, 0xBA, 0xFE, 0xCA],
];

/// Whether the first bytes of a file are a `#!` line or a Mach-O / fat header. Pure, for the tests.
pub fn has_program_magic(head: &[u8]) -> bool {
    head.starts_with(b"#!") || (head.len() >= 4 && MACH_O_MAGICS.iter().any(|m| head[..4] == m[..]))
}

/// macOS content checks on a path (`fs::metadata` follows links): a regular file with any execute bit or a program header
/// ([`has_program_magic`]), a bundle folder (`Contents/Info.plist`), or a special file (a FIFO is never read, it would
/// block). A path that cannot be read is left to the name check (`open` fails on it anyway). Built on Windows too, where
/// only the tests use it.
#[cfg_attr(windows, allow(dead_code))]
fn unix_content_launches(path: &Path) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.is_dir() {
        return path.join("Contents").join("Info.plist").exists();
    }
    if !meta.is_file() {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            return true;
        }
    }
    let Ok(file) = std::fs::File::open(path) else { return false };
    let mut head = Vec::with_capacity(4);
    if file.take(4).read_to_end(&mut head).is_err() {
        return false;
    }
    has_program_magic(&head)
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
        AssocIsDangerous, ILFree, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, SHOpenFolderAndSelectItems,
        SHParseDisplayName, ShellExecuteExW,
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

    /// `AssocIsDangerous` (shlwapi): whether the OS treats this type (with the dot) as unsafe to open, which also covers
    /// types an installed handler marks `FTA_AlwaysUnsafe`.
    pub fn assoc_is_dangerous(ty: &str) -> bool {
        let ty = HSTRING::from(ty);
        // SAFETY: a NUL-terminated string living for the call; only reads the registry.
        unsafe { AssocIsDangerous(PCWSTR(ty.as_ptr())) }.as_bool()
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
            "x.msu",
            "x.ppkg",
            "x.wsb",
            "x.jnlp",
            "x.mdb",
            "x.mde",
            "x.accdb",
            "x.accde",
            "x.accdr",
            "x.accda",
            "x.accdu",
            "x.ade",
            "x.adp",
            "x.mda",
            "x.mam",
            "x.maf",
            "x.maq",
            "x.mar",
            "x.mat",
            "x.maw",
            "disk.ISO",
            "disk.img",
            "disk.vhd",
            "disk.vhdx",
            "x.cab",
            "x.appx",
            "x.appxbundle",
            "x.msix",
            "x.msixbundle",
            "x.appinstaller",
            "x.library-ms",
            "x.search-ms",
            "x.searchconnector-ms",
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
        for name in [
            "Calc.app",
            "run.command",
            "x.terminal",
            "setup.pkg",
            "s.sh",
            "a.scpt",
            "l.webloc",
            "p.mobileconfig",
            "x.xpc",
            "x.appex",
            "x.framework",
            "x.service",
            "x.systemextension",
            "x.mdimporter",
            "x.dmg",
        ] {
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

    /// PLAN.md "W4 (open path, second security review 2026-11-07)": the OS's own verdict is consulted on top of the list.
    #[cfg(windows)]
    #[test]
    fn assoc_is_dangerous_is_consulted() {
        assert!(win::assoc_is_dangerous(".exe"));
        assert!(win::assoc_is_dangerous(".EXE"));
        assert!(!win::assoc_is_dangerous(".txt"));
        assert!(!win::assoc_is_dangerous(".png"));
        // Every type the OS calls dangerous is refused, whether or not the fixed list has it.
        let dir = tempfile::tempdir().unwrap();
        for ty in [".exe", ".bat", ".lnk", ".url", ".hta", ".scr", ".msi", ".ps1", ".reg", ".cpl", ".appref-ms", ".ws"] {
            if win::assoc_is_dangerous(ty) {
                assert!(launches_program(&dir.path().join(format!("x{ty}")).to_string_lossy()), "{ty} is dangerous to the OS");
            }
        }
        // No PATHEXT entry, not in the fixed list: only AssocIsDangerous can refuse it.
        let probe = [".partial", ".xnk", ".grp", ".mcf", ".glk", ".ops", ".prg", ".ksh", ".csh", ".fxp", ".mdz", ".mdt", ".mdw"];
        for ty in probe.into_iter().filter(|ty| win::assoc_is_dangerous(ty)) {
            assert!(!is_program_name(&format!("a{ty}"), true, ""), "{ty} is not in the fixed list");
            assert!(launches_program(&dir.path().join(format!("a{ty}")).to_string_lossy()), "{ty}: AssocIsDangerous refuses it");
        }
    }

    /// A link with a document name is judged by its target too (needs the symlink privilege or Developer Mode; skipped
    /// otherwise).
    #[cfg(windows)]
    #[test]
    fn open_path_judges_the_target_of_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("run.bat");
        std::fs::write(&script, b"rem x\r\n").unwrap();
        let link = dir.path().join("notes.txt");
        if std::os::windows::fs::symlink_file(&script, &link).is_err() {
            return;
        }
        assert!(launches_program(&link.to_string_lossy()));
    }

    #[test]
    fn program_headers_are_recognised() {
        assert!(has_program_magic(b"#!/bin/sh\n"));
        assert!(has_program_magic(b"#!"));
        for magic in MACH_O_MAGICS {
            assert!(has_program_magic(&[magic[0], magic[1], magic[2], magic[3], 0, 0]));
        }
        for head in [&b""[..], b"#", b"hello", b"\x7fELF", b"\xcf\xfa\xed", b" #!/bin/sh"] {
            assert!(!has_program_magic(head), "{head:?}");
        }
    }

    /// The macOS content checks (built everywhere, so they also run on the Windows CI): a `#!` file named x.txt, a fake
    /// Mach-O, and a folder holding Contents/Info.plist are programs; plain files and folders are not.
    #[test]
    fn content_checks_find_scripts_binaries_and_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join("x.txt"), b"#!/bin/sh\ntouch ran\n").unwrap();
        std::fs::write(d.join("tool"), [0xCF, 0xFA, 0xED, 0xFE, 7, 0, 0, 1]).unwrap();
        std::fs::write(d.join("fat"), [0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 2]).unwrap();
        std::fs::create_dir_all(d.join("Foo").join("Contents")).unwrap();
        std::fs::write(d.join("Foo").join("Contents").join("Info.plist"), b"<plist/>").unwrap();
        std::fs::write(d.join("notes.txt"), b"hello").unwrap();
        std::fs::write(d.join("empty.txt"), b"").unwrap();
        std::fs::create_dir(d.join("plain")).unwrap();
        for name in ["x.txt", "tool", "fat", "Foo"] {
            assert!(unix_content_launches(&d.join(name)), "{name} is a program");
        }
        for name in ["notes.txt", "empty.txt", "plain", "missing"] {
            assert!(!unix_content_launches(&d.join(name)), "{name} opens");
        }
    }

    /// macOS / unix: each of these makes launches_program true, so openPath reveals it; nothing is opened here.
    #[cfg(unix)]
    #[test]
    fn launches_program_checks_content_and_link_targets() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let build = d.join("build");
        std::fs::write(&build, b"echo hi\n").unwrap();
        std::fs::set_permissions(&build, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(d.join("x.txt"), b"#!/bin/sh\n").unwrap();
        std::fs::write(d.join("renamed.pdf"), [0xFE, 0xED, 0xFA, 0xCF, 0, 0, 0, 0]).unwrap();
        std::fs::create_dir_all(d.join("Foo").join("Contents")).unwrap();
        std::fs::write(d.join("Foo").join("Contents").join("Info.plist"), b"<plist/>").unwrap();
        std::fs::create_dir(d.join("Calc.app")).unwrap();
        std::fs::write(d.join("run.sh"), b"echo hi\n").unwrap();
        std::fs::set_permissions(d.join("run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&build, d.join("notes.txt")).unwrap();
        symlink(d.join("Foo"), d.join("readme.md")).unwrap();
        symlink(d.join("Calc.app"), d.join("doc.txt")).unwrap();
        symlink(d.join("run.sh"), d.join("song.mp3")).unwrap();
        for name in ["build", "x.txt", "renamed.pdf", "Foo", "Foo/", "Calc.app", "notes.txt", "readme.md", "doc.txt", "song.mp3"]
        {
            assert!(launches_program(&d.join(name).to_string_lossy()), "{name} must be revealed");
        }
        let plain = d.join("plain.txt");
        std::fs::write(&plain, b"hello").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::create_dir(d.join("folder")).unwrap();
        for name in ["plain.txt", "folder"] {
            assert!(!launches_program(&d.join(name).to_string_lossy()), "{name} opens");
        }
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
