//! macOS window chrome and app menu (PLAN W2), as in 1.1.4:
//! - windows: `titleBarStyle: 'hidden'` with the traffic lights at (12, 10) on the main window and (12, 11) on detached windows
//!   (Tauri: `TitleBarStyle::Overlay`, hidden title, `traffic_light_position`), WebKit background throttling off
//!   (macOS 14+, `backgroundThrottling: false`);
//! - menu: `Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])`, i.e. Electron's macOS app menu and Edit
//!   menu with their labels and accelerators. No View or Window menu, so no reload (Cmd+R reaches the page) and no close
//!   (Cmd+W reaches the page), as in 1.1.4;
//! - process: WebKit's automatic text substitutions off and App Nap off (unimux_platform::mac), before the first webview.
//!
//! The menu layout is plain data, so the Windows test run checks it against Electron's role table; only the code that turns
//! it into a Tauri menu is macOS-only (compile-checked with `node scripts/mac-check.mjs`, run on a Mac in R3).

// The layout is data on every OS (tested on Windows), used only by the macOS code.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// Which kind of app window a builder is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    Main,
    /// A detached window.
    Detached,
}

/// Electron's `trafficLightPosition` of 1.1.4 (index.ts / detachedWindows.ts), in points from the window's top-left corner.
pub fn traffic_lights(kind: WindowKind) -> (f64, f64) {
    match kind {
        WindowKind::Main => (12.0, 10.0),
        WindowKind::Detached => (12.0, 11.0),
    }
}

/// The copyright holder of 1.1.4's Info.plist: electron-builder's `companyName`, i.e. package.json `author`.
pub const COPYRIGHT_HOLDER: &str = "ajzak, azozowsky";

/// The copyright line of the About panel. 1.1.4's `about` role showed the standard AppKit panel with Info.plist's
/// `NSHumanReadableCopyright`, which electron-builder writes as `Copyright © <build year> <companyName>` when package.json
/// sets no `build.copyright` (app-builder-lib appInfo.copyright); the year here is the build's too (build.rs, UTC).
pub fn about_copyright() -> String {
    format!("Copyright \u{a9} {} {COPYRIGHT_HOLDER}", env!("UNIMUX_BUILD_YEAR"))
}

/// One entry of Electron's role menus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    PasteAndMatchStyle,
    Delete,
    SelectAll,
    StartSpeaking,
    StopSpeaking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    Item(Role),
    Separator,
    Submenu(&'static str, &'static [Entry]),
}

pub const APP_NAME: &str = "unimux";

/// Electron's `appMenu` role (macOS): label = app name.
pub const APP_MENU: &[Entry] = &[
    Entry::Item(Role::About),
    Entry::Separator,
    Entry::Item(Role::Services),
    Entry::Separator,
    Entry::Item(Role::Hide),
    Entry::Item(Role::HideOthers),
    Entry::Item(Role::ShowAll),
    Entry::Separator,
    Entry::Item(Role::Quit),
];

/// Electron's `editMenu` role on macOS.
pub const EDIT_MENU: &[Entry] = &[
    Entry::Item(Role::Undo),
    Entry::Item(Role::Redo),
    Entry::Separator,
    Entry::Item(Role::Cut),
    Entry::Item(Role::Copy),
    Entry::Item(Role::Paste),
    Entry::Item(Role::PasteAndMatchStyle),
    Entry::Item(Role::Delete),
    Entry::Item(Role::SelectAll),
    Entry::Separator,
    Entry::Submenu("Speech", &[Entry::Item(Role::StartSpeaking), Entry::Item(Role::StopSpeaking)]),
];

/// The menu bar: (title, entries).
pub const MENU_BAR: &[(&str, &[Entry])] = &[(APP_NAME, APP_MENU), ("Edit", EDIT_MENU)];

