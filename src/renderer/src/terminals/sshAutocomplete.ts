// Termius-like command autocomplete for SSH terminals: the renderer side. Every SSH terminal gets a CommandLineFollower
// (shared/commandFollower.ts: the line, the popup's keys, what is recorded) wired to xterm's events; this module keeps the
// per-host history cache (main stores it, src/main/ssh/commandHistory.ts), offers the snippets, and hands the popup's state
// and the terminal's geometry to components/ssh/SshAutocomplete.tsx.
import type { IDisposable, Terminal } from '@xterm/xterm';
import { atBottom } from '../../../shared/commandLine';
import { CommandLineFollower, type AutocompleteView } from '../../../shared/commandFollower';
import { COMMAND_HISTORY_LIMITS, frecency, recordCommand, type CommandHistoryEntry } from '../../../shared/commandHistory';
import type { SuggestSource } from '../../../shared/commandSuggest';
import { findCell } from '../../../shared/state';
import type { Snippet } from '../../../shared/types';
import { getS, useStore } from '../store';
import { terminals, type RemoteAddon } from './TerminalManager';

export type { AutocompleteView };

/** Snippets rank like a command run a few times this week. */
const SNIPPET_WEIGHT = 3;

const enabled = (): boolean => getS().settings.sshAutocomplete !== false;

/** Where the terminal's character grid is on screen (client pixels) and the font it is drawn with. */
export interface TerminalGeometry { left: number; top: number; cellWidth: number; cellHeight: number; fontFamily: string; fontSize: number }

const addons = new Map<string, SshTerminalAddon>();
const listeners = new Map<string, Set<() => void>>();

export function subscribeAutocomplete(cellId: string, listener: () => void): () => void {
  let set = listeners.get(cellId);
  if (!set) listeners.set(cellId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(cellId);
  };
}

export const autocompleteView = (cellId: string): AutocompleteView | null => addons.get(cellId)?.follower.view ?? null;
export const terminalGeometry = (cellId: string): TerminalGeometry | null => addons.get(cellId)?.geometry() ?? null;

/** A click on a suggestion: inserted like Enter on it, and the terminal keeps the keyboard. */
export function acceptSuggestion(cellId: string, index: number): void {
  const addon = addons.get(cellId);
  addon?.follower.accept(index);
  addon?.focus();
}

// ── the history cache (one per host, shared by its cells) ────────────────────

interface HostHistory {
  entries: CommandHistoryEntry[];
  version: number;
  /** Runs recorded while the stored list is on its way (applied on top of it); null once loaded. */
  pending: Array<{ command: string; at: number }> | null;
}

const histories = new Map<string, HostHistory>();

function historyOf(hostId: string): HostHistory {
  const known = histories.get(hostId);
  if (known) return known;
  const h: HostHistory = { entries: [], version: 0, pending: [] };
  histories.set(hostId, h);
  void window.mc.sshHistory.list(hostId).then((entries) => {
    if (histories.get(hostId) !== h) return;
    let merged = Array.isArray(entries) ? entries : [];
    for (const run of h.pending ?? []) merged = recordCommand(merged, run.command, run.at);
    h.entries = merged;
    h.pending = null;
    h.version++;
    for (const a of addons.values()) a.follower.refresh();
  }, () => { h.pending = null; });
  return h;
}

function remember(hostId: string, command: string): void {
  const h = historyOf(hostId);
  const at = Date.now();
  const next = recordCommand(h.entries, command, at);
  if (next === h.entries) return;
  h.entries = next;
  h.pending?.push({ command, at });
  h.version++;
  window.mc.sshHistory.record(hostId, command);
}

/** Drops the cached history after it was cleared in main (null: every host's). */
export function forgetHistory(hostId: string | null): void {
  if (hostId === null) histories.clear();
  else histories.delete(hostId);
  for (const a of addons.values()) a.follower.refresh();
}

