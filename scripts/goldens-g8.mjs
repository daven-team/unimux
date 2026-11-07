// The notes / monitor / changelog part of the golden corpus (1.2.0, PLAN G8), used by scripts/dump-goldens.mjs. Every answer
// comes from the TS code of 1.1.4:
//
//   test/golden/changelog.jsonl  {releases} -> parseReleases(releases) of src/shared/changelog.ts (cleanReleaseNotes on bodies
//                                 made of awkward fragments: guides after \r / U+2028, four hashes, CRLF, JS white space, titles)
//                                 and {a, b} -> compareVersions(a, b)
//   test/golden/monitor.jsonl    {procs, prev, wallMs, cores, app, cells} -> cpuPercents + buildMonitor + killablePid of
//                                 src/shared/monitor.ts on random process trees (reused pids, cycles, console hosts, foreign
//                                 processes, ties in CPU and memory)
import { rng } from './goldens-normalize.mjs';

const FRAGMENTS = [
  '- Added a window.', '- Fixed a bug.', '# unimux 1.0.0', '# ajzakomator 0.5.4', '#\tUNIMUX 1.2', '## unimux 1.0', '# unimux x',
  'Windows packages for unimux 0.5.5.', 'windows PACKAGES for ajzakomator', 'Windows packages for someone', 'Validated with unit tests.',
  'validated with', 'Validated without tests', 'Validated with-care', '## Which download should I choose?', '### which DOWNLOAD should i choose?',
  '#### Which download should I choose?', '# Which download ſhould I choose?', '#\n\nWhich download should I choose? x', 'Choose an asset.',
  '**Bold** and `code`', '  indented  ', ' nbsp ', '﻿bom', ' ', ' ', '\r', '\r\n', '\n', '\n\n', '\n\n\n', ' ', '\t',
  'Some <b>text</b>.', 'ąę €', '😀', '1.0.0',
];
const TAGS = ['v1.2.0', 'v0.5.10', 'v0.5.9', 'v0.10.0', '1.1.4', 'vv1.0.0', 'v1.2', 'v1.2.0-beta', 'nightly', 'v01.2.3', 'v1.02.3', 'v1.2.03',
  'v0.0.0', 'v1.1.4', 'v1.1.4', 'v99999999999999999999.0.0', 'V1.0.0', 'v1.0.0 ', '', 'v1.0.0\n'];

function changelogRows(parseReleases, compareVersions) {
  const r = rng(808);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const rows = [];
  const body = () => {
    let text = '';
    const n = Math.floor(r() * 9);
    for (let i = 0; i < n; i++) text += pick(FRAGMENTS) + pick(['\n', '\n\n', '\r\n\r\n', '', ' ', '\r', ' ']);
    return text;
  };
  const value = () => pick([true, false, null, 0, 1, '', 'x', [], {}, undefined]);
  for (let i = 0; i < 300; i++) {
    const releases = [];
    const n = Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      const item = {};
      if (r() < 0.95) item.tag_name = r() < 0.9 ? pick(TAGS) : pick([5, null, true]);
      if (r() < 0.8) item.name = pick(['unimux 1.0', '', 'Release', 7, null]);
      if (r() < 0.8) item.published_at = pick(['2026-10-10T12:00:00Z', '', 5]);
      if (r() < 0.5) item.created_at = pick(['2026-01-01T00:00:00Z', null]);
      if (r() < 0.8) item.html_url = pick(['https://example.test/r', 5]);
      if (r() < 0.9) item.body = r() < 0.9 ? body() : 42;
      const draft = value();
      if (draft !== undefined) item.draft = draft;
      const pre = value();
      if (pre !== undefined) item.prerelease = pre;
      releases.push(r() < 0.05 ? pick([null, 5, 'x', []]) : item);
    }
    const input = i % 50 === 49 ? { message: 'rate limited' } : releases;
    rows.push({ releases: input, out: parseReleases(input) });
  }
  for (let i = 0; i < 200; i++) {
    const a = pick(TAGS), b = pick(TAGS);
    rows.push({ a, b, cmp: compareVersions(a, b) });
  }
  return rows;
}

const NAMES = ['unimux.exe', 'msedgewebview2.exe', 'OpenConsole.exe', 'conhost.exe', 'CONHOST', 'pwsh.exe', 'cmd.exe', 'node.exe',
  'claude.exe', 'codex.exe', 'bash', 'other.exe', 'openconsole.exe.bak', 'Open Console.exe'];

function monitorRows({ buildMonitor, cpuPercents, cpuMemo, killablePid }) {
  const r = rng(1006);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const int = (n) => Math.floor(r() * n);
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const n = 2 + int(i < 200 ? 12 : 60);
    const pids = new Set();
    while (pids.size < n) pids.add(1 + int(n * 3));
    const list = [...pids];
    const main = list[0];
    const procs = list.map((pid, k) => ({
      pid,
      // Mostly a tree under main; some foreign, some cycles, some reused parents.
      ppid: k === 0 ? 1 : r() < 0.8 ? list[int(k)] : pick([0, 1, list[int(n)], 9999]),
      cpuMs: r() < 0.2 ? 0 : Math.round(r() * 1e6) / pick([1, 3, 7]),
      mem: pick([0, 1000, 1000, 2048, 5000]) * (1 + int(4)),
      start: r() < 0.1 ? 0 : k * 10 + int(r() < 0.2 ? 200 : 10),
      name: k === 0 ? 'unimux.exe' : pick(NAMES),
    }));
    // The earlier snapshot: some processes changed their CPU, some pids belong to another process now.
    const prevProcs = procs.filter(() => r() < 0.8).map((p) => ({ ...p, cpuMs: Math.max(0, p.cpuMs - Math.round(r() * 5e3)), start: r() < 0.1 ? p.start + 1 : p.start }));
    const prev = r() < 0.15 ? null : cpuMemo(prevProcs);
    const wallMs = pick([0, 500, 2000, 2000, 2013.5]);
    const cores = pick([1, 4, 8, 12]);
    const cpu = cpuPercents(procs, prev, wallMs, cores);
    const kinds = ['renderer', 'gpu', 'webview', 'utility', 'ptyhost'];
    const app = [{ pid: main, kind: 'main' }];
    for (const p of procs.slice(1)) if (r() < 0.15) app.push({ pid: p.pid, kind: pick(kinds), ...(r() < 0.5 ? { name: pick(['Network Service', '', 'unimux Pty Host']) } : {}) });
    if (r() < 0.1) app.push({ pid: 77777, kind: 'gpu' });
    const cells = [];
    for (const p of procs.slice(1)) if (r() < 0.12) cells.push({ cellId: `c${cells.length}`, pid: p.pid });
    if (r() < 0.2) cells.push({ cellId: 'gone', pid: 88888 });
    const sample = buildMonitor({ procs, cpu, cores, app, cells, queryMs: 3 });
    const killable = list.filter((pid) => killablePid(sample, pid));
    rows.push({ procs, prev: prev ? [...prev].map(([pid, v]) => [pid, v.cpuMs, v.start]) : null, wallMs, cores, app, cells, cpu: [...cpu], sample, killable });
  }
  return rows;
}

export async function g8Goldens(load) {
  const [{ parseReleases, compareVersions }, monitor] = await Promise.all([load('src/shared/changelog.ts'), load('src/shared/monitor.ts')]);
  return {
    'changelog.jsonl': changelogRows(parseReleases, compareVersions),
    'monitor.jsonl': monitorRows(monitor),
  };
}
