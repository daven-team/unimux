// "Wyślij prompt do wielu agentów" (1.1.1): one prompt to the checked Claude Code and Codex cells of every grid and window. Only an
// agent idle at its prompt gets it now; a busy one is skipped with the reason, or its prompt goes to the cell's prompt queue.
// shared/agentPrompt.ts decides, renderer/agentPrompt.ts asks the windows (the states shown here are probed every second).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  agentTargets, initialSelection, planCounts, quickSelect, summarizeOutcomes, targetAction, TARGET_STATE_LABEL,
  type AgentPromptOutcome, type QuickSelection, type TargetState,
} from '../../../shared/agentPrompt';
import { cellLabel } from '../../../shared/agentWork';
import { cellOwners } from '../../../shared/detached';
import { cellShell, shownProfileName } from '../../../shared/profiles';
import { hasSnippetVars } from '../../../shared/snippetVars';
import { getProfile } from '../../../shared/state';
import { pushHistory } from '../../../shared/ssh';
import type { AppState } from '../../../shared/types';
import { requestAgentPrompt } from '../agentPrompt';
import { useI18n } from '../i18n';
import { fillSnippetForCells } from '../snippetSend';
import { closeModal, getS, getUi, toast, useStore } from '../store';
import { IX } from './icons';
import { ProviderIcon } from './ProviderIcons';
import './agentPrompt.css';

/** Kept while the app runs: the last prompts (Up in an empty box recalls them) and the queue option. */
let history: string[] = [];
let queueBusyPref = true;
const PROBE_MS = 1000;

/** Until the first probe answers: a guess from the status this window knows (the detached windows report theirs). */
function guessState(cellId: string): TargetState {
  const status = getUi().statuses[cellId];
  if (status === 'working') return 'working';
  if (status === 'exited') return 'exited';
  return status === undefined ? 'notStarted' : 'ready';
}

