import { useMemo, useSyncExternalStore } from 'react';
import { detectLanguage, type Language } from '../../shared/languages';
import { messages } from '../../shared/messages';
import { translate, translateError, type MessageKey, type MessageParams } from '../../shared/i18n';
import { isLanguageLoaded, languageLoadFailed, languageTablesVersion, loadLanguageTable, messageTable, subscribeLanguageTables } from './messageTable';
import { getS, toast, useStore } from './store';

const systemLanguage = () => detectLanguage(navigator.languages);

/** True in the app build, where the shared tables are filled per language (vite.messages.ts); false in tests. */
const perLanguage = (messages as unknown) === messageTable;
/** The last language whose translations were ready: shown until a newly chosen one has loaded. */
let shown: Language | null = null;

/** The chosen language, or the system one before the first-run choice. */
export const chosenLanguage = (): Language => getS().settings.language ?? systemLanguage();

/** Loads a language's translations; switch to a language only after this resolves (boot, Settings, first run). */
export function loadLanguage(language: Language): Promise<void> {
  return perLanguage ? loadLanguageTable(language) : Promise.resolve();
}

let lastPick = 0;
/** A language picked in a list: loads it, then applies it, unless another one was picked meanwhile; a failed load says so. */
export function pickLanguage(language: Language, apply: (language: Language) => void): void {
  const pick = ++lastPick;
  void loadLanguage(language).then(
    () => { if (pick === lastPick) apply(language); },
    () => { if (pick === lastPick) toast(tr('Nie udało się wczytać tego języka. Spróbuj ponownie.'), 'error'); },
  );
}

/** The language texts are shown in: the requested one once loaded, the previous one meanwhile (never untranslated keys). */
function shownLanguage(requested: Language): Language {
  if (!perLanguage || isLanguageLoaded(requested)) return (shown = requested);
  // A language set from outside the usual paths (another window, a resync): load it, keep the current texts meanwhile.
  // A chunk that failed is not requested again from here (tr() runs often); picking the language again retries it.
  if (!languageLoadFailed(requested)) void loadLanguageTable(requested).catch(() => undefined);
  return shown ?? requested;
}

/** For actions and event handlers, read the current preference at the moment of use. */
export const tr = (key: MessageKey, params?: MessageParams) =>
  translate(shownLanguage(chosenLanguage()), key, params);

/** An error from main in the language the texts are shown in (raw before the first-run choice). */
export const errorText = (message: string) =>
  getS().settings.language ? translateError(shownLanguage(chosenLanguage()), message) : message;

export function useI18n() {
  const requested = useStore((st) => st.s.settings.language) ?? systemLanguage();
  // Re-render when a language finished loading (only matters for a language set without loading it first).
  useSyncExternalStore(subscribeLanguageTables, languageTablesVersion, languageTablesVersion);
  const language = shownLanguage(requested);
  return useMemo(() => ({
    language,
    tr: (key: MessageKey, params?: MessageParams) => translate(language, key, params),
    errorText: (message: string) => translateError(language, message),
  }), [language]);
}
