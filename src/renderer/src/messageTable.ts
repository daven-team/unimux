/// <reference path="./virtual-messages.d.ts" />
// The renderer's message rows, filled one language at a time. In the renderer build every shared message table
// (`messages`, `*Messages`) is this object (vite.messages.ts), so the main chunk carries no translations and
// each language is a small chunk loaded on demand. Without that build step (tests, tools) the shared tables keep all
// languages and this object stays unused.
import type { Language } from '../../shared/languages';

export const messageTable: Record<string, string[]> = {};

type Chunk = { column: number; default: Record<string, string> };
const chunks: Record<Exclude<Language, 'pl'>, () => Promise<Chunk>> = {
  en: () => import('virtual:mc-messages/en'),
  de: () => import('virtual:mc-messages/de'),
  es: () => import('virtual:mc-messages/es'),
  fr: () => import('virtual:mc-messages/fr'),
  pt: () => import('virtual:mc-messages/pt'),
};

/** Polish needs no table: the keys are the Polish texts. */
const loaded = new Set<Language>(['pl']);
const loading = new Map<Language, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

export function isLanguageLoaded(language: Language): boolean {
  return loaded.has(language);
}

/** Languages whose chunk failed to load: background loads do not retry them (no request per tr() call). */
const failed = new Set<Language>();

export function languageLoadFailed(language: Language): boolean {
  return failed.has(language);
}

/** Loads a language's translations once; concurrent calls share the request. A failed load rejects and is remembered. */
export function loadLanguageTable(language: Language): Promise<void> {
  if (loaded.has(language)) return Promise.resolve();
  let pending = loading.get(language);
  if (!pending) {
    pending = chunks[language as Exclude<Language, 'pl'>]().then((chunk) => {
      for (const [key, text] of Object.entries(chunk.default)) (messageTable[key] ??= [])[chunk.column] = text;
      loaded.add(language);
      failed.delete(language);
      version++;
      for (const listener of listeners) listener();
    }, (error: unknown) => {
      failed.add(language);
      throw error;
    }).finally(() => loading.delete(language));
    loading.set(language, pending);
  }
  return pending;
}

/** For useSyncExternalStore: changes whenever another language finished loading. */
export function subscribeLanguageTables(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function languageTablesVersion(): number {
  return version;
}
