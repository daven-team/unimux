// The renderer side of the close confirmation with a stubbed window (no DOM): a dialog that replaces another resolves the
// replaced one as cancelled, and the quit question never leaves main waiting on a dialog that is gone.
import { beforeAll, describe, expect, it, vi } from 'vitest';

let store: any;
let guard: any;
let sftpStore: any;
const answers: string[] = [];
const guards: boolean[] = [];
const handlers = new Map<string, (...args: unknown[]) => void>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      applyStateEdit: (edit: { id: string }) => Promise.resolve({ revision: 0, editId: edit.id }),
      loadSnapshot: () => new Promise(() => undefined),
      setQuitGuard: (ask: boolean) => { guards.push(ask); },
      answerQuit: (answer: string) => { answers.push(answer); },
      on: (channel: string, cb: (...args: unknown[]) => void) => { handlers.set(channel, cb); return () => undefined; },
    },
    setTimeout, clearTimeout,
  });
  // The renderer is not part of the node tsconfig: loaded through variables, so tsc does not follow the imports.
  const storePath = '../src/renderer/src/store';
  const guardPath = '../src/renderer/src/closeGuard';
  const sftpStorePath = '../src/renderer/src/sftpStore';
  store = await import(/* @vite-ignore */ storePath);
  guard = await import(/* @vite-ignore */ guardPath);
  sftpStore = await import(/* @vite-ignore */ sftpStorePath);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A state with one working Claude cell named "Reviewer". */
function workingState() {
  const s = store.getS();
  const project = {
    id: 'p1', name: 'Project X', path: '/x', activeTabId: 't1', archive: [],
    tabs: [{ id: 't1', name: 'Main', layout: { cols: 1, rows: 1 }, cells: [{ id: 'a', profileId: 'claude', name: 'Reviewer' }] }],
  };
  store.useStore.setState({ s: { ...s, projects: [project], settings: { ...s.settings, confirmCloseWorking: true } } });
  store.setUi({ statuses: { a: 'working' } });
}

describe('replaced dialogs', () => {
  it('resolves the replaced dialog as cancelled and gives each dialog its own id', async () => {
    const first = store.askChoice('First', '', [{ label: 'Go', value: 'go' }]);
    const firstId = store.getUi().dialog.id;
    const second = store.askChoiceChecked('Second', '', [{ label: 'Go', value: 'go' }], 'Do not ask again');
    const secondId = store.getUi().dialog.id;
    expect(secondId).not.toBe(firstId);
    await expect(first).resolves.toBeNull();
    store.getUi().dialog.onChoose('go', true);
    await expect(second).resolves.toEqual({ value: 'go', checked: true });
    expect(store.getUi().dialog).toBeNull();
  });
});

describe('quit question', () => {
  it('acknowledges a repeated question only while its dialog is on screen, and asks again when it is gone', async () => {
    workingState();
    guard.initQuitGuard();
    const ask = handlers.get('app:confirm-quit')!;
    answers.length = 0;
    ask();
    expect(answers).toEqual(['asking']);
    const quitDialog = store.getUi().dialog;
    expect(quitDialog.title).toContain('agents');
    expect(quitDialog.body).toContain('Reviewer');
    // A second Close while the dialog is open: still asking, no second dialog.
    ask();
    expect(answers).toEqual(['asking', 'asking']);
    expect(store.getUi().dialog.id).toBe(quitDialog.id);
    // Another dialog replaces the quit question: it counts as cancelled (main stops holding), the next Close asks afresh.
    const other = store.askChoice('Other', '', [{ label: 'Go', value: 'go' }]);
    await flush();
    expect(answers).toEqual(['asking', 'asking', 'cancel']);
    ask();
    expect(answers).toEqual(['asking', 'asking', 'cancel', 'asking']);
    await expect(other).resolves.toBeNull();
    const again = store.getUi().dialog;
    expect(again.id).not.toBe(quitDialog.id);
    again.onChoose(null);
    await flush();
    expect(answers.at(-1)).toBe('cancel');
    ask();
    store.getUi().dialog.onChoose('close', false);
    await flush();
    expect(answers.at(-1)).toBe('quit');
  });
});

