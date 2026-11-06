//! The screen API of the detached windows (W5): monitors in physical pixels (what Tauri / Win32 report) turned into the
//! display list Electron's `screen` module gave 1.1.4, in DIPs. state.json keeps detached-window bounds in those DIPs, so a
//! 1.1.4 registry opens at the same place in 1.2.0 and the other way round.
//!
//! The DIP layout follows Chromium's `ScreenWin` (ui/display/win/screen_win.cc): the primary display keeps its origin
//! (physical / scale), every other display is placed next to a display it touches (breadth first from the primary), with
//! its size in its own DIPs and its offset along the shared edge scaled by the parent's factor; a display that touches none
//! falls back to physical / scale. With one scale factor everywhere DIPs are physical pixels divided by it, which is the
//! usual case. Points and rectangles convert through the display they lie on (rectangles: the one with the biggest
//! overlap, else the nearest), as ScreenToDIPRect / DIPToScreenRect do.
//!
//! Display ids: Electron's id was a hash of the monitor's device path; 1.2.0 uses a hash of the monitor name and its
//! physical position (FNV-1a, 32 bit). Only `bounds` decide where a window reopens (restoreBounds); the id is kept as data.

/// A rectangle (physical pixels or DIPs, as the field it sits in says).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }
    pub fn right(&self) -> f64 {
        self.x + self.width
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
    fn overlap(&self, b: &Rect) -> f64 {
        let w = self.right().min(b.right()) - self.x.max(b.x);
        let h = self.bottom().min(b.bottom()) - self.y.max(b.y);
        if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
    }
    fn distance2(&self, x: f64, y: f64) -> f64 {
        let cx = x.clamp(self.x, self.right());
        let cy = y.clamp(self.y, self.bottom());
        (cx - x).powi(2) + (cy - y).powi(2)
    }
    fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
    /// `Math.round` of every field (halves towards +Infinity).
    pub fn rounded(&self) -> Self {
        let r = |v: f64| (v + 0.5).floor();
        Self::new(r(self.x), r(self.y), r(self.width), r(self.height))
    }
}

/// A monitor as the OS reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Monitor {
    pub name: String,
    /// Physical bounds and work area (virtual-screen pixels).
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale: f64,
    pub primary: bool,
}

/// A display of the DIP layout.
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    pub id: f64,
    pub scale: f64,
    pub physical: Rect,
    pub physical_work: Rect,
    /// Bounds and work area in DIPs (Electron `display.bounds` / `display.workArea`).
    pub bounds: Rect,
    pub work_area: Rect,
}

/// The display list of one moment (monitors change: build a new one for every placement).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Screen {
    pub displays: Vec<Display>,
    pub primary: usize,
}

/// A stable display id: FNV-1a (32 bit) of `<name>@<x>,<y>` (physical position).
pub fn display_id(name: &str, x: f64, y: f64) -> f64 {
    let mut h: u32 = 0x811c_9dc5;
    for b in format!("{name}@{x},{y}").bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    f64::from(h)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Right,
    Left,
    Bottom,
    Top,
}

/// Where `child` touches `parent` (sharing an edge, with some overlap along it).
fn touching(parent: &Rect, child: &Rect) -> Option<Side> {
    let overlaps_y = child.y < parent.bottom() && parent.y < child.bottom();
    let overlaps_x = child.x < parent.right() && parent.x < child.right();
    if child.x == parent.right() && overlaps_y {
        Some(Side::Right)
    } else if child.right() == parent.x && overlaps_y {
        Some(Side::Left)
    } else if child.y == parent.bottom() && overlaps_x {
        Some(Side::Bottom)
    } else if child.bottom() == parent.y && overlaps_x {
        Some(Side::Top)
    } else {
        None
    }
}

