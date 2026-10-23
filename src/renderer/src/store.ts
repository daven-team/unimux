import { create } from 'zustand';
import { defaultState } from '../../shared/state';
import type { CellStatus } from '../../shared/status';
import type { AppState } from '../../shared/types';
import type { StateSnapshot } from '../../shared/stateEdits';
import type { StateChange } from '../../shared/statePatch';
import { StateSync } from '../../shared/stateSync';
import { shareStructure } from '../../shared/structuralShare';
import { patchChanges } from '../../shared/renderEquality';
import type { McpInfo } from '../../shared/automation';
import type { LoginTarget } from '../../shared/accounts';
import type { CliId, CliStatusMap } from '../../shared/cliStatus';
import type { DbKind } from '../../shared/db';

export type Modal =
  | { kind: 'grid'; projectId: string }
  | { kind: 'history'; projectId: string }
  | { kind: 'changelog' }
  | { kind: 'search'; projectId: string }
  | { kind: 'snippet'; snippetId: string | null; projectId?: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'file'; projectId: string; relativePath: string }
  | { kind: 'auth'; provider: 'claude' | 'codex'; target: LoginTarget }
  | { kind: 'broadcast'; projectId: string; tabId: string }
  | { kind: 'dbConnection'; connectionId?: string; dbKind?: DbKind };

export type Dialog = { id: number } & (
  | { kind: 'prompt'; title: string; value: string; placeholder?: string; onSubmit: (value: string) => void }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      actions: Array<{ label: string; value: string; danger?: boolean; primary?: boolean }>;
      /** A checkbox under the text (for example "do not ask again"); its state comes with the choice. */
      check?: string;
      onChoose: (value: string | null, checked?: boolean) => void;
    });

export interface Ui {
  statuses: Record<string, CellStatus>;
  /** Cells whose last turn failed (waiting with reason error) and why: a StopFailure code or 'usage-limit'. */
  failures: Record<string, string>;
  focusedCellId: string | null;
  maximizedCellId: string | null;
  palette: boolean;
  modal: Modal | null;
  dialog: Dialog | null;
  toast: { text: string; kind: 'info' | 'error' } | null;
  cellErrors: Record<string, string>;
  missingPaths: Record<string, true>;
  /** Conversation titles by session id (from Claude/Codex transcripts) - default cell labels. */
  sessionTitles: Record<string, string>;
  /** Bumped when every terminal must be (re)started, e.g. after a pty host crash. */
  epoch: number;
  /** Id of the panel chosen in the left rail (see panelRegistry.tsx); an unknown or unavailable id shows the default panel. */
  sidebarView: string;
  automationOpen: boolean;
  settingsTabOpen: boolean;
  settingsActive: boolean;
  mcpInfo: McpInfo;
  /** Detected Claude Code / Codex binaries; a missing entry means "not checked yet" (never blocks a start). */
  cliStatus: CliStatusMap;
  /** The install window of a missing CLI; it sits above every modal. `locked` = an install runs (it cannot be dismissed by accident). */
  install: { cli: CliId; locked: boolean } | null;
  /** Cells whose start was skipped because their CLI is not installed (they show the install card and start by themselves once it is found). */
  heldCells: Record<string, true>;
  /** Progress of the background loader while it still has cells to start (null otherwise). */
  backgroundLoad: { done: number; total: number; capped: boolean } | null;
}

interface Store {
  s: AppState;
  ui: Ui;
  ready: boolean;
  update(fn: (s: AppState) => AppState): void;
  setUi(patch: Partial<Ui> | ((ui: Ui) => Partial<Ui>)): void;
  init(snapshot: StateSnapshot): void;
  /** Main's change (a patch): applied, or kept while a full state is being fetched; a change that does not follow ours starts that fetch. */
  applyChange(change: StateChange): void;
  /** Fetches the full state of main again. */
  resync(): Promise<void>;
}

/**
 * A detached window (1.0.6) shows its own tab as the active project and grid (shared/detached.ts viewOverlay); the main
 * window shows the state as it is. Set once before the first state arrives.
 */
let overlay: ((s: AppState) => AppState) | null = null;
export function setStateOverlay(fn: (s: AppState) => AppState): void { overlay = fn; }
const view = (s: AppState): AppState => (overlay ? overlay(s) : s);

const sync = new StateSync({ state: defaultState(window.mc.platform), revision: -1 }, {
  transport: { applyEdit: (edit) => window.mc.applyStateEdit(edit), loadSnapshot: () => window.mc.loadSnapshot() },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  // Main's echo of an edit (and an ack) rebuilds objects the screen already shows: unchanged parts keep their identity,
  // and a state equal to the shown one changes nothing, so components re-render only for what really changed.
  onState: (s) => {
    const shown = useStore.getState().s;
    const next = shareStructure(shown, view(s));
    if (next !== shown) useStore.setState({ s: next });
  },
  onError: (error) => toast(String(error), 'error'),
});