describe('quit question with SFTP transfers', () => {
  const item = (id: string, state: string) => ({ id, state, sessionId: 'sftp:x', batchId: 'b', name: id });
  it('holds the quit while transfers run, asks about them first (Cancel keeps them), then about working agents', async () => {
    // initQuitGuard already ran in the test above: its subscriptions and the 'app:confirm-quit' handler are live.
    const ask = handlers.get('app:confirm-quit')!;
    store.setUi({ statuses: {} });
    guards.length = 0;
    sftpStore.useSftpStore.setState({ transfers: [item('a', 'running'), item('b', 'queued'), item('c', 'done')], preparing: [] });
    expect(guards).toEqual([true]);
    expect(guard.activeTransferCount()).toBe(2);
    answers.length = 0;
    ask();
    expect(answers).toEqual(['asking']);
    const q = store.getUi().dialog;
    expect(q.title).toBe('Quit while transfers are running?');
    expect(q.body).toBe('Transfers in progress: 2. Quitting the app stops them.');
    expect(q.actions.map((a: { label: string }) => a.label)).toEqual(['Quit anyway']);
    ask();
    expect(answers).toEqual(['asking', 'asking']);
    q.onChoose(null);
    await flush();
    expect(answers.at(-1)).toBe('cancel');
    expect(sftpStore.useSftpStore.getState().transfers).toHaveLength(3);
    // Quit anyway with no working agent: quits.
    ask();
    store.getUi().dialog.onChoose('quit');
    await flush();
    expect(answers.at(-1)).toBe('quit');
    // Transfers and working agents: both questions in turn; a further Close during the second one is "still asking".
    workingState();
    answers.length = 0;
    ask();
    store.getUi().dialog.onChoose('quit');
    await flush();
    const agents = store.getUi().dialog;
    expect(agents.title).toContain('agents');
    ask();
    expect(answers).toEqual(['asking', 'asking']);
    agents.onChoose('close', false);
    await flush();
    expect(answers.at(-1)).toBe('quit');
    // A preparing folder walk counts too; nothing running and no working agent lets the quit go unasked.
    store.setUi({ statuses: {} });
    sftpStore.useSftpStore.setState({ transfers: [item('c', 'done')], preparing: [{ batchId: 'p', queue: null, sources: 1 }] });
    expect(guards.at(-1)).toBe(true);
    sftpStore.useSftpStore.setState({ preparing: [] });
    expect(guards.at(-1)).toBe(false);
  });
});