impl Role {
    /// Electron's label for the role (English on every system, like 1.1.4).
    pub fn label(self) -> &'static str {
        match self {
            Role::About => "About unimux",
            Role::Services => "Services",
            Role::Hide => "Hide unimux",
            Role::HideOthers => "Hide Others",
            Role::ShowAll => "Show All",
            Role::Quit => "Quit unimux",
            Role::Undo => "Undo",
            Role::Redo => "Redo",
            Role::Cut => "Cut",
            Role::Copy => "Copy",
            Role::Paste => "Paste",
            Role::PasteAndMatchStyle => "Paste and Match Style",
            Role::Delete => "Delete",
            Role::SelectAll => "Select All",
            Role::StartSpeaking => "Start Speaking",
            Role::StopSpeaking => "Stop Speaking",
        }
    }

    /// Electron's accelerator for the role on macOS (Tauri accelerator syntax). The predefined items carry the same ones
    /// (muda); the custom items are built with this.
    pub fn accelerator(self) -> Option<&'static str> {
        match self {
            Role::Hide => Some("Cmd+H"),
            Role::HideOthers => Some("Cmd+Alt+H"),
            Role::Quit => Some("Cmd+Q"),
            Role::Undo => Some("Cmd+Z"),
            Role::Redo => Some("Shift+Cmd+Z"),
            Role::Cut => Some("Cmd+X"),
            Role::Copy => Some("Cmd+C"),
            Role::Paste => Some("Cmd+V"),
            Role::PasteAndMatchStyle => Some("Cmd+Alt+Shift+V"),
            Role::SelectAll => Some("Cmd+A"),
            Role::About | Role::Services | Role::ShowAll | Role::Delete | Role::StartSpeaking | Role::StopSpeaking => None,
        }
    }

    /// Menu id of the roles Tauri has no predefined item for (they send their selector themselves, see `on_menu_event`).
    pub fn custom_id(self) -> Option<&'static str> {
        match self {
            Role::PasteAndMatchStyle => Some("mc-edit-paste-and-match-style"),
            Role::Delete => Some("mc-edit-delete"),
            Role::StartSpeaking => Some("mc-edit-start-speaking"),
            Role::StopSpeaking => Some("mc-edit-stop-speaking"),
            _ => None,
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::utils::config::BackgroundThrottlingPolicy;
    use tauri::{AppHandle, LogicalPosition, Manager, Runtime, TitleBarStyle, WebviewWindowBuilder};
    use unimux_platform::mac::{EditAction, send_edit_action};

    use super::{Entry, MENU_BAR, Role, WindowKind, traffic_lights};

    /// The 1.1.4 chrome of a window: hidden title bar with the traffic lights where 1.1.4 put them, no WebKit throttling.
    pub fn apply<'a, R: Runtime, M: Manager<R>>(
        builder: WebviewWindowBuilder<'a, R, M>,
        kind: WindowKind,
    ) -> WebviewWindowBuilder<'a, R, M> {
        let (x, y) = traffic_lights(kind);
        builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(x, y))
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
    }

    fn item<R: Runtime>(app: &AppHandle<R>, role: Role) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
        let text = Some(role.label());
        Ok(match role {
            Role::About => {
                let about = AboutMetadata {
                    name: Some(super::APP_NAME.into()),
                    version: Some(unimux_core::VERSION.into()),
                    copyright: Some(super::about_copyright()),
                    ..Default::default()
                };
                Box::new(PredefinedMenuItem::about(app, text, Some(about))?)
            }
            Role::Services => Box::new(PredefinedMenuItem::services(app, text)?),
            Role::Hide => Box::new(PredefinedMenuItem::hide(app, text)?),
            Role::HideOthers => Box::new(PredefinedMenuItem::hide_others(app, text)?),
            Role::ShowAll => Box::new(PredefinedMenuItem::show_all(app, text)?),
            Role::Quit => Box::new(PredefinedMenuItem::quit(app, text)?),
            Role::Undo => Box::new(PredefinedMenuItem::undo(app, text)?),
            Role::Redo => Box::new(PredefinedMenuItem::redo(app, text)?),
            Role::Cut => Box::new(PredefinedMenuItem::cut(app, text)?),
            Role::Copy => Box::new(PredefinedMenuItem::copy(app, text)?),
            Role::Paste => Box::new(PredefinedMenuItem::paste(app, text)?),
            Role::SelectAll => Box::new(PredefinedMenuItem::select_all(app, text)?),
            Role::PasteAndMatchStyle | Role::Delete | Role::StartSpeaking | Role::StopSpeaking => {
                let id = role.custom_id().unwrap_or_default();
                Box::new(MenuItem::with_id(app, id, role.label(), true, role.accelerator())?)
            }
        })
    }

    fn entries<R: Runtime>(app: &AppHandle<R>, list: &[Entry]) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
        list.iter()
            .map(|entry| -> tauri::Result<Box<dyn IsMenuItem<R>>> {
                Ok(match *entry {
                    Entry::Item(role) => item(app, role)?,
                    Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                    Entry::Submenu(title, inner) => submenu(app, title, inner)?,
                })
            })
            .collect()
    }

    fn submenu<R: Runtime>(app: &AppHandle<R>, title: &str, list: &[Entry]) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
        let items = entries(app, list)?;
        let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|b| b.as_ref()).collect();
        Ok(Box::new(Submenu::with_items(app, title, true, &refs)?))
    }

    /// The menu bar of 1.1.4 (Builder::menu; replaces Tauri's default macOS menu with its Close Window and View items).
    pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        let bar = MENU_BAR.iter().map(|(title, list)| submenu(app, title, list)).collect::<tauri::Result<Vec<_>>>()?;
        let refs: Vec<&dyn IsMenuItem<R>> = bar.iter().map(|b| b.as_ref()).collect();
        Menu::with_items(app, &refs)
    }

    /// The custom Edit items send their AppKit action to the first responder (the focused webview), like a native item.
    pub fn on_menu_event(id: &str) {
        let action = match id {
            id if Some(id) == Role::PasteAndMatchStyle.custom_id() => EditAction::PasteAndMatchStyle,
            id if Some(id) == Role::Delete.custom_id() => EditAction::Delete,
            id if Some(id) == Role::StartSpeaking.custom_id() => EditAction::StartSpeaking,
            id if Some(id) == Role::StopSpeaking.custom_id() => EditAction::StopSpeaking,
            _ => return,
        };
        send_edit_action(action);
    }

    /// Process-wide settings that must precede the first webview: WebKit text substitutions off, App Nap off.
    pub fn prepare_process() {
        unimux_platform::mac::disable_text_substitutions();
        unimux_platform::mac::disable_app_nap();
    }
}

