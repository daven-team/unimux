// Snippet variables (1.0.6): `{{name}}` and `{{name:default}}` in a snippet's text are filled in when it is sent.
// The built-ins come from the target cell and the machine; the others are asked for in a small dialog.

/** Filled in by the app for each target cell: the project's name, the cell's folder, its git branch, today's date, the clipboard. */
export const SNIPPET_BUILTINS = ['project', 'path', 'branch', 'date', 'clipboard'] as const;
export type SnippetBuiltin = (typeof SNIPPET_BUILTINS)[number];
export const isSnippetBuiltin = (name: string): name is SnippetBuiltin => (SNIPPET_BUILTINS as readonly string[]).includes(name);

export const SNIPPET_VAR_LIMITS = { count: 20, name: 40, value: 10_000 } as const;

/**
 * `{{ name }}` or `{{ name:default }}`: a name starts with a letter or `_` and holds letters, digits, `_`, `-` and `.`;
 * a default runs to the closing braces on the same line. Anything else (`{{ .Values }}`, `{{}}`) stays text.
 */
const VAR = /\{\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*(?::([^}\n]*))?\}\}/gu;

export interface SnippetVar { name: string; default?: string }
export interface SnippetVarMatch extends SnippetVar { from: number; to: number }

/** Every variable of the text in order, with its place. */
export function snippetVarMatches(text: string): SnippetVarMatch[] {
  const out: SnippetVarMatch[] = [];
  for (const m of text.matchAll(VAR)) {
    if (m[1].length > SNIPPET_VAR_LIMITS.name) continue;
    out.push({ name: m[1], ...(m[2] !== undefined ? { default: m[2].trim() } : {}), from: m.index!, to: m.index! + m[0].length });
  }
  return out;
}

/** The distinct variables of the text in order of first use; the first default given for a name wins. */
export function parseSnippetVars(text: string): SnippetVar[] {
  const byName = new Map<string, SnippetVar>();
  for (const { name, default: fallback } of snippetVarMatches(text)) {
    const seen = byName.get(name);
    if (!seen) byName.set(name, { name, ...(fallback !== undefined ? { default: fallback } : {}) });
    else if (seen.default === undefined && fallback !== undefined) seen.default = fallback;
  }
  return [...byName.values()];
}

/** The variables the user is asked for (built-ins are filled by the app), at most SNIPPET_VAR_LIMITS.count. */
export const snippetUserVars = (text: string): SnippetVar[] => parseSnippetVars(text).filter((v) => !isSnippetBuiltin(v.name)).slice(0, SNIPPET_VAR_LIMITS.count);

/** The built-ins the text uses (only those are worked out: the clipboard is read and git asked only when needed). */
export const snippetBuiltinsUsed = (text: string): Set<SnippetBuiltin> =>
  new Set(parseSnippetVars(text).map((v) => v.name).filter(isSnippetBuiltin));

/** True when the text has any variable at all. */
export const hasSnippetVars = (text: string): boolean => snippetVarMatches(text).length > 0;

/**
 * The text with every variable replaced: its value when given (also an empty one), else its default, else ''.
 * Values are inserted as they are (a value holding `{{x}}` is not filled again).
 */
export function fillSnippetVars(text: string, values: Readonly<Record<string, string | undefined>>): string {
  let out = '';
  let at = 0;
  for (const m of snippetVarMatches(text)) {
    const value = Object.prototype.hasOwnProperty.call(values, m.name) ? values[m.name] : undefined;
    out += text.slice(at, m.from) + (value ?? m.default ?? '');
    at = m.to;
  }
  return out + text.slice(at);
}

/** The values shown first in the dialog: the last ones used with this snippet, else the defaults from the text, else empty. */
export function initialSnippetValues(vars: readonly SnippetVar[], last: unknown): Record<string, string> {
  const remembered = last && typeof last === 'object' && !Array.isArray(last) ? (last as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const v of vars) {
    const kept = remembered[v.name];
    out[v.name] = typeof kept === 'string' ? kept : v.default ?? '';
  }
  return out;
}

/**
 * The values kept with the snippet after a send: the ones just entered over the previous ones, for names the text still uses,
 * each capped. Returns `previous` itself when nothing changed (no needless state write).
 */
export function rememberSnippetValues(previous: Readonly<Record<string, string>> | undefined, entered: Readonly<Record<string, string>>, text: string): Record<string, string> | undefined {
  const names = new Set(snippetUserVars(text).map((v) => v.name));
  const next: Record<string, string> = {};
  for (const name of names) {
    const value = Object.prototype.hasOwnProperty.call(entered, name) ? entered[name] : previous?.[name];
    if (typeof value === 'string') next[name] = value.slice(0, SNIPPET_VAR_LIMITS.value);
  }
  const keys = Object.keys(next);
  if (previous && keys.length === Object.keys(previous).length && keys.every((k) => previous[k] === next[k])) return previous as Record<string, string>;
  return keys.length || previous ? next : undefined;
}

/** {{date}}: the local date as YYYY-MM-DD. */
export function snippetDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What the built-ins of one target cell need: the project, the cell's folder and how to read its branch. */
export interface SnippetBuiltinSource {
  project: string;
  path: string;
  /** The current git branch of `path` ('' when none: not a repository, a detached HEAD, git missing). */
  branch: () => Promise<string>;
  clipboard: () => Promise<string>;
  now?: Date;
}

/** The values of the built-ins the text uses, for one target cell; reading the branch or the clipboard never throws. */
export async function resolveSnippetBuiltins(text: string, source: SnippetBuiltinSource): Promise<Partial<Record<SnippetBuiltin, string>>> {
  const used = snippetBuiltinsUsed(text);
  const out: Partial<Record<SnippetBuiltin, string>> = {};
  const safe = async (read: () => Promise<string>) => { try { return String(await read() ?? ''); } catch { return ''; } };
  if (used.has('project')) out.project = source.project;
  if (used.has('path')) out.path = source.path;
  if (used.has('date')) out.date = snippetDate(source.now);
  if (used.has('branch')) out.branch = await safe(source.branch);
  if (used.has('clipboard')) out.clipboard = await safe(source.clipboard);
  return out;
}

/** A fresh global pattern of one variable (for an editor's match decorator). */
export const snippetVarPattern = (): RegExp => new RegExp(VAR.source, 'gu');
