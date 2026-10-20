// Unsaved Redis values (1.0.0) with a stubbed window (no DOM): drafts are kept per tab until saved, discarded or the tab closes;
// closing a Redis tab with drafts asks (Save / Discard / Cancel), and the database step of the quit question counts them.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let drafts: any;
let files: any;
let store: any;
let guard: any;
const answers: string[] = [];
const guards: boolean[] = [];
const handlers = new Map<string, (...args: unknown[]) => void>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US', userAgent: 'node', platform: 'linux' });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      applyStateEdit: (edit: { id: string }) => Promise.resolve({ revision: 0, editId: edit.id }),
      loadSnapshot: () => new Promise(() => undefined),
      setQuitGuard: (ask: boolean) => { guards.push(ask); },
      answerQuit: (answer: string) => { answers.push(answer); },
      on: (channel: string, cb: (...args: unknown[]) => void) => { handlers.set(channel, cb); return () => undefined; },
      db: { vaultInfo: () => new Promise(() => undefined), sessions: () => new Promise(() => undefined) },
    },
    setTimeout, clearTimeout,
  });
  // The renderer is not part of the node tsconfig: loaded through variables, so tsc does not follow the imports.
  const paths = ['../src/renderer/src/redis/redisDrafts', '../src/renderer/src/files', '../src/renderer/src/store', '../src/renderer/src/closeGuard'];
  [drafts, files, store, guard] = await Promise.all(paths.map((p) => import(/* @vite-ignore */ p)));
  // What db/tabs.ts registers for Redis tabs (that module pulls in the terminals, which need a DOM): the close question and the
  // Redis part of the database quit step.
  files.setDbTabHooks({ confirmClose: (doc: any) => (doc.redis ? drafts.confirmCloseRedis(doc) : Promise.resolve(true)), closed: () => undefined });
  guard.initQuitGuard();
  guard.setDatabaseQuitWork({
    pending: () => drafts.redisDraftTotal() > 0,
    ask: async () => (await store.askChoice('Quit with unsaved database work?', drafts.redisQuitLine() ?? '', [{ label: 'Quit anyway', value: 'quit', danger: true }])) === 'quit',
    subscribe: (changed: () => void) => { drafts.useRedisDrafts.subscribe((st: any, prev: any) => { if (st.drafts !== prev.drafts) changed(); }); },
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const TAB = 'redis-tab-1';
function openTab(id = TAB) {
  const doc = {
    id, projectId: '', relativePath: 'local · Keys · DB 0', name: 'local', text: '', savedText: '', diskText: '', status: 'ready', saving: false, error: null, wrap: false,
    redis: { kind: 'redis', view: 'keys', connectionId: 'c1', db: 0, uid: id },
  };
  files.useFileStore.setState((s: any) => ({ documents: [...s.documents.filter((d: any) => d.id !== id), doc], activeFileId: id }));
}
const isOpen = (id = TAB) => files.useFileStore.getState().documents.some((d: any) => d.id === id);

beforeEach(() => {
  for (const id of Object.keys(drafts.useRedisDrafts.getState().drafts)) drafts.dropRedisDrafts(id);
  files.useFileStore.setState({ documents: [], activeFileId: null });
});

describe('the draft store', () => {
  it('keeps drafts per tab and slot, counts them and forgets a tab', () => {
    const a = drafts.draftSlot(0, 'string', 'k1', 'value');
    const b = drafts.draftSlot(0, 'hash', 'k2', 'f:x');
    expect(a).not.toBe(drafts.draftSlot(1, 'string', 'k1', 'value'));
    drafts.putDraft('t1', a, { value: { text: 'x' }, save: null });
    drafts.putDraft('t1', b, { value: 'y', save: null });
    drafts.putDraft('t2', a, { value: 'z', save: null });
    expect(drafts.getDraft('t1', a)).toEqual({ text: 'x' });
    expect(drafts.redisDraftCount('t1')).toBe(2);
    expect(drafts.redisDraftTotal()).toBe(3);
    expect(drafts.redisDirtyTabs()).toBe(2);
    drafts.putDraft('t1', b, null);
    expect(drafts.redisDraftCount('t1')).toBe(1);
    drafts.remember('t1', 'open', 'field');
    expect(drafts.recall('t1', 'open')).toBe('field');
    drafts.dropRedisDrafts('t1');
    expect(drafts.redisDraftCount('t1')).toBe(0);
    expect(drafts.recall('t1', 'open')).toBeUndefined();
    expect(drafts.redisDraftTotal()).toBe(1);
  });

  it('saves every edit in turn, drops the inputs of new items when all went through, and stops at the first failure', async () => {
    const order: string[] = [];
    drafts.putDraft('t3', 'a', { value: 1, save: async () => { order.push('a'); return true; } });
    drafts.putDraft('t3', 'input', { value: 'typed', save: null });
    drafts.putDraft('t3', 'b', { value: 2, save: async () => { order.push('b'); return false; } });
    drafts.putDraft('t3', 'c', { value: 3, save: async () => { order.push('c'); return true; } });
    expect(await drafts.saveRedisDrafts('t3')).toBe(false);
    expect(order).toEqual(['a', 'b']);
    expect(Object.keys(drafts.useRedisDrafts.getState().drafts.t3).sort()).toEqual(['b', 'c', 'input']);
    drafts.putDraft('t3', 'b', { value: 2, save: async () => { order.push('b2'); return true; } });
    expect(await drafts.saveRedisDrafts('t3')).toBe(true);
    expect(order).toEqual(['a', 'b', 'b2', 'c']);
    expect(drafts.redisDraftCount('t3')).toBe(0);
  });
});

describe('closing a Redis tab', () => {
  it('closes at once without drafts', async () => {
    openTab();
    expect(await files.closeFile(TAB)).toBe(true);
    expect(store.getUi().dialog).toBeNull();
    expect(isOpen()).toBe(false);
  });

  it('asks with Save / Discard / Cancel: Cancel keeps the tab and the draft, Discard closes and drops it', async () => {
    openTab();
    drafts.putDraft(TAB, 's', { value: 'x', save: async () => true });
    let closing = files.closeFile(TAB);
    const q = store.getUi().dialog;
    expect(q.title).toBe('Save the changes in the Redis tab local?');
    expect(q.body).toBe('Unsaved Redis values: 1.');
    // The dialog adds its own Cancel button (it answers null).
    expect(q.actions.map((a: { label: string }) => a.label)).toEqual(['Save', 'Discard changes']);
    q.onChoose(null);
    expect(await closing).toBe(false);
    expect(isOpen()).toBe(true);
    expect(drafts.redisDraftCount(TAB)).toBe(1);
    closing = files.closeFile(TAB);
    store.getUi().dialog.onChoose(null);
    expect(await closing).toBe(false);
    expect(isOpen()).toBe(true);
    closing = files.closeFile(TAB);
    store.getUi().dialog.onChoose('discard');
    expect(await closing).toBe(true);
    expect(isOpen()).toBe(false);
    expect(drafts.redisDraftCount(TAB)).toBe(0);
  });

  it('Save writes the drafts first; a failed write keeps the tab open', async () => {
    openTab();
    let ok = false;
    const saved: string[] = [];
    drafts.putDraft(TAB, 's', { value: 'x', save: async () => { saved.push('s'); return ok; } });
    drafts.putDraft(TAB, 'add', { value: 'typed', save: null });
    let closing = files.closeFile(TAB);
    expect(store.getUi().dialog.body).toBe('Unsaved Redis values: 2.');
    store.getUi().dialog.onChoose('save');
    expect(await closing).toBe(false);
    expect(isOpen()).toBe(true);
    expect(drafts.redisDraftCount(TAB)).toBe(2);
    ok = true;
    closing = files.closeFile(TAB);
    store.getUi().dialog.onChoose('save');
    expect(await closing).toBe(true);
    expect(saved).toEqual(['s', 's']);
    expect(isOpen()).toBe(false);
    expect(drafts.redisDraftCount(TAB)).toBe(0);
  });
});

describe('quitting with unsaved Redis values', () => {
  it('holds the quit and asks in the database step; Cancel keeps them, Quit anyway quits', async () => {
    openTab();
    guards.length = 0;
    drafts.putDraft(TAB, 's', { value: 'x', save: null });
    expect(guards.at(-1)).toBe(true);
    const ask = handlers.get('app:confirm-quit')!;
    answers.length = 0;
    ask();
    const q = store.getUi().dialog;
    expect(q.title).toBe('Quit with unsaved database work?');
    expect(q.body).toContain('Unsaved Redis values: 1. They will be lost.');
    q.onChoose(null);
    await flush();
    expect(answers).toEqual(['asking', 'cancel']);
    expect(drafts.redisDraftCount(TAB)).toBe(1);
    ask();
    store.getUi().dialog.onChoose('quit');
    await flush();
    expect(answers.at(-1)).toBe('quit');
    drafts.dropRedisDrafts(TAB);
    expect(guards.at(-1)).toBe(false);
  });
});
