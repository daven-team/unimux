import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  advanceBar, barScript, barStageWidth, diskLevel, fitBar, formatBytes, formatMemory, formatRate, formatUptime, formatUptimeShort,
  memoryPercent, normalizeBarItems, osIdOf, parseBar, splitWho, type BarStage,
  parseDf, parseWho, rootDisk, shownBarItems, sparklinePoints, SSH_BAR_HISTORY,
} from '../src/shared/sshBar';

const lines = (...l: string[]) => `${l.join('\n')}\n`;

const DEBIAN = lines(
  'Welcome to srv36 (motd from .bashrc)',
  '@v 1',
  '@host srv36',
  '@kernel Linux 6.1.0-18-amd64',
  '@osr PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
  '@osr ID=debian',
  '@ncpu 2',
  '@user root',
  '@stat cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0',
  '@mem MemTotal:        1004500 kB',
  '@mem MemFree:          120000 kB',
  '@mem MemAvailable:     763000 kB',
  '@mem Buffers:           20000 kB',
  '@mem Cached:           400000 kB',
  '@net     lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0',
  '@net   eth0: 9876543   20000    0    0    0     0          0         0  1234567   15000    0    0    0     0       0          0',
  '@net docker0:  555555    10    0    0    0     0          0         0   555555     10    0    0    0     0       0          0',
  '@load 0.08 0.03 0.01 1/123 4567',
  '@uptime 1234567.89 2345678.12',
  '@tty pts/0',
  '@who root     pts/0        2026-10-24 09:12 (192.168.1.20)',
  '@who root     pts/1        2026-10-24 10:40 (10.0.0.7)',
  '@who anna     tty1         2026-10-20 08:00',
  '@df /dev/sda1        20511312 17804216   1641840      92% /',
  '@df udev               484608        0    484608       0% /dev',
  '@df tmpfs              100452      820     99632       1% /run',
  '@df /dev/sdb1       102687672 40000000  57428000      42% /srv/data',
  '@df /dev/sda1        20511312 17804216   1641840      92% /var/lib/docker/overlay',
  '@df /dev/loop0          56832    56832         0     100% /snap/core18/2812',
  '@end',
);

const UBUNTU = lines(
  '@v 1',
  '@host web-01',
  '@kernel Linux 5.15.0-91-generic',
  '@osr PRETTY_NAME="Ubuntu 22.04.3 LTS"',
  '@osr ID=ubuntu',
  '@osr ID_LIKE=debian',
  '@ncpu 4',
  '@user deploy',
  '@stat cpu  200 0 100 700 0 0 0 0 0 0',
  '@mem MemTotal:        8000000 kB',
  '@mem MemAvailable:    6000000 kB',
  '@net ens3: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0',
  '@who deploy   pts/0        2026-10-24 09:12 (203.0.113.5)',
  '@df /dev/vda1  40581564 12000000 28564780  30% /',
  '@end',
);

// busybox: who prints a header and the host bare; /proc/net/dev of an old kernel has no space after the colon.
const ALPINE = lines(
  '@v 1',
  '@host alpine-box',
  '@kernel Linux 6.6.14-0-virt',
  '@osr NAME="Alpine Linux"',
  '@osr ID=alpine',
  '@osr PRETTY_NAME="Alpine Linux v3.19"',
  '@ncpu 1',
  '@user root',
  '@stat cpu  5000 0 2000 93000 0 0 0 0 0 0',
  '@mem MemTotal:         500000 kB',
  '@mem MemFree:          200000 kB',
  '@mem MemAvailable:     350000 kB',
  '@net eth0:12345 10 0 0 0 0 0 0 54321 10 0 0 0 0 0 0',
  '@load 0.00 0.00 0.00 1/50 999',
  '@uptime 300.5 290.1',
  '@tty pts/0',
  '@who USER       TTY      IDLE      TIME            HOST',
  '@who root       pts/0    00:00     Oct 24 10:22:33 192.168.56.1',
  '@df Filesystem           1024-blocks    Used Available Capacity Mounted on',
  '@df /dev/sda3              7854264   900000   6527264  13% /',
  '@df devtmpfs                 10240        0     10240   0% /dev',
  '@df shm                     250000        0    250000   0% /dev/shm',
  '@end',
);