impl Screen {
    /// The DIP layout of the monitors (an empty list gives an empty screen).
    pub fn new(monitors: &[Monitor]) -> Self {
        if monitors.is_empty() {
            return Self::default();
        }
        let primary = monitors.iter().position(|m| m.primary).unwrap_or(0);
        let scale = |m: &Monitor| if m.scale > 0.0 && m.scale.is_finite() { m.scale } else { 1.0 };
        let mut dip: Vec<Option<Rect>> = vec![None; monitors.len()];
        let p = &monitors[primary];
        let ps = scale(p);
        dip[primary] = Some(Rect::new(p.bounds.x / ps, p.bounds.y / ps, p.bounds.width / ps, p.bounds.height / ps));
        let mut queue = vec![primary];
        let mut at = 0;
        while at < queue.len() {
            let parent = queue[at];
            at += 1;
            let pd = dip[parent].expect("placed");
            let pm = &monitors[parent];
            let pscale = scale(pm);
            for (i, m) in monitors.iter().enumerate() {
                if dip[i].is_some() {
                    continue;
                }
                let Some(side) = touching(&pm.bounds, &m.bounds) else { continue };
                let s = scale(m);
                let (w, h) = (m.bounds.width / s, m.bounds.height / s);
                let along_x = pd.x + (m.bounds.x - pm.bounds.x) / pscale;
                let along_y = pd.y + (m.bounds.y - pm.bounds.y) / pscale;
                let rect = match side {
                    Side::Right => Rect::new(pd.right(), along_y, w, h),
                    Side::Left => Rect::new(pd.x - w, along_y, w, h),
                    Side::Bottom => Rect::new(along_x, pd.bottom(), w, h),
                    Side::Top => Rect::new(along_x, pd.y - h, w, h),
                };
                dip[i] = Some(rect);
                queue.push(i);
            }
        }
        let displays = monitors
            .iter()
            .zip(dip)
            .map(|(m, d)| {
                let s = scale(m);
                let bounds = d.unwrap_or(Rect::new(m.bounds.x / s, m.bounds.y / s, m.bounds.width / s, m.bounds.height / s));
                let work = Rect::new(
                    bounds.x + (m.work_area.x - m.bounds.x) / s,
                    bounds.y + (m.work_area.y - m.bounds.y) / s,
                    m.work_area.width / s,
                    m.work_area.height / s,
                );
                Display {
                    id: display_id(&m.name, m.bounds.x, m.bounds.y),
                    scale: s,
                    physical: m.bounds,
                    physical_work: m.work_area,
                    bounds: bounds.rounded(),
                    work_area: work.rounded(),
                }
            })
            .collect();
        Self { displays, primary }
    }

    pub fn primary_id(&self) -> f64 {
        self.displays.get(self.primary).map_or(0.0, |d| d.id)
    }