export function AgentPromptDialog({ tabId }: { tabId?: string }) {
  const { tr } = useI18n();
  const projects = useStore((st) => st.s.projects);
  const profiles = useStore((st) => st.s.profiles);
  const settings = useStore((st) => st.s.settings);
  const detachedWindows = useStore((st) => st.s.detachedWindows);
  const sessionTitles = useStore((st) => st.ui.sessionTitles);
  const targets = useMemo(() => agentTargets({ projects, profiles }), [projects, profiles]);
  const owners = useMemo(() => cellOwners({ projects, detachedWindows }), [projects, detachedWindows]);
  const [checked, setChecked] = useState<Set<string>>(() => initialSelection(agentTargets(getS()), tabId));
  const [text, setText] = useState('');
  const [queueBusy, setQueueBusy] = useState(queueBusyPref);
  const [fillVars, setFillVars] = useState(true);
  const [states, setStates] = useState<Record<string, TargetState>>({});
  const [sending, setSending] = useState(false);
  const [recall, setRecall] = useState<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const targetIds = targets.map((t) => t.cellId).join(',');

  // The states come from the window that holds each cell (a detached grid's cells too), refreshed while the dialog is open.
  useEffect(() => {
    let alive = true;
    const ids = targetIds ? targetIds.split(',') : [];
    const probe = async () => {
      if (!ids.length) return;
      const out = await requestAgentPrompt({ mode: 'probe', queueBusy: false, items: ids.map((cellId) => ({ cellId, text: textRef.current })) });
      if (!alive) return;
      setStates((prev) => {
        const next: Record<string, TargetState> = {};
        for (const id of ids) next[id] = out[id]?.state ?? prev[id] ?? 'unreachable';
        return ids.every((id) => prev[id] === next[id]) && Object.keys(prev).length === ids.length ? prev : next;
      });
    };
    void probe();
    const timer = window.setInterval(() => void probe(), PROBE_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [targetIds]);

  const stateOf = (cellId: string): TargetState => states[cellId] ?? guessState(cellId);
  const shownStates = Object.fromEntries(targets.map((t) => [t.cellId, stateOf(t.cellId)]));
  const ordered = targets.filter((t) => checked.has(t.cellId)).map((t) => t.cellId);
  const plan = planCounts(ordered, shownStates, queueBusy);
  const usesVars = hasSnippetVars(text);

  const labelOf = (cellId: string): string => {
    const s = getS();
    for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) {
      if (c.id === cellId) return cellLabel(c, getUi().sessionTitles, shownProfileName(getProfile(s, c.profileId), cellShell(c, s.settings.shell), tr));
    }
    return cellId;
  };

  const pick = (kind: QuickSelection) => setChecked((cur) => quickSelect(kind, targets, cur, shownStates, tabId ?? activeTabId(getS())));

  const send = async () => {
    if (sending || !text.trim() || !ordered.length) return;
    let texts: Map<string, string> | null = null;
    if (fillVars && usesVars) {
      texts = await fillSnippetForCells({ id: 'agent-prompt', name: tr('Prompt'), text, autoSend: true }, ordered);
      if (!texts) return;
    }
    setSending(true);
    const items = ordered.map((cellId) => ({ cellId, text: texts?.get(cellId) ?? text })).filter((i) => i.text.trim());
    const out = await requestAgentPrompt({ mode: 'send', queueBusy, items });
    for (const i of items) if (!out[i.cellId]) out[i.cellId] = { state: 'unreachable', result: 'skipped' };
    history = pushHistory(history, text);
    queueBusyPref = queueBusy;
    closeModal();
    toast(summaryText(out, labelOf, tr), summarizeOutcomes(out).sent + summarizeOutcomes(out).queued ? 'info' : 'error');
  };

  const toggle = (cellId: string, on: boolean) => setChecked((cur) => { const n = new Set(cur); if (on) n.add(cellId); else n.delete(cellId); return n; });

  return (
    <div className="modal agent-prompt" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head"><h3>{tr('Wyślij prompt do wielu agentów')}</h3><button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={closeModal}><IX /></button></div>
      <div className="modal-body">
        {!targets.length ? <p className="muted">{tr('Żaden grid nie ma komórki Claude ani Codex.')}</p> : <>
          <textarea ref={area} className="input agent-prompt-text" rows={5} autoFocus spellCheck={false} value={text}
            placeholder={tr('Prompt (Enter: nowa linia, Ctrl+Enter: wyślij)')}
            onChange={(e) => { setText(e.target.value); setRecall(null); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
              if (e.key === 'ArrowUp' && (!text || recall !== null) && history.length) {
                e.preventDefault();
                const i = recall === null ? history.length - 1 : Math.max(0, recall - 1);
                setRecall(i); setText(history[i]);
              }
              if (e.key === 'Escape') closeModal();
            }} />
          <div className="agent-prompt-options">
            <label className="check"><input type="checkbox" checked={queueBusy} onChange={(e) => setQueueBusy(e.target.checked)} /> {tr('Zajętym agentom dodaj prompt do ich kolejki')}</label>
            {usesVars && <label className="check"><input type="checkbox" checked={fillVars} onChange={(e) => setFillVars(e.target.checked)} /> {tr('Wypełnij zmienne {{...}} przed wysłaniem')}</label>}
          </div>
          <div className="agent-prompt-quick">
            <button className="btn small ghost" onClick={() => pick('grid')}>{tr('Agenci tego gridu')}</button>
            <button className="btn small ghost" onClick={() => pick('all')}>{tr('Agenci wszystkich gridów')}</button>
            <button className="btn small ghost" onClick={() => pick('idle')}>{tr('Tylko wolni')}</button>
            <button className="btn small ghost" onClick={() => pick('none')}>{tr('Odznacz wszystkie')}</button>
          </div>
          <ul className="agent-prompt-targets">
            {targets.map((t) => {
              const project = projects.find((p) => p.id === t.projectId);
              const tab = project?.tabs.find((g) => g.id === t.tabId);
              const cell = tab?.cells.find((c) => c.id === t.cellId);
              if (!project || !tab || !cell) return null;
              const state = stateOf(t.cellId);
              const action = targetAction(state, queueBusy);
              const on = checked.has(t.cellId);
              const label = cellLabel(cell, sessionTitles, shownProfileName(getProfile({ profiles } as AppState, cell.profileId), cellShell(cell, settings.shell), tr));
              return (
                <li key={t.cellId} className={`agent-prompt-row ${on ? `will-${action}` : 'off'}`}>
                  <label className="check">
                    <input type="checkbox" checked={on} onChange={(e) => toggle(t.cellId, e.target.checked)} />
                    <span className="agent-prompt-icon"><ProviderIcon provider={t.cli} size={14} /></span>
                    <span className="agent-prompt-name">{label}</span>
                    <span className="agent-prompt-place">{tab.name} · {project.name}{owners.has(t.cellId) ? ` · ${tr('osobne okno')}` : ''}</span>
                  </label>
                  <span className={`agent-prompt-state st-${state}`}>{tr(TARGET_STATE_LABEL[state])}</span>
                  <span className="agent-prompt-action">{on ? tr(action === 'send' ? 'wyśle teraz' : action === 'queue' ? 'do kolejki' : 'pominie') : ''}</span>
                </li>
              );
            })}
          </ul>
        </>}
      </div>
      <div className="modal-foot">
        <span className="agent-prompt-plan">{tr('Teraz: {send} · do kolejki: {queue} · pominięte: {skip}', { send: plan.send, queue: plan.queue, skip: plan.skip })}</span>
        <button className="btn" onClick={closeModal}>{tr('Zamknij')}</button>
        <button className="btn white" disabled={sending || !text.trim() || !plan.send && !plan.queue} onClick={() => void send()}>
          {queueBusy ? tr('Wyślij teraz do wolnych, resztę dodaj do kolejki') : tr('Wyślij do wolnych ({count})', { count: plan.send })}
        </button>
      </div>
    </div>
  );
}

function activeTabId(s: AppState): string | undefined {
  const p = s.projects.find((x) => x.id === s.activeProjectId);
  return p?.activeTabId ?? undefined;
}

/** "Wysłano do 3, w kolejce 1, pominięto 1", and which cells were skipped and why (the first three). */
function summaryText(out: Record<string, AgentPromptOutcome>, labelOf: (cellId: string) => string, tr: ReturnType<typeof useI18n>['tr']): string {
  const sum = summarizeOutcomes(out);
  const head = tr('Wysłano do {sent}, w kolejce {queued}, pominięto {skipped}', sum);
  const skipped = Object.entries(out).filter(([, o]) => o.result !== 'sent' && o.result !== 'queued');
  if (!skipped.length) return head;
  const list = skipped.slice(0, 3).map(([id, o]) => `${labelOf(id)} (${tr(TARGET_STATE_LABEL[o.state])})`).join(', ');
  return `${head}: ${list}${skipped.length > 3 ? ', …' : ''}`;
}
