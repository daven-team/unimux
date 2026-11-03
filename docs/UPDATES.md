# Updating

An update is never installed without your click. Development builds do not install updates.

To check manually, right-click the **unimux** name/version and choose **Check for updates**. If checking or downloading fails, the header offers a retry and shows the error.

Agent conversations are restored after an update through their CLI resume support; a turn in progress is lost.

## Updating while work is in progress

When you start an update from the status bar while something is in progress, unimux first lists what would be interrupted, grouped and with the cell names, across the main window and the detached windows: agents in the middle of a turn, agents waiting for your answer, cells with queued prompts, files being saved, unsaved files, SFTP transfers, open database transactions, staged table edits and unsaved Redis values, an account switch or sign-in, and the MCP tasks of the agents involved. With nothing in progress the update starts as before.

- **Zaktualizuj, gdy skończą** (the default) waits until no agent works, the queues are sent, saves, transfers and the sign-in have finished and transactions are committed or rolled back, then starts the update by itself (after a few quiet seconds). You can keep working and sending prompts meanwhile; a new turn holds the update again. The status bar shows **Aktualizacja po zakończeniu pracy agentów (N)**; a click says what it still waits for, the X stops waiting. An agent that waits for your answer holds the update for 3 minutes at most, and the wait gives up after 8 hours.
- **Zaktualizuj teraz** starts the update at once and cuts off the running turns, transfers and open transactions.
- Unsaved files and staged table edits are kept as drafts over the restart either way; paused prompt queues stay paused.

This question is always asked, also when **Pytaj przed zamknięciem pracujących agentów** is turned off: that setting is about closing a cell, a grid or the app, while an update restarts everything.

## Modes

**Settings → Updates** has two modes:

- **Manual** (the default): nothing happens at start. The app downloads updates in the background; the status bar shows **Version … available - Update** and, once it is downloaded, **Version … ready - Install**. Clicking either opens the update window, which finishes the download if needed, installs and starts the new version.
- **Automatic**: at start the app shows a short "Checking for updates" window only if the check is slow. When a new version exists it asks "Install now" or "Later" and starts downloading in the background while you decide, so "Install now" goes straight to the installer. "Later", the close button and Escape start the current version, and the status bar button installs the update afterwards.

If a newer release appears before the installer starts, the window follows the newest one; once the installer has started, that version finishes and the newer one is offered after the relaunch. With no update, no network or any error the app simply starts.

## Windows

The installed Windows app checks GitHub Releases through electron-updater.

## macOS

Squirrel.Mac (electron-updater) refuses updates that are only ad-hoc signed, so the macOS app has its own updater with the same two modes.

1. It reads `latest-mac.yml` from the latest GitHub release and downloads the `.zip` for your processor (Apple Silicon or Intel) into `~/Library/Application Support/unimux/updates/mac`.
2. It checks the size and SHA-512, unpacks the archive with `ditto` and verifies the bundle (version, bundle identifier, executable and `codesign --verify`).
3. After you click install, a small script waits until the app has quit, moves the old app aside, puts the new one in its place (restoring the old one if anything fails), removes the quarantine flag and starts the new version.

The log is `updates/mac/update.log`.

The app only replaces itself when it runs from a normal, writable `.app` that belongs to you (for example in **Applications**). From the mounted DMG, a translocated (quarantined) copy, a read-only or administrator-owned location, or when macOS denies the **App Management** permission, the status bar offers the download page instead and the tooltip says why.

The first update to a macOS version that contains this updater is still manual (older versions cannot do it), and the updater has not yet been validated on a real Mac.
