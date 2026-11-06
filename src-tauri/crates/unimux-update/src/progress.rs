//! Port of `src/shared/updateProgress.ts` (UpdateProgressModel, closeAction): what the update window shows while the
//! installer replaces the app. The installer reports no progress, so the percentage blends the hard signals (old app exited,
//! installer done, new app ready) with an estimate from the install directory shrinking and regrowing.
//!
//! SP6 ports it 1:1 so the window can be exercised end to end; U2 gates it with goldens written by the TS model.

use serde::Serialize;

/// The stages of the update window (the first four of the TS union belong to the startup gate and are not produced here).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateStage {
    Preparing,
    Closing,
    Installing,
    Launching,
    Done,
    Error,
}

impl UpdateStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Closing => "closing",
            Self::Installing => "installing",
            Self::Launching => "launching",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
}

/// Why a stage takes long, so the window says what it waits for instead of showing a frozen bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateNote {
    WaitingClose,
    WaitingInstaller,
    InstallingLong,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UpdateSnapshot {
    pub elapsed_ms: f64,
    pub closed: bool,
    pub installed: bool,
    pub ready: bool,
    pub dir_bytes: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UpdateProgress {
    pub stage: UpdateStage,
    pub percent: f64,
    pub note: Option<UpdateNote>,
}

pub const WAIT_CLOSE_NOTE_MS: f64 = 8000.0;
pub const WAIT_INSTALLER_NOTE_MS: f64 = 15000.0;
pub const SLOW_INSTALL_NOTE_MS: f64 = 60000.0;
const UNCONFIRMED_INSTALL_FRACTION: f64 = 0.6;

const PREPARE_END: f64 = 8.0;
const CLOSE_END: f64 = 16.0;
const INSTALL_END: f64 = 90.0;
const LAUNCH_END: f64 = 99.0;

fn ease(value: f64) -> f64 {
    1.0 - (-value).exp()
}

/// What X, Escape and Alt+F4 do: hide while work is in flight, exit once finished or given up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Exit,
}

pub fn close_action(stage: UpdateStage) -> CloseAction {
    match stage {
        UpdateStage::Done | UpdateStage::Error => CloseAction::Exit,
        _ => CloseAction::Hide,
    }
}

/// `Math.round(x)` of JS (halves round up, also for negatives).
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

#[derive(Debug, Clone)]
pub struct UpdateProgressModel {
    baseline_bytes: f64,
    min_bytes: f64,
    shown: f64,
    closed_at: Option<f64>,
    installed_at: Option<f64>,
}

impl UpdateProgressModel {
    pub fn new(baseline_bytes: f64) -> Self {
        Self { baseline_bytes, min_bytes: f64::INFINITY, shown: 0.0, closed_at: None, installed_at: None }
    }

    pub fn update(&mut self, s: UpdateSnapshot) -> UpdateProgress {
        let stage;
        let percent;
        let mut note = None;
        if s.closed && self.closed_at.is_none() {
            self.closed_at = Some(s.elapsed_ms);
        }
        if s.installed && self.installed_at.is_none() {
            self.installed_at = Some(s.elapsed_ms);
        }
        if let (Some(bytes), true) = (s.dir_bytes, s.closed) {
            self.min_bytes = self.min_bytes.min(bytes);
        }

        if s.ready {
            stage = UpdateStage::Done;
            percent = 100.0;
        } else if s.installed {
            stage = UpdateStage::Launching;
            let since = s.elapsed_ms - self.installed_at.unwrap_or(s.elapsed_ms);
            percent = INSTALL_END + (LAUNCH_END - INSTALL_END) * ease(since / 5000.0);
        } else if s.closed {
            stage = UpdateStage::Installing;
            let since = s.elapsed_ms - self.closed_at.unwrap_or(s.elapsed_ms);
            let measured = self.size_fraction(s.dir_bytes);
            let cap = if measured > 0.0 { 0.85 } else { UNCONFIRMED_INSTALL_FRACTION };
            let estimate = (0.85 * ease(since / 25000.0)).min(cap);
            percent = CLOSE_END + (INSTALL_END - CLOSE_END) * measured.max(estimate).min(0.97);
            if measured == 0.0 && since > WAIT_INSTALLER_NOTE_MS {
                note = Some(UpdateNote::WaitingInstaller);
            } else if since > SLOW_INSTALL_NOTE_MS {
                note = Some(UpdateNote::InstallingLong);
            }
        } else if s.elapsed_ms < 1200.0 {
            stage = UpdateStage::Preparing;
            percent = PREPARE_END * ease(s.elapsed_ms / 600.0);
        } else {
            stage = UpdateStage::Closing;
            percent = PREPARE_END + (CLOSE_END - PREPARE_END) * ease((s.elapsed_ms - 1200.0) / 2500.0);
            if s.elapsed_ms > WAIT_CLOSE_NOTE_MS {
                note = Some(UpdateNote::WaitingClose);
            }
        }
        self.shown = self.shown.max(percent.min(100.0));
        UpdateProgress { stage, percent: js_round(self.shown * 10.0) / 10.0, note }
    }