    fn nearest<'a>(list: impl Iterator<Item = (&'a Display, Rect)>, x: f64, y: f64) -> Option<&'a Display> {
        let mut best: Option<(&Display, f64)> = None;
        for (d, r) in list {
            let dist = r.distance2(x, y);
            if best.is_none_or(|(_, b)| dist < b) {
                best = Some((d, dist));
            }
        }
        best.map(|(d, _)| d)
    }

    /// The display of a physical point (the one holding it, else the nearest).
    fn display_of_physical_point(&self, x: f64, y: f64) -> Option<&Display> {
        self.displays
            .iter()
            .find(|d| d.physical.contains(x, y))
            .or_else(|| Self::nearest(self.displays.iter().map(|d| (d, d.physical)), x, y))
    }

    /// The display a physical rectangle is mostly on (else the nearest to its center).
    fn display_of_physical_rect(&self, r: &Rect) -> Option<&Display> {
        let best = self.displays.iter().map(|d| (d, d.physical.overlap(r))).filter(|(_, a)| *a > 0.0).fold(
            None::<(&Display, f64)>,
            |acc, (d, a)| match acc {
                Some((_, b)) if b >= a => acc,
                _ => Some((d, a)),
            },
        );
        let (cx, cy) = r.center();
        best.map(|(d, _)| d).or_else(|| Self::nearest(self.displays.iter().map(|d| (d, d.physical)), cx, cy))
    }

    /// Electron `getDisplayMatching(rect)`: the display a DIP rectangle overlaps most, else the nearest to its center.
    pub fn display_matching(&self, r: &Rect) -> Option<&Display> {
        let best = self.displays.iter().map(|d| (d, d.bounds.overlap(r))).filter(|(_, a)| *a > 0.0).fold(
            None::<(&Display, f64)>,
            |acc, (d, a)| match acc {
                Some((_, b)) if b >= a => acc,
                _ => Some((d, a)),
            },
        );
        let (cx, cy) = r.center();
        best.map(|(d, _)| d).or_else(|| Self::nearest(self.displays.iter().map(|d| (d, d.bounds)), cx, cy))
    }

    /// A physical point in DIPs (`screen.getCursorScreenPoint()`).
    pub fn point_to_dip(&self, x: f64, y: f64) -> (f64, f64) {
        match self.display_of_physical_point(x, y) {
            Some(d) => (d.bounds.x + (x - d.physical.x) / d.scale, d.bounds.y + (y - d.physical.y) / d.scale),
            None => (x, y),
        }
    }

    /// A physical window rectangle in DIPs (`win.getBounds()`).
    pub fn rect_to_dip(&self, r: &Rect) -> Rect {
        match self.display_of_physical_rect(r) {
            Some(d) => Rect::new(
                d.bounds.x + (r.x - d.physical.x) / d.scale,
                d.bounds.y + (r.y - d.physical.y) / d.scale,
                r.width / d.scale,
                r.height / d.scale,
            ),
            None => *r,
        }
    }

    /// A DIP rectangle in physical pixels (`new BrowserWindow(bounds)`), rounded.
    pub fn rect_to_physical(&self, r: &Rect) -> Rect {
        match self.display_matching(r) {
            Some(d) => Rect::new(
                d.physical.x + (r.x - d.bounds.x) * d.scale,
                d.physical.y + (r.y - d.bounds.y) * d.scale,
                r.width * d.scale,
                r.height * d.scale,
            )
            .rounded(),
            None => r.rounded(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::too_many_arguments, reason = "a test helper: one row per monitor reads best")]
    fn monitor(name: &str, x: f64, y: f64, w: f64, h: f64, taskbar: f64, scale: f64, primary: bool) -> Monitor {
        Monitor { name: name.into(), bounds: Rect::new(x, y, w, h), work_area: Rect::new(x, y, w, h - taskbar), scale, primary }
    }

    #[test]
    fn one_scale_factor_is_physical_pixels() {
        // This machine: DISPLAY1 1920x1080 primary, DISPLAY2 left of it, taskbar 48 px.
        let s = Screen::new(&[
            monitor("\\\\.\\DISPLAY1", 0.0, 0.0, 1920.0, 1080.0, 48.0, 1.0, true),
            monitor("\\\\.\\DISPLAY2", -1920.0, 0.0, 1920.0, 1080.0, 48.0, 1.0, false),
        ]);
        assert_eq!(s.displays[1].bounds, Rect::new(-1920.0, 0.0, 1920.0, 1080.0));
        assert_eq!(s.displays[1].work_area, Rect::new(-1920.0, 0.0, 1920.0, 1032.0));
        let r = Rect::new(-1500.0, 100.0, 1000.0, 700.0);
        assert_eq!(s.rect_to_dip(&r), r);
        assert_eq!(s.rect_to_physical(&r), r);
        assert_eq!(s.display_matching(&r).unwrap().id, s.displays[1].id);
        assert_eq!(s.point_to_dip(-10.0, 5.0), (-10.0, 5.0));
        assert_eq!(s.primary_id(), display_id("\\\\.\\DISPLAY1", 0.0, 0.0));
    }

    #[test]
    fn a_single_scaled_display_divides_by_its_factor() {
        let s = Screen::new(&[monitor("A", 0.0, 0.0, 2560.0, 1600.0, 60.0, 1.25, true)]);
        assert_eq!(s.displays[0].bounds, Rect::new(0.0, 0.0, 2048.0, 1280.0));
        assert_eq!(s.displays[0].work_area, Rect::new(0.0, 0.0, 2048.0, 1232.0));
        assert_eq!(s.rect_to_dip(&Rect::new(250.0, 125.0, 1250.0, 875.0)), Rect::new(200.0, 100.0, 1000.0, 700.0));
        assert_eq!(s.rect_to_physical(&Rect::new(200.0, 100.0, 1000.0, 700.0)), Rect::new(250.0, 125.0, 1250.0, 875.0));
    }

    /// Mixed DPI: a 100 percent primary and a 4K monitor at 200 percent on its right. The second display starts where the
    /// primary ends in DIPs and is half its physical size; a window on it round-trips.
    #[test]
    fn mixed_dpi_places_the_second_display_next_to_the_primary() {
        let s = Screen::new(&[
            monitor("P", 0.0, 0.0, 1920.0, 1080.0, 40.0, 1.0, true),
            monitor("4K", 1920.0, -200.0, 3840.0, 2160.0, 80.0, 2.0, false),
        ]);
        assert_eq!(s.displays[1].bounds, Rect::new(1920.0, -200.0, 1920.0, 1080.0));
        assert_eq!(s.displays[1].work_area, Rect::new(1920.0, -200.0, 1920.0, 1040.0));
        let physical = Rect::new(1920.0 + 800.0, 400.0, 2000.0, 1400.0);
        let dip = s.rect_to_dip(&physical);
        assert_eq!(dip, Rect::new(1920.0 + 400.0, 100.0, 1000.0, 700.0));
        assert_eq!(s.rect_to_physical(&dip), physical);
        assert_eq!(s.point_to_dip(1920.0 + 100.0, 0.0), (1970.0, -100.0));
        assert_eq!(s.display_matching(&dip).unwrap().scale, 2.0);
    }

    /// A 150 percent display on the left of a 125 percent primary, and one below the primary at 100 percent.
    #[test]
    fn displays_on_the_left_and_below_follow_the_parent_scale_along_the_edge() {
        let s = Screen::new(&[
            monitor("L", -2880.0, 300.0, 2880.0, 1620.0, 0.0, 1.5, false),
            monitor("P", 0.0, 0.0, 2560.0, 1440.0, 0.0, 1.25, true),
            monitor("B", 500.0, 1440.0, 1920.0, 1080.0, 0.0, 1.0, false),
        ]);
        assert_eq!(s.primary, 1);
        assert_eq!(s.displays[1].bounds, Rect::new(0.0, 0.0, 2048.0, 1152.0));
        // Left: width 2880 / 1.5 = 1920 DIPs, y offset 300 physical of the parent at 1.25 = 240.
        assert_eq!(s.displays[0].bounds, Rect::new(-1920.0, 240.0, 1920.0, 1080.0));
        // Below: y at the parent's DIP bottom, x offset 500 / 1.25 = 400.
        assert_eq!(s.displays[2].bounds, Rect::new(400.0, 1152.0, 1920.0, 1080.0));
        for d in &s.displays {
            let inside = Rect::new(d.work_area.x + 10.0, d.work_area.y + 10.0, 600.0, 400.0);
            let physical = s.rect_to_physical(&inside);
            assert_eq!(s.rect_to_dip(&physical).rounded(), inside, "display {}", d.id);
        }
    }

    #[test]
    fn a_detached_monitor_falls_back_to_its_own_scale_and_ids_are_stable() {
        let s = Screen::new(&[
            monitor("P", 0.0, 0.0, 1920.0, 1080.0, 0.0, 1.0, true),
            monitor("Far", 5000.0, 0.0, 1920.0, 1080.0, 0.0, 1.5, false),
        ]);
        assert_eq!(s.displays[1].bounds, Rect::new(3333.0, 0.0, 1280.0, 720.0));
        assert_eq!(display_id("P", 0.0, 0.0), display_id("P", 0.0, 0.0));
        assert_ne!(display_id("P", 0.0, 0.0), display_id("P", 1.0, 0.0));
        assert!(Screen::new(&[]).displays.is_empty());
    }
}