export const useStore = create<Store>((set, get) => ({
  s: defaultState(window.mc.platform),
  ui: {
    statuses: {},
    failures: {},
    focusedCellId: null,
    maximizedCellId: null,
    palette: false,
    modal: null,
    dialog: null,
    toast: null,
    cellErrors: {},
    missingPaths: {},
    sessionTitles: {},
    epoch: 0,
    sidebarView: 'projects',
    automationOpen: false,
    settingsTabOpen: false,
    settingsActive: false,
    mcpInfo: { running: false },
    cliStatus: {},
    install: null,
    heldCells: {},
    backgroundLoad: null,
  },
  ready: false,
  update(fn) {
    const base = get().s;
    const next = fn(base);
    if (next === base) return;
    const edit = { id: crypto.randomUUID(), base, next };
    set({ s: next });
    // Only what changed goes over the wire; the new state comes back as the patch of `state:changed`, the answer just acknowledges.
    sync.submit(edit);
  },
  setUi(patch) {
    const ui = get().ui;
    const changes = typeof patch === 'function' ? patch(ui) : patch;
    // A patch that changes nothing (focusing the focused cell on every click) does not notify the listeners.
    if (!patchChanges(ui, changes)) return;
    set((st) => ({ ui: { ...st.ui, ...changes } }));
  },
  init(snapshot) {
    set({ s: view(sync.init(snapshot)), ready: true });
  },
  applyChange(change) { sync.receive(change); },
  resync() { return sync.resync(); },
}));

export const getS = () => useStore.getState().s;
export const getUi = () => useStore.getState().ui;
export const update = (fn: (s: AppState) => AppState) => useStore.getState().update(fn);
export const setUi = (patch: Partial<Ui> | ((ui: Ui) => Partial<Ui>)) => useStore.getState().setUi(patch);

let toastTimer: number | undefined;
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  setUi({ toast: { text, kind } });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setUi({ toast: null }), kind === 'error' ? 6000 : 3000);
}

let dialogIds = 0;
/** A new dialog replaces an open one: the replaced one resolves as cancelled first, so no caller waits forever. */
function replaceOpenDialog(): number {
  const previous = pendingPrompt;
  pendingPrompt = null;
  previous?.(true);
  return ++dialogIds;
}

export function askText(title: string, value = '', placeholder?: string): Promise<string | null> {
  const id = replaceOpenDialog();
  return new Promise((resolve) => {
    setUi({
      dialog: {
        id, kind: 'prompt', title, value, placeholder,
        onSubmit: (v) => {
          pendingPrompt = null;
          setUi({ dialog: null });
          resolve(v);
        },
      },
    });
    // Closing the modal without submit resolves with null (see Modals).
    pendingPrompt = () => resolve(null);
  });
}

export function askChoice(
  title: string, body: string,
  actions: Array<{ label: string; value: string; danger?: boolean; primary?: boolean }>,
): Promise<string | null> {
  const id = replaceOpenDialog();
  return new Promise((resolve) => {
    setUi({
      dialog: {
        id, kind: 'confirm', title, body, actions,
        onChoose: (v) => {
          pendingPrompt = null;
          setUi({ dialog: null });
          resolve(v);
        },
      },
    });
    pendingPrompt = () => resolve(null);
  });
}

/** askChoice with a checkbox: resolves with the chosen value (null when cancelled) and whether the box was ticked. */
export function askChoiceChecked(
  title: string, body: string,
  actions: Array<{ label: string; value: string; danger?: boolean; primary?: boolean }>,
  check: string,
): Promise<{ value: string | null; checked: boolean; replaced?: true }> {
  const id = replaceOpenDialog();
  return new Promise((resolve) => {
    setUi({
      dialog: {
        id, kind: 'confirm', title, body, actions, check,
        onChoose: (value, checked) => {
          pendingPrompt = null;
          setUi({ dialog: null });
          resolve({ value, checked: checked === true });
        },
      },
    });
    pendingPrompt = (replaced) => resolve({ value: null, checked: false, ...(replaced ? { replaced: true } : {}) });
  });
}

/** Resolves the open dialog as cancelled; `replaced` when a newer dialog took its place (not the user's choice). */
let pendingPrompt: ((replaced?: boolean) => void) | null = null;
export function closeModal(): void {
  setUi({ modal: null });
}

export function closeDialog(): void {
  const p = pendingPrompt;
  pendingPrompt = null;
  setUi({ dialog: null });
  p?.();
}
