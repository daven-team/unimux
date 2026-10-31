// Export of one Claude Code or Codex conversation to Markdown (1.1.1). The conversation search thread reads the transcript
// (src/convsearch/exporter.ts) into ConvExportData: the user and agent texts and a one-line summary of each tool call, never
// tool output or reasoning. The renderer turns that into Markdown here, with its texts translated. No imports: the worker,
// main and the renderer all use this file.
import type { ConvCli, ConvRole } from './convSearch';

/** What to export: an indexed transcript file (a search result) or the conversation of a cell. */
export type ConvExportSource = { file: string } | { cli: ConvCli; id: string };

export type ConvExportItem =
  | { kind: 'msg'; role: ConvRole; text: string; ts: number; cut?: boolean }
  | { kind: 'tool'; name: string; detail: string; ts: number };

export interface ConvExportData {
  ok: boolean;
  error?: string;
  cli: ConvCli;
  id: string;
  title: string;
  cwd: string;
  model?: string;
  startedAt: number;
  updatedAt: number;
  items: ConvExportItem[];
  /** The conversation was longer than EXPORT_LIMITS: only its beginning is in `items`. */
  capped: boolean;
}

/** A long conversation is cut (the save dialog takes up to 4 MB, a note 200k characters). */
export const EXPORT_LIMITS = { docChars: 3_000_000, messageChars: 200_000, detailChars: 160, items: 50_000 } as const;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clipDetail = (s: string) => {
  const line = oneLine(s);
  return line.length > EXPORT_LIMITS.detailChars ? `${line.slice(0, EXPORT_LIMITS.detailChars - 1)}…` : line;
};

const parseArgs = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return value;
  try { return JSON.parse(t); } catch { return value; }
};

/** A shell command as one string: Codex passes ["bash", "-lc", "npm test"] or ["rg", "x"]. */
function commandText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return '';
  const parts = value as string[];
  if (parts.length >= 3 && /^(ba|z|)sh$|bash\.exe$|^pwsh$|^powershell(\.exe)?$|^cmd(\.exe)?$/i.test(parts[0]) && /^(-l?c|-Command|\/c)$/i.test(parts[1])) return parts.slice(2).join(' ');
  return parts.join(' ');
}

/** The files an apply_patch input touches. */
function patchFiles(text: string): string {
  const files = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  return files.join(', ');
}

const KEY_ORDER = ['command', 'cmd', 'file_path', 'notebook_path', 'pattern', 'path', 'query', 'url', 'description', 'prompt', 'skill', 'name'];

/** One line that says what a tool call did ("npm test", "src/a.ts"), from its name and input; '' when nothing short says it. */
export function toolDetail(name: string, input: unknown): string {
  const value = parseArgs(input);
  if (typeof value === 'string') return clipDetail(name === 'apply_patch' ? patchFiles(value) || value : value);
  if (!value || typeof value !== 'object') return '';
  const o = value as Record<string, unknown>;
  if (o.command !== undefined || o.cmd !== undefined) {
    const cmd = commandText(o.command ?? o.cmd);
    if (cmd) return clipDetail(cmd);
  }
  if (typeof o.input === 'string' && name === 'apply_patch') return clipDetail(patchFiles(o.input));
  // A web search (Codex) names its query in an action.
  if (typeof o.query === 'string') return clipDetail(o.query);
  for (const key of KEY_ORDER) if (typeof o[key] === 'string' && (o[key] as string).trim()) return clipDetail(o[key] as string);
  return '';
}

/** Inline code that survives backticks inside it. */
export function inlineCode(text: string): string {
  const runs = text.match(/`+/g);
  const fence = '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1);
  const pad = fence.length > 1 || text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const two = (n: number) => String(n).padStart(2, '0');
/** Local date and time as "2026-10-31 14:05". */
export const formatStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

export interface MarkdownLabels {
  /** The heading of the user's messages ("Ty"). */
  you: string;
  date: string;
  folder: string;
  agent: string;
  session: string;
  /** Prefix of a tool call line ("Narzędzie"). */
  tool: string;
  untitled: string;
  /** Note after a message cut in the middle and at the end of a cut conversation. */
  cutMessage: string;
  capped: string;
}

export interface MarkdownOptions { tools: boolean }

export const agentName = (cli: ConvCli): string => (cli === 'claude' ? 'Claude' : 'Codex');

/** The Markdown of a conversation: a title, its date, project folder and agent, then "## Ty" / "## Claude" sections. */
export function renderConvMarkdown(data: ConvExportData, opts: MarkdownOptions, labels: MarkdownLabels): string {
  const out: string[] = [];
  out.push(`# ${oneLine(data.title) || labels.untitled}`, '');
  const start = data.startedAt ? formatStamp(data.startedAt) : '';
  const end = data.updatedAt ? formatStamp(data.updatedAt) : '';
  if (start) out.push(`- ${labels.date}: ${start}${end && end !== start ? ` - ${end}` : ''}`);
  if (data.cwd) out.push(`- ${labels.folder}: ${inlineCode(data.cwd)}`);
  const product = data.cli === 'claude' ? 'Claude Code' : 'Codex';
  out.push(`- ${labels.agent}: ${product}${data.model ? ` (${data.model})` : ''}`);
  if (data.id) out.push(`- ${labels.session}: ${inlineCode(data.id)}`);
  out.push('', '---');
  let section: ConvRole | null = null;
  let lastTool = false;
  for (const item of data.items) {
    if (item.kind === 'tool' && !opts.tools) continue;
    const role: ConvRole = item.kind === 'tool' ? 'assistant' : item.role;
    if (role !== section) {
      out.push('', `## ${role === 'user' ? labels.you : agentName(data.cli)}`);
      section = role;
      lastTool = false;
    }
    if (item.kind === 'tool') {
      // Consecutive tool calls form one quoted block (each on its own line).
      out.push(lastTool ? '>' : '', `> ${labels.tool}: ${item.name}${item.detail ? ` ${inlineCode(item.detail)}` : ''}`);
      lastTool = true;
    } else {
      out.push('', item.text.replace(/\r\n?/g, '\n').trimEnd() + (item.cut ? ` … _(${labels.cutMessage})_` : ''));
      lastTool = false;
    }
  }
  if (data.capped) out.push('', '---', '', `_${labels.capped}_`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** "Fix the lost tabs 2026-10-24" without characters a file name cannot hold (the extension is added by the save). */
export function exportBaseName(title: string, startedAt: number, fallback: string): string {
  const day = startedAt ? formatStamp(startedAt).slice(0, 10) : '';
  const name = oneLine(title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80).trim() || fallback;
  return day ? `${name} ${day}` : name;
}

/** Text for a note: cut at a line end below `max` characters, with `note` after the cut. */
export function capText(text: string, max: number, note: string): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const room = Math.max(0, max - note.length - 8);
  const at = text.lastIndexOf('\n', room);
  return { text: `${text.slice(0, at > room / 2 ? at : room).trimEnd()}\n\n---\n\n_${note}_\n`, cut: true };
}
