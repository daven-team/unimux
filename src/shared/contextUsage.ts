// How full the context window of a cell's conversation is ("Kontekst 32%" in the card header). Pure: the main process reads
// the transcript (Claude, ~/.claude/projects/<dir>/<session>.jsonl) or the rollout (Codex, ~/.codex/sessions/.../rollout-*.jsonl)
// from the last offset it read and feeds the new lines here. Only token counts, model ids and compaction markers are read,
// never any message text.

export type ContextCli = 'claude' | 'codex';

/** The context of the current conversation: tokens it takes in the window of its model. */
export interface ContextUsage {
  cli: ContextCli;
  tokens: number;
  window: number;
  /** 0-100, rounded down to a whole percent (100 = full). */
  percent: number;
  model?: string;
}

/** What the lines read so far say; updated line by line (a later line wins). */
export interface ContextScan {
  /** Tokens in the context after the latest model call; null when unknown (nothing yet, or a compaction without a count). */
  tokens: number | null;
  model?: string;
  /** Codex states the window of its model itself (model_context_window). */
  window?: number;
  /** A line that sets the tokens was seen (the backward read of a long file stops at the first chunk that has one). */
  seen: boolean;
}

export const emptyScan = (): ContextScan => ({ tokens: null, seen: false });

export const CLAUDE_DEFAULT_WINDOW = 200_000;
const MILLION = 1_000_000;

/**
 * The context window of a Claude model id. Claude Opus / Sonnet 4.6 and later, Haiku 5 and later, Fable and Mythos have
 * 1M tokens; older models (Opus 4.5, Sonnet 4.5, Haiku 4.5, Claude 3.x) 200k, unless the model was asked for with the
 * `[1m]` suffix (Sonnet 4 / 4.5 long context). Unknown ids (a proxy's own names) get 200k: `contextUsage` raises it to 1M
 * once the conversation is visibly larger than that.
 */
export function claudeContextWindow(model: string | undefined, hint?: string): number {
  if (/\[1m\]|-1m\b/i.test(`${model ?? ''} ${hint ?? ''}`)) return MILLION;
  const id = (model ?? '').toLowerCase();
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (!m) return CLAUDE_DEFAULT_WINDOW;
  const family = m[1];
  const version = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  if (family === 'fable' || family === 'mythos') return MILLION;
  if (family === 'haiku') return version >= 5 ? MILLION : CLAUDE_DEFAULT_WINDOW;
  return version >= 4.6 ? MILLION : CLAUDE_DEFAULT_WINDOW;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const MODEL = /^[\w.:@/[\]-]{1,100}$/;
const cleanModel = (v: unknown): string | undefined => (typeof v === 'string' && MODEL.test(v) ? v : undefined);

/** One Claude transcript entry: the main chain's assistant messages carry the usage of their API call. */
export function applyClaudeEntry(scan: ContextScan, entry: unknown): ContextScan {
  if (!entry || typeof entry !== 'object') return scan;
  const e = entry as Record<string, any>;
  // /compact and auto-compaction: the window starts again with the summary (postTokens, when the version records it).
  if (e.type === 'system' && e.subtype === 'compact_boundary') {
    const post = num(e.compactMetadata?.postTokens);
    return { ...scan, tokens: post || null, seen: true };
  }
  if (e.type !== 'assistant' || e.isSidechain === true) return scan;
  const msg = e.message;
  const usage = msg?.usage;
  if (!usage || typeof usage !== 'object') return scan;
  const model = cleanModel(msg.model);
  // API errors are written as "<synthetic>" messages with zero usage: they say nothing about the context.
  if (msg.model === '<synthetic>') return scan;
  const tokens = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens) + num(usage.output_tokens);
  if (!tokens) return scan;
  return { ...scan, tokens, model: model ?? scan.model, seen: true };
}

/** One Codex rollout line: token_count events (last call's usage and the model's window), the turn's model, compactions. */
export function applyCodexEntry(scan: ContextScan, entry: unknown): ContextScan {
  if (!entry || typeof entry !== 'object') return scan;
  const e = entry as Record<string, any>;
  const p = e.payload;
  if (e.type === 'turn_context') {
    const model = cleanModel(p?.model);
    return model ? { ...scan, model } : scan;
  }
  if (e.type === 'compacted') return { ...scan, tokens: null, seen: true };
  if (e.type !== 'event_msg' || p?.type !== 'token_count') return scan;
  const info = p.info;
  if (!info || typeof info !== 'object') return scan; // rate-limit-only events
  const last = info.last_token_usage;
  if (!last || typeof last !== 'object') return scan;
  // Codex's own "context left" counts the last call: its input (cached part included) plus its output.
  const tokens = num(last.total_tokens) || num(last.input_tokens) + num(last.output_tokens);
  const window = num(info.model_context_window);
  return { ...scan, tokens: tokens || null, window: window || scan.window, seen: true };
}

/** Cheap test before JSON.parse: most lines (messages, tool output) can never change the result. */
function relevant(cli: ContextCli, line: string): boolean {
  if (cli === 'claude') return line.includes('"usage"') || line.includes('compact_boundary');
  return line.includes('token_count') || line.includes('"turn_context"') || line.includes('"compacted"');
}

/** Applies every complete line of `text` (a chunk of the file that starts and ends at line boundaries). */
export function scanLines(cli: ContextCli, scan: ContextScan, text: string): ContextScan {
  const apply = cli === 'claude' ? applyClaudeEntry : applyCodexEntry;
  let out = scan;
  for (const line of text.split('\n')) {
    if (!line || !relevant(cli, line)) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; } // garbage or a half-written line
    out = apply(out, entry);
  }
  return out;
}

/** The usage to show; null while the tokens or the window are unknown. `modelHint` is the cell's model setting. */
export function contextUsage(cli: ContextCli, scan: ContextScan, modelHint?: string): ContextUsage | null {
  if (scan.tokens === null || scan.tokens <= 0) return null;
  let window = cli === 'codex' ? scan.window ?? 0 : claudeContextWindow(scan.model, modelHint);
  if (!window) return null;
  // A conversation larger than the table's window runs on a bigger one (a 1M model under an unknown or proxied id).
  if (cli === 'claude' && scan.tokens > window && window < MILLION) window = MILLION;
  const percent = Math.max(0, Math.min(100, Math.floor((scan.tokens / window) * 100)));
  return { cli, tokens: scan.tokens, window, percent, ...(scan.model ? { model: scan.model } : {}) };
}

export type ContextLevel = 'ok' | 'warn' | 'high';

/** Amber above 70%, red above 90%. */
export const contextLevel = (percent: number): ContextLevel => (percent > 90 ? 'high' : percent > 70 ? 'warn' : 'ok');

/** "64 312" (thin groups with a plain space, the same in every language of the app). */
export const groupDigits = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export const sameUsage = (a: ContextUsage | null | undefined, b: ContextUsage | null | undefined): boolean =>
  a === b || (!!a && !!b && a.tokens === b.tokens && a.window === b.window && a.model === b.model && a.cli === b.cli);
