// The Monitor panel (1.0.6): what loads the computer, as the app sees it. Main takes one system-wide process snapshot per tick
// (Windows: a resident PowerShell helper reading NtQuerySystemInformation, macOS: one `ps`) only while the panel asks for it;
// everything below is pure: parsing the snapshots, the CPU arithmetic between two of them and the trees of the app and its cells.

/** One process of a system snapshot. `cpuMs`: CPU time used since it started; `start`: start time (ms, only compared). */
export interface RawProc { pid: number; ppid: number; cpuMs: number; mem: number; start: number; name: string }

/** The Electron processes (app.getAppMetrics) and the utility hosts by their service names. */
export type AppProcKind = 'main' | 'renderer' | 'gpu' | 'ptyhost' | 'sftphost' | 'dbhost' | 'utility' | 'other';
export interface AppProcInfo { pid: number; kind: AppProcKind; name?: string }

export interface MonitorRow { pid: number; name: string; cpu: number; mem: number; depth: number }
export interface MonitorAppRow { pid: number; kind: AppProcKind; name: string; cpu: number; mem: number }
export interface MonitorCell { cellId: string; pid: number; cpu: number; mem: number; rows: MonitorRow[] }
export interface MonitorSample {
  ok: boolean;
  /** Logical processors; a CPU value of 100 is the whole machine (as in Task Manager). */
  cores: number;
  app: MonitorAppRow[];
  cells: MonitorCell[];
  /** Sums: the app with every cell, in % and bytes. */
  cpu: number;
  mem: number;
  /** How long the snapshot took in main (ms). */
  queryMs: number;
}

export const MONITOR_INTERVAL_MS = 2000;

// ── parsing ──────────────────────────────────────────────────────────────────

/** Windows helper rows: pid, ppid, CPU time (100 ns), private working set (bytes), create time (FILETIME), image name. */
export function parseWinSnapshot(text: string): RawProc[] {
  const out: RawProc[] = [];
  for (const line of text.split('\n')) {
    const f = line.replace(/\r$/, '').split('\t');
    if (f.length < 6) continue;
    const pid = Number(f[0]), ppid = Number(f[1]), cpu = Number(f[2]), mem = Number(f[3]), start = Number(f[4]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(cpu) || !Number.isFinite(mem)) continue;
    out.push({ pid, ppid: Number.isSafeInteger(ppid) ? ppid : 0, cpuMs: cpu / 1e4, mem, start: Number.isFinite(start) ? start / 1e4 : 0, name: f.slice(5).join(' ') });
  }
  return out;
}

