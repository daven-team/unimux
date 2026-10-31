// The conversation index (1.0.9): every Claude Code transcript (<claude dir>/projects/<folder>/<session>.jsonl) and every
// Codex rollout (<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl), reduced to their user and assistant texts. It runs in a
// worker thread. A pass lists the folders and stats the files; only new and changed files are read, and a file that only grew
// (transcripts are append-only) is read from where the last pass stopped. The index is saved to a cache file between runs.
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { deserialize, serialize } from 'v8';
import {
  fold, INDEX_LIMITS, MESSAGE_SEP, searchDocs, TRANSCRIPT_LIMITS,
  type ConvCli, type ConvDoc, type ConvQuery, type ConvRole, type ConvSearchResult, type ConvTranscript, type ConvTranscriptMessage,
} from '../shared/convSearch';
import { feedLine, newMeta, readLines, type ConvMeta } from './parse';

export interface IndexerOptions {
  /** Claude config folders (CLAUDE_CONFIG_DIR or ~/.claude); their `projects` subfolder is read. */
  claudeRoots: string[];
  /** Codex homes (CODEX_HOME or ~/.codex); their `sessions` subfolder is read. */
  codexRoots: string[];
  cacheFile?: string;
  now?: () => number;
  /** A pass started within this long after the last one is not repeated (a search per keystroke must not stat every file). */
  freshMs?: number;
}

interface DocState extends ConvDoc { meta: ConvMeta; len: number; visible: boolean }

interface Entry { file: string; cli: ConvCli; size: number; mtimeMs: number; birthtimeMs: number; ino: number; offset: number; doc: DocState }

const CACHE_VERSION = 1;
const STAT_CONCURRENCY = 24;
const READ_CONCURRENCY = 6;
/** The cache is written after a pass that read at least this many files in full (and when the worker shuts down). */
const SAVE_AFTER_PARSES = 8;

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160);

function emptyDoc(cli: ConvCli, file: string): DocState {
  return {
    cli, file, id: '', cwd: '', title: '', startedAt: 0, updatedAt: 0, text: '', folded: '', starts: [], roles: '', times: [],
    capped: false, meta: newMeta(), len: 0, visible: false,
  };
}

/** Runs `fn` over `items` with at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * Reads a transcript from `from` into `doc`, adding its messages under the index limits. Returns the new offset.
 * Exported for the tests.
 */
export async function readInto(file: string, from: number, doc: DocState, limits = INDEX_LIMITS, sizeHint?: number): Promise<number> {
  const fh = await open(file, 'r');
  const texts: string[] = [];
  const sink = (role: ConvRole, text: string, ts: number) => {
    if (doc.capped) return;
    const cut = text.length > limits.messageChars ? text.slice(0, limits.messageChars) : text;
    const start = doc.starts.length ? doc.len + 1 : 0;
    if (start + cut.length > limits.docChars) { doc.capped = true; return; }
    doc.starts.push(start);
    doc.roles += role === 'user' ? 'u' : 'a';
    doc.times.push(ts);
    doc.len = start + cut.length;
    texts.push(cut);
  };
  let offset = from;
  try {
    offset = await readLines(fh, from, (buf, s, e) => feedLine(doc.cli, doc.meta, buf, s, e, sink), undefined, sizeHint);
  } finally {
    await fh.close();
  }
  if (texts.length) {
    const added = texts.join(MESSAGE_SEP);
    const sep = doc.text ? MESSAGE_SEP : '';
    doc.text += sep + added;
    doc.folded += sep + fold(added);
  }
  return offset;
}

function finish(doc: DocState, mtimeMs: number, birthtimeMs: number): void {
  const m = doc.meta;
  doc.id = m.id ?? '';
  doc.cwd = m.cwd;
  doc.title = clip(m.custom ?? m.ai ?? m.prompt ?? '');
  doc.startedAt = m.firstTs || birthtimeMs || mtimeMs;
  doc.updatedAt = Math.max(mtimeMs, m.lastTs);
  if (m.model) doc.model = m.model;
  // Sessions without an id or any prompt (a CLI opened and closed) are noise, as in the History list.
  doc.visible = !!doc.id && !!doc.title && doc.starts.length > 0;
}

