// The Monitor panel's pure logic: snapshot parsing, CPU between two snapshots, the app and cell trees, what may be killed.
import { describe, expect, it } from 'vitest';
import {
  appProcKind, buildMonitor, childrenOf, cpuMemo, cpuPercents, descendants, formatBytes, formatCpu, killablePid,
  matchConsoleHosts, parsePsSnapshot, parsePsTime, parseWinSnapshot, type RawProc,
} from '../src/shared/monitor';
import { Monitor, type ProcessSnapshots } from '../src/main/monitor';

const proc = (pid: number, ppid: number, name: string, start = pid, cpuMs = 0, mem = 1000): RawProc => ({ pid, ppid, name, start, cpuMs, mem });

describe('snapshot parsing', () => {
  it('reads the Windows helper rows (100 ns CPU, FILETIME start) and skips junk', () => {
    const text = '0\t0\t999\t8192\t1\t\n4\t0\t350000\t12288\t134369538273443634\tSystem\n812\t4\t20000\t2048\t134369538273450000\tOpen Console.exe\r\nbad\n7\tx\n';
    expect(parseWinSnapshot(text)).toEqual([
      { pid: 4, ppid: 0, cpuMs: 35, mem: 12288, start: 13436953827344.3634, name: 'System' },
      { pid: 812, ppid: 4, cpuMs: 2, mem: 2048, start: 13436953827345, name: 'Open Console.exe' },
    ]);
  });

  it('reads ps CPU times in every shape macOS prints', () => {
    expect(parsePsTime('0:00.03')).toBeCloseTo(30);
    expect(parsePsTime('12:34.50')).toBeCloseTo(754_500);
    expect(parsePsTime('123:04.00')).toBeCloseTo(7_384_000);
    expect(parsePsTime('1:02:03')).toBe(3_723_000);
    expect(parsePsTime('2-01:00:00')).toBe(2 * 86_400_000 + 3_600_000);
    expect(parsePsTime('n/a')).toBeNaN();
  });

  it('reads ps rows with lstart and executable paths with spaces', () => {
    const text = [
      '  501     1  20480   0:01.50 Thu Oct 23 10:00:00 2026     /Applications/unimux.app/Contents/MacOS/unimux',
      '  777   501   1024   0:00.00 Thu Oct 23 10:00:05 2026     /Applications/Some App.app/Contents/MacOS/Some Helper',
      'garbage',
    ].join('\n');
    const rows = parsePsSnapshot(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 501, ppid: 1, mem: 20480 * 1024, cpuMs: 1500, name: 'unimux', start: Date.UTC(2026, 9, 23, 10, 0, 0) });
    expect(rows[1].name).toBe('Some Helper');
  });
});

describe('CPU between snapshots', () => {
  it('is the CPU time used in the interval over every core, 0 for new or reused pids', () => {
    const before = [proc(1, 0, 'a', 10, 1000), proc(2, 0, 'b', 20, 500), proc(3, 0, 'c', 30, 100)];
    const after = [proc(1, 0, 'a', 10, 3000), proc(2, 0, 'b', 99, 4000), proc(3, 0, 'c', 30, 100), proc(4, 0, 'd', 40, 900)];
    const cpu = cpuPercents(after, cpuMemo(before), 2000, 4);
    expect(cpu.get(1)).toBe(25); // 2 s of CPU in 2 s on 4 cores
    expect(cpu.get(2)).toBe(0); // the pid now belongs to another process
    expect(cpu.get(3)).toBe(0);
    expect(cpu.get(4)).toBe(0); // first seen
    expect(cpuPercents(after, null, 2000, 4).get(1)).toBe(0);
    expect(cpuPercents([proc(1, 0, 'a', 10, 1e9)], cpuMemo(before), 2000, 1).get(1)).toBe(100);
    expect(cpuPercents([proc(1, 0, 'a', 10, 0)], cpuMemo(before), 2000, 1).get(1)).toBe(0);
  });
});

describe('trees', () => {
  it('ignores a parent pid that was reused by a younger process', () => {
    const procs = [proc(10, 1, 'parent', 500), proc(11, 10, 'child', 600), proc(12, 10, 'orphan', 100)];
    expect(childrenOf(procs).get(10)?.map((p) => p.pid)).toEqual([11]);
    expect(descendants(childrenOf(procs), 10).map((p) => p.pid)).toEqual([11]);
  });

  it('survives cycles', () => {
    const procs = [proc(1, 2, 'a', 0), proc(2, 1, 'b', 0)];
    expect(descendants(childrenOf(procs), 1).map((p) => p.pid)).toEqual([2]);
  });

  it('gives each cell the console host ConPTY started right before its shell', () => {
    const hosts = [proc(50, 9, 'OpenConsole.exe', 1000), proc(51, 9, 'OpenConsole.exe', 2000), proc(52, 9, 'OpenConsole.exe', 3000), proc(53, 9, 'node.exe', 2999)];
    const roots = [{ cellId: 'b', proc: proc(61, 9, 'pwsh.exe', 2010) }, { cellId: 'a', proc: proc(60, 9, 'pwsh.exe', 1010) }, { cellId: 'c', proc: proc(62, 9, 'pwsh.exe', 3005) }];
    const got = matchConsoleHosts(hosts, roots);
    expect(Object.fromEntries([...got].map(([k, v]) => [k, v.pid]))).toEqual({ a: 50, b: 51, c: 52 });
    expect(matchConsoleHosts([proc(50, 9, 'conhost.exe', 5000)], [{ cellId: 'a', proc: proc(60, 9, 'sh', 1000) }]).size).toBe(0);
  });
});

