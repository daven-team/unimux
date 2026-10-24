// Context window usage of each Claude / Codex cell's conversation (see shared/contextUsage.ts). Nothing polls: a hook or
// notify of the cell (a tool call, a turn end, a compaction) asks for a refresh, which reads only what the transcript gained
// since the last read. The first read of a conversation goes backwards from the end of the file until it finds a usage line,
// so a long transcript is never read whole.
import { open, readdir, stat } from 'fs/promises';
import { basename, isAbsolute, join } from 'path';
import { contextUsage, emptyScan, sameUsage, scanLines, type ContextCli, type ContextScan, type ContextUsage } from '../shared/contextUsage';
import { claudeProjectDirName } from './sessions';

/** What the tracker needs to know about a cell; null when it has no agent conversation (shell, SSH, no session yet). */
export interface ContextTarget {
  cli: ContextCli;
  sessionId: string;
  cwd: string;
  /** The cell's model setting (a `[1m]` suffix asks for the long window). */
  modelHint?: string;
}

export interface ContextTrackerDeps {
  target(cellId: string): ContextTarget | null;
  /** The usage of a cell changed (null: no longer known). */
  emit(cellId: string, usage: ContextUsage | null): void;
  /** Claude's config folder (CLAUDE_CONFIG_DIR or ~/.claude). */
  claudeDir(): string;
  /** Codex's home (CODEX_HOME or ~/.codex). */
  codexHome(): string;
}

/** The first backward read; it doubles until a usage line is found. */
const FIRST_CHUNK = 256 * 1024;
/** Lines can be long (a tool call with a whole file): a chunk without a line end grows up to this. */
const MAX_CHUNK = 16 * 1024 * 1024;
/** The backward read gives up after this much of a file without any usage line. */
const MAX_BACKWARD = 64 * 1024 * 1024;
/** A file that grew by more than this since the last read is read backwards again instead of forwards. */
const MAX_FORWARD = 8 * 1024 * 1024;
/** Hooks come in bursts (every tool call): one refresh per cell at most this often. */
const THROTTLE_MS = 800;
/** A turn end: the last message may land in the file just after the hook, so the file is read once more a bit later. */
const SETTLE_MS = 2500;
const MAX_CODEX_FILES = 5000;

interface Entry {
  key: string;
  file: string;
  /** Byte offset of the first line not read yet (always at a line start). */
  offset: number;
  ino?: number;
  birthtimeMs: number;
  scan: ContextScan;
  usage: ContextUsage | null;
}

type Handle = Awaited<ReturnType<typeof open>>;

async function readAt(fh: Handle, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  return buf.subarray(0, bytesRead);
}

/**
 * Reads the file backwards from `size` in growing chunks of whole lines until one of them sets the tokens. Returns that
 * state and the offset just after the last complete line of the file (a line being written stays for the next read).
 */
export async function scanBackwards(fh: Handle, size: number, cli: ContextCli): Promise<{ scan: ContextScan; offset: number }> {
  let end = size;
  let want = FIRST_CHUNK;
  let offset = -1;
  /** The newest model named at or after the usage line (Codex names it once per turn, in the turn context). */
  let model: string | undefined;
  let found: ContextScan | null = null;
  while (end > 0 && size - end < MAX_BACKWARD) {
    const start = Math.max(0, end - want);
    const buf = await readAt(fh, start, end - start);
    let from = 0;
    if (start > 0) {
      const nl = buf.indexOf(10);
      if (nl < 0) { // one line longer than the chunk
        if (want >= MAX_CHUNK) break;
        want *= 2;
        continue;
      }
      from = nl + 1;
    }
    let to = buf.length;
    if (offset < 0) {
      const last = buf.lastIndexOf(10);
      to = last < from ? from : last + 1;
      offset = start + to;
    }
    const scan = scanLines(cli, emptyScan(), buf.subarray(from, to).toString('utf8'));
    model ??= scan.model;
    if (!found && scan.seen) found = scan;
    // Claude names the model on the usage line itself; a Codex usage line may need an earlier turn context for it.
    if (found && (model || cli === 'claude')) break;
    end = start + from;
    want = Math.min(want * 2, MAX_CHUNK);
  }
  const scan = found ?? emptyScan();
  return { scan: model ? { ...scan, model } : scan, offset: Math.max(0, offset) };
}

export class ContextTracker {
  private entries = new Map<string, Entry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private settle = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<ContextUsage | null>>();
  private again = new Set<string>();
  private shown = new Map<string, ContextUsage | null>();
  /** Transcript paths the hooks reported, by session id (Claude writes them where its config folder is, per account). */
  private transcripts = new Map<string, string>();
  private codexFiles = new Map<string, string>();
  reads = 0;

  constructor(private readonly deps: ContextTrackerDeps) {}

  /** A Claude hook payload named the session's transcript. Accepted only as `<session id>.jsonl` at an absolute path. */
  noteTranscript(sessionId: string, path: string): void {
    if (!isAbsolute(path) || basename(path).toLowerCase() !== `${sessionId.toLowerCase()}.jsonl`) return;
    this.transcripts.set(sessionId.toLowerCase(), path);
  }

  /** The current usage of a cell (read now). */
  get(cellId: string): Promise<ContextUsage | null> {
    return this.refresh(cellId);
  }

