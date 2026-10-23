// The Monitor panel's data (1.0.6). Nothing here runs on its own: the panel asks for a sample every 2 s while it is on screen,
// and a sample takes one system-wide process snapshot. Windows: a resident PowerShell helper answers each request with one
// NtQuerySystemInformation call (about 7 ms; Get-CimInstance Win32_Process takes about 750 ms per call and a process start of
// powershell.exe per tick would cost as much), started on the first request and ended 15 s after the last one. macOS: one `ps`.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { cpus } from 'os';
import {
  appProcKind, buildMonitor, cpuMemo, cpuPercents, killablePid, parsePsSnapshot, parseWinSnapshot,
  type AppProcInfo, type CpuMemo, type MonitorSample, type RawProc,
} from '../shared/monitor';

const IDLE_STOP_MS = 15_000;
const QUERY_TIMEOUT_MS = 5_000;
const END = '\n.\n';

/**
 * The Windows helper. Add-Type compiles the reader once (about 0.7 s with the PowerShell start); where Add-Type is not allowed
 * (constrained language mode) it falls back to Get-CimInstance, slower but the same rows: pid, ppid, CPU time (100 ns),
 * memory (bytes; private working set, or the working set in the fallback), start (FILETIME), name.
 */
const WIN_HELPER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$fast = $true
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class UnimuxProcs {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr b, int l, out int r);
  static IntPtr buf = IntPtr.Zero; static int size = 1 << 20;
  public static string Snapshot() {
    for (int tries = 0; ; tries++) {
      if (buf == IntPtr.Zero) buf = Marshal.AllocHGlobal(size);
      int need;
      int st = NtQuerySystemInformation(5, buf, size, out need);
      if (st == unchecked((int)0xC0000004) && tries < 8) { Marshal.FreeHGlobal(buf); buf = IntPtr.Zero; size = Math.Max(size * 2, need + 65536); continue; }
      if (st != 0) return "";
      break;
    }
    var sb = new StringBuilder(64 * 1024);
    long off = 0;
    for (;;) {
      IntPtr p = new IntPtr(buf.ToInt64() + off);
      int next = Marshal.ReadInt32(p, 0);
      int nameLen = Marshal.ReadInt16(p, 56) & 0xffff;
      IntPtr nameBuf = Marshal.ReadIntPtr(p, 64);
      string name = nameBuf == IntPtr.Zero ? "" : Marshal.PtrToStringUni(nameBuf, nameLen / 2);
      sb.Append(Marshal.ReadIntPtr(p, 80).ToInt64()).Append('\\t').Append(Marshal.ReadIntPtr(p, 88).ToInt64()).Append('\\t')
        .Append(Marshal.ReadInt64(p, 40) + Marshal.ReadInt64(p, 48)).Append('\\t').Append(Marshal.ReadInt64(p, 8)).Append('\\t')
        .Append(Marshal.ReadInt64(p, 32)).Append('\\t').Append(name.Replace('\\t', ' ').Replace('\\n', ' ')).Append('\\n');
      if (next == 0) break;
      off += next;
    }
    return sb.ToString();
  }
}
'@
} catch { $fast = $false }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($fast) { [Console]::Out.Write([UnimuxProcs]::Snapshot()) }
  else {
    $rows = foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,UserModeTime,KernelModeTime,WorkingSetSize,CreationDate,Name) {
      $start = 0; if ($p.CreationDate) { $start = $p.CreationDate.ToFileTimeUtc() }
      "$($p.ProcessId)\`t$($p.ParentProcessId)\`t$([long]$p.UserModeTime + [long]$p.KernelModeTime)\`t$($p.WorkingSetSize)\`t$start\`t$($p.Name)"
    }
    [Console]::Out.Write(($rows -join "\`n") + "\`n")
  }
  [Console]::Out.Write("\`n.\`n")
  [Console]::Out.Flush()
}
`;

/** One system snapshot per call; on Windows through the resident helper. */
export class ProcessSnapshots {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Helper processes started so far (diagnostics and tests). */
  starts = 0;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  take(): Promise<RawProc[]> {
    const run = this.queue.then(() => this.takeNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async takeNow(): Promise<RawProc[]> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_STOP_MS);
    this.idle.unref?.();
    if (this.platform !== 'win32') return parsePsSnapshot(await this.ps());
    return parseWinSnapshot(await this.ask());
  }

  private ps(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,lstart=,comm='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: QUERY_TIMEOUT_MS },
        (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
  }

  private ask(): Promise<string> {
    const child = this.child ?? this.startHelper();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; this.stop(); reject(new Error('process snapshot timed out')); }, QUERY_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      child.stdin.write('s\n');
    });
  }

  private startHelper(): ChildProcessWithoutNullStreams {
    this.starts++;
    const encoded = Buffer.from(WIN_HELPER, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const end = this.buffer.indexOf(END);
      if (end < 0) return;
      const text = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + END.length);
      const pending = this.pending;
      this.pending = null;
      if (pending) { clearTimeout(pending.timer); pending.resolve(text); }
    });
    child.stderr.on('data', () => undefined);
    const gone = (error?: Error) => {
      if (this.child === child) this.child = null;
      const pending = this.pending;
      this.pending = null;
      if (pending) { clearTimeout(pending.timer); pending.reject(error ?? new Error('process snapshot helper exited')); }
    };
    child.on('error', gone);
    child.on('exit', () => gone());
    child.stdin.on('error', () => undefined);
    return child;
  }

  stop(): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000).unref?.();
  }
}

/** What main tells the monitor about the app (Electron's metrics, the running cells' pty shells). */
export interface MonitorDeps {
  appMetrics: () => ReadonlyArray<{ pid: number; type: string; serviceName?: string; name?: string }>;
  cells: () => ReadonlyArray<{ cellId: string; pid: number }>;
  mainPid?: number;
  kill?: (pid: number) => void;
}

export class Monitor {
  private memo: CpuMemo | null = null;
  private memoAt = 0;
  readonly snapshots: ProcessSnapshots;
  private readonly cores = Math.max(1, cpus().length);

  constructor(private readonly deps: MonitorDeps, snapshots = new ProcessSnapshots()) {
    this.snapshots = snapshots;
  }

  private appProcs(): AppProcInfo[] {
    const main = this.deps.mainPid ?? process.pid;
    // A utility process's `name` is its fork's serviceName ("unimux Pty Host"); its `serviceName` is Electron's ("node.mojom.NodeService").
    const list: AppProcInfo[] = this.deps.appMetrics().map((m) => ({ pid: m.pid, kind: m.pid === main ? 'main' : appProcKind(m.type, m.name ?? m.serviceName), name: m.name ?? m.serviceName }));
    if (!list.some((a) => a.kind === 'main')) list.unshift({ pid: main, kind: 'main' });
    return list;
  }

  async sample(): Promise<MonitorSample> {
    const t0 = Date.now();
    let procs: RawProc[];
    try {
      procs = await this.snapshots.take();
    } catch {
      return { ok: false, cores: this.cores, app: [], cells: [], cpu: 0, mem: 0, queryMs: Date.now() - t0 };
    }
    const now = Date.now();
    // A pause longer than a few ticks (the panel was closed) starts the CPU arithmetic over.
    const prev = this.memo && now - this.memoAt < 10_000 ? this.memo : null;
    const cpu = cpuPercents(procs, prev, now - this.memoAt, this.cores);
    this.memo = cpuMemo(procs);
    this.memoAt = now;
    return buildMonitor({ procs, cpu, cores: this.cores, app: this.appProcs(), cells: this.deps.cells(), queryMs: now - t0 });
  }

  /** Kills one process of a cell's tree; anything else (the app, a host, a pid that is no longer ours) is refused. */
  async kill(pid: unknown): Promise<boolean> {
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
    let procs: RawProc[];
    try { procs = await this.snapshots.take(); } catch { return false; }
    const fresh = buildMonitor({ procs, cpu: new Map(), cores: this.cores, app: this.appProcs(), cells: this.deps.cells() });
    if (!killablePid(fresh, pid)) return false;
    try {
      (this.deps.kill ?? ((p: number) => process.kill(p)))(pid);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.snapshots.stop();
  }
}