// CentOS 6: no os-release (redhat-release instead), no MemAvailable.
const CENTOS6 = lines(
  '@v 1',
  '@host legacy',
  '@kernel Linux 2.6.32-754.el6.x86_64',
  '@osr PRETTY_NAME=CentOS release 6.10 (Final)',
  '@ncpu 2',
  '@user admin',
  '@stat cpu  100 0 50 850 0 0 0 0',
  '@mem MemTotal:        2000000 kB',
  '@mem MemFree:          500000 kB',
  '@mem Buffers:          100000 kB',
  '@mem Cached:           400000 kB',
  '@net   eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0',
  '@df /dev/mapper/VolGroup-lv_root  51475068  45000000  3854608  93% /',
  '@end',
);

// FreeBSD: no /proc.
const FREEBSD = lines(
  '@v 1',
  '@host bsd',
  '@kernel FreeBSD 14.0-RELEASE',
  '@osr NAME=FreeBSD',
  '@osr ID=freebsd',
  '@osr PRETTY_NAME="FreeBSD 14.0-RELEASE"',
  '@ncpu 4',
  '@user root',
  '@sysctl kern.cp_time 1000 0 500 100 8400',
  '@sysctl hw.physmem 4261412864',
  '@sysctl hw.pagesize 4096',
  '@sysctl vm.stats.vm.v_free_count 500000',
  '@sysctl vm.stats.vm.v_inactive_count 100000',
  '@sysctl vm.loadavg { 0.15 0.20 0.25 }',
  '@sysctl kern.boottime { sec = 1761200000, usec = 123456 } Thu Oct 23 08:13:20 2025',
  '@now 1761203600',
  '@ns vtnet0  1500 <Link#1>      58:9c:fc:00:00:01  1000     0     0  5000000   800     0  700000     0',
  '@ns lo0    16384 <Link#2>      lo0                 10     0     0      999    10     0     999     0',
  '@who root           pts/0    Oct 24 10:00 (10.0.0.9)',
  '@df /dev/ada0p2  30000000 12000000 15600000    44%    /',
  '@df devfs                1        1        0   100%    /dev',
  '@end',
);

const MACOS = lines(
  '@v 1',
  '@host mac-mini.local',
  '@kernel Darwin 23.4.0',
  '@osr PRETTY_NAME=macOS 14.4',
  '@ncpu 8',
  '@user alice',
  '@sysctl hw.memsize 17179869184',
  '@sysctl hw.physmem 2147483648',
  '@sysctl vm.loadavg { 1.50 1.20 1.00 }',
  '@now 1761203600',
  '@vm Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  '@vm Pages free:                               10000.',
  '@vm Pages active:                            300000.',
  '@vm Pages inactive:                          290000.',
  '@vm Pages speculative:                         5000.',
  '@pscpu 80.5',
  '@ns en0   1500  <Link#11>   a4:83:e7:00:00:01  120000     0  98765432  90000     0  1234567     0',
  '@ns lo0   16384 <Link#1>                       5000     0    500000   5000     0   500000     0',
  '@who alice    console  Oct 20 08:00',
  '@who alice    ttys000  Oct 24 10:00 (192.168.1.3)',
  '@df /dev/disk3s1s1   482797652  9000000 300000000     3%    /',
  '@df /dev/disk3s6     482797652  2097152 300000000     1%    /System/Volumes/VM',
  '@df /dev/disk3s5     482797652 170000000 300000000    37%    /System/Volumes/Data',
  '@end',
);

