// Asking before closing a grid, a cell or the app while Claude or Codex agents are in the middle of a turn. Waiting-for-you and
// idle cells do not count. "Do not ask again" turns the setting off (Settings > App settings turns it back on).
import { allCellIds, namesList, shouldConfirmClose, workingAgents } from '../../shared/agentWork';
import { updateSettings } from '../../shared/state';
import { tr } from './i18n';
import { askChoiceChecked, getS, getUi, update, useStore } from './store';

export type CloseKind = 'tab' | 'cell' | 'app';

const TITLES = {
  tab: 'Zamknąć zakładkę, w której pracują agenci?',
  cell: 'Zamknąć pracującego agenta?',
  app: 'Zamknąć aplikację, gdy agenci pracują?',
} as const;

/** Resolves true when closing may go on: nothing affected is working, the setting is off, or the user chose "Close anyway". */
export async function confirmCloseWorking(cellIds: Iterable<string>, kind: CloseKind): Promise<boolean> {
  const s = getS();
  const ui = getUi();
  const working = workingAgents(s, cellIds, ui.statuses, ui.sessionTitles);
  if (!shouldConfirmClose(s, working)) return true;
  const body = tr('Pracujący agenci ({count}): {names}. Ich bieżąca tura zostanie przerwana.', {
    count: working.length, names: namesList(working.map((w) => w.label)),
  });
  const { value, checked } = await askChoiceChecked(tr(TITLES[kind]), body, [
    { label: tr('Zamknij mimo to'), value: 'close', danger: true },
  ], tr('Nie pytaj ponownie'));
  if (value !== 'close') return false;
  if (checked) update((st) => updateSettings(st, { confirmCloseWorking: false }));
  return true;
}

/**
 * Tells main whether quitting must ask first (some agent works and the setting is on), so a quit with nothing to ask about never
 * waits for this window. Main then asks through 'app:confirm-quit'.
 */
export function initQuitGuard(): void {
  let last: boolean | undefined;
  const push = (): void => {
    const { s, ui } = useStore.getState();
    const guard = shouldConfirmClose(s, workingAgents(s, allCellIds(s), ui.statuses, ui.sessionTitles));
    if (guard === last) return;
    last = guard;
    window.mc.setQuitGuard(guard);
  };
  push();
  useStore.subscribe((st, prev) => {
    if (st.ui.statuses !== prev.ui.statuses || st.s.projects !== prev.s.projects || st.s.settings !== prev.s.settings || st.s.profiles !== prev.s.profiles) push();
  });
  let asking = false;
  window.mc.on('app:confirm-quit', () => {
    if (asking) { window.mc.answerQuit('asking'); return; }
    asking = true;
    window.mc.answerQuit('asking');
    void confirmCloseWorking(allCellIds(getS()), 'app')
      .catch(() => true)
      .then((go) => { asking = false; window.mc.answerQuit(go ? 'quit' : 'cancel'); });
  });
}
