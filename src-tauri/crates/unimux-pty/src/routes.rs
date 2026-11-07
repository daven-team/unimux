//! Which renderer window gets a terminal's output (port of src/ptyhost/routes.ts) and the sizes that arrive before their
//! terminal exists (the early-size LRU of src/ptyhost/router.ts).

use std::collections::{HashMap, VecDeque};

pub const MAIN_WINDOW: &str = "main";
/// Early sizes kept at most (router.ts EARLY_SIZES_MAX).
pub const EARLY_SIZES_MAX: usize = 200;

/// Every terminal belongs to the main window unless it was routed to a detached window. Messages from a window are
/// accepted only for the terminals it owns.
#[derive(Debug, Default)]
pub struct WindowRoutes {
    owners: HashMap<String, String>,
    /// The window whose report set the focused terminal (another window's "nothing focused" must not clear it).
    focus_window: Option<String>,
}

impl WindowRoutes {
    pub fn owner_of(&self, id: &str) -> &str {
        self.owners.get(id).map(String::as_str).unwrap_or(MAIN_WINDOW)
    }

    /// Routes a terminal to a window (None or "main": the main window). Returns the previous owner when it changed.
    pub fn set(&mut self, id: &str, window: Option<&str>) -> Option<String> {
        let before = self.owner_of(id).to_string();
        let after = window.unwrap_or(MAIN_WINDOW);
        if after == MAIN_WINDOW {
            self.owners.remove(id);
        } else {
            self.owners.insert(id.to_string(), after.to_string());
        }
        (before != after).then_some(before)
    }

    /// May a message about terminal `id` from `window` reach it?
    pub fn accepts(&self, window: &str, id: &str) -> bool {
        self.owner_of(id) == window
    }

    /// A focus report: `Some(id)` to pass on (inner None = none focused), None when the report is to be ignored (a window
    /// that lost the focus says "none" after another window already reported its terminal).
    pub fn focus(&mut self, window: &str, id: Option<&str>) -> Option<Option<String>> {
        if let Some(id) = id {
            self.focus_window = Some(window.to_string());
            return Some(Some(id.to_string()));
        }
        if self.focus_window.as_deref().is_some_and(|w| w != window) {
            return None;
        }
        self.focus_window = None;
        Some(None)
    }

    /// A terminal is gone: its route goes with it.
    pub fn forget(&mut self, id: &str) {
        self.owners.remove(id);
    }
}

/// Sizes that arrived before their spawn (the renderer's port is faster than the spawn request), newest last, bounded.
#[derive(Debug, Default)]
pub struct EarlySizes {
    order: VecDeque<String>,
    sizes: HashMap<String, (u16, u16)>,
}

impl EarlySizes {
    pub fn set(&mut self, id: &str, cols: u16, rows: u16) {
        if self.sizes.insert(id.to_string(), (cols, rows)).is_some() {
            self.order.retain(|x| x != id);
        }
        self.order.push_back(id.to_string());
        if self.order.len() > EARLY_SIZES_MAX
            && let Some(oldest) = self.order.pop_front()
        {
            self.sizes.remove(&oldest);
        }
    }

    pub fn take(&mut self, id: &str) -> Option<(u16, u16)> {
        let size = self.sizes.remove(id)?;
        self.order.retain(|x| x != id);
        Some(size)
    }

    pub fn len(&self) -> usize {
        self.sizes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sizes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminals_belong_to_main_until_routed() {
        let mut r = WindowRoutes::default();
        assert_eq!(r.owner_of("a"), MAIN_WINDOW);
        assert_eq!(r.set("a", Some("detached-1")), Some("main".to_string()));
        assert_eq!(r.set("a", Some("detached-1")), None);
        assert!(r.accepts("detached-1", "a"));
        assert!(!r.accepts("main", "a"));
        assert_eq!(r.set("a", None), Some("detached-1".to_string()));
        assert!(r.accepts("main", "a"));
    }

    #[test]
    fn a_window_that_lost_the_focus_does_not_clear_another_windows_report() {
        let mut r = WindowRoutes::default();
        assert_eq!(r.focus("detached-1", Some("x")), Some(Some("x".into())));
        assert_eq!(r.focus("main", None), None);
        assert_eq!(r.focus("detached-1", None), Some(None));
        assert_eq!(r.focus("main", None), Some(None));
    }

    // host-router.test.ts: sizes before the terminal exists, bounded, handed out once.
    #[test]
    fn early_sizes_are_bounded_and_handed_out_once() {
        let mut e = EarlySizes::default();
        e.set("new", 120, 40);
        assert_eq!(e.take("new"), Some((120, 40)));
        assert_eq!(e.take("new"), None);
        for i in 0..250 {
            e.set(&format!("x{i}"), 80, 24);
        }
        assert_eq!(e.take("x0"), None);
        assert_eq!(e.take("x249"), Some((80, 24)));
        assert_eq!(e.len(), EARLY_SIZES_MAX - 1);
    }

    #[test]
    fn a_size_set_again_counts_as_the_newest() {
        let mut e = EarlySizes::default();
        e.set("keep", 1, 1);
        for i in 0..EARLY_SIZES_MAX - 1 {
            e.set(&format!("x{i}"), 80, 24);
        }
        e.set("keep", 2, 2);
        e.set("one-more", 3, 3);
        assert_eq!(e.take("keep"), Some((2, 2)));
        assert_eq!(e.take("x0"), None);
    }
}
