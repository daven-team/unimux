// Ctrl+Tab between recently used tabs of the strip (1.1.1). The tab in front is recorded on every change (newest first);
// Ctrl+Tab picks the previous one, more Tabs with Ctrl held walk further, Shift walks back, and releasing Ctrl switches. A
// quick tap toggles between the last two tabs; held a moment longer, a switcher with the tabs shows (TabSwitcher.tsx).
// The keys are the shortcuts 'tab.next' / 'tab.prev' (shared/shortcuts.ts), so they can be changed in Settings.
import { create } from 'zustand';
import { mruOrder, stepIndex, switchHeld, touchMru, type HeldModifiers } from '../../shared/tabMru';
import { useFileStore } from './files';
import { useSshStore } from './sshStore';
import { useStore } from './store';
import { activateWorkspaceKey, currentStrip, frontKey } from './workspaceStrip';

/** A tap shorter than this switches without showing the list. */
export const SWITCHER_DELAY_MS = 180;

interface SwitcherState {
  /** A switch is running (the modifier is held). */
  active: boolean;
  /** The list shows (after SWITCHER_DELAY_MS). */
  visible: boolean;
  order: string[];
  index: number;
}

export const useTabSwitcher = create<SwitcherState>(() => ({ active: false, visible: false, order: [], index: 0 }));

let mru: string[] = [];
let held: HeldModifiers = { ctrl: false, alt: false, shift: false, meta: false };
let showTimer: number | null = null;
let tracking = false;

/** The tabs newest first (tests and the CDP checks read it). */
export const recentTabs = (): readonly string[] => mru;

const record = () => { mru = touchMru(mru, frontKey()); };

/** Starts recording the tab in front (once per window). */
export function startTabTracking(): () => void {
  if (tracking) return () => undefined;
  tracking = true;
  record();
  const unsubs = [useStore.subscribe(record), useFileStore.subscribe(record), useSshStore.subscribe(record)];
  return () => { tracking = false; unsubs.forEach((u) => u()); };
}

function reset(): void {
  if (showTimer !== null) { window.clearTimeout(showTimer); showTimer = null; }
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', cancelTabSwitch);
  useTabSwitcher.setState({ active: false, visible: false, order: [], index: 0 });
}

/** Switches to the tab the switcher points at (or `key`, a click in the list). */
export function commitTabSwitch(key?: string): void {
  const st = useTabSwitcher.getState();
  if (!st.active) return;
  const target = key ?? st.order[st.index];
  reset();
  if (target && target !== frontKey()) activateWorkspaceKey(target);
}

export function cancelTabSwitch(): void {
  if (useTabSwitcher.getState().active) reset();
}

/**
 * One press of 'tab.next' (dir 1) or 'tab.prev' (dir -1); `keys` is the key press that fired it. A shortcut without Ctrl, Alt
 * or Cmd (an F-key) cannot be held, so it switches at once.
 */
export function stepTabSwitch(dir: 1 | -1, keys: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): void {
  const st = useTabSwitcher.getState();
  if (st.active) {
    useTabSwitcher.setState({ index: stepIndex(st.order.length, st.index, dir) });
    return;
  }
  const { shown, active } = currentStrip();
  const order = mruOrder(mru, shown, active);
  // With the SSH view in front no tab of the strip is: the first step goes to the most recent tab itself.
  const base = active && order[0] === active ? 1 : 0;
  if (order.length <= base) return;
  const first = dir === 1 ? base % order.length : order.length - 1;
  held = { ctrl: keys.ctrlKey, alt: keys.altKey, shift: keys.shiftKey, meta: keys.metaKey };
  if (!held.ctrl && !held.alt && !held.meta) {
    const target = order[first];
    if (target && target !== active) activateWorkspaceKey(target);
    return;
  }
  useTabSwitcher.setState({ active: true, visible: false, order, index: first });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', cancelTabSwitch);
  showTimer = window.setTimeout(() => { showTimer = null; if (useTabSwitcher.getState().active) useTabSwitcher.setState({ visible: true }); }, SWITCHER_DELAY_MS);
}

const MODIFIER = /^(Control|Shift|Alt|Meta|OS|AltGraph)$/;

/**
 * Keys while the switcher runs: the arrows move, Enter switches, Esc cancels. The shortcut itself (Tab) is the dispatcher's
 * (renderer/shortcuts.ts calls stepTabSwitch); any other key ends the switch without switching and goes where it would.
 */
function onKeyDown(e: KeyboardEvent): void {
  if (!useTabSwitcher.getState().active || MODIFIER.test(e.key)) return;
  if (e.key === 'Tab') return;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'Escape') { stop(); cancelTabSwitch(); return; }
  if (e.key === 'Enter') { stop(); commitTabSwitch(); return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    stop();
    const st = useTabSwitcher.getState();
    useTabSwitcher.setState({ index: stepIndex(st.order.length, st.index, e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1), visible: true });
    return;
  }
  cancelTabSwitch();
}

function onKeyUp(e: KeyboardEvent): void {
  if (!useTabSwitcher.getState().active) return;
  if (!switchHeld(held, e)) { e.preventDefault(); e.stopPropagation(); commitTabSwitch(); }
}
