// Languages of notes and snippets with code (1.0.6): the choice in their editors and the info string of a Markdown code fence.

export const CODE_LANGUAGES = [
  { id: 'text', label: 'Plain text' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'shell', label: 'Shell / Bash' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'sql', label: 'SQL' },
  { id: 'python', label: 'Python' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'java', label: 'Java' },
  { id: 'csharp', label: 'C#' },
  { id: 'toml', label: 'TOML' },
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number]['id'];

const IDS = new Set<string>(CODE_LANGUAGES.map((language) => language.id));
const ALIASES: Record<string, CodeLanguage> = {
  txt: 'text', plain: 'text', plaintext: 'text', none: 'text',
  md: 'markdown', mdx: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shellscript: 'shell', terminal: 'shell',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', posh: 'powershell',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  mysql: 'sql', postgres: 'sql', postgresql: 'sql', psql: 'sql', sqlite: 'sql', plsql: 'sql', tsql: 'sql',
  py: 'python', python3: 'python',
  jsonc: 'json', json5: 'json',
  yml: 'yaml',
  htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  scss: 'css', less: 'css',
  golang: 'go',
  rs: 'rust',
  h: 'c',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', 'c#': 'csharp',
};

/** A language id from an info string (```ts, ```bash title="x", ```{.python}) or a saved choice; null when unknown. */
export function resolveCodeLanguage(info: string | null | undefined): CodeLanguage | null {
  const word = (info ?? '').trim().split(/[\s,{}]+/).find(Boolean)?.replace(/^\./, '').replace(/^language-/, '').toLowerCase() ?? '';
  if (!word) return null;
  if (IDS.has(word)) return word as CodeLanguage;
  return ALIASES[word] ?? null;
}

/** A saved language field: a known id or undefined (an unknown or missing value falls back to the default of the editor). */
export function normalizeCodeLanguage(raw: unknown): CodeLanguage | undefined {
  return typeof raw === 'string' && IDS.has(raw) ? (raw as CodeLanguage) : undefined;
}

/** The label of a language in the menus. */
export const codeLanguageLabel = (id: CodeLanguage): string => CODE_LANGUAGES.find((language) => language.id === id)?.label ?? id;

/** A highlighted range of a text: `cls` is the class list of its span. */
export interface HighlightRange { from: number; to: number; cls: string }

/**
 * Cuts `text` into runs for display: the highlighter's ranges (sorted, not overlapping) and the marked ranges (snippet variables)
 * laid over them. Each run carries the classes of every range it lies in ('' for plain text). Adjacent runs never share classes.
 */
export function highlightRuns(text: string, ranges: readonly HighlightRange[], marks: readonly HighlightRange[] = []): Array<{ text: string; cls: string }> {
  const cuts = new Set<number>([0, text.length]);
  for (const r of ranges) { cuts.add(clamp(r.from, text.length)); cuts.add(clamp(r.to, text.length)); }
  for (const r of marks) { cuts.add(clamp(r.from, text.length)); cuts.add(clamp(r.to, text.length)); }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Array<{ text: string; cls: string }> = [];
  // Both lists are sorted and flat, so one pointer each walks them along the cuts.
  let ri = 0;
  let mi = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    while (ri < ranges.length && ranges[ri].to <= from) ri++;
    while (mi < marks.length && marks[mi].to <= from) mi++;
    const classes: string[] = [];
    if (ri < ranges.length && ranges[ri].from <= from) classes.push(ranges[ri].cls);
    if (mi < marks.length && marks[mi].from <= from) classes.push(marks[mi].cls);
    const cls = classes.join(' ');
    const last = out.at(-1);
    if (last && last.cls === cls) last.text += text.slice(from, to);
    else out.push({ text: text.slice(from, to), cls });
  }
  return out;
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

/** The runs as HTML: escaped text, a span for each run with classes. */
export const runsToHtml = (runs: ReadonlyArray<{ text: string; cls: string }>): string =>
  runs.map((run) => run.cls ? `<span class="${escapeHtml(run.cls)}">${escapeHtml(run.text)}</span>` : escapeHtml(run.text)).join('');
