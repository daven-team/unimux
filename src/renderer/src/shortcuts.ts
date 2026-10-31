// App-wide shortcuts, handled in the capture phase so they win over the focused terminal. Which key does what comes from the
// registry in shared/shortcuts.ts (defaults plus the user's overrides in the settings); the decision itself is shared/shortcutDispatch.ts.
// Defaults avoid keys Claude/Codex use themselves (Ctrl+T, Ctrl+B, Ctrl+W, Alt+arrows ...).
import { useEffect } from 'react';
import { activeProject } from '../../shared/state';
import { decideShortcut } from '../../shared/shortcutDispatch';
import { displayCombo, matchShortcut, RepeatGuard, resolveShortcuts, shortcutDef, type ShortcutResolution } from '../../shared/shortcuts';
import { addAgent, moveCellBy, moveFocus, quickTab, toggleMaximize } from './actions';
import { closeFrontTab, cycleWorkspace, frontKey } from './workspaceStrip';
import { getS, getUi, setUi, update, useStore } from './store';
import { focusedTerminalCell, openTerminalFind } from './terminals/terminalFind';
import { captureSelectionToNote } from './notesUi';
import { openQueue } from './promptQueue';
import { openAgentPrompt } from './agentPrompt';
import { stepToWaiting } from './waiting';

let cached: { overrides: unknown; platform: string; resolution: ShortcutResolution } | null = null;

/** The combos in force (defaults plus overrides); recomputed only when the saved overrides change. */
export function currentShortcuts(): ShortcutResolution {
  const overrides = getS().settings.shortcuts;
  const platform = window.mc.platform;
  if (!cached || cached.overrides !== overrides || cached.platform !== platform) cached = { overrides, platform, resolution: resolveShortcuts(overrides, platform) };
  return cached.resolution;
}

/** Does this key press trigger the action `id` (for the shortcuts a component handles itself: file tree, editor, dialogs)? */
export function matchesShortcut(id: string, event: KeyboardEvent | React.KeyboardEvent): boolean {
  return matchShortcut(event, currentShortcuts(), id);
}

/** The key combination of an action as the user reads it ("Ctrl+Shift+E", "Cmd+K"), or '' when it is switched off. */
export function shortcutText(id: string): string {
  const combo = currentShortcuts().combos[id];
  if (combo) return displayCombo(combo, window.mc.platform);
  const fixed = shortcutDef(id)?.fixedText;
  return fixed ? fixed.replace(/\bMod\b/, window.mc.platform === 'darwin' ? 'Cmd' : 'Ctrl') : '';
}

/** `Title (Ctrl+K)`, or just the title when the shortcut is switched off. */
export function titleWithShortcut(title: string, id: string): string {
  const text = shortcutText(id);
  return text ? `${title} (${text})` : title;
}

/** For components that show a combo: re-renders them when the user changes a shortcut. */
export function useShortcutText(): (id: string) => string {
  useStore((st) => st.s.settings.shortcuts);
  return shortcutText;
}

let recording = false;
const repeats = new RepeatGuard();
/** While the Settings screen records a new combination the app's own shortcuts are off. */
export function setShortcutRecording(active: boolean): void {
  // The key that finished the recording may still be held: its auto-repeat must not fire the new action.
  if (recording && !active) repeats.arm();
  recording = active;
}

function focusTarget(target: EventTarget | null): 'terminal' | 'input' | 'other' {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return 'other';
  if (el.closest('.xterm')) return 'terminal';
  if (el.isContentEditable || el.closest('input, textarea, select, .cm-editor')) return 'input';
  return 'other';
}

function run(id: string): void {
  const project = activeProject(getS());
  switch (id) {
    case 'palette.open': case 'palette.openAlt': setUi((ui) => ({ palette: !ui.palette })); break;
    case 'terminal.new': quickTab(); break;
    case 'agent.add': void addAgent(getS().settings.lastProfileId); break;
    case 'grid.new': if (project) setUi({ modal: { kind: 'grid', projectId: project.id } }); break;
    case 'conversations.search': setUi((ui) => ({ modal: ui.modal?.kind === 'conversations' ? null : { kind: 'conversations' } })); break;
    case 'history.open': if (project) setUi({ modal: { kind: 'history', projectId: project.id } }); break;
    // The tab in front, whatever its kind: with a file or the SSH view in front this never closes the grid behind it.
    case 'tab.close': closeFrontTab(); break;
    case 'snippets.toggle': update((s) => ({ ...s, snippetsOpen: !s.snippetsOpen })); break;
    case 'notes.toggle': update((s) => ({ ...s, notesOpen: !s.notesOpen })); break;
    case 'notes.capture': captureSelectionToNote(); break;
    case 'sidebar.toggle': update((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed })); break;
    case 'cell.maximize': toggleMaximize(); break;
    case 'cell.queue': openQueue(); break;
    case 'agents.prompt': openAgentPrompt(); break;
    case 'terminal.find': { const cell = focusedTerminalCell(); if (cell) openTerminalFind(cell); break; }
    case 'tab.next': cycleWorkspace(1); break;
    case 'tab.prev': cycleWorkspace(-1); break;
    case 'cell.focus.left': moveFocus(-1, 0); break;
    case 'cell.focus.right': moveFocus(1, 0); break;
    case 'cell.focus.up': moveFocus(0, -1); break;
    case 'cell.focus.down': moveFocus(0, 1); break;
    case 'cell.move.left': moveCellBy(-1, 0); break;
    case 'cell.move.right': moveCellBy(1, 0); break;
    case 'cell.move.up': moveCellBy(0, -1); break;
    case 'cell.move.down': moveCellBy(0, 1); break;
    case 'waiting.next': stepToWaiting(1); break;
    case 'waiting.prev': stepToWaiting(-1); break;
  }
}

/** `only`: the actions this window offers (a detached window, 1.0.6); other combos are left to the page. */
export function useShortcuts(only?: ReadonlySet<string>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.type !== 'keydown') return;
      if (repeats.swallow(e)) { e.preventDefault(); e.stopPropagation(); return; }
      const s = getS();
      const ui = getUi();
      const project = activeProject(s);
      const id = decideShortcut(e, {
        resolution: currentShortcuts(), languageChosen: !!s.settings.language, recording,
        overlayOpen: !!(ui.dialog || ui.modal), paletteOpen: ui.palette, settingsActive: ui.settingsActive,
        hasProject: !!project, hasTab: !!frontKey(), target: focusTarget(e.target),
      });
      if (!id || (only && !only.has(id))) return;
      e.preventDefault();
      e.stopPropagation();
      run(id);
    };
    const onUp = (e: KeyboardEvent) => repeats.release(e);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onUp, true); };
  }, []);
}