/** `ps` CPU time: `[dd-][hh:]mm:ss[.cc]` (macOS prints minutes past 59 as well, like `123:04.56`). */
export function parsePsTime(value: string): number {
  const m = /^(?:(\d+)-)?([\d:.]+)$/.exec(value.trim());
  if (!m) return NaN;
  const parts = m[2].split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return (seconds + Number(m[1] ?? 0) * 86400) * 1000;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ps -A -o pid=,ppid=,rss=,time=,lstart=,comm=` (rss in KB; lstart `Thu Oct 23 10:00:00 2026`; comm is the executable path). */
export function parsePsSnapshot(text: string): RawProc[] {
  const out: RawProc[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const pid = Number(f[0]), ppid = Number(f[1]), rss = Number(f[2]), cpuMs = parsePsTime(f[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(rss) || !Number.isFinite(cpuMs)) continue;
    const [, mon, day, time, year] = f.slice(4, 9);
    const [h, mi, s] = time.split(':').map(Number);
    const start = Date.UTC(Number(year), Math.max(0, MONTHS.indexOf(mon)), Number(day), h, mi, s);
    const path = f.slice(9).join(' ');
    out.push({ pid, ppid: Number.isSafeInteger(ppid) ? ppid : 0, cpuMs, mem: rss * 1024, start: Number.isFinite(start) ? start : 0, name: path.slice(path.lastIndexOf('/') + 1) });
  }
  return out;
}

// ── CPU between two snapshots ───────────────────────────────────────────────

export type CpuMemo = Map<number, { cpuMs: number; start: number }>;

/**
 * CPU % of each process since the previous snapshot (`wallMs` ago), 100 being every core busy. A process seen for the first
 * time, or a pid that now belongs to a different process (another start time), shows 0 until the next snapshot.
 */
export function cpuPercents(procs: readonly RawProc[], prev: CpuMemo | null, wallMs: number, cores: number): Map<number, number> {
  const out = new Map<number, number>();
  const denom = Math.max(1, wallMs) * Math.max(1, cores);
  for (const p of procs) {
    const before = prev?.get(p.pid);
    const used = before && before.start === p.start ? p.cpuMs - before.cpuMs : 0;
    out.set(p.pid, Math.max(0, Math.min(100, (used / denom) * 100)));
  }
  return out;
}

export function cpuMemo(procs: readonly RawProc[]): CpuMemo {
  return new Map(procs.map((p) => [p.pid, { cpuMs: p.cpuMs, start: p.start }]));
}

// ── trees ────────────────────────────────────────────────────────────────────

/** Children by parent pid. A "child" that started before its parent is a reused parent pid, not a child. */
export function childrenOf(procs: readonly RawProc[]): Map<number, RawProc[]> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Map<number, RawProc[]>();
  for (const p of procs) {
    const parent = byPid.get(p.ppid);
    if (!parent || parent.pid === p.pid || (parent.start && p.start && p.start < parent.start)) continue;
    const list = out.get(p.ppid);
    if (list) list.push(p); else out.set(p.ppid, [p]);
  }
  return out;
}

/** Every descendant of `pid` (not `pid` itself). */
export function descendants(children: Map<number, RawProc[]>, pid: number): RawProc[] {
  const out: RawProc[] = [];
  const seen = new Set<number>([pid]);
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

const CONSOLE_HOST = /^(openconsole|conhost)(\.exe)?$/i;

/**
 * Windows: the console host of each cell. ConPTY starts it (a child of the Pty Host) right before the cell's shell, so a
 * cell gets the latest unclaimed console host started no later than its shell (1 s tolerance for clock granularity).
 */
export function matchConsoleHosts(hosts: readonly RawProc[], roots: ReadonlyArray<{ cellId: string; proc: RawProc }>): Map<string, RawProc> {
  const out = new Map<string, RawProc>();
  const free = hosts.filter((h) => CONSOLE_HOST.test(h.name)).sort((a, b) => a.start - b.start);
  for (const root of [...roots].sort((a, b) => b.proc.start - a.proc.start)) {
    let best = -1;
    for (let i = 0; i < free.length; i++) if (free[i].start <= root.proc.start + 1000) best = i;
    if (best < 0) continue;
    out.set(root.cellId, free[best]);
    free.splice(best, 1);
  }
  return out;
}

const byCpu = <T extends { cpu: number; mem: number }>(a: T, b: T) => b.cpu - a.cpu || b.mem - a.mem;

export interface MonitorInput {
  procs: readonly RawProc[];
  cpu: ReadonlyMap<number, number>;
  cores: number;
  /** The app's own processes (Electron metrics); the first `main` is the root of the app tree. */
  app: readonly AppProcInfo[];
  /** The pty shell of each running cell. */
  cells: ReadonlyArray<{ cellId: string; pid: number }>;
  queryMs?: number;
}

/**
 * The panel's data: the app's processes (Electron ones plus anything else main or the hosts started, the monitor helper
 * included) and, per cell, its pty process tree with the console host. Cells sorted by CPU, rows depth-first with the busiest
 * child first; app rows by CPU.
 */
export function buildMonitor(input: MonitorInput): MonitorSample {
  const byPid = new Map(input.procs.map((p) => [p.pid, p]));
  const children = childrenOf(input.procs);
  const cpuOf = (pid: number) => input.cpu.get(pid) ?? 0;
  const claimed = new Set<number>();
  const roots = input.cells.flatMap((c) => { const proc = byPid.get(c.pid); return proc ? [{ cellId: c.cellId, proc }] : []; });
  const ptyHost = input.app.find((a) => a.kind === 'ptyhost');
  // Windows only in practice: no other platform has these console hosts.
  const consoles = matchConsoleHosts(ptyHost ? children.get(ptyHost.pid) ?? [] : [], roots);
  const cells: MonitorCell[] = roots.map(({ cellId, proc }) => {
    const rows: MonitorRow[] = [];
    const walk = (p: RawProc, depth: number) => {
      if (claimed.has(p.pid)) return;
      claimed.add(p.pid);
      rows.push({ pid: p.pid, name: p.name, cpu: cpuOf(p.pid), mem: p.mem, depth });
      const kids = [...(children.get(p.pid) ?? [])].sort((a, b) => cpuOf(b.pid) - cpuOf(a.pid) || b.mem - a.mem);
      for (const kid of kids) walk(kid, depth + 1);
    };
    walk(proc, 0);
    const host = consoles.get(cellId);
    if (host) walk(host, 0);
    return { cellId, pid: proc.pid, cpu: rows.reduce((s, r) => s + r.cpu, 0), mem: rows.reduce((s, r) => s + r.mem, 0), rows };
  }).sort(byCpu);
  const known = new Map(input.app.map((a) => [a.pid, a]));
  const app: MonitorAppRow[] = [];
  for (const info of input.app) {
    const p = byPid.get(info.pid);
    if (!p || claimed.has(p.pid)) continue;
    claimed.add(p.pid);
    app.push({ pid: p.pid, kind: info.kind, name: info.name || p.name, cpu: cpuOf(p.pid), mem: p.mem });
  }
  const main = input.app.find((a) => a.kind === 'main');
  if (main) {
    for (const p of descendants(children, main.pid)) {
      if (claimed.has(p.pid) || known.has(p.pid)) continue;
      claimed.add(p.pid);
      app.push({ pid: p.pid, kind: 'other', name: p.name, cpu: cpuOf(p.pid), mem: p.mem });
    }
  }
  app.sort(byCpu);
  const sum = (rows: ReadonlyArray<{ cpu: number; mem: number }>, key: 'cpu' | 'mem') => rows.reduce((s, r) => s + r[key], 0);
  return {
    ok: true, cores: input.cores, app, cells,
    cpu: sum(app, 'cpu') + sum(cells, 'cpu'), mem: sum(app, 'mem') + sum(cells, 'mem'), queryMs: input.queryMs ?? 0,
  };
}

/** Whether `pid` may be killed from the panel: a process of a cell's tree (its shell, the agent, their children). */
export function killablePid(sample: Pick<MonitorSample, 'cells'>, pid: number): boolean {
  return sample.cells.some((c) => c.rows.some((r) => r.pid === pid && !CONSOLE_HOST.test(r.name)));
}

/** The kind of an Electron process from app.getAppMetrics (`type`, plus the service name of a utility process). */
export function appProcKind(type: string, serviceName: string | undefined): AppProcKind {
  if (type === 'Browser') return 'main';
  if (type === 'Tab') return 'renderer';
  if (type === 'GPU') return 'gpu';
  if (type === 'Utility') {
    if (/pty host/i.test(serviceName ?? '')) return 'ptyhost';
    if (/sftp host/i.test(serviceName ?? '')) return 'sftphost';
    if (/db host/i.test(serviceName ?? '')) return 'dbhost';
    return 'utility';
  }
  return 'other';
}

/** "12.3 MB" style memory, 1024-based like Task Manager. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024 * 1024) return `${Math.max(0, Math.round((bytes || 0) / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 100 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatCpu(cpu: number): string {
  return `${(Number.isFinite(cpu) ? cpu : 0).toFixed(1)}%`;
}