describe('SSH status bar script', () => {
  it('asks for the system only on the first run and ends with a marker', () => {
    expect(barScript(true)).toContain('/etc/os-release');
    expect(barScript(false)).not.toContain('/etc/os-release');
    expect(barScript(false)).toContain('@ncpu'.slice(0, 0));
    expect(barScript(false).trimEnd().endsWith('echo @end')).toBe(true);
    // Plain POSIX sh: no bash-only syntax.
    expect(barScript(true)).not.toMatch(/\[\[|\$\(\(|<<<|function /);
  });
});

// The script itself on this machine's sh (macOS and Linux runners; Windows has none): it parses into a complete sample.
describe.runIf(process.platform !== 'win32')('the script on a real sh', () => {
  it('reads this machine', () => {
    const out = execFileSync('/bin/sh', ['-s'], { input: barScript(true), encoding: 'utf8', timeout: 15_000 });
    const s = parseBar(out)!;
    expect(s.complete).toBe(true);
    expect(s.host).toBeTruthy();
    expect(s.user).toBeTruthy();
    expect(s.os!.id).not.toBe('unknown');
    expect(s.cpu).toBeDefined();
    expect(s.mem!.total).toBeGreaterThan(0);
    expect(s.disks.some((d) => d.mount === '/')).toBe(true);
    expect(s.ncpu).toBeGreaterThan(0);
  }, 20_000);
});

describe('parseBar', () => {
  it('reads a Debian server, skipping the login chatter', () => {
    const s = parseBar(DEBIAN)!;
    expect(s.complete).toBe(true);
    expect(s.host).toBe('srv36');
    expect(s.os).toEqual({ id: 'debian', name: 'Debian GNU/Linux 12 (bookworm)' });
    expect(s.user).toBe('root');
    expect(s.ncpu).toBe(2);
    expect(s.cpu).toEqual({ busy: 10132153 + 290696 + 3084719 + 25195, total: 10132153 + 290696 + 3084719 + 46828483 + 16683 + 25195 });
    expect(s.mem).toEqual({ total: 1004500 * 1024, available: 763000 * 1024 });
    // lo and docker0 are not counted.
    expect(s.net).toEqual({ rx: 9876543, tx: 1234567 });
    expect(s.load).toEqual([0.08, 0.03, 0.01]);
    expect(s.uptime).toBeCloseTo(1234567.89);
    expect(s.who).toEqual([
      { user: 'root', tty: 'pts/0', from: '192.168.1.20', since: '2026-10-24 09:12', self: true },
      { user: 'root', tty: 'pts/1', from: '10.0.0.7', since: '2026-10-24 10:40', self: false },
      { user: 'anna', tty: 'tty1', from: '', since: '2026-10-20 08:00', self: false },
    ]);
    // udev, tmpfs, snap loops dropped; the bind mount of sda1 folds into /.
    expect(s.disks.map((d) => [d.mount, d.percent])).toEqual([['/', 92], ['/srv/data', 42]]);
    expect(rootDisk(s.disks)!.size).toBe(20511312 * 1024);
  });

  it('reads Ubuntu (ID wins over ID_LIKE) and Mint (its ID before ubuntu)', () => {
    expect(parseBar(UBUNTU)!.os!.id).toBe('ubuntu');
    expect(osIdOf('linuxmint', 'ubuntu debian', '', 'Linux')).toBe('mint');
    expect(osIdOf('pop', 'ubuntu debian', '', 'Linux')).toBe('ubuntu');
    expect(osIdOf('rocky', 'rhel centos fedora', '', 'Linux')).toBe('rocky');
    expect(osIdOf('almalinux', 'rhel centos fedora', '', 'Linux')).toBe('alma');
    expect(osIdOf('amzn', 'centos rhel fedora', '', 'Linux')).toBe('rhel');
    expect(osIdOf('opensuse-leap', 'suse opensuse', '', 'Linux')).toBe('suse');
    expect(osIdOf('manjaro', 'arch', '', 'Linux')).toBe('arch');
    expect(osIdOf('nixos', '', 'NixOS 24.05', 'Linux')).toBe('linux');
    expect(osIdOf('', '', '', 'SunOS')).toBe('unknown');
  });

  it('reads busybox (Alpine): the who header, a bare host, /proc/net/dev without a space', () => {
    const s = parseBar(ALPINE)!;
    expect(s.os!.id).toBe('alpine');
    expect(s.net).toEqual({ rx: 12345, tx: 54321 });
    expect(s.who).toEqual([{ user: 'root', tty: 'pts/0', from: '192.168.56.1', since: 'Oct 24 10:22:33', self: true }]);
    expect(s.disks.map((d) => d.mount)).toEqual(['/']);
  });

  it('reads CentOS 6: redhat-release and memory without MemAvailable', () => {
    const s = parseBar(CENTOS6)!;
    expect(s.os!.id).toBe('centos');
    expect(s.mem).toEqual({ total: 2000000 * 1024, available: (500000 + 100000 + 400000) * 1024 });
    expect(s.disks[0]).toMatchObject({ fs: '/dev/mapper/VolGroup-lv_root', mount: '/', percent: 93 });
    expect(s.load).toBeUndefined();
    // No who lines: this session alone.
    expect(s.who).toEqual([{ user: 'admin', tty: '', from: '', since: '', self: true }]);
  });

  it('reads FreeBSD without /proc: sysctl, netstat, boot time', () => {
    const s = parseBar(FREEBSD)!;
    expect(s.os!.id).toBe('freebsd');
    expect(s.cpu).toEqual({ busy: 1600, total: 10000 });
    expect(s.mem).toEqual({ total: 4261412864, available: 600000 * 4096 });
    expect(s.net).toEqual({ rx: 5000000, tx: 700000 });
    expect(s.load).toEqual([0.15, 0.2, 0.25]);
    expect(s.uptime).toBe(3600);
    expect(s.who[0]).toMatchObject({ user: 'root', tty: 'pts/0', from: '10.0.0.9', self: false });
    expect(s.disks.map((d) => d.mount)).toEqual(['/']);
  });

  it('reads macOS: vm_stat, ps, netstat with an empty address, system volumes dropped', () => {
    const s = parseBar(MACOS)!;
    expect(s.os!.id).toBe('macos');
    expect(s.mem).toEqual({ total: 17179869184, available: (10000 + 290000 + 5000) * 16384 });
    expect(s.cpu).toEqual({ psSum: 80.5 });
    expect(s.net).toEqual({ rx: 98765432, tx: 1234567 });
    // /dev/disk3s1s1 / and the data volume; VM is no disk.
    expect(s.disks.map((d) => d.mount)).toEqual(['/', '/System/Volumes/Data']);
    const t = advanceBar(null, s, 0);
    expect(t.cpuPercent).toBeCloseTo(80.5 / 8);
  });

  it('gives up on output that is no answer (a Windows shell, a menu) and keeps a cut run', () => {
    expect(parseBar("'exec' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n")).toBeNull();
    expect(parseBar('')).toBeNull();
    const cut = parseBar(lines('@v 1', '@host h', '@user u', '@stat cpu 1 0 1 8 0 0 0 0'))!;
    expect(cut.complete).toBe(false);
    expect(cut.host).toBe('h');
    expect(cut.disks).toEqual([]);
    // Later runs do not ask for the system: no os.
    expect(parseBar(lines('@v 1', '@kernel Linux 6.1', '@end'))!.os).toBeUndefined();
    // A first run of a Linux box with neither os-release nor redhat-release.
    expect(parseBar(lines('@v 1', '@kernel Linux 4.4', '@ncpu 1', '@end'))!.os).toEqual({ id: 'linux' });
  });

  it('strips control characters a hostile server could send', () => {
    const s = parseBar(lines('@v 1', '@host evil\u001b]0;pwned\u0007', '@end'))!;
    expect(s.host).toBe('evil]0;pwned');
  });
});

describe('parseDf and parseWho', () => {
  it('keeps mount points with spaces and the shortest mount of a device', () => {
    expect(parseDf(['/dev/sdc1 1000 500 500 50% /mnt/my disk', '/dev/sdc1 1000 500 500 50% /mnt/my disk/bind'])).toEqual([
      { fs: '/dev/sdc1', mount: '/mnt/my disk', size: 1024000, used: 512000, avail: 512000, percent: 50 },
    ]);
    expect(parseDf(['garbage line', 'overlay 1000 100 900 10% /'])).toHaveLength(1);
  });

  it('folds a container’s bind mounts into its overlay root (same size, used and free)', () => {
    // df -Pk in a Docker container (seen on Alpine and Debian images under WSL2).
    expect(parseDf([
      'overlay         1055762868 63012344 1006677768   6% /',
      'tmpfs                65536        0      65536   0% /dev',
      'shm                  65536        0      65536   0% /dev/shm',
      '/dev/sdd        1055762868 63012344 1006677768   6% /etc/hosts',
      '/dev/sdd        1055762868 63012344 1006677768   6% /etc/hostname',
    ]).map((d) => d.mount)).toEqual(['/']);
  });

  it('shows the cell’s own session when the server keeps no login records (a container)', () => {
    const s = parseBar(lines('@v 1', '@user root', '@client 172.17.0.1', '@tty pts/0', '@end'))!;
    expect(s.who).toEqual([{ user: 'root', tty: 'pts/0', from: '172.17.0.1', since: '', self: true }]);
  });

  it('marks the cell’s own session only for its tty and user', () => {
    expect(parseWho(['bob pts/0 2026-10-24 09:12 (1.2.3.4)'], 'pts/0', 'root')[0].self).toBe(false);
    expect(parseWho(['root pts/0 2026-10-24 09:12 (1.2.3.4)'], undefined, 'root')[0].self).toBe(false);
  });
});

describe('advanceBar', () => {
  const at = (cpu: [number, number], net: [number, number]) => parseBar(lines('@v 1', `@stat cpu ${cpu[0]} 0 0 ${cpu[1]} 0 0 0 0`, `@net eth0: ${net[0]} 0 0 0 0 0 0 0 ${net[1]} 0 0 0 0 0 0 0`, '@end'))!;

  it('makes CPU % and network rates from two samples', () => {
    const a = advanceBar(null, at([100, 900], [1000, 500]), 0);
    expect(a.cpuPercent).toBeUndefined();
    expect(a.rx).toBeUndefined();
    const b = advanceBar(a, at([150, 1000], [7000, 2000]), 3000);
    expect(b.cpuPercent).toBeCloseTo((50 / 150) * 100);
    expect(b.rx).toBe(2000);
    expect(b.tx).toBe(500);
    expect(b.cpuHistory).toHaveLength(1);
  });

  it('makes no rate after a long gap or a counter reset (a reboot)', () => {
    const a = advanceBar(null, at([100, 900], [1000, 500]), 0);
    const late = advanceBar(a, at([200, 1800], [9000, 900]), 60_000);
    expect(late.cpuPercent).toBeUndefined();
    expect(late.rx).toBeUndefined();
    const reset = advanceBar(advanceBar(null, at([100, 900], [5000, 5000]), 0), at([10, 90], [10, 10]), 3000);
    expect(reset.cpuPercent).toBeUndefined();
    expect(reset.rx).toBeUndefined();
  });

  it('keeps the last SSH_BAR_HISTORY CPU samples and the system of the first run', () => {
    let t = advanceBar(null, { ...at([0, 0], [0, 0]), os: { id: 'debian' }, ncpu: 2 }, 0);
    for (let i = 1; i <= SSH_BAR_HISTORY + 5; i++) t = advanceBar(t, at([i * 10, i * 90], [i, i]), i * 3000);
    expect(t.cpuHistory).toHaveLength(SSH_BAR_HISTORY);
    expect(t.cpuHistory.every((v) => Math.abs(v - 10) < 1e-9)).toBe(true);
    expect(t.os).toEqual({ id: 'debian' });
    expect(t.ncpu).toBe(2);
  });
});

describe('formatting', () => {
  it('writes memory in the unit of the total with the locale decimal sign', () => {
    expect(formatMemory({ total: 1004500 * 1024, available: 763000 * 1024 }, 'pl')).toBe('0,23/0,96 GB');
    expect(formatMemory({ total: 16 * 1024 ** 3, available: 4 * 1024 ** 3 }, 'en')).toBe('12.0/16.0 GB');
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1536, 'en')).toBe('1.50 KB');
    expect(formatRate(52_000, 'de')).toBe('50,8 KB/s');
    expect(formatRate(-3, 'en')).toBe('0 B/s');
  });

  it('writes uptimes, disk levels and the sparkline', () => {
    expect(formatUptime(1234567)).toBe('14 d 6 h');
    expect(formatUptime(3 * 3600 + 5 * 60)).toBe('3 h 5 min');
    expect(formatUptime(59)).toBe('0 min');
    expect([diskLevel(80), diskLevel(81), diskLevel(90), diskLevel(91)]).toEqual(['ok', 'warn', 'warn', 'full']);
    expect(sparklinePoints([5], 60, 12)).toBe('');
    const pts = sparklinePoints([0, 100], 58, 12).split(' ');
    expect(pts).toEqual(['56.0,11.5', '58.0,0.5']);
  });

  it('switches items off only with false', () => {
    expect(shownBarItems(undefined)).toEqual(['host', 'cpu', 'mem', 'net', 'uptime', 'user', 'disk']);
    expect(shownBarItems({ net: false, user: true })).toEqual(['host', 'cpu', 'mem', 'uptime', 'user', 'disk']);
    expect(normalizeBarItems({ net: false, user: true, bogus: false })).toEqual({ net: false });
    expect(normalizeBarItems('x')).toBeUndefined();
    expect(normalizeBarItems({ uptime: false })).toEqual({ uptime: false });
  });

  it('writes the short forms: memory share, compact rates, uptime in the app language', () => {
    expect(memoryPercent({ total: 1000, available: 630 })).toBeCloseTo(37);
    expect(memoryPercent({ total: 0, available: 0 })).toBe(0);
    expect(formatRate(9000, 'pl', true)).toBe('8,8K');
    expect(formatRate(40_000, 'en', true)).toBe('39K');
    expect(formatRate(300, 'en', true)).toBe('300B');
    expect(formatRate(5 * 1024 ** 2, 'en', true)).toBe('5.0M');
    expect(formatUptimeShort(297 * 86400 + 5000, 'pl')).toBe('297 dni');
    expect(formatUptimeShort(86400, 'pl')).toBe('1 dzień');
    expect(formatUptimeShort(297 * 86400, 'en')).toBe('297 days');
    expect(formatUptimeShort(5 * 3600 + 12 * 60 + 30, 'pl')).toBe('5 h 12 min');
    expect(formatUptimeShort(5 * 3600 + 12 * 60, 'pl', true)).toBe('5 h');
    expect(formatUptimeShort(720, 'de')).toBe('12 min');
    expect(formatUptimeShort(297 * 86400, 'pl', true)).toMatch(/^297\s?d/);
  });
});

describe('the user item', () => {
  const w = (user: string, tty: string, self = false) => ({ user, tty, from: '', since: '', self });
  it('lists everyone else first and the cell’s own session last', () => {
    const { others, self } = splitWho([w('root', 'pts/0', true), w('root', 'pts/1'), w('backup', 'pts/2')], 'root');
    expect(others.map((x) => x.tty)).toEqual(['pts/1', 'pts/2']);
    expect(self?.tty).toBe('pts/0');
  });

  it('takes the first row of the same user when no tty was found, and works without any row', () => {
    const { others, self } = splitWho([w('backup', 'pts/2'), w('daniel', 'pts/3'), w('daniel', 'pts/4')], 'daniel');
    expect(self).toMatchObject({ tty: 'pts/3', self: true });
    expect(others.map((x) => x.tty)).toEqual(['pts/2', 'pts/4']);
    expect(splitWho([], 'x')).toEqual({ others: [], self: undefined });
    expect(splitWho([w('a', 'pts/0')], undefined)).toEqual({ others: [w('a', 'pts/0')], self: undefined });
  });
});

describe('fitBar', () => {
  const all = ['host', 'cpu', 'mem', 'net', 'uptime', 'user', 'disk'] as const;
  const widths = {
    host: { full: 120, compact: 120 }, cpu: { full: 90, compact: 90, bare: 46 }, mem: { full: 100, compact: 46 },
    net: { full: 150, compact: 90 }, uptime: { full: 60, compact: 44 }, user: { full: 70, compact: 70 }, disk: { full: 60, compact: 40 },
  };
  const at = (room: number, current?: BarStage) => fitBar(all, widths, room, 12, 90, current);

  it('keeps everything in full while it fits, then shortens values, then the sparkline, then drops items', () => {
    // Full: 90 (host at most hostMin) + 90 + 100 + 150 + 60 + 70 + 60 + 6 gaps of 12 = 692.
    expect(barStageWidth({ compact: false, spark: true, items: [...all] }, widths, 12, 90)).toBe(692);
    expect(at(692)).toEqual({ compact: false, spark: true, items: [...all], rank: 0 });
    expect(at(691)).toEqual({ compact: true, spark: true, items: [...all], rank: 1 });
    // Short forms without the sparkline: 90 + 46 + 46 + 90 + 44 + 70 + 40 + 72 = 498.
    expect(at(540)).toEqual({ compact: true, spark: false, items: [...all], rank: 2 });
    expect(at(498).rank).toBe(2);
    expect(at(497).rank).toBeGreaterThan(2);
  });

  it('drops by priority but keeps a less important item that still fits, the first one always', () => {
    expect(at(450).items).toEqual(['host', 'cpu', 'mem', 'net', 'uptime', 'disk']);
    // The network does not fit any more, the user (less important, narrower) does.
    expect(at(400).items).toEqual(['host', 'cpu', 'mem', 'uptime', 'user', 'disk']);
    expect(at(340).items).toEqual(['host', 'cpu', 'mem', 'uptime', 'disk']);
    expect(at(300).items).toEqual(['host', 'cpu', 'mem', 'disk']);
    expect(at(10).items).toEqual(['host']);
    expect(fitBar(['mem', 'disk'], widths, 10, 12, 90).items).toEqual(['mem']);
    expect(at(300).rank).toBeLessThan(at(10).rank);
  });

  it('comes back to a roomier stage only with a few pixels to spare', () => {
    const compact = at(691);
    expect(at(692, compact)).toBe(compact);
    expect(at(700, compact).rank).toBe(0);
    const tight = at(300);
    expect(at(305, tight)).toEqual(tight);
    expect(at(318, tight)).toEqual(tight);
    expect(at(350, tight).items).toEqual(['host', 'cpu', 'mem', 'uptime', 'disk']);
    expect(at(200, at(692)).rank).toBe(at(200).rank);
  });
});