  /** Something happened in the cell: read its file soon (throttled). `turnEnd` reads once more after the file settled. */
  poke(cellId: string, turnEnd = false): void {
    if (!this.timers.has(cellId)) {
      this.timers.set(cellId, setTimeout(() => { this.timers.delete(cellId); void this.refresh(cellId); }, THROTTLE_MS));
    }
    if (turnEnd) {
      clearTimeout(this.settle.get(cellId));
      this.settle.set(cellId, setTimeout(() => { this.settle.delete(cellId); void this.refresh(cellId); }, SETTLE_MS));
    }
  }

  forget(cellId: string): void {
    clearTimeout(this.timers.get(cellId));
    clearTimeout(this.settle.get(cellId));
    this.timers.delete(cellId);
    this.settle.delete(cellId);
    this.entries.delete(cellId);
    this.shown.delete(cellId);
  }

  /** The last usage sent for a cell (automation's list_agents). */
  current(cellId: string): ContextUsage | null {
    return this.shown.get(cellId) ?? null;
  }

  private refresh(cellId: string): Promise<ContextUsage | null> {
    const busy = this.running.get(cellId);
    if (busy) { this.again.add(cellId); return busy; }
    const run = this.read(cellId).catch(() => null).then((usage) => {
      this.running.delete(cellId);
      if (!sameUsage(this.shown.get(cellId) ?? null, usage)) {
        this.shown.set(cellId, usage);
        this.deps.emit(cellId, usage);
      }
      if (this.again.delete(cellId)) void this.refresh(cellId);
      return usage;
    });
    this.running.set(cellId, run);
    return run;
  }

  private async read(cellId: string): Promise<ContextUsage | null> {
    const target = this.deps.target(cellId);
    if (!target) { this.entries.delete(cellId); return null; }
    const key = `${target.cli}:${target.sessionId.toLowerCase()}`;
    let entry = this.entries.get(cellId);
    if (entry && entry.key !== key) entry = undefined;
    const file = entry?.file ?? await this.locate(target);
    if (!file) { this.entries.delete(cellId); return null; }
    let st;
    try { st = await stat(file); } catch {
      this.entries.delete(cellId);
      if (target.cli === 'codex') this.codexFiles.delete(target.sessionId.toLowerCase());
      return null;
    }
    // A replaced or truncated file is read again from its end.
    if (entry && (st.size < entry.offset || st.ino !== entry.ino || st.birthtimeMs !== entry.birthtimeMs)) entry = undefined;
    if (entry && st.size === entry.offset) return contextUsage(target.cli, entry.scan, target.modelHint);
    const fh = await open(file, 'r');
    try {
      this.reads++;
      if (!entry || st.size - entry.offset > MAX_FORWARD) {
        const { scan, offset } = await scanBackwards(fh, st.size, target.cli);
        // Codex names its model in the turn context, which may sit before the usage line the backward read stopped at.
        const kept = entry?.scan.model && !scan.model ? { ...scan, model: entry.scan.model } : scan;
        entry = { key, file, offset, ino: st.ino, birthtimeMs: st.birthtimeMs, scan: kept, usage: null };
      } else {
        const buf = await readAt(fh, entry.offset, st.size - entry.offset);
        const last = buf.lastIndexOf(10);
        if (last >= 0) {
          entry.scan = scanLines(target.cli, entry.scan, buf.subarray(0, last + 1).toString('utf8'));
          entry.offset += last + 1;
        }
      }
    } finally {
      await fh.close();
    }
    this.entries.set(cellId, entry);
    entry.usage = contextUsage(target.cli, entry.scan, target.modelHint);
    return entry.usage;
  }

  private async locate(target: ContextTarget): Promise<string | null> {
    const id = target.sessionId.toLowerCase();
    if (target.cli === 'claude') {
      const reported = this.transcripts.get(id);
      if (reported) return reported;
      const projects = join(this.deps.claudeDir(), 'projects');
      const direct = join(projects, claudeProjectDirName(target.cwd), `${target.sessionId}.jsonl`);
      if (await exists(direct)) return direct;
      // Long paths are shortened (with a hash) by newer versions: look for the session in every project folder.
      let dirs: string[] = [];
      try { dirs = await readdir(projects); } catch { return null; }
      for (const dir of dirs) {
        const candidate = join(projects, dir, `${target.sessionId}.jsonl`);
        if (await exists(candidate)) return candidate;
      }
      return null;
    }
    const cached = this.codexFiles.get(id);
    if (cached) return cached;
    const found = await findCodexRollout(join(this.deps.codexHome(), 'sessions'), id);
    if (found) this.codexFiles.set(id, found);
    return found;
  }
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** The rollout file of a Codex thread: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, searched newest first. */
export async function findCodexRollout(root: string, id: string): Promise<string | null> {
  const suffix = `-${id.toLowerCase()}.jsonl`;
  let seen = 0;
  const walk = async (dir: string): Promise<string | null> => {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return null; }
    items.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const item of items) {
      if (item.isFile() && item.name.toLowerCase().endsWith(suffix)) return join(dir, item.name);
      if (item.isFile() && ++seen > MAX_CODEX_FILES) return null;
    }
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const hit = await walk(join(dir, item.name));
      if (hit || seen > MAX_CODEX_FILES) return hit;
    }
    return null;
  };
  return walk(root);
}
