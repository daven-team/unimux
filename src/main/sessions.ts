// Index of past Claude Code / Codex conversations for a project folder.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { open, readdir, stat } from 'fs/promises';
import { join, sep } from 'path';
import type { SessionInfo } from '../shared/types';
import { normalizeProjectPath } from '../shared/platform';

export type { SessionInfo };


const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_CODEX_FILES = 600;
const CONCURRENCY = 4;

/** Claude stores sessions under ~/.claude/projects/<path with every non-alphanumeric char → '-'>. */
export const claudeProjectDirName = (projectPath: string) => projectPath.replace(/[^a-zA-Z0-9]/g, '-');

const normPath = normalizeProjectPath;

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

async function readSliceAsync(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line at a slice boundary or garbage - skip
    }
  }
  return out;
}

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);
const isInjected = (s: string) => /^\s*(<|# AGENTS\.md)/.test(s);
const byUpdated = (a: SessionInfo, b: SessionInfo) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ── Claude ──────────────────────────────────────────────────────────────────

function claudeText(entry: any): string | null {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
  return text && !isInjected(text) ? text : null;
}

interface FileStat { size: number; mtimeMs: number; birthtimeMs: number; ino?: number }

/** What the head of a transcript says; it never changes once the file is at least as long as the head slice. */
interface ClaudeHead {
  id?: string;
  cwd: string;
  firstTs?: string;
  prompt?: string;
  /** The latest /rename and generated titles inside the head slice. */
  custom?: string;
  ai?: string;
  /** The file was at least HEAD_BYTES long when the head was read, so later appends never touch it. */
  complete: boolean;
}

interface ClaudeTail { id?: string; custom?: string; ai?: string }

const lastString = (entries: any[], type: string, key: string): string | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === type && typeof e[key] === 'string' && e[key]) return e[key];
  }
  return undefined;
};

function parseClaudeHead(text: string, size: number): ClaudeHead {
  const head = parseLines(text);
  return {
    id: head.find((e) => typeof e?.sessionId === 'string')?.sessionId,
    cwd: head.find((e) => e?.cwd)?.cwd ?? '',
    firstTs: head.find((e) => e?.timestamp)?.timestamp,
    prompt: head.map(claudeText).find(Boolean) ?? undefined,
    custom: lastString(head, 'custom-title', 'customTitle'),
    ai: lastString(head, 'ai-title', 'aiTitle'),
    complete: size >= HEAD_BYTES,
  };
}

/** The tail is only read for titles (and an id the head lacked): every other line is skipped before JSON.parse. */
function parseClaudeTail(text: string, needId: boolean): ClaudeTail {
  const wanted: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('-title') && !(needId && line.includes('sessionId'))) continue;
    try { wanted.push(JSON.parse(line)); } catch { /* partial line at a slice boundary or garbage - skip */ }
  }
  return {
    id: needId ? wanted.find((e) => typeof e?.sessionId === 'string')?.sessionId : undefined,
    custom: lastString(wanted, 'custom-title', 'customTitle'),
    ai: lastString(wanted, 'ai-title', 'aiTitle'),
  };
}

function claudeInfo(head: ClaudeHead, tail: ClaudeTail, st: FileStat): SessionInfo | null {
  const id = head.id ?? tail.id;
  if (!id) return null;
  // A title the user gave with /rename wins over the generated one; the latest entry of either kind counts.
  const title = tail.custom ?? head.custom ?? tail.ai ?? head.ai ?? head.prompt;
  if (!title) return null; // sessions without any user prompt are noise
  return {
    cli: 'claude',
    id,
    cwd: head.cwd,
    title: clip(title),
    startedAt: head.firstTs ? Date.parse(head.firstTs) : st.birthtimeMs,
    updatedAt: st.mtimeMs,
  };
}

const tailStart = (st: FileStat) => Math.max(0, st.size - TAIL_BYTES);

/** `birthtimeMs` and `ino` tell a replaced transcript (same path, new file) from one that only grew. */
interface ClaudeEntry { mtimeMs: number; size: number; birthtimeMs: number; ino?: number; info: SessionInfo | null; head: ClaudeHead }

/** A grown transcript whose head was complete only needs its tail again (a running agent appends all the time). */
const canReuseHead = (hit: ClaudeEntry | undefined, st: FileStat): hit is ClaudeEntry =>
  !!hit && hit.head.complete && st.size >= hit.size && hit.birthtimeMs === st.birthtimeMs && hit.ino === st.ino;

