//! The background update checks of the running app (initUpdater of src/main/updater.ts): the first one 8 s after the start,
//! then one every 30 minutes, on Windows and macOS alike.

use std::future::Future;
use std::time::Duration;

/// When the first background check runs after the start.
pub const FIRST_CHECK: Duration = Duration::from_secs(8);
/// How often the running app looks for an update.
pub const CHECK_EVERY: Duration = Duration::from_secs(30 * 60);

/// Runs `check` after `first`, then every `every`. `check(true)` is the first one (the caller skips it when the startup gate
/// has just looked). A tick missed while the computer slept runs once, not once per missed period (1.1.4's setInterval).
/// Ends as soon as `check` answers false (the updater is gone).
pub async fn background_checks<F, Fut>(first: Duration, every: Duration, mut check: F)
where
    F: FnMut(bool) -> Fut,
    Fut: Future<Output = bool>,
{
    tokio::time::sleep(first).await;
    if !check(true).await {
        return;
    }
    let mut timer = tokio::time::interval(every);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    timer.tick().await;
    loop {
        timer.tick().await;
        if !check(false).await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parking_lot::Mutex;

    use super::*;

    /// test/mac-update-state.test.ts (and updater.test.ts) "checks in the background shortly after start and then periodically".
    #[tokio::test(start_paused = true)]
    async fn checks_shortly_after_the_start_and_then_every_half_hour_until_the_updater_is_gone() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let task = tokio::spawn(background_checks(FIRST_CHECK, CHECK_EVERY, move |first| {
            let seen = seen.clone();
            async move {
                seen.lock().push((tokio::time::Instant::now(), first));
                seen.lock().len() < 3
            }
        }));
        let start = tokio::time::Instant::now();
        tokio::time::sleep(Duration::from_millis(7_900)).await;
        assert!(calls.lock().is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(calls.lock().len(), 1);
        tokio::time::sleep(CHECK_EVERY).await;
        assert_eq!(calls.lock().len(), 2);
        tokio::time::sleep(CHECK_EVERY).await;
        task.await.unwrap();
        let calls = calls.lock().clone();
        assert_eq!(calls.iter().map(|(_, first)| *first).collect::<Vec<_>>(), [true, false, false]);
        assert_eq!(calls[0].0 - start, FIRST_CHECK);
        assert_eq!(calls[1].0 - calls[0].0, CHECK_EVERY);
        assert_eq!(calls[2].0 - calls[1].0, CHECK_EVERY);
    }
}
