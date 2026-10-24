// The status bar of a connected SSH cell (1.0.7): what the server is asked (one POSIX sh script on an exec channel of the
// cell's own SSH connection, like the path completion of remotePaths.ts: no second login, nothing in the shell's history),
// how its answer is read, how two answers make rates (CPU %, network), and how the numbers are written. Linux reads /proc;
// FreeBSD and macOS answer through sysctl, vm_stat and netstat. Anything missing just hides its item. Pure, tested in Node.

/** One run every this long while the cell is on screen. */
export const SSH_BAR_INTERVAL_MS = 3000;
/** A run that takes longer is given up (a hung df on a dead NFS mount); what came until then still counts. */
export const SSH_BAR_TIMEOUT_MS = 5000;
/** Bytes of exec output read at most. */
export const SSH_BAR_MAX_BYTES = 64 * 1024;
/** Runs in a row that brought nothing usable (no sh, a Windows server, exec refused): the bar stops for this session. */
export const SSH_BAR_MAX_FAILURES = 3;
/** CPU samples kept for the sparkline. */
export const SSH_BAR_HISTORY = 30;
/** Two samples further apart than this make no rate (the cell was off screen meanwhile). */
export const SSH_BAR_MAX_GAP_MS = 15_000;

/**
 * One run as the Pty Host reports it: what the script printed (cut after SSH_BAR_MAX_BYTES or the timeout: `partial`), how
 * long the exec took and how many bytes came back. `busy`: the previous run of the session has not ended.
 */
export type SshStatsRun =
  | { ok: true; text: string; ms: number; bytes: number; partial: boolean }
  | { ok: false; reason: 'busy' | 'gone' | 'unsupported' | 'failed' };

export type SshBarItem = 'host' | 'cpu' | 'mem' | 'disk' | 'net' | 'uptime' | 'user';
/** Left to right, like MobaXterm's bar (1.0.8: the machine's uptime between the network and the user). */
export const SSH_BAR_ITEMS: readonly SshBarItem[] = ['host', 'cpu', 'mem', 'net', 'uptime', 'user', 'disk'];
/** Most important first: a narrow cell keeps the start of this list (fitBar). */
export const SSH_BAR_PRIORITY: readonly SshBarItem[] = ['host', 'cpu', 'mem', 'disk', 'uptime', 'net', 'user'];

export type OsId = 'debian' | 'ubuntu' | 'mint' | 'centos' | 'rhel' | 'rocky' | 'alma' | 'fedora' | 'arch' | 'alpine' | 'suse' | 'linux' | 'freebsd' | 'macos' | 'unknown';

export interface DiskInfo { fs: string; mount: string; size: number; used: number; avail: number; percent: number }
export interface WhoEntry { user: string; tty: string; from: string; since: string; self: boolean }

/** What one run told (bytes, seconds; counters are cumulative and become rates in advanceBar). */
export interface BarSample {
  host?: string;
  /** Only the first run of a session asks for the system. */
  os?: { id: OsId; name?: string };
  kernel?: string;
  user?: string;
  /** Linux and FreeBSD: cumulative ticks; macOS: the sum of every process's %CPU (ps), divided by the CPU count later. */
  cpu?: { busy: number; total: number } | { psSum: number };
  mem?: { total: number; available: number };
  net?: { rx: number; tx: number };
  load?: [number, number, number];
  uptime?: number;
  ncpu?: number;
  disks: DiskInfo[];
  who: WhoEntry[];
  /** The script ran to its end (a cut run keeps what it printed). */
  complete: boolean;
}

/**
 * The script. `first`: also the system (os-release, the CPU count), which never changes during a session.
 * The tty of the cell's own shell is the one of the sibling process of this exec under the same sshd (listScript does the same).
 */