interface Listed { file: string; cli: ConvCli }

async function listClaude(root: string): Promise<Listed[]> {
  const base = join(root, 'projects');
  let dirs: string[];
  try { dirs = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out: Listed[] = [];
  await pool(dirs, 8, async (name) => {
    try {
      for (const f of await readdir(join(base, name), { withFileTypes: true })) {
        // Only the conversations themselves: subagent transcripts live in subfolders and cannot be resumed.
        if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: join(base, name, f.name), cli: 'claude' });
      }
    } catch { /* unreadable folder - skip */ }
  });
  return out;
}

async function listCodex(root: string): Promise<Listed[]> {
  const out: Listed[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory() && depth < 4) await walk(join(dir, it.name), depth + 1);
      else if (it.isFile() && it.name.startsWith('rollout-') && it.name.endsWith('.jsonl')) out.push({ file: join(dir, it.name), cli: 'codex' });
    }
  };
  await walk(join(root, 'sessions'), 0);
  return out;
}

export class ConvIndexer {
  private entries = new Map<string, Entry>();
  private passPromise: Promise<void> | null = null;
  private lastPassAt = 0;
  private progress: { done: number; total: number } | null = null;
  private parsesSinceSave = 0;
  private loaded: Promise<void> | null = null;
  /** Counters for the tests and the timing report. */
  stats = { passes: 0, fullReads: 0, appendReads: 0, bytesRead: 0, lastPassMs: 0 };

