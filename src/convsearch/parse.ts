// Reading Claude Code and Codex transcripts for the conversation search (1.0.9). A transcript is JSONL; most of its bytes
// are tool calls, tool output, request blobs and reasoning, so every line is first checked on its raw bytes and only the few
// that can hold a user or assistant text (or a title, the cwd, the model) are decoded and parsed. Malformed lines are skipped.
import type { ConvCli, ConvRole } from '../shared/convSearch';

/** What a transcript says about itself. */
export interface ConvMeta {
  id?: string;
  cwd: string;
  firstTs: number;
  lastTs: number;
  model?: string;
  /** A /rename title and a generated one (Claude), the latest of each kind. */
  custom?: string;
  ai?: string;
  /** The first real prompt. */
  prompt?: string;
}

export const newMeta = (): ConvMeta => ({ cwd: '', firstTs: 0, lastTs: 0 });

export type MessageSink = (role: ConvRole, text: string, ts: number) => void;

const bytes = (s: string) => Buffer.from(s, 'latin1');
const has = (buf: Buffer, start: number, end: number, needle: Buffer) => buf.subarray(start, end).indexOf(needle) >= 0;

const C_USER = bytes('"type":"user"');
const C_ASSISTANT = bytes('"type":"assistant"');
const C_TOOL_RESULT = bytes('"type":"tool_result"');
const C_TEXT = bytes('"type":"text"');
const C_TITLE = bytes('-title"');
const X_META = bytes('"type":"session_meta"');
const X_TURN = bytes('"type":"turn_context"');
const X_ITEM = bytes('"type":"response_item"');
const X_MESSAGE = bytes('"type":"message"');
const X_DEVELOPER = bytes('"role":"developer"');
const X_SYSTEM = bytes('"role":"system"');

/** Can this raw Claude line hold something the index wants? (Decoding and parsing every line would cost ten times more.) */
export function claudeWanted(buf: Buffer, start: number, end: number): boolean {
  if (end - start < 20) return false;
  if (has(buf, start, end, C_ASSISTANT)) return has(buf, start, end, C_TEXT);
  if (has(buf, start, end, C_USER)) return !has(buf, start, end, C_TOOL_RESULT);
  return has(buf, start, end, C_TITLE);
}

export function codexWanted(buf: Buffer, start: number, end: number): boolean {
  if (end - start < 20) return false;
  if (has(buf, start, end, X_ITEM)) return has(buf, start, end, X_MESSAGE) && !has(buf, start, end, X_DEVELOPER) && !has(buf, start, end, X_SYSTEM);
  return has(buf, start, end, X_META) || has(buf, start, end, X_TURN);
}

export const wantedFor = (cli: ConvCli) => (cli === 'claude' ? claudeWanted : codexWanted);

/** Text the CLI or the app injects as a "user" message (command output, reminders, AGENTS.md, interruptions). */
export const isInjected = (s: string) => /^\s*(<|# AGENTS\.md|\[Request interrupted)/.test(s);

const tsOf = (e: any): number => {
  const t = typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
};

function seen(meta: ConvMeta, ts: number): void {
  if (!ts) return;
  if (!meta.firstTs || ts < meta.firstTs) meta.firstTs = ts;
  if (ts > meta.lastTs) meta.lastTs = ts;
}

const textParts = (content: unknown, types: string[]): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) if (part && types.includes(part.type) && typeof part.text === 'string') out.push(part.text);
  return out;
};

function userPrompt(meta: ConvMeta, text: string): void {
  if (!meta.prompt) meta.prompt = text;
}

/** One parsed Claude line. */
export function claudeEntry(meta: ConvMeta, e: any, sink: MessageSink): void {
  if (!e || typeof e !== 'object') return;
  if (!meta.id && typeof e.sessionId === 'string' && e.sessionId) meta.id = e.sessionId;
  if (!meta.cwd && typeof e.cwd === 'string' && e.cwd) meta.cwd = e.cwd;
  if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) { meta.custom = e.customTitle; return; }
  if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) { meta.ai = e.aiTitle; return; }
  if (e.type !== 'user' && e.type !== 'assistant') return;
  if (e.isSidechain || e.isMeta || e.isApiErrorMessage) return;
  const ts = tsOf(e);
  seen(meta, ts);
  const msg = e.message;
  if (!msg) return;
  if (e.type === 'assistant') {
    if (typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<')) meta.model = msg.model;
    const text = textParts(msg.content, ['text']).join('\n\n').trim();
    if (text) sink('assistant', text, ts);
    return;
  }
  const text = textParts(msg.content, ['text']).filter((t) => !isInjected(t)).join('\n\n').trim();
  if (!text || isInjected(text)) return;
  userPrompt(meta, text);
  sink('user', text, ts);
}

