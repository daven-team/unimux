// Unsaved edits of Redis tabs (1.0.0): a string value being edited (text, JSON or hex), a hash field, a list element, a sorted
// set score, and the inputs of new items (hash field, list element, set member, sorted set member, stream entry). The value views
// unmount when another tab comes to the front, so what was typed lives here, per tab, until it is saved, undone or the tab closes
// (redisClient drops a closed tab's drafts). Closing a tab with drafts asks first, and so does quitting (closeGuard's database step).
import { create } from 'zustand';
import { tr } from '../i18n';
import { askChoice } from '../store';

/**
 * One unsaved edit: what the editor shows again when it comes back (`value`), and how to save it without the editor (null: the
 * input of a new item, which "Save" on closing drops).
 */
export interface RedisDraft<T = unknown> { value: T; save: (() => Promise<boolean>) | null }

interface DraftStore {
  /** tab id -> slot -> draft. A slot names the DB, the key, the type and the part being edited. */
  drafts: Record<string, Record<string, RedisDraft>>;
  /** tab id -> slot -> what the view had open (the chosen field or element); not an edit, never asked about. */
  memory: Record<string, Record<string, unknown>>;
}

export const useRedisDrafts = create<DraftStore>(() => ({ drafts: {}, memory: {} }));

/** The slot of a value view's part: DB, type and key bytes keep two keys (or one key holding another type now) apart. */
export const draftSlot = (db: number, type: string, keyId: string, part: string): string => `${db}\u0000${type}\u0000${keyId}\u0000${part}`;

export function getDraft<T>(tabId: string, slot: string): T | undefined {
  return useRedisDrafts.getState().drafts[tabId]?.[slot]?.value as T | undefined;
}

/** Stores a draft (null removes it); the same value again changes nothing. */
export function putDraft<T>(tabId: string, slot: string, draft: RedisDraft<T> | null): void {
  useRedisDrafts.setState((st) => {
    const tab = st.drafts[tabId] ?? {};
    if (!draft && !(slot in tab)) return st;
    const next = { ...tab };
    if (draft) next[slot] = draft as RedisDraft; else delete next[slot];
    const drafts = { ...st.drafts };
    if (Object.keys(next).length) drafts[tabId] = next; else delete drafts[tabId];
    return { drafts };
  });
}

export function recall<T>(tabId: string, slot: string): T | undefined {
  return useRedisDrafts.getState().memory[tabId]?.[slot] as T | undefined;
}

export function remember(tabId: string, slot: string, value: unknown): void {
  useRedisDrafts.setState((st) => {
    const tab = st.memory[tabId] ?? {};
    if (tab[slot] === value) return st;
    const next = { ...tab };
    if (value === undefined || value === null) delete next[slot]; else next[slot] = value;
    return { memory: { ...st.memory, [tabId]: next } };
  });
}

/** Unsaved edits of one tab. */
export const redisDraftCount = (tabId: string): number => Object.keys(useRedisDrafts.getState().drafts[tabId] ?? {}).length;
/** Unsaved edits of every Redis tab (the quit question). */
export const redisDraftTotal = (): number => Object.values(useRedisDrafts.getState().drafts).reduce((n, tab) => n + Object.keys(tab).length, 0);
/** Redis tabs with unsaved edits. */
export const redisDirtyTabs = (): number => Object.keys(useRedisDrafts.getState().drafts).length;

/**
 * "Save" when closing a tab: every edit that can be saved is saved in turn; the first one that fails stops (it and the rest stay,
 * the tab stays open). When all went through, the inputs of new items are dropped too.
 */
export async function saveRedisDrafts(tabId: string): Promise<boolean> {
  const tab = useRedisDrafts.getState().drafts[tabId] ?? {};
  for (const [slot, draft] of Object.entries(tab)) {
    if (!draft.save) continue;
    if (!await draft.save()) return false;
    // Saved: the slot goes, unless it was edited again meanwhile.
    if (useRedisDrafts.getState().drafts[tabId]?.[slot] === draft) putDraft(tabId, slot, null);
  }
  dropRedisDrafts(tabId);
  return true;
}

/** Forgets everything of a tab (it closed, or its drafts were discarded). */
export function dropRedisDrafts(tabId: string): void {
  useRedisDrafts.setState((st) => {
    if (!(tabId in st.drafts) && !(tabId in st.memory)) return st;
    const drafts = { ...st.drafts };
    const memory = { ...st.memory };
    delete drafts[tabId];
    delete memory[tabId];
    return { drafts, memory };
  });
}

/** A Redis tab with unsaved values asks like a file tab before it closes: save them, discard them, or keep the tab open (the dialog's own Cancel). */
export async function confirmCloseRedis(doc: { id: string; name: string }): Promise<boolean> {
  const count = redisDraftCount(doc.id);
  if (!count) return true;
  const choice = await askChoice(tr('Zapisać zmiany w karcie Redis {name}?', { name: doc.name }), tr('Niezapisane wartości Redis: {count}.', { count }), [
    { label: tr('Zapisz'), value: 'save', primary: true },
    { label: tr('Odrzuć zmiany'), value: 'discard', danger: true },
  ]);
  if (choice === 'save') return saveRedisDrafts(doc.id);
  if (choice !== 'discard') return false;
  dropRedisDrafts(doc.id);
  return true;
}

/** The line of the database quit question about unsaved Redis values (null: none). */
export function redisQuitLine(): string | null {
  const count = redisDraftTotal();
  return count ? tr('Niezapisane wartości Redis: {count}. Zostaną utracone.', { count }) : null;
}