/** One-line snippets of the cell's project (and the global ones): what the popup offers next to the history. */
function snippetSources(snippets: readonly Snippet[], projectId: string | undefined): SuggestSource[] {
  const out: SuggestSource[] = [];
  for (const sn of snippets) {
    if (sn.projectId && sn.projectId !== projectId) continue;
    const text = sn.text.trim();
    if (!text || /[\r\n]/.test(text) || text.length > COMMAND_HISTORY_LIMITS.command) continue;
    out.push({ text, kind: 'snippet', weight: SNIPPET_WEIGHT, label: sn.name });
  }
  return out;
}

let sourceMemo: { key: unknown[]; sources: SuggestSource[] } | null = null;

function sourcesFor(hostId: string, projectId: string | undefined): SuggestSource[] {
  const h = historyOf(hostId);
  const snippets = getS().snippets;
  const key = [h, h.version, snippets, projectId];
  if (sourceMemo && key.every((k, i) => k === sourceMemo!.key[i])) return sourceMemo.sources;
  const now = Date.now();
  const sources: SuggestSource[] = [
    ...h.entries.map((e): SuggestSource => ({ text: e.command, kind: 'history', weight: frecency(e, now) })),
    ...snippetSources(snippets, projectId),
  ];
  sourceMemo = { key, sources };
  return sources;
}

/** The add-on of one SSH terminal (TerminalManager.setRemoteAddon): xterm's events into the follower, its popup out. */
class SshTerminalAddon implements RemoteAddon {
  readonly follower: CommandLineFollower;
  private readonly disposables: IDisposable[];

  constructor(private readonly cellId: string, private readonly term: Terminal) {
    addons.get(cellId)?.dispose();
    addons.set(cellId, this);
    const follower = (this.follower = new CommandLineFollower(term, {
      hostId: () => findCell(getS(), cellId)?.cell.ssh?.hostId ?? null,
      enabled,
      shown: () => {
        const el = term.element;
        return !!el?.isConnected && el.offsetParent !== null && document.activeElement === term.textarea;
      },
      sources: (hostId) => sourcesFor(hostId, findCell(getS(), cellId)?.project.id),
      lastCommand: (hostId) => historyOf(hostId).entries[0]?.command,
      remember,
      publish: () => listeners.get(cellId)?.forEach((l) => l()),
      now: () => performance.now(),
    }));
    const blur = () => follower.close();
    term.textarea?.addEventListener('blur', blur);
    this.disposables = [
      term.onData((d) => follower.input(d)),
      // The line is read once a write is parsed, never in the middle of one (a completion listing scrolls before the prompt
      // is drawn again); scrolling back and switching to the alternate screen only hide the popup.
      term.onWriteParsed(() => follower.parsed()),
      term.onScroll(() => { if (!atBottom(term.buffer.active)) follower.close(); }),
      term.onResize(() => follower.refresh()),
      term.buffer.onBufferChange(() => follower.close()),
      term.parser.registerOscHandler(133, (payload) => { follower.promptMark(payload); return false; }),
      { dispose: () => term.textarea?.removeEventListener('blur', blur) },
    ];
  }

  key(ev: KeyboardEvent): boolean {
    if (ev.type !== 'keydown' || !this.follower.key(ev)) return true;
    ev.preventDefault();
    ev.stopPropagation();
    return false;
  }

  focus(): void {
    this.term.focus();
  }

  geometry(): TerminalGeometry | null {
    const rect = this.term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return null;
    return {
      left: rect.left, top: rect.top, cellWidth: rect.width / this.term.cols, cellHeight: rect.height / this.term.rows,
      fontFamily: this.term.options.fontFamily ?? 'monospace', fontSize: this.term.options.fontSize ?? 13,
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.follower.dispose();
    if (addons.get(this.cellId) === this) addons.delete(this.cellId);
  }
}

terminals.setRemoteAddon((cellId, term) => new SshTerminalAddon(cellId, term));

// Turned off in Settings: open popups close at once (the next keystroke resets every line).
useStore.subscribe((st, prev) => {
  if (st.s.settings.sshAutocomplete !== prev.s.settings.sshAutocomplete) for (const a of addons.values()) a.follower.refresh();
});