  constructor(private readonly opts: IndexerOptions) {}

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  /** Loads the saved index once (a missing, old or broken cache file just means a full first pass). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.opts.cacheFile) return;
      try {
        const data = deserialize(await readFile(this.opts.cacheFile)) as { version: number; entries: Entry[] };
        if (data?.version !== CACHE_VERSION || !Array.isArray(data.entries)) return;
        for (const e of data.entries) if (e?.file && e.doc) this.entries.set(e.file, e);
      } catch { /* no cache yet */ }
    })();
    return this.loaded;
  }

  async save(): Promise<void> {
    const file = this.opts.cacheFile;
    if (!file) return;
    this.parsesSinceSave = 0;
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, serialize({ version: CACHE_VERSION, entries: [...this.entries.values()] }));
      await rename(tmp, file);
    } catch { /* the next pass rebuilds what is missing */ }
  }

  get dirty(): boolean { return this.parsesSinceSave > 0; }
  get indexing(): { done: number; total: number } | null { return this.passPromise ? (this.progress ?? { done: 0, total: 0 }) : null; }

  /** Starts a pass unless one runs or the last one is fresh; resolves when the current pass ends. */
  refresh(force = false): Promise<void> {
    if (this.passPromise) return this.passPromise;
    if (!force && this.lastPassAt && this.now() - this.lastPassAt < (this.opts.freshMs ?? 4000)) return Promise.resolve();
    const run = this.pass().finally(() => { this.passPromise = null; this.progress = null; this.lastPassAt = this.now(); });
    this.passPromise = run;
    return run;
  }

  private async pass(): Promise<void> {
    await this.load();
    const started = this.now();
    this.stats.passes++;
    const lists = await Promise.all([...this.opts.claudeRoots.map(listClaude), ...this.opts.codexRoots.map(listCodex)]);
    const listed = new Map<string, Listed>();
    for (const l of lists.flat()) listed.set(l.file, l);
    for (const key of this.entries.keys()) if (!listed.has(key)) this.entries.delete(key);
    const changed: Array<{ l: Listed; st: { size: number; mtimeMs: number; birthtimeMs: number; ino: number } }> = [];
    await pool([...listed.values()], STAT_CONCURRENCY, async (l) => {
      try {
        const st = await stat(l.file);
        const hit = this.entries.get(l.file);
        if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return;
        changed.push({ l, st: { size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, ino: Number(st.ino) } });
      } catch { this.entries.delete(l.file); }
    });
    // Newest first: the conversations the user most likely looks for are searchable first.
    changed.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    this.progress = { done: 0, total: changed.length };
    await pool(changed, READ_CONCURRENCY, async ({ l, st }) => {
      try { await this.readEntry(l, st); } catch { /* unreadable now - the next pass tries again */ }
      if (this.progress) this.progress.done++;
    });
    this.stats.lastPassMs = this.now() - started;
    if (this.parsesSinceSave >= SAVE_AFTER_PARSES) await this.save();
  }

  private async readEntry(l: Listed, st: { size: number; mtimeMs: number; birthtimeMs: number; ino: number }): Promise<void> {
    const hit = this.entries.get(l.file);
    // A file that only grew keeps what was read; a replaced or shortened one is read again from the start.
    const append = !!hit && st.size >= hit.size && hit.ino === st.ino && hit.birthtimeMs === st.birthtimeMs && hit.cli === l.cli;
    const doc = append ? structuredCloneDoc(hit!.doc) : emptyDoc(l.cli, l.file);
    const from = append ? hit!.offset : 0;
    const offset = await readInto(l.file, from, doc, INDEX_LIMITS, st.size);
    this.stats.bytesRead += Math.max(0, offset - from);
    if (append) this.stats.appendReads++; else { this.stats.fullReads++; this.parsesSinceSave++; }
    finish(doc, st.mtimeMs, st.birthtimeMs);
    this.entries.set(l.file, { file: l.file, cli: l.cli, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, ino: st.ino, offset, doc });
  }

  /** The indexed conversations (a conversation copied to a second file counts once: the newest file). */
  *docs(): Iterable<ConvDoc> {
    const byId = new Map<string, DocState>();
    for (const { doc } of this.entries.values()) {
      if (!doc.visible) continue;
      const key = `${doc.cli}:${doc.id}`;
      const other = byId.get(key);
      if (!other || other.updatedAt < doc.updatedAt) byId.set(key, doc);
    }
    yield* byId.values();
  }

  search(query: ConvQuery): ConvSearchResult {
    const started = this.now();
    const result = searchDocs(this.docs(), query);
    return { ...result, indexing: this.indexing, tookMs: this.now() - started };
  }

  /** The whole conversation of an indexed file, read again with the larger preview limits. */
  async transcript(file: string): Promise<ConvTranscript> {
    const entry = this.entries.get(file);
    if (!entry) return { ok: false, messages: [], capped: false, error: 'unknown' };
    const doc = emptyDoc(entry.cli, file);
    const messages: ConvTranscriptMessage[] = [];
    try {
      const fh = await open(file, 'r');
      try {
        let total = 0;
        await readLines(fh, 0, (buf, s, e) => feedLine(entry.cli, doc.meta, buf, s, e, (role, text, ts) => {
          if (doc.capped) return;
          const cut = text.length > TRANSCRIPT_LIMITS.messageChars;
          const kept = cut ? text.slice(0, TRANSCRIPT_LIMITS.messageChars) : text;
          if (total + kept.length > TRANSCRIPT_LIMITS.docChars) { doc.capped = true; return; }
          total += kept.length;
          messages.push({ role, text: kept, ts, cut });
        }));
      } finally { await fh.close(); }
    } catch (error) {
      return { ok: false, messages: [], capped: false, error: String((error as Error)?.message ?? error) };
    }
    return { ok: true, messages, capped: doc.capped };
  }

  /** The CLI of an indexed file (undefined for a file the index does not know: nothing else is read on request). */
  cliOf(file: string): ConvCli | undefined { return this.entries.get(file)?.cli; }

  /** The newest indexed file of a session, if the index holds it. */
  fileOf(cli: ConvCli, id: string): string | null {
    let best: Entry | null = null;
    for (const e of this.entries.values()) if (e.cli === cli && e.doc.id === id && (!best || e.mtimeMs > best.mtimeMs)) best = e;
    return best?.file ?? null;
  }

  /** Test hook. */
  size(): number { return this.entries.size; }
}

/** A copy of a document that a read may extend while searches still see the old one. */
function structuredCloneDoc(doc: DocState): DocState {
  return { ...doc, meta: { ...doc.meta }, starts: doc.starts.slice(), times: doc.times.slice() };
}