    fn size_fraction(&self, bytes: Option<f64>) -> f64 {
        let Some(bytes) = bytes.filter(|b| *b != 0.0) else { return 0.0 };
        if self.baseline_bytes <= 0.0 || self.min_bytes == f64::INFINITY {
            return 0.0;
        }
        let baseline = self.baseline_bytes;
        let removed = ((baseline - self.min_bytes) / baseline).clamp(0.0, 1.0);
        if removed < 0.2 {
            return 0.0;
        }
        let regrown = ((bytes - self.min_bytes) / (baseline - self.min_bytes).max(1.0)).clamp(0.0, 1.0);
        0.3 * removed + 0.7 * regrown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(elapsed_ms: f64, closed: bool, installed: bool, ready: bool, dir_bytes: Option<f64>) -> UpdateSnapshot {
        UpdateSnapshot { elapsed_ms, closed, installed, ready, dir_bytes }
    }

    #[test]
    fn stages_follow_the_signals_and_the_bar_only_moves_forward() {
        let mut m = UpdateProgressModel::new(100.0);
        let p = m.update(snap(0.0, false, false, false, None));
        assert_eq!((p.stage, p.percent), (UpdateStage::Preparing, 0.0));
        let p = m.update(snap(600.0, false, false, false, None));
        assert_eq!(p.stage, UpdateStage::Preparing);
        // 8 * (1 - e^-1) = 5.057...
        assert_eq!(p.percent, 5.1);
        let p = m.update(snap(9000.0, false, false, false, None));
        assert_eq!((p.stage, p.note), (UpdateStage::Closing, Some(UpdateNote::WaitingClose)));
        let closing = p.percent;
        let p = m.update(snap(9250.0, true, false, false, Some(100.0)));
        assert_eq!(p.stage, UpdateStage::Installing);
        assert!(p.percent >= closing);
        // The directory shrinks to 10 and regrows to 100: measured = 0.3 * 0.9 + 0.7 * 1 = 0.97.
        m.update(snap(9500.0, true, false, false, Some(10.0)));
        let p = m.update(snap(10000.0, true, false, false, Some(100.0)));
        assert_eq!(p.percent, js_round((16.0 + 74.0 * 0.97) * 10.0) / 10.0);
        let p = m.update(snap(10250.0, true, true, false, Some(100.0)));
        assert_eq!(p.stage, UpdateStage::Launching);
        assert!(p.percent >= 87.8);
        let p = m.update(snap(12000.0, true, true, true, Some(100.0)));
        assert_eq!((p.stage, p.percent), (UpdateStage::Done, 100.0));
    }

    #[test]
    fn an_installer_that_touches_nothing_is_capped_and_noted() {
        let mut m = UpdateProgressModel::new(1000.0);
        m.update(snap(1000.0, true, false, false, Some(1000.0)));
        let p = m.update(snap(1000.0 + 16000.0, true, false, false, Some(1000.0)));
        assert_eq!(p.note, Some(UpdateNote::WaitingInstaller));
        let p = m.update(snap(1000.0 + 600000.0, true, false, false, Some(1000.0)));
        assert!(p.percent <= 16.0 + 74.0 * 0.6 + 0.05);
    }

    #[test]
    fn close_hides_while_working_and_exits_when_finished() {
        assert_eq!(close_action(UpdateStage::Installing), CloseAction::Hide);
        assert_eq!(close_action(UpdateStage::Preparing), CloseAction::Hide);
        assert_eq!(close_action(UpdateStage::Done), CloseAction::Exit);
        assert_eq!(close_action(UpdateStage::Error), CloseAction::Exit);
    }
}