export function barScript(first: boolean): string {
  return [
    '# unimux status bar',
    'LC_ALL=C; export LC_ALL',
    'echo "@v 1"',
    'k=$(uname -s 2>/dev/null)',
    'echo "@host $(uname -n 2>/dev/null)"',
    'echo "@kernel $k $(uname -r 2>/dev/null)"',
    ...(first ? [
      'if [ -r /etc/os-release ]; then grep -E \'^(ID|ID_LIKE|PRETTY_NAME)=\' /etc/os-release 2>/dev/null | sed \'s/^/@osr /\'',
      'elif [ -r /etc/redhat-release ]; then echo "@osr PRETTY_NAME=$(head -n 1 /etc/redhat-release)"; fi',
      '[ "$k" = Darwin ] && echo "@osr PRETTY_NAME=macOS $(sw_vers -productVersion 2>/dev/null)"',
      'echo "@ncpu $(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"',
    ] : []),
    'echo "@user $(id -un 2>/dev/null || whoami 2>/dev/null)"',
    'echo "@client ${SSH_CLIENT%% *}"',
    'if [ -r /proc/stat ]; then',
    '  head -n 1 /proc/stat | sed \'s/^/@stat /\'',
    '  grep -E \'^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SReclaimable):\' /proc/meminfo 2>/dev/null | sed \'s/^/@mem /\'',
    '  sed \'1,2d; s/^/@net /\' /proc/net/dev 2>/dev/null',
    '  echo "@load $(cat /proc/loadavg 2>/dev/null)"',
    '  echo "@uptime $(cat /proc/uptime 2>/dev/null)"',
    '  for c in $(cat /proc/$PPID/task/*/children 2>/dev/null); do',
    '    [ "$c" = "$$" ] && continue',
    '    t=$(readlink /proc/$c/fd/0 2>/dev/null)',
    '    case "$t" in /dev/pts/*|/dev/tty*) echo "@tty ${t#/dev/}"; break;; esac',
    '  done',
    'else',
    '  for s in kern.cp_time hw.memsize hw.physmem hw.pagesize vm.stats.vm.v_free_count vm.stats.vm.v_inactive_count vm.stats.vm.v_cache_count vm.loadavg kern.boottime; do',
    '    v=$(sysctl -n $s 2>/dev/null) && [ -n "$v" ] && echo "@sysctl $s $v"',
    '  done',
    '  echo "@now $(date +%s)"',
    '  if [ "$k" = Darwin ]; then',
    '    vm_stat 2>/dev/null | sed \'s/^/@vm /\'',
    '    ps -A -o %cpu= 2>/dev/null | awk \'{s+=$1} END {print "@pscpu " s}\'',
    '  fi',
    '  netstat -ibn 2>/dev/null | awk \'$3 ~ /^<Link/ {print "@ns " $0}\'',
    'fi',
    'who 2>/dev/null | head -n 50 | sed \'s/^/@who /\'',
    'l=; df -Pkl / >/dev/null 2>&1 && l=l',
    'df -Pk$l 2>/dev/null | sed \'1d; s/^/@df /\' | head -n 100',
    'echo @end',
    '',
  ].join('\n');
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
const unquote = (s: string): string => clean(s.replace(/^(["'])(.*)\1$/, '$2'));

/** The logo for os-release's ID and ID_LIKE (or the name of a box without it). */
export function osIdOf(id: string, like: string, pretty: string, kernel: string): OsId {
  const words = [id, ...like.split(/\s+/)].map((w) => w.toLowerCase()).filter(Boolean);
  const known: Array<[RegExp, OsId]> = [
    [/^ubuntu$/, 'ubuntu'], [/^(linuxmint|mint)$/, 'mint'], [/^(debian|raspbian|devuan|kali)$/, 'debian'],
    [/^(rocky)$/, 'rocky'], [/^(almalinux)$/, 'alma'], [/^centos$/, 'centos'], [/^(rhel|redhat|ol|amzn)$/, 'rhel'],
    [/^fedora$/, 'fedora'], [/^(arch|archarm|manjaro|endeavouros)$/, 'arch'], [/^alpine$/, 'alpine'],
    [/^(opensuse.*|sles|sled|suse)$/, 'suse'], [/^freebsd$/, 'freebsd'],
  ];
  // The ID itself wins (Mint before its ID_LIKE ubuntu), then ID_LIKE in order.
  for (const w of words) for (const [re, os] of known) if (re.test(w)) return os;
  const name = pretty.toLowerCase();
  if (name.includes('centos')) return 'centos';
  if (name.includes('red hat')) return 'rhel';
  if (name.includes('rocky')) return 'rocky';
  if (name.includes('alma')) return 'alma';
  if (name.includes('fedora')) return 'fedora';
  if (name.startsWith('macos')) return 'macos';
  const k = kernel.toLowerCase();
  if (k === 'darwin') return 'macos';
  if (k === 'freebsd') return 'freebsd';
  if (k === 'linux') return 'linux';
  return 'unknown';
}

/** Mounts and filesystems that are no disk (memory, kernel, snap images, macOS system volumes). */
function realDisk(fs: string, mount: string): boolean {
  if (mount === '/') return true;
  if (/^(tmpfs|devtmpfs|udev|none|shm|overlay|devfs|proc|sysfs|cgroup2?|efivarfs|map .*|fdescfs|linprocfs|tracefs|ramfs)$/.test(fs)) return false;
  if (fs.startsWith('/dev/loop')) return false;
  if (/^\/(dev|proc|sys|run|snap)(\/|$)/.test(mount)) return false;
  if (mount.startsWith('/System/Volumes/') && mount !== '/System/Volumes/Data') return false;
  return true;
}

/**
 * `df -Pk` lines (without the header): one entry per filesystem, the shortest mount of one mounted several times (the same
 * device, or the same size, used and free space: a container's overlay root and its /etc/hosts bind mount).
 */
export function parseDf(lines: string[]): DiskInfo[] {
  const disks: DiskInfo[] = [];
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [fs, sizeK, usedK, availK, cap] = f;
    const mount = f.slice(5).join(' ');
    const size = num(sizeK);
    const used = num(usedK);
    const avail = num(availK);
    if (size === undefined || used === undefined || avail === undefined || size <= 0 || !mount.startsWith('/')) continue;
    if (!realDisk(fs, mount)) continue;
    // Like df: used of what a user can have (root's reserved blocks excluded), rounded up.
    const parsed = num(cap.replace('%', ''));
    const percent = used + avail > 0 ? Math.ceil((used / (used + avail)) * 100) : parsed ?? 0;
    const disk = { fs: clean(fs), mount: clean(mount), size: size * 1024, used: used * 1024, avail: avail * 1024, percent };
    const at = disks.findIndex((d) => d.fs === disk.fs || (d.size === disk.size && d.used === disk.used && d.avail === disk.avail));
    if (at < 0) disks.push(disk);
    else if (disk.mount.length < disks[at].mount.length) disks[at] = disk;
  }
  return disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

/** `who` lines: GNU and BSD (`user tty date (from)`) and busybox (a USER TTY IDLE TIME HOST header, the host bare). */
export function parseWho(lines: string[], selfTty: string | undefined, selfUser: string | undefined): WhoEntry[] {
  const out: WhoEntry[] = [];
  const busybox = lines.length > 0 && /^USER\s+TTY\b/.test(lines[0].trim());
  for (const line of busybox ? lines.slice(1) : lines) {
    const f = clean(line).split(/\s+/).filter(Boolean);
    if (f.length < 2) continue;
    const [user, tty] = f;
    let from = '';
    let since: string[];
    if (busybox) {
      // USER TTY IDLE "Mon DD HH:MM:SS" HOST
      since = f.slice(3, 6);
      from = f[6] ?? '';
    } else {
      let rest = f.slice(2);
      const last = rest[rest.length - 1];
      if (last && /^\(.*\)$/.test(last)) { from = last.slice(1, -1); rest = rest.slice(0, -1); }
      since = rest;
    }
    out.push({ user, tty, from, since: since.join(' '), self: !!selfTty && tty === selfTty && (!selfUser || user === selfUser) });
  }
  return out.slice(0, 50);
}

/** `/proc/net/dev` lines (header cut): received and sent bytes of every interface but loopback and container plumbing. */
export function parseNetDev(lines: string[]): { rx: number; tx: number } | undefined {
  let rx = 0; let tx = 0; let any = false;
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || /^(lo|veth|docker|br-|virbr|vnet|cni|flannel|cali|kube|tunl|dummy|ifb)/.test(name)) continue;
    const f = line.slice(colon + 1).trim().split(/\s+/);
    const r = num(f[0]);
    const t = num(f[8]);
    if (r === undefined || t === undefined) continue;
    rx += r; tx += t; any = true;
  }
  return any ? { rx, tx } : undefined;
}

/** `netstat -ibn` link rows (FreeBSD, macOS): Ibytes and Obytes counted from the right (the Address column may be empty). */
export function parseNetstat(lines: string[]): { rx: number; tx: number } | undefined {
  let rx = 0; let tx = 0; let any = false;
  const seen = new Set<string>();
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || /^lo\d*$/.test(f[0]) || seen.has(f[0])) continue;
    const r = num(f[f.length - 5]);
    const t = num(f[f.length - 2]);
    if (r === undefined || t === undefined) continue;
    seen.add(f[0]);
    rx += r; tx += t; any = true;
  }
  return any ? { rx, tx } : undefined;
}

/** Everything one run printed. Lines before the first marker (a chatty login file) and unknown markers are skipped. */
export function parseBar(output: string): BarSample | null {
  const lines = output.replace(/\r/g, '').split('\n');
  if (!lines.some((l) => l === '@v 1')) return null;
  const sample: BarSample = { disks: [], who: [], complete: lines.some((l) => l === '@end') };
  const osr: Record<string, string> = {};
  const mem: Record<string, number> = {};
  const sysctl: Record<string, string> = {};
  const vm: string[] = [];
  const netDev: string[] = [];
  const netstat: string[] = [];
  const who: string[] = [];
  const df: string[] = [];
  let tty: string | undefined;
  let client: string | undefined;
  let now: number | undefined;
  let pscpu: number | undefined;
  for (const line of lines) {
    const sp = line.indexOf(' ');
    if (!line.startsWith('@') || sp < 0) continue;
    const key = line.slice(1, sp);
    const value = line.slice(sp + 1);
    switch (key) {
      case 'host': { const h = clean(value); if (h) sample.host = h.slice(0, 255); break; }
      case 'kernel': { const k = clean(value); if (k) sample.kernel = k.slice(0, 255); break; }
      case 'osr': { const eq = value.indexOf('='); if (eq > 0) osr[value.slice(0, eq)] = unquote(value.slice(eq + 1)); break; }
      case 'ncpu': { const n = num(value.trim()); if (n && n > 0) sample.ncpu = n; break; }
      case 'user': { const u = clean(value); if (u) sample.user = u.slice(0, 64); break; }
      case 'stat': {
        const f = value.trim().split(/\s+/);
        if (f[0] !== 'cpu') break;
        const v = f.slice(1, 9).map((x) => num(x) ?? 0);
        const total = v.reduce((a, b) => a + b, 0);
        const idle = (v[3] ?? 0) + (v[4] ?? 0);
        if (total > 0) sample.cpu = { busy: total - idle, total };
        break;
      }
      case 'mem': { const m = /^(\w+):\s+(\d+)/.exec(value.trim()); if (m) mem[m[1]] = Number(m[2]) * 1024; break; }
      case 'net': netDev.push(value); break;
      case 'ns': netstat.push(value); break;
      case 'load': {
        const f = value.replace(/[{}]/g, ' ').trim().split(/\s+/).slice(0, 3).map(num);
        if (f.length === 3 && f.every((x) => x !== undefined)) sample.load = f as [number, number, number];
        break;
      }
      case 'uptime': { const u = num(value.trim().split(/\s+/)[0]); if (u !== undefined && u >= 0) sample.uptime = u; break; }
      case 'tty': { const t = clean(value); if (t) tty = t; break; }
      case 'client': { const c = clean(value); if (c) client = c.slice(0, 64); break; }
      case 'sysctl': { const s2 = value.indexOf(' '); if (s2 > 0) sysctl[value.slice(0, s2)] = value.slice(s2 + 1).trim(); break; }
      case 'now': now = num(value.trim()); break;
      case 'vm': vm.push(value); break;
      case 'pscpu': pscpu = num(value.trim()); break;
      case 'who': who.push(value); break;
      case 'df': df.push(value); break;
    }
  }
  // Only a run that asked for the system (the first of a session, the one with @ncpu) says which one it is.
  if (lines.some((l) => l.startsWith('@ncpu')) || Object.keys(osr).length) {
    const id = osIdOf(osr.ID ?? '', osr.ID_LIKE ?? '', osr.PRETTY_NAME ?? '', sample.kernel?.split(' ')[0] ?? '');
    sample.os = { id, ...(osr.PRETTY_NAME ? { name: osr.PRETTY_NAME.slice(0, 120) } : {}) };
  }
  if (mem.MemTotal) {
    const available = mem.MemAvailable ?? (mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0) + (mem.SReclaimable ?? 0);
    sample.mem = { total: mem.MemTotal, available: Math.min(available, mem.MemTotal) };
  }
  sample.net = parseNetDev(netDev) ?? parseNetstat(netstat);
  if (!sample.net) delete sample.net;
  // FreeBSD / macOS.
  const cp = sysctl['kern.cp_time']?.split(/\s+/).map((x) => num(x) ?? 0);
  if (!sample.cpu && cp && cp.length >= 5) {
    const total = cp.reduce((a, b) => a + b, 0);
    if (total > 0) sample.cpu = { busy: total - cp[4], total };
  }
  if (!sample.cpu && pscpu !== undefined && pscpu >= 0) sample.cpu = { psSum: pscpu };
  if (!sample.load && sysctl['vm.loadavg']) {
    const f = sysctl['vm.loadavg'].replace(/[{}]/g, ' ').trim().split(/\s+/).slice(0, 3).map(num);
    if (f.length === 3 && f.every((x) => x !== undefined)) sample.load = f as [number, number, number];
  }
  const boot = /sec = (\d+)/.exec(sysctl['kern.boottime'] ?? '');
  if (sample.uptime === undefined && boot && now) sample.uptime = Math.max(0, now - Number(boot[1]));
  if (!sample.mem) {
    const total = num(sysctl['hw.memsize']) ?? num(sysctl['hw.physmem']);
    if (total && total > 0) {
      if (vm.length) {
        const page = num(/page size of (\d+) bytes/.exec(vm[0])?.[1]) ?? 4096;
        const pages = (name: string) => num(new RegExp(`^Pages ${name}:\\s+(\\d+)`).exec(vm.find((l) => l.startsWith(`Pages ${name}:`)) ?? '')?.[1]) ?? 0;
        sample.mem = { total, available: Math.min(total, (pages('free') + pages('inactive') + pages('speculative')) * page) };
      } else if (sysctl['vm.stats.vm.v_free_count']) {
        const page = num(sysctl['hw.pagesize']) ?? 4096;
        const free = (num(sysctl['vm.stats.vm.v_free_count']) ?? 0) + (num(sysctl['vm.stats.vm.v_inactive_count']) ?? 0) + (num(sysctl['vm.stats.vm.v_cache_count']) ?? 0);
        sample.mem = { total, available: Math.min(total, free * page) };
      }
    }
  }
  sample.who = parseWho(who, tty, sample.user);
  // No login records (a container, a system without utmp): at least this session, from what the exec itself knows.
  if (!sample.who.length && sample.user) sample.who = [{ user: sample.user, tty: tty ?? '', from: client ?? '', since: '', self: true }];
  sample.disks = parseDf(df);
  return sample;
}

/** Where a session's bar stands: the last sample, the rates made of the last two, the CPU history of the sparkline. */
export interface BarTrack {
  at: number;
  sample: BarSample;
  /** The system of the first run (later runs do not ask again). */
  os?: { id: OsId; name?: string };
  ncpu?: number;
  cpuPercent?: number;
  rx?: number;
  tx?: number;
  cpuHistory: number[];
}

/** A new sample at `at` ms: rates from the counters of the previous one (none after a gap or a counter reset). */
export function advanceBar(prev: BarTrack | null, sample: BarSample, at: number): BarTrack {
  const dt = prev ? (at - prev.at) / 1000 : 0;
  const fresh = !!prev && dt > 0 && dt * 1000 <= SSH_BAR_MAX_GAP_MS;
  const ncpu = sample.ncpu ?? prev?.ncpu;
  let cpuPercent: number | undefined;
  if (sample.cpu && 'psSum' in sample.cpu) cpuPercent = Math.max(0, Math.min(100, sample.cpu.psSum / (ncpu ?? 1)));
  else if (sample.cpu && fresh && prev!.sample.cpu && 'total' in prev!.sample.cpu) {
    const dTotal = sample.cpu.total - prev!.sample.cpu.total;
    const dBusy = sample.cpu.busy - prev!.sample.cpu.busy;
    if (dTotal > 0 && dBusy >= 0) cpuPercent = Math.max(0, Math.min(100, (dBusy / dTotal) * 100));
  }
  let rx: number | undefined;
  let tx: number | undefined;
  if (sample.net && fresh && prev!.sample.net) {
    const dRx = sample.net.rx - prev!.sample.net.rx;
    const dTx = sample.net.tx - prev!.sample.net.tx;
    if (dRx >= 0 && dTx >= 0) { rx = dRx / dt; tx = dTx / dt; }
  }
  const history = cpuPercent === undefined ? (fresh ? prev!.cpuHistory : []) : [...(fresh ? prev!.cpuHistory : []), cpuPercent].slice(-SSH_BAR_HISTORY);
  return {
    at, sample, os: sample.os ?? prev?.os, ncpu,
    // A rate needs two samples: until then the previous value stays (none on the first run).
    cpuPercent: cpuPercent ?? (fresh ? prev!.cpuPercent : undefined),
    rx: rx ?? (fresh && sample.net ? prev!.rx : undefined),
    tx: tx ?? (fresh && sample.net ? prev!.tx : undefined),
    cpuHistory: history,
  };
}

/** The disk the bar shows: the root filesystem, else the first one. */
export const rootDisk = (disks: DiskInfo[]): DiskInfo | undefined => disks.find((d) => d.mount === '/') ?? disks[0];

export type DiskLevel = 'ok' | 'warn' | 'full';
/** Amber above 80 %, red above 90 %. */
export const diskLevel = (percent: number): DiskLevel => (percent > 90 ? 'full' : percent > 80 ? 'warn' : 'ok');

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
/** Bytes in binary units with two decimals under 10, one under 100 ("0,23 GB", "12,4 GB", "931 GB"); `unit` forces one. */
export function formatBytes(bytes: number, locale: string, unit?: number): string {
  let i = unit ?? 0;
  if (unit === undefined) while (i < UNITS.length - 1 && bytes >= 1024 ** (i + 1) * 0.995) i++;
  const v = bytes / 1024 ** i;
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)} ${UNITS[i]}`;
}

/** Memory as "used/total" in one unit, GB from half a GB of total on ("0,23/0,96 GB"). */
export function formatMemory(mem: { total: number; available: number }, locale: string): string {
  let unit = 0;
  while (unit < UNITS.length - 1 && mem.total >= 1024 ** (unit + 1) * 0.5) unit++;
  return `${formatBytes(mem.total - mem.available, locale, unit).replace(/ \S+$/, '')}/${formatBytes(mem.total, locale, unit)}`;
}

/** The share of memory in use, 0 to 100. */
export const memoryPercent = (mem: { total: number; available: number }): number => (mem.total > 0 ? ((mem.total - mem.available) / mem.total) * 100 : 0);

/** A transfer rate ("0 B/s", "12,4 KB/s"); `compact`: one decimal at most, a one-letter unit, no "/s" ("8,8K", "312K"). */
export function formatRate(bytesPerSecond: number, locale: string, compact = false): string {
  const full = formatBytes(Math.max(0, bytesPerSecond), locale);
  if (!compact) return `${full}/s`;
  let i = 0;
  const b = Math.max(0, bytesPerSecond);
  while (i < UNITS.length - 1 && b >= 1024 ** (i + 1) * 0.995) i++;
  const v = b / 1024 ** i;
  const digits = i === 0 || v >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)}${i === 0 ? 'B' : UNITS[i][0]}`;
}