function readClaudeSession(file: string, st: FileStat, hit?: ClaudeEntry): ClaudeEntry {
  let head: ClaudeHead;
  if (canReuseHead(hit, st)) { head = hit.head; claudeTailReads++; }
  else { head = parseClaudeHead(readSlice(file, 0, HEAD_BYTES), st.size); claudeParses++; }
  const tail = st.size > HEAD_BYTES ? parseClaudeTail(readSlice(file, tailStart(st), TAIL_BYTES), !head.id) : {};
  return { mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs, ino: st.ino, head, info: claudeInfo(head, tail, st) };
}

async function readClaudeSessionAsync(file: string, st: FileStat, hit?: ClaudeEntry): Promise<ClaudeEntry> {
  const reuse = canReuseHead(hit, st);
  if (reuse) claudeTailReads++; else claudeParses++;
  const [headText, tailText] = await Promise.all([
    reuse ? Promise.resolve('') : readSliceAsync(file, 0, HEAD_BYTES),
    st.size > HEAD_BYTES ? readSliceAsync(file, tailStart(st), TAIL_BYTES) : Promise.resolve(''),
  ]);
  const head = reuse ? hit!.head : parseClaudeHead(headText, st.size);
  const tail = st.size > HEAD_BYTES ? parseClaudeTail(tailText, !head.id) : {};
  return { mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs, ino: st.ino, head, info: claudeInfo(head, tail, st) };
}

// Parsed sessions keyed by file; reused while mtime and size are unchanged. Pruned per listed folder.
const claudeCache = new Map<string, ClaudeEntry>();
let claudeParses = 0;
let claudeTailReads = 0;

/** Test hook: how many files were parsed in full (with the head) and tail-only since start, and how many are cached. */
export const claudeCacheStats = () => ({ parses: claudeParses, tailReads: claudeTailReads, cached: claudeCache.size });
export const clearClaudeCache = () => { claudeCache.clear(); claudeParses = 0; claudeTailReads = 0; };

const claudeDir = (home: string, projectPath: string) => join(home, '.claude', 'projects', claudeProjectDirName(projectPath));
const cachedClaude = (file: string, st: FileStat) => {
  const hit = claudeCache.get(file);
  return hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : undefined;
};

/** Drops cache entries of `dir` whose files were not seen in the latest listing. */
function pruneClaudeCache(dir: string, seen: Set<string>): void {
  const prefix = dir + sep;
  for (const key of claudeCache.keys()) if (key.startsWith(prefix) && !seen.has(key)) claudeCache.delete(key);
}

export function listClaudeSessions(home: string, projectPath: string): SessionInfo[] {
  const dir = claudeDir(home, projectPath);
  if (!existsSync(dir)) {
    pruneClaudeCache(dir, new Set());
    return [];
  }
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = join(dir, f);
    try {
      const st = statSync(file);
      seen.add(file);
      let entry = cachedClaude(file, st);
      if (!entry) {
        entry = readClaudeSession(file, st, claudeCache.get(file));
        claudeCache.set(file, entry);
      }
      if (entry.info) out.push(entry.info);
    } catch {
      // unreadable file - skip
    }
  }
  pruneClaudeCache(dir, seen);
  return out.sort(byUpdated);
}

/** Same result as listClaudeSessions, but never blocks the event loop on file IO. */
export async function listClaudeSessionsAsync(home: string, projectPath: string): Promise<SessionInfo[]> {
  return listClaudeDirAsync(claudeDir(home, projectPath));
}

async function listClaudeDirAsync(dir: string): Promise<SessionInfo[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    pruneClaudeCache(dir, new Set());
    return [];
  }
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const file = join(dir, names[next++]);
      try {
        const st = await stat(file);
        seen.add(file);
        let entry = cachedClaude(file, st);
        if (!entry) {
          entry = await readClaudeSessionAsync(file, st, claudeCache.get(file));
          claudeCache.set(file, entry);
        }
        if (entry.info) out.push(entry.info);
      } catch {
        // unreadable file - skip
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  pruneClaudeCache(dir, seen);
  return out.sort(byUpdated);
}

// ── Codex ───────────────────────────────────────────────────────────────────

interface CodexMeta {
  id: string;
  cwd: string;
  timestamp?: string;
}

interface CodexEntry { file: string; mtimeMs: number; meta: CodexMeta | null; title: string | null | undefined }

// Parsed heads keyed by path; reused while the file's mtime is unchanged. Pruned to the files of the latest full listing.
const metaCache = new Map<string, CodexEntry>();
/** Listings of session folders keyed by path, reused while the folder's mtime is unchanged (old day folders never change). */
const dirCache = new Map<string, { mtimeMs: number; dirs: string[]; files: string[] }>();
/** The newest rollout files with their heads, shared by every listing within INDEX_TTL_MS (one refresh asks once per worktree). */
let codexIndex: { home: string; at: number; entries: Promise<CodexEntry[]> } | null = null;
const INDEX_TTL_MS = 2000;
let codexDirReads = 0;