/** One parsed Codex line. Messages come from response_item (the model's input and output); event_msg copies are skipped. */
export function codexEntry(meta: ConvMeta, e: any, sink: MessageSink): void {
  if (!e || typeof e !== 'object') return;
  const p = e.payload;
  if (!p || typeof p !== 'object') return;
  const ts = tsOf(e);
  if (e.type === 'session_meta') {
    const id = p.id ?? p.session_id;
    if (!meta.id && typeof id === 'string') meta.id = id;
    if (typeof p.cwd === 'string' && p.cwd) meta.cwd = p.cwd;
    const started = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
    seen(meta, Number.isFinite(started) ? started : ts);
    if (typeof p.model === 'string' && p.model) meta.model = p.model;
    return;
  }
  if (e.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) meta.model = p.model;
    if (!meta.cwd && typeof p.cwd === 'string') meta.cwd = p.cwd;
    return;
  }
  if (e.type !== 'response_item' || p.type !== 'message') return;
  if (p.role !== 'user' && p.role !== 'assistant') return;
  seen(meta, ts);
  if (p.role === 'assistant') {
    const text = textParts(p.content, ['output_text', 'text']).join('\n\n').trim();
    if (text) sink('assistant', text, ts);
    return;
  }
  const text = textParts(p.content, ['input_text', 'text']).filter((t) => !isInjected(t)).join('\n\n').trim();
  if (!text) return;
  userPrompt(meta, text);
  sink('user', text, ts);
}

export const entryFor = (cli: ConvCli) => (cli === 'claude' ? claudeEntry : codexEntry);

/**
 * Feeds one raw line: checked on its bytes, decoded and parsed only when it can matter. Returns whether it was a complete,
 * wanted JSON line (a trailing line without a newline counts as read only then).
 */
export function feedLine(cli: ConvCli, meta: ConvMeta, buf: Buffer, start: number, end: number, sink: MessageSink): boolean {
  // An assistant line without text still names the model while none is known (a session of tool calls only).
  const wanted = wantedFor(cli)(buf, start, end) || (cli === 'claude' && !meta.model && end - start > 20 && has(buf, start, end, C_ASSISTANT));
  if (!wanted) return false;
  let e: unknown;
  try { e = JSON.parse(buf.toString('utf8', start, end)); } catch { return false; }
  try { entryFor(cli)(meta, e, sink); } catch { /* an odd shape - skip the line */ }
  return true;
}

/** The longest line the reader keeps (longer ones are huge tool output or pasted images; they are skipped). */
export const MAX_LINE = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export interface ReadableFile { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }

/**
 * Streams the lines of a file from byte `from` (a line start) to its end. Returns the offset after the last line that was
 * read whole: the next read of a grown (append-only) file starts there.
 */
export async function readLines(file: ReadableFile, from: number, onLine: (buf: Buffer, start: number, end: number) => boolean, maxLine = MAX_LINE, sizeHint?: number): Promise<number> {
  // A small file gets a buffer of its size (most transcripts are far below a chunk).
  const size = sizeHint === undefined ? CHUNK : Math.max(4096, Math.min(CHUNK, sizeHint - from + 1));
  const buf = Buffer.allocUnsafe(size);
  let pos = from;
  let consumed = from;
  let carry: Buffer | null = null;
  let skipping = false;
  for (;;) {
    const { bytesRead } = await file.read(buf, 0, size, pos);
    if (!bytesRead) break;
    const data = buf.subarray(0, bytesRead);
    const base = pos;
    pos += bytesRead;
    let s = 0;
    for (;;) {
      const nl = data.indexOf(10, s);
      if (nl < 0) break;
      if (skipping) skipping = false;
      else if (carry) {
        const line: Buffer = Buffer.concat([carry, data.subarray(s, nl)]);
        carry = null;
        if (line.length <= maxLine) onLine(line, 0, line.length);
      } else onLine(data, s, nl);
      s = nl + 1;
      consumed = base + s;
    }
    if (s < data.length && !skipping) {
      const rest = data.subarray(s);
      if ((carry?.length ?? 0) + rest.length > maxLine) { carry = null; skipping = true; }
      else carry = carry ? Buffer.concat([carry, rest]) : Buffer.from(rest);
    }
  }
  // The last line has no newline yet: it counts only when it is already a whole line.
  if (carry && !skipping && onLine(carry, 0, carry.length)) consumed = pos;
  return consumed;
}