/** An uptime as days, hours and minutes ("12 d 3 h", "3 h 5 min", "4 min"). */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/**
 * The machine's uptime for the bar, short and in the app's language: whole days from one day on ("297 dni", "1 day"),
 * hours and minutes below ("5 h 12 min", "12 min"). `compact`: "297 d.", "5 h".
 */
export function formatUptimeShort(seconds: number, locale: string, compact = false): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'day', unitDisplay: compact ? 'narrow' : 'long' }).format(d);
  if (h > 0) return compact ? `${h} h` : `${h} h ${m} min`;
  return `${m} min`;
}

/**
 * The logged-in sessions as the user card lists them: everyone else first, the cell's own session last. When no row is
 * marked as the cell's own (no tty found), the first row of the same user stands for it.
 */
export function splitWho(who: WhoEntry[], user: string | undefined): { others: WhoEntry[]; self: WhoEntry | undefined } {
  let at = who.findIndex((w) => w.self);
  if (at < 0 && user) at = who.findIndex((w) => w.user === user);
  return { others: who.filter((_, i) => i !== at), self: at >= 0 ? { ...who[at], self: true } : undefined };
}

/**
 * One way to lay the bar out: values in their full or short form ("0,23/0,96 GB" or "24%"), the CPU sparkline or not, and
 * the items shown. `rank` orders them from the roomiest (0: everything in full) to the tightest.
 */