/** Test hooks. */
export const codexCacheStats = () => ({ dirReads: codexDirReads, cachedDirs: dirCache.size, cachedFiles: metaCache.size });
export const clearCodexCache = () => { metaCache.clear(); dirCache.clear(); codexIndex = null; codexDirReads = 0; };

async function codexMeta(file: string): Promise<CodexMeta | null> {
  // The first line (session_meta) carries the id and cwd; it can be tens of KB.
  for (let size = 64 * 1024; size <= 1024 * 1024; size *= 4) {
    const text = await readSliceAsync(file, 0, size);
    const nl = text.indexOf('\n');
    if (nl < 0 && text.length === size) continue;
    try {
      const first = JSON.parse(nl < 0 ? text : text.slice(0, nl));
      if (first?.type !== 'session_meta') return null;
      const p = first.payload ?? {};
      const id = p.id ?? p.session_id;
      return id ? { id, cwd: p.cwd ?? '', timestamp: p.timestamp } : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function codexTitle(file: string): Promise<string | null> {
  for (const e of parseLines(await readSliceAsync(file, 0, HEAD_BYTES))) {
    if (e?.type === 'event_msg' && e.payload?.type === 'user_message' && typeof e.payload.message === 'string' && !isInjected(e.payload.message))
      return e.payload.message;
    if (e?.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'user' && Array.isArray(e.payload.content)) {
      const text = e.payload.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).find((t: string) => t && !isInjected(t));
      if (text) return text;
    }
  }
  return null;
}

const descending = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

async function listDir(dir: string): Promise<{ dirs: string[]; files: string[] }> {
  const { mtimeMs } = await stat(dir);
  const hit = dirCache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  codexDirReads++;
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.name.endsWith('.jsonl')) files.push(e.name);
  }
  const entry = { mtimeMs, dirs: dirs.sort(descending), files: files.sort(descending) };
  dirCache.set(dir, entry);
  return entry;
}

/**
 * The newest `limit` rollout files. Paths are YYYY/MM/DD/rollout-<timestamp>-..., so walking every level in descending name
 * order yields them newest first, and the walk stops as soon as it has enough (old day folders are not even listed).
 */
async function codexFiles(home: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let listing;
    try { listing = await listDir(dir); } catch { dirCache.delete(dir); return; }
    for (const name of listing.files) {
      if (out.length >= limit) return;
      out.push(join(dir, name));
    }
    for (const name of listing.dirs) {
      if (out.length >= limit) return;
      await walk(join(dir, name));
    }
  };
  await walk(join(home, '.codex', 'sessions'));
  return out;
}

async function codexEntry(file: string): Promise<CodexEntry | null> {
  try {
    const { mtimeMs } = await stat(file);
    let entry = metaCache.get(file);
    if (!entry || entry.mtimeMs !== mtimeMs) {
      entry = { file, mtimeMs, meta: await codexMeta(file), title: undefined };
      metaCache.set(file, entry);
    }
    return entry;
  } catch {
    metaCache.delete(file);
    return null;
  }
}

async function readCodexEntries(home: string, limit: number): Promise<CodexEntry[]> {
  const files = await codexFiles(home, limit);
  const entries: Array<CodexEntry | null> = new Array(files.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      entries[i] = await codexEntry(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  if (limit >= MAX_CODEX_FILES) {
    const seen = new Set(files);
    for (const key of metaCache.keys()) if (!seen.has(key)) metaCache.delete(key);
  }
  return entries.filter((e): e is CodexEntry => !!e);
}

/** The shared index of the newest MAX_CODEX_FILES sessions (rebuilt at most every INDEX_TTL_MS; concurrent callers share it). */
function codexIndexFor(home: string): Promise<CodexEntry[]> {
  const now = Date.now();
  if (codexIndex && codexIndex.home === home && now - codexIndex.at < INDEX_TTL_MS) return codexIndex.entries;
  const entries = readCodexEntries(home, MAX_CODEX_FILES);
  const current = { home, at: now, entries };
  codexIndex = current;
  entries.catch(() => { if (codexIndex === current) codexIndex = null; });
  return entries;
}

export async function listCodexSessionsAsync(home: string, projectPath: string): Promise<SessionInfo[]> {
  const want = normPath(projectPath);
  return listCodexWhere(home, (cwd) => cwd === want);
}

/** Codex sessions whose normalized cwd passes `wanted`. */
async function listCodexWhere(home: string, wanted: (cwd: string) => boolean): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const entry of await codexIndexFor(home)) {
    const { meta } = entry;
    if (!meta || !wanted(normPath(meta.cwd))) continue;
    if (entry.title === undefined) {
      try { entry.title = await codexTitle(entry.file); } catch { continue; }
    }
    if (!entry.title) continue;
    out.push({
      cli: 'codex',
      id: meta.id,
      cwd: meta.cwd,
      title: clip(entry.title),
      startedAt: meta.timestamp ? Date.parse(meta.timestamp) : entry.mtimeMs,
      updatedAt: entry.mtimeMs,
    });
  }
  return out.sort(byUpdated);
}

