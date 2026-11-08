import { messages } from './messages';
import type { Language } from './languages';

export type MessageKey = keyof typeof messages;
export type MessageParams = Record<string, string | number>;
/** Position of each language in a message row (Polish is the key itself). */
export const MESSAGE_COLUMN = { en: 0, de: 1, es: 2, fr: 3, pt: 4 } as const;

/** Polish source messages keep the original interface easy to find in the code. */
export function translate(language: Language, key: MessageKey, params: MessageParams = {}): string {
  // The renderer fills its tables per language (vite.messages.ts); a row it has not loaded yet shows the key, never throws.
  const message = language === 'pl' ? key : (messages[key] as readonly string[] | undefined)?.[MESSAGE_COLUMN[language]] ?? key;
  return message.replace(/\{(\w+)\}/g, (token, name: string) => String(params[name] ?? token));
}

export function translateError(language: Language, message: string): string {
  return Object.hasOwn(messages, message) ? translate(language, message as MessageKey) : message;
}

export function formatAgo(language: Language, timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - timestamp) / 1000);
  if (seconds < 60) return translate(language, 'przed chwilą');
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 86400 * 7) return formatter.format(-Math.floor(seconds / 86400), 'day');
  return new Date(timestamp).toLocaleDateString(language);
}