export interface BarStage { compact: boolean; spark: boolean; items: SshBarItem[]; rank: number }
/** Measured widths of an item in px: its full and short forms, and (the CPU) the short form without the sparkline. */
export interface BarItemWidths { full: number; compact: number; bare?: number }

/** The width one item takes in a stage, the host name counted at most at `hostMin` (it shrinks with an ellipsis). */
function itemWidth(item: SshBarItem, w: BarItemWidths | undefined, compact: boolean, spark: boolean, hostMin: number): number {
  if (!w) return 0;
  const px = compact ? (item === 'cpu' && !spark ? w.bare ?? w.compact : w.compact) : w.full;
  return item === 'host' ? Math.min(px, hostMin) : px;
}

/** The width a stage takes: its items with the gaps between them. */
export function barStageWidth(stage: Omit<BarStage, 'rank'>, widths: Partial<Record<SshBarItem, BarItemWidths>>, gap: number, hostMin: number): number {
  const total = stage.items.reduce((n, item) => n + itemWidth(item, widths[item], stage.compact, stage.spark, hostMin), 0);
  return total + gap * Math.max(0, stage.items.length - 1);
}

/** The roomiest stage that fits `room` (see fitBar). */
function fitIn(present: readonly SshBarItem[], widths: Partial<Record<SshBarItem, BarItemWidths>>, room: number, gap: number, hostMin: number): BarStage {
  const whole: Array<[boolean, boolean]> = present.includes('cpu') ? [[false, true], [true, true], [true, false]] : [[false, true], [true, true]];
  for (let i = 0; i < whole.length; i++) {
    const stage = { compact: whole[i][0], spark: whole[i][1], items: [...present], rank: i };
    if (barStageWidth(stage, widths, gap, hostMin) <= room) return stage;
  }
  // Items go by SSH_BAR_PRIORITY, but a less important one that still fits stays: no free room while something is hidden.
  // The most important item present always stays (the host name shrinks).
  const keep = new Set<SshBarItem>();
  let used = 0;
  for (const item of SSH_BAR_PRIORITY) {
    if (!present.includes(item)) continue;
    const need = itemWidth(item, widths[item], true, false, hostMin) + (keep.size ? gap : 0);
    if (!keep.size || used + need <= room) { keep.add(item); used += need; }
  }
  const items = present.filter((item) => keep.has(item));
  return { compact: true, spark: false, items, rank: 3 + present.length - items.length };
}