#[cfg(target_os = "macos")]
pub use imp::{app_menu, apply, on_menu_event, prepare_process};

/// A double click on the title bar's drag area (bridge/macDrag.ts, macOS only): what the user's "Double-click a window's title
/// bar to" setting says, as Electron did for 1.1.4's `-webkit-app-region: drag` area. Elsewhere nothing (Windows: W1's
/// WM_NCHITTEST caption).
#[tauri::command]
pub fn mac_title_double_click(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use unimux_platform::TitleDoubleClick;
        let result = match unimux_platform::mac::title_double_click() {
            TitleDoubleClick::Zoom if window.is_maximized().unwrap_or(false) => window.unmaximize(),
            TitleDoubleClick::Zoom => window.maximize(),
            TitleDoubleClick::Minimize => window.minimize(),
            TitleDoubleClick::Nothing => Ok(()),
        };
        result.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roles(list: &[Entry], out: &mut Vec<Role>) {
        for entry in list {
            match entry {
                Entry::Item(role) => out.push(*role),
                Entry::Submenu(_, inner) => roles(inner, out),
                Entry::Separator => {}
            }
        }
    }

    #[test]
    fn about_panel_has_1_1_4s_copyright_line() {
        let year: u32 = env!("UNIMUX_BUILD_YEAR").parse().unwrap();
        assert!((2026..3000).contains(&year));
        assert_eq!(about_copyright(), format!("Copyright \u{a9} {year} ajzak, azozowsky"));
        // electron-builder's companyName is package.json `author`; 1.1.4 set no build.copyright.
        let package = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../package.json")).unwrap();
        let package: serde_json::Value = serde_json::from_str(&package).unwrap();
        assert_eq!(package["author"], COPYRIGHT_HOLDER);
        assert!(package["build"].get("copyright").is_none());
        // The macOS menu code hands it to the About item.
        let source = include_str!("mac_chrome.rs");
        assert!(source.contains("copyright: Some(super::about_copyright()),"));
    }

    #[test]
    fn traffic_lights_are_where_1_1_4_put_them() {
        assert_eq!(traffic_lights(WindowKind::Main), (12.0, 10.0));
        assert_eq!(traffic_lights(WindowKind::Detached), (12.0, 11.0));
    }

    #[test]
    fn menu_bar_is_electrons_app_and_edit_menu() {
        let titles: Vec<&str> = MENU_BAR.iter().map(|(t, _)| *t).collect();
        assert_eq!(titles, ["unimux", "Edit"]);
        let labels = |list: &[Entry]| -> Vec<String> {
            list.iter()
                .map(|e| match e {
                    Entry::Item(r) => r.label().to_string(),
                    Entry::Separator => "-".into(),
                    Entry::Submenu(t, inner) => {
                        format!(
                            "{t}[{}]",
                            inner
                                .iter()
                                .map(|i| if let Entry::Item(r) = i { r.label() } else { "?" })
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    }
                })
                .collect()
        };
        assert_eq!(
            labels(APP_MENU),
            ["About unimux", "-", "Services", "-", "Hide unimux", "Hide Others", "Show All", "-", "Quit unimux"]
        );
        assert_eq!(
            labels(EDIT_MENU),
            [
                "Undo",
                "Redo",
                "-",
                "Cut",
                "Copy",
                "Paste",
                "Paste and Match Style",
                "Delete",
                "Select All",
                "-",
                "Speech[Start Speaking,Stop Speaking]"
            ]
        );
    }

    #[test]
    fn no_reload_close_or_window_items() {
        let mut all = Vec::new();
        for (_, list) in MENU_BAR {
            roles(list, &mut all);
        }
        for role in &all {
            let label = role.label().to_ascii_lowercase();
            assert!(!label.contains("reload") && !label.contains("close") && !label.contains("minimize"), "{label}");
            // Cmd+R and Cmd+W must reach the page (1.1.4 had no View / Window menu).
            assert!(!matches!(role.accelerator(), Some("Cmd+R" | "Cmd+W" | "Cmd+Shift+R" | "Cmd+M")), "{role:?}");
        }
        let accels: Vec<_> = all.iter().filter_map(|r| r.accelerator()).collect();
        let mut unique = accels.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), accels.len(), "duplicate accelerators: {accels:?}");
    }

    #[test]
    fn custom_items_have_ids_and_parse_as_accelerators() {
        for role in [Role::PasteAndMatchStyle, Role::Delete, Role::StartSpeaking, Role::StopSpeaking] {
            assert!(role.custom_id().is_some_and(|id| id.starts_with("mc-edit-")));
        }
        assert_eq!(Role::Paste.custom_id(), None);
        // muda's accelerator syntax: modifiers it knows, then exactly one key.
        let mut all = Vec::new();
        for (_, list) in MENU_BAR {
            roles(list, &mut all);
        }
        for accel in all.iter().filter_map(|r| r.accelerator()) {
            let parts: Vec<&str> = accel.split('+').collect();
            let (key, mods) = parts.split_last().unwrap();
            assert!(mods.iter().all(|m| matches!(*m, "Cmd" | "Shift" | "Alt")), "{accel}");
            assert!(key.len() == 1 && key.chars().all(|c| c.is_ascii_uppercase()), "{accel}");
        }
    }
}
