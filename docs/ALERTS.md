# Status, alerts and AI accounts

## Status

Every cell, tab and project shows a live status: ◐ working, ● waiting for you.

A Claude cell whose agent started a dynamic workflow stays ◐ working while Claude Code waits for it (also when the workflow is quiet for hours). It turns ● waiting for you, with one alert, when Claude's next turn ends without a running workflow, or right away when the agent asks you something or the turn fails. A workflow that is never reported as ending turns the cell to waiting for you silently after 6 hours.

A turn that ends with a limit or an error is shown in red instead of "waiting for you": **limit reached** for a rate limit (Claude) or "You've hit your usage limit" (Codex), **error** for any other failure.

## Alerts

Claude and Codex cells raise a desktop notification and a sound for three events:

- **finished**: the agent ended its turn,
- **needs you**: a permission prompt or a question,
- **error**: the turn ended with an API error such as a rate limit, shown with a readable reason.

Click a notification to jump to the cell.

**Settings → Notifications and sounds** gives each event its own notification switch and sound: one of eight built-in synthesized presets (the default is a soft ding-dong), the system sound, your own file (wav, mp3, ogg, m4a, aac or flac, up to 5 MB) or off. There is also a volume slider, quiet hours (they may wrap past midnight) and a test button per event that plays exactly what would play.

Rules:

- Desktop notifications are always silent: the app plays the sound you chose, so you never hear a double ding.
- Alerts stay silent while you look at the cell in the active window, and never fire for restored sessions or a cell that merely went quiet.
- One alert per turn: minimizing and restoring the window, switching tabs or waking the computer never makes an agent that already reported alert again.
- **Mute alerts of this cell** in the cell menu silences one cell (its status is still shown).
- The saved alert settings take precedence over the notification and sound settings of earlier versions, which are only read when no alert settings exist yet.

## How Claude Code reports a turn

Claude cells get per-cell hooks through `--settings` (your own `settings.json` is never touched): prompt, Stop, StopFailure, Notification and SessionStart post to the app's local hook server with `curl`, and the tool hooks (PreToolUse, PostToolUse, SubagentStop) only say "still working" and run in the background (`async`, Claude Code 2.1 or newer; older builds run them synchronously), so no tool call waits for them. Every hook request bypasses a configured HTTP proxy (`--noproxy '*'`), the same as the Codex hook, so a corporate proxy cannot swallow the status.

## How Codex reports a turn

Codex cells are launched with a per-process `notify` hook (never written to your `config.toml`): when a turn completes, Codex calls `curl` against the app's local hook server. That gives an exact end of turn and the exact conversation id, so several Codex cells in one folder each resume their own conversation after a restart. It replaces a `notify` program you may have configured, for these cells only. If the hook never reports (an old Codex), the cell falls back to the activity heuristic.

A notify only starts a turn end: it counts once the cell has been quiet for about 2.5 s, so a sub-agent finishing mid-turn never raises a false "finished" alert or binds the wrong conversation. The conversation is stored after its first committed turn end and confirmed after the second.

The hook address (a per-run token plus a per-start nonce) is part of the launch command typed into the cell's shell, so it can appear in that shell's history. It only lets a local process fake status events of a cell and is useless after the app quits.

## Accounts & limits

The **Accounts & limits** panel shows the 5-hour and weekly limits of every Claude account the app knows and of Codex. Every account has exactly one card; the one signed in to Claude Code is marked **main**. Accounts are identified by their Anthropic account and organization ids, the e-mail is only a label.

- **Signed in somewhere else.** When another tool (for example cswap) or `claude /login` switches the Claude Code sign-in, the app notices it within about 20 seconds while the limits panel is on and the window is visible (otherwise at the next read of the limits): the new account gets its card (or is added), the account that left keeps its card with a note, and the app never renews a copy of a sign-in that another tool may hold. A second copy of the same account is set aside instead of shown twice, and nothing is deleted without asking.
- **Make main account** saves the current main sign-in on its card first and then writes the selected account into Claude Code, holding Claude Code's own lock files so neither Claude Code nor cswap can write at the same moment. Open Claude sessions normally pick up the new sign-in on their next message (a session that does not can be restarted or resumed).
- **Sign in again** on a saved card only renews the account of that card: if the browser signs in a different account, nothing is changed and you can add that account as a new one. On the **main** card it signs Claude Code in again: whichever account the browser signs in becomes the main account, and the previous main sign-in is saved on its card first.
- **Access denied (HTTP 403)**, for example a paused subscription, is shown as such; signing in again would not help.
- The limits of each account are read at most every 3 minutes, with the app's own client name, and a rate limit is always waited out (with a safety margin).
- The app never renews a copy of a sign-in that cswap also holds (every card cswap lists whose sign-in came from Claude Code, including cards created by 0.9.0 and accounts that were main before), because renewing it would invalidate cswap's copy. **Make main account** still works for such a card while its copy is fresh: only the files are moved, without contacting the sign-in server. When the copy would need renewing, the app says so: switch to that account with cswap, or sign in to it again here.
- **Renew this copy in unimux** on such a card (its menu, or the button under the cswap note) tells the app that the copy is its own sign-in, after a confirmation: from then on the app renews it itself. This is safe if you signed in to that account in unimux; a copy that came from Make main account in an older version may leave cswap without a working token for that account, and you sign in there once. Sign in again stays available on every card.

If a swap is interrupted, the app keeps an emergency copy, blocks further swaps and asks you to check both accounts. After you clear the warning, sign in again to any account that stopped working (a Claude sign-in is always possible again). When the app could not finish the recovery itself and the swap may already have written the new sign-in, clearing the warning marks the outgoing account as switched out, and its card keeps its own saved sign-in: the app does not copy the Claude Code sign-in onto it until that sign-in changes or you sign in to the card again.

Not available on macOS, where Claude keeps its login in the Keychain (saved accounts cannot be added there either).

**Settings → Accounts & limits** holds everything about the panel: whether it is shown and how often it refreshes, the **account switcher** (the **Switcher** switch in the panel header turns it on and off, and the line under the header, or a right click on the switch, opens its card with the mode, the target and primary account, both thresholds and returning home; here are its 5-hour and 7-day thresholds, the mode, the target and primary account, returning home and the pause between switches) and the **limit warnings** (a notification at a chosen share of the 5-hour or 7-day limit, and optionally when the limit is available again). Every threshold is a slider from 1 to 100 %: drag it, or use the arrow keys (1 %) and Page Up / Page Down (10 %). The limit warnings are notifications, so the main switch and the quiet hours of Notifications and sounds still apply to them; the switcher is not silenced by them.