/**
 * The layout of the bar for `room` px: everything in full while it fits; then short forms; then no sparkline; then items
 * dropped by SSH_BAR_PRIORITY. Coming back to a roomier stage than `current` needs `slack` px to spare, so a rate that grows
 * and shrinks by a digit does not make items blink.
 */
export function fitBar(present: readonly SshBarItem[], widths: Partial<Record<SshBarItem, BarItemWidths>>, room: number, gap: number, hostMin: number, current?: BarStage, slack = 8): BarStage {
  const best = fitIn(present, widths, room, gap, hostMin);
  if (!current || best.rank >= current.rank) return best;
  const grown = fitIn(present, widths, room - slack, gap, hostMin);
  if (grown.rank < current.rank) return grown;
  const still = current.items.every((item) => present.includes(item)) && barStageWidth(current, widths, gap, hostMin) <= room;
  return still ? current : best;
}

/** The SVG polyline of the sparkline in a `width` x `height` box (0 % at the bottom); empty below two samples. */
export function sparklinePoints(history: number[], width: number, height: number, slots = SSH_BAR_HISTORY): string {
  if (history.length < 2) return '';
  const step = width / (slots - 1);
  const start = width - step * (history.length - 1);
  return history.map((v, i) => `${(start + i * step).toFixed(1)},${(height - (Math.max(0, Math.min(100, v)) / 100) * (height - 1) - 0.5).toFixed(1)}`).join(' ');
}

/** The items switched on: every one unless Settings turned it off. */
export function shownBarItems(toggles: Partial<Record<SshBarItem, boolean>> | undefined): SshBarItem[] {
  return SSH_BAR_ITEMS.filter((item) => toggles?.[item] !== false);
}

/** A saved toggles object as it may be trusted (unknown keys and non-false values dropped). */
export function normalizeBarItems(raw: unknown): Partial<Record<SshBarItem, boolean>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Partial<Record<SshBarItem, boolean>> = {};
  for (const item of SSH_BAR_ITEMS) if ((raw as Record<string, unknown>)[item] === false) out[item] = false;
  return Object.keys(out).length ? out : undefined;
}