/**
 * Codex session for `cwd` written within the last `windowMs` and not bound elsewhere - called right after a Codex cell
 * finished a turn, when its rollout file was just appended to (so it reads the newest files itself, never the shared index).
 */
export async function findRecentCodexSession(home: string, cwd: string, windowMs: number, exclude: Set<string>): Promise<string | null> {
  const want = normPath(cwd);
  const since = Date.now() - windowMs;
  let best: { id: string; mtimeMs: number } | null = null;
  for (const { meta, mtimeMs } of await readCodexEntries(home, 80)) {
    if (mtimeMs < since || !meta || exclude.has(meta.id) || normPath(meta.cwd) !== want) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { id: meta.id, mtimeMs };
  }
  return best?.id ?? null;
}

/** A worktree of the project main knows from its cells (open or in closed grids). */
export interface WorktreeHint { path: string; branch: string }

const splitPath = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return { parent: cut < 0 ? '' : trimmed.slice(0, cut), name: trimmed.slice(cut + 1) };
};

/**
 * Tells whether a (normalized) cwd is a worktree folder of the project: one of the known worktrees, or a sibling named
 * `<project folder>-wt-<name>` the way createWorktree (src/main/worktree.ts) names them, so removed ones count too.
 */
export function worktreeMatcher(projectPath: string, known: WorktreeHint[]): (cwd: string) => boolean {
  const project = splitPath(projectPath);
  const prefix = normPath(`${project.parent}/${project.name}-wt-`);
  const exact = new Set(known.map((w) => normPath(w.path)));
  const self = normPath(projectPath);
  return (cwd) => cwd !== self && (exact.has(cwd) || (cwd.startsWith(prefix) && cwd.length > prefix.length && !/[\\/]/.test(cwd.slice(prefix.length))));
}

/** The current branch of an existing worktree folder (for a resumed cell); undefined when git cannot tell. */
export type BranchOf = (path: string) => Promise<string | undefined>;

/**
 * Non-blocking listing for the IPC handler: the project's own conversations and those held in its worktree folders
 * (labelled with the worktree branch or folder name, with `exists` false for a removed folder).
 */
export async function listSessionsAsync(home: string, projectPath: string, worktrees: WorktreeHint[] = [], branchOf?: BranchOf): Promise<SessionInfo[]> {
  const isWorktree = worktreeMatcher(projectPath, worktrees);
  const [claude, codex, claudeWt, codexWt] = await Promise.all([
    listClaudeSessionsAsync(home, projectPath),
    listCodexSessionsAsync(home, projectPath),
    listClaudeWorktreesAsync(home, projectPath, worktrees, isWorktree),
    listCodexWhere(home, isWorktree),
  ]);
  const known = new Map(worktrees.map((w) => [normPath(w.path), w.branch]));
  const branches = new Map<string, Promise<string | undefined>>();
  const labelled = await Promise.all([...claudeWt, ...codexWt].map(async (info) => {
    const key = normPath(info.cwd);
    const exists = existsSync(info.cwd);
    let branch = known.get(key);
    if (!branch && exists && branchOf) {
      if (!branches.has(key)) branches.set(key, branchOf(info.cwd).catch(() => undefined));
      branch = await branches.get(key);
    }
    return { ...info, worktree: { path: info.cwd, label: branch ?? splitPath(info.cwd).name, exists, ...(branch ? { branch } : {}) } };
  }));
  return [...claude, ...codex, ...labelled].sort(byUpdated);
}

/** Claude sessions of the worktree folders: the session folders whose encoded name can belong to one, checked by their cwd. */
async function listClaudeWorktreesAsync(home: string, projectPath: string, worktrees: WorktreeHint[], isWorktree: (cwd: string) => boolean): Promise<SessionInfo[]> {
  const root = join(home, '.claude', 'projects');
  const project = splitPath(projectPath);
  const prefix = claudeProjectDirName(`${project.parent}/${project.name}-wt-`);
  const exact = new Set(worktrees.map((w) => claudeProjectDirName(w.path)));
  const own = claudeProjectDirName(projectPath);
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const dirs = names.filter((name) => name !== own && (exact.has(name) || (name.startsWith(prefix) && name.length > prefix.length)));
  const lists = await Promise.all(dirs.map((name) => listClaudeDirAsync(join(root, name))));
  // The encoding is lossy (every non-alphanumeric character becomes '-'): the cwd recorded in the session decides.
  return lists.flat().filter((info) => !!info.cwd && isWorktree(normPath(info.cwd)));
}