describe('quit question with database work', () => {
  // A fake of what the database module registers: `pending` and a question of its own (Quit anyway / Cancel).
  let pending = false;
  let notify: () => void = () => undefined;
  const asked: string[] = [];
  const work = {
    pending: () => pending,
    ask: () => { asked.push('db'); return store.askChoice('Unsaved database work', '', [{ label: 'Quit anyway', value: 'quit', danger: true }]).then((v: string | null) => v === 'quit'); },
    subscribe: (changed: () => void) => { notify = changed; },
  };
  const item = (id: string, state: string) => ({ id, state, sessionId: 'sftp:x', batchId: 'b', name: id });
  const setPending = (value: boolean) => { pending = value; notify(); };
  const reset = () => {
    store.setUi({ statuses: {} });
    sftpStore.useSftpStore.setState({ transfers: [], preparing: [] });
    setPending(false);
  };

  it('registers through setDatabaseQuitWork and holds the quit only while database work is pending', () => {
    // initQuitGuard already ran above: the registration feeds its guard.
    store.setUi({ statuses: {} });
    sftpStore.useSftpStore.setState({ transfers: [], preparing: [] });
    guard.setDatabaseQuitWork(work);
    guards.length = 0;
    setPending(true);
    expect(guards).toEqual([true]);
    setPending(false);
    expect(guards).toEqual([true, false]);
  });

  it('asks about database work first and cancels the quit when it is cancelled', async () => {
    const ask = handlers.get('app:confirm-quit')!;
    reset();
    workingState();
    sftpStore.useSftpStore.setState({ transfers: [item('a', 'running')], preparing: [] });
    setPending(true);
    answers.length = 0;
    ask();
    expect(answers).toEqual(['asking']);
    const db = store.getUi().dialog;
    expect(db.title).toBe('Unsaved database work');
    // A further Close while the database question is on screen: still asking, no second dialog.
    ask();
    expect(answers).toEqual(['asking', 'asking']);
    expect(store.getUi().dialog.id).toBe(db.id);
    db.onChoose(null);
    await flush();
    expect(answers.at(-1)).toBe('cancel');
    expect(store.getUi().dialog).toBeNull();
  });

  it('then asks about transfers and then about agents, in that order, and cancels at each step', async () => {
    const ask = handlers.get('app:confirm-quit')!;
    // Quit anyway at every step: three dialogs in order, then quit.
    reset();
    workingState();
    sftpStore.useSftpStore.setState({ transfers: [item('a', 'running')], preparing: [] });
    setPending(true);
    answers.length = 0;
    const titles: string[] = [];
    ask();
    titles.push(store.getUi().dialog.title);
    store.getUi().dialog.onChoose('quit');
    await flush();
    titles.push(store.getUi().dialog.title);
    store.getUi().dialog.onChoose('quit');
    await flush();
    titles.push(store.getUi().dialog.title);
    store.getUi().dialog.onChoose('close', false);
    await flush();
    expect(titles[0]).toBe('Unsaved database work');
    expect(titles[1]).toBe('Quit while transfers are running?');
    expect(titles[2]).toContain('agents');
    expect(answers).toEqual(['asking', 'quit']);
    // Cancel at the transfers step.
    answers.length = 0;
    ask();
    store.getUi().dialog.onChoose('quit');
    await flush();
    expect(store.getUi().dialog.title).toBe('Quit while transfers are running?');
    store.getUi().dialog.onChoose(null);
    await flush();
    expect(answers).toEqual(['asking', 'cancel']);
    expect(store.getUi().dialog).toBeNull();
    // Cancel at the agents step.
    answers.length = 0;
    ask();
    store.getUi().dialog.onChoose('quit');
    await flush();
    store.getUi().dialog.onChoose('quit');
    await flush();
    const agents = store.getUi().dialog;
    expect(agents.title).toContain('agents');
    // A further Close during the last question is "still asking".
    ask();
    expect(answers).toEqual(['asking', 'asking']);
    agents.onChoose(null);
    await flush();
    expect(answers).toEqual(['asking', 'asking', 'cancel']);
  });

  it('a database question replaced by another dialog answers cancel and never goes on to the next steps', async () => {
    const ask = handlers.get('app:confirm-quit')!;
    reset();
    workingState();
    setPending(true);
    answers.length = 0;
    ask();
    const other = store.askChoice('Other', '', [{ label: 'Go', value: 'go' }]);
    await flush();
    expect(answers).toEqual(['asking', 'cancel']);
    expect(store.getUi().dialog.title).toBe('Other');
    store.getUi().dialog.onChoose('go');
    await expect(other).resolves.toBe('go');
  });

  it('without pending database work there is no database question', async () => {
    const ask = handlers.get('app:confirm-quit')!;
    reset();
    workingState();
    asked.length = 0;
    answers.length = 0;
    ask();
    expect(store.getUi().dialog.title).toContain('agents');
    store.getUi().dialog.onChoose('close', false);
    await flush();
    expect(asked).toEqual([]);
    expect(answers).toEqual(['asking', 'quit']);
    // Nothing at all to ask about: the quit is not held.
    store.setUi({ statuses: {} });
    expect(guards.at(-1)).toBe(false);
  });
});
