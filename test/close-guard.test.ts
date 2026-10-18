// The renderer side of the close confirmation with a stubbed window (no DOM): a dialog that replaces another resolves the
// replaced one as cancelled, and the quit question never leaves main waiting on a dialog that is gone.
import { beforeAll, describe, expect, it, vi } from 'vitest';

let store: any;
let guard: any;
const answers: string[] = [];
const handlers = new Map<string, (...args: unknown[]) => void>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      applyStateEdit: (edit: { id: string }) => Promise.resolve({ revision: 0, editId: edit.id }),
      loadSnapshot: () => new Promise(() => undefined),
      setQuitGuard: () => undefined,
      answerQuit: (answer: string) => { answers.push(answer); },
      on: (channel: string, cb: (...args: unknown[]) => void) => { handlers.set(channel, cb); return () => undefined; },
    },
    setTimeout, clearTimeout,
  });
  // The renderer is not part of the node tsconfig: loaded through variables, so tsc does not follow the imports.
  const storePath = '../src/renderer/src/store';
  const guardPath = '../src/renderer/src/closeGuard';
  store = await import(/* @vite-ignore */ storePath);
  guard = await import(/* @vite-ignore */ guardPath);
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