describe('buildMonitor', () => {
  // main 100 -> renderer 101, gpu 102, pty host 103 (-> console 200, shell 201 -> claude 202 -> bash 203; console 210, shell 211),
  // monitor helper 104 (not an Electron process); 999 is somebody else's.
  const procs = [
    proc(100, 1, 'unimux.exe', 1), proc(101, 100, 'unimux.exe', 2), proc(102, 100, 'unimux.exe', 3), proc(103, 100, 'unimux.exe', 4),
    proc(104, 100, 'powershell.exe', 5),
    proc(200, 103, 'OpenConsole.exe', 10), proc(201, 103, 'pwsh.exe', 11), proc(202, 201, 'claude.exe', 12, 0, 5000), proc(203, 202, 'bash.exe', 13),
    proc(210, 103, 'OpenConsole.exe', 20), proc(211, 103, 'pwsh.exe', 21),
    proc(999, 1, 'other.exe', 30),
  ];
  const cpu = new Map([[100, 1], [101, 2], [104, 0.5], [202, 30], [203, 5], [211, 3], [210, 0.2]]);
  const app = [
    { pid: 100, kind: 'main' as const }, { pid: 101, kind: 'renderer' as const }, { pid: 102, kind: 'gpu' as const },
    { pid: 103, kind: 'ptyhost' as const, name: 'unimux Pty Host' },
  ];
  const sample = buildMonitor({ procs, cpu, cores: 8, app, cells: [{ cellId: 'quiet', pid: 211 }, { cellId: 'busy', pid: 201 }, { cellId: 'gone', pid: 777 }] });

  it('puts the busiest cell first with its tree depth-first and its console host', () => {
    expect(sample.cells.map((c) => c.cellId)).toEqual(['busy', 'quiet']);
    expect(sample.cells[0].rows.map((r) => [r.pid, r.depth])).toEqual([[201, 0], [202, 1], [203, 2], [200, 0]]);
    expect(sample.cells[0].cpu).toBe(35);
    expect(sample.cells[0].mem).toBe(8000);
    expect(sample.cells[1].rows.map((r) => r.pid)).toEqual([211, 210]);
  });

  it('lists the app processes and anything else the app started, never a cell process twice, never a foreign one', () => {
    expect(sample.app.map((a) => [a.pid, a.kind])).toEqual([[101, 'renderer'], [100, 'main'], [104, 'other'], [102, 'gpu'], [103, 'ptyhost']]);
    expect(sample.app.find((a) => a.pid === 103)?.name).toBe('unimux Pty Host');
    const all = [...sample.app.map((a) => a.pid), ...sample.cells.flatMap((c) => c.rows.map((r) => r.pid))];
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(999);
    expect(sample.cpu).toBeCloseTo(41.7);
  });

  it('allows killing only processes of a cell tree, never a console host, a host or the app', () => {
    expect(killablePid(sample, 203)).toBe(true);
    expect(killablePid(sample, 201)).toBe(true);
    expect(killablePid(sample, 200)).toBe(false);
    expect(killablePid(sample, 103)).toBe(false);
    expect(killablePid(sample, 100)).toBe(false);
    expect(killablePid(sample, 999)).toBe(false);
  });
});

describe('Monitor (main)', () => {
  const procs = [proc(100, 1, 'unimux.exe', 1), proc(103, 100, 'unimux.exe', 4), proc(200, 103, 'OpenConsole.exe', 10), proc(201, 103, 'cmd.exe', 11), proc(202, 201, 'node.exe', 12)];
  const snapshots = { take: async () => procs, stop: () => undefined } as unknown as ProcessSnapshots;
  const metrics = [
    { pid: 100, type: 'Browser' },
    // Electron reports a utility process with its fork's serviceName as `name` and its own service as `serviceName`.
    { pid: 103, type: 'Utility', name: 'unimux Pty Host', serviceName: 'node.mojom.NodeService' },
  ];

  it('names the hosts by their fork names and matches the console hosts to the cells', async () => {
    const monitor = new Monitor({ appMetrics: () => metrics, cells: () => [{ cellId: 'c', pid: 201 }], mainPid: 100 }, snapshots);
    const sample = await monitor.sample();
    expect(sample.app.find((a) => a.pid === 103)).toMatchObject({ kind: 'ptyhost', name: 'unimux Pty Host' });
    expect(sample.cells[0].rows.map((r) => r.pid)).toEqual([201, 202, 200]);
  });

  it('kills only processes of a cell tree', async () => {
    const killed: number[] = [];
    const monitor = new Monitor({ appMetrics: () => metrics, cells: () => [{ cellId: 'c', pid: 201 }], mainPid: 100, kill: (pid) => killed.push(pid) }, snapshots);
    expect(await monitor.kill(202)).toBe(true);
    expect(await monitor.kill(100)).toBe(false);
    expect(await monitor.kill(103)).toBe(false);
    expect(await monitor.kill(200)).toBe(false);
    expect(await monitor.kill('202')).toBe(false);
    expect(killed).toEqual([202]);
  });
});

describe('labels', () => {
  it('maps Electron process types and host service names', () => {
    expect(appProcKind('Browser', undefined)).toBe('main');
    expect(appProcKind('Tab', undefined)).toBe('renderer');
    expect(appProcKind('GPU', undefined)).toBe('gpu');
    expect(appProcKind('Utility', 'unimux Pty Host')).toBe('ptyhost');
    expect(appProcKind('Utility', 'unimux SFTP Host')).toBe('sftphost');
    expect(appProcKind('Utility', 'unimux DB Host')).toBe('dbhost');
    expect(appProcKind('Utility', 'Network Service')).toBe('utility');
    expect(appProcKind('Zygote', undefined)).toBe('other');
  });

  it('formats memory and CPU', () => {
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(formatCpu(12.345)).toBe('12.3%');
    expect(formatCpu(NaN)).toBe('0.0%');
  });
});
