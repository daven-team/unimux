import { describe, expect, it } from 'vitest';
import type { ProjectDirectory, ProjectFileEntry } from '../src/shared/types';
import {
  flattenTree, inIgnoredFolder, indentFor, indentGuides, INDENT, scrollToShow, scrollTopForPinned, shownFolders, stabilizeRows, stickyIndent, stickyRows, TWISTIE, visibleRange, type TreeRow,
} from '../src/shared/treeRows';

const dir = (path: string): ProjectFileEntry => ({ name: path.split('/').pop()!, path, kind: 'directory' });
const file = (path: string): ProjectFileEntry => ({ name: path.split('/').pop()!, path, kind: 'file' });
const ok = (...entries: ProjectFileEntry[]): ProjectDirectory => ({ ok: true, entries, truncated: false });
const paths = (rows: TreeRow[]) => rows.map((r) => r.type === 'entry' ? r.entry.path : `<${r.message}:${r.dir}>`);

const listings: Record<string, ProjectDirectory> = {
  '': ok(dir('a'), dir('b'), file('z.txt')),
  a: ok(dir('a/x'), file('a/1.ts'), file('a/2.ts')),
  'a/x': ok(file('a/x/deep.md')),
  b: ok(),
};
const get = (path: string) => listings[path];

describe('flattenTree', () => {
  it('lists only the root when nothing is expanded', () => {
    expect(paths(flattenTree(get, new Set()))).toEqual(['a', 'b', 'z.txt']);
  });

  it('puts the children of open folders right after them, with depth, parent and subtree end', () => {
    const rows = flattenTree(get, new Set(['a', 'a/x', 'b']));
    expect(paths(rows)).toEqual(['a', 'a/x', 'a/x/deep.md', 'a/1.ts', 'a/2.ts', 'b', '<empty:b>', 'z.txt']);
    const a = rows[0], x = rows[1], deep = rows[2];
    expect(a).toMatchObject({ depth: 0, parent: -1, open: true, end: 5, pos: 1, size: 3 });
    expect(x).toMatchObject({ depth: 1, parent: 0, open: true, end: 3 });
    expect(deep).toMatchObject({ depth: 2, parent: 1, end: 3 });
    expect(rows[6]).toMatchObject({ type: 'message', message: 'empty', depth: 1, parent: 5 });
    expect(rows[7]).toMatchObject({ depth: 0, pos: 3, size: 3, end: 8 });
  });

  it('hides the children of a closed parent even when they are expanded themselves', () => {
    expect(paths(flattenTree(get, new Set(['a/x'])))).toEqual(['a', 'b', 'z.txt']);
  });

  it('shows loading, error and truncation rows', () => {
    const rows = flattenTree((p) => p === '' ? { ok: true, entries: [dir('a'), dir('b')], truncated: true } : p === 'b' ? { ok: false, error: 'boom' } : undefined, new Set(['a', 'b']));
    expect(paths(rows)).toEqual(['a', '<loading:a>', 'b', '<error:b>', '<truncated:>']);
    expect(rows[3]).toMatchObject({ error: 'boom', depth: 1 });
    expect(paths(flattenTree(() => undefined, new Set()))).toEqual(['<loading:>']);
  });

  it('flattens a big tree quickly', () => {
    const big: Record<string, ProjectDirectory> = {};
    const open = new Set<string>();
    const make = (path: string, depth: number) => {
      const entries: ProjectFileEntry[] = [];
      if (depth < 5) for (let i = 0; i < 6; i++) { const child = path ? `${path}/d${i}` : `d${i}`; entries.push(dir(child)); open.add(child); make(child, depth + 1); }
      for (let i = 0; i < 5; i++) entries.push(file(path ? `${path}/f${i}` : `f${i}`));
      big[path] = ok(...entries);
    };
    make('', 0);
    const start = performance.now();
    const rows = flattenTree((p) => big[p], open);
    expect(rows.length).toBeGreaterThan(50000);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('stabilizeRows', () => {
  it('keeps the row objects whose content did not change, so their memoized views do not re-render', () => {
    const before = stabilizeRows(null, flattenTree(get, new Set(['a'])));
    // b opens: the rows above it keep their objects; b itself and the rows after it (moved down) are new
    const after = stabilizeRows(before, flattenTree(get, new Set(['a', 'b'])));
    const byKey = new Map(before.map((r) => [r.key, r]));
    const same = after.filter((r) => byKey.get(r.key) === r).map((r) => r.key);
    expect(same).toEqual(['a', 'a/x', 'a/1.ts', 'a/2.ts']);
    expect(paths(after)).toEqual(['a', 'a/x', 'a/1.ts', 'a/2.ts', 'b', '<empty:b>', 'z.txt']);
  });

  it('returns the same list when nothing changed, also after a reload with new listing objects', () => {
    const before = stabilizeRows(null, flattenTree(get, new Set(['a'])));
    const reloaded = (path: string) => { const l = listings[path]; return l?.ok ? { ...l, entries: l.entries.map((e) => ({ ...e })) } : l; };
    expect(stabilizeRows(before, flattenTree(reloaded, new Set(['a'])))).toBe(before);
  });

  it('keeps the unchanged rows when a listing arrives (a loading row becomes entries)', () => {
    const loading = stabilizeRows(null, flattenTree((p) => p === 'a/x' ? undefined : listings[p], new Set(['a', 'a/x'])));
    const loaded = stabilizeRows(loading, flattenTree(get, new Set(['a', 'a/x'])));
    const kept = loaded.filter((r) => loading.includes(r)).map((r) => r.key);
    expect(kept).toEqual(['a', 'a/x', 'a/1.ts', 'a/2.ts', 'b', 'z.txt']);
  });
});

describe('shownFolders', () => {
  it('keeps the root and the expanded folders whose parents are all expanded', () => {
    expect(shownFolders(['a', 'a/x', 'b/y', 'a/x/q'])).toEqual(['', 'a', 'a/x', 'a/x/q']);
    expect(shownFolders([])).toEqual(['']);
  });
});

describe('inIgnoredFolder', () => {
  const tree: Record<string, ProjectDirectory> = {
    '': ok(dir('node_modules'), dir('out'), dir('src'), file('release')),
    node_modules: ok(dir('node_modules/react'), file('node_modules/.package-lock.json')),
    'node_modules/react': ok(file('node_modules/react/index.js')),
    src: ok(dir('src/build'), dir('src/lib'), file('src/main.ts')),
    'src/build': ok(file('src/build/a.js')),
    'src/lib': ok(file('src/lib/b.ts')),
  };
  const rows = flattenTree((path) => tree[path], new Set(['node_modules', 'node_modules/react', 'src', 'src/build', 'src/lib']));
  const dimmed = (names?: ReadonlySet<string>) => rows.flatMap((row, i) => row.type === 'entry' && inIgnoredFolder(rows, i, names) ? [row.entry.path] : []);

  it('dims the dependency and build output folders and everything below them, at any depth', () => {
    expect(dimmed()).toEqual([
      'node_modules', 'node_modules/react', 'node_modules/react/index.js', 'node_modules/.package-lock.json', 'out', 'src/build', 'src/build/a.js',
    ]);
  });

  it('matches folders only (a file named release stays) and takes another set of names', () => {
    expect(dimmed(new Set(['lib', 'release']))).toEqual(['src/lib', 'src/lib/b.ts']);
    expect(inIgnoredFolder(rows, -1)).toBe(false);
    expect(inIgnoredFolder(rows, rows.length)).toBe(false);
  });
});

describe('stickyRows', () => {
  // a chain of folders l0/l1/.../l9, each with three files after its subfolder
  const chain: Record<string, ProjectDirectory> = {};
  const open = new Set<string>();
  let path = '';
  for (let level = 0; level < 10; level++) {
    const child = path ? `${path}/l${level}` : `l${level}`;
    chain[path] = ok(dir(child), file(`${child}-a`), file(`${child}-b`), file(`${child}-c`));
    open.add(child);
    path = child;
  }
  chain[path] = ok(file(`${path}/leaf-1`), file(`${path}/leaf-2`));
  const rows = flattenTree((p) => chain[p], open);
  const h = 20;
  const pinnedPaths = (top: number, max = 5) => stickyRows(rows, top, h, max).rows.map((i) => (rows[i] as Extract<TreeRow, { type: 'entry' }>).entry.path.split('/').pop());

  it('pins nothing at the top of the list', () => {
    expect(stickyRows(rows, 0, h)).toEqual({ rows: [], offset: 0 });
    expect(stickyRows([], 100, h)).toEqual({ rows: [], offset: 0 });
  });

  it('pins the folders around the rows behind the stack, outermost first', () => {
    // rows: a, a/x, a/x/deep.md, a/1.ts, a/2.ts, b, <empty b>, z.txt
    const small = flattenTree(get, new Set(['a', 'a/x', 'b']));
    const at = (top: number) => stickyRows(small, top, 20, 5);
    expect(at(10)).toEqual({ rows: [0, 1], offset: 0 });
    // a/x ends with deep.md: it slides up while a/1.ts comes up under the stack
    expect(at(30)).toEqual({ rows: [0, 1], offset: -10 });
    expect(at(39)).toEqual({ rows: [0, 1], offset: -19 });
    expect(at(40)).toEqual({ rows: [0], offset: 0 });
    expect(at(50)).toEqual({ rows: [0], offset: 0 });
    // a ends with a/2.ts (row 4): pushed up, then gone
    expect(at(80)).toEqual({ rows: [0], offset: 0 });
    expect(at(90)).toEqual({ rows: [0], offset: -10 });
    expect(at(100)).toEqual({ rows: [], offset: 0 });
    // b, partly scrolled away, holds its "empty" message
    expect(at(110)).toEqual({ rows: [5], offset: 0 });
  });

  it('a long chain of open folders looks the same as without pinning', () => {
    expect(pinnedPaths(h)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    expect(pinnedPaths(h, 10)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9']);
  });

  it('keeps the deepest levels when there are more than the limit', () => {
    // scrolled to the leaves: ten ancestors, the five closest stay
    const leaf = rows.findIndex((r) => r.type === 'entry' && r.entry.name === 'leaf-1');
    expect(pinnedPaths((leaf - 5) * h)).toEqual(['l5', 'l6', 'l7', 'l8', 'l9']);
    expect(pinnedPaths((leaf - 3) * h, 3)).toEqual(['l7', 'l8', 'l9']);
  });

  it('pushes the last pinned folder up when its subtree ends below it', () => {
    // the subtree of l9 ends with leaf-2; l8's files follow
    const leaf2 = rows.findIndex((r) => r.type === 'entry' && r.entry.name === 'leaf-2');
    const top = (leaf2 - 4) * h + 8; // leaf-2 is behind the last slot, 8 px of it above the stack's bottom
    const result = stickyRows(rows, top, h, 5);
    expect(result.offset).toBe(-8);
    expect(pinnedPaths(top)).toEqual(['l5', 'l6', 'l7', 'l8', 'l9']);
    expect(pinnedPaths((leaf2 - 3) * h)).toEqual(['l4', 'l5', 'l6', 'l7', 'l8']);
  });

  it('drops a folder whose subtree has ended', () => {
    const own = rows.findIndex((r) => r.type === 'entry' && r.entry.path.endsWith('l9-a'));
    // l9-a sits in l8, after l9's subtree: l9 is no longer pinned
    expect(pinnedPaths((own - 5) * h)).toEqual(['l4', 'l5', 'l6', 'l7', 'l8']);
  });

  it('a click on a pinned folder scrolls it right under its own pinned parents', () => {
    expect(scrollTopForPinned(30, 2, h)).toBe(28 * h);
    expect(scrollTopForPinned(30, 9, h, 5)).toBe(25 * h);
    expect(scrollTopForPinned(1, 4, h)).toBe(0);
    const l7 = rows.findIndex((r) => r.type === 'entry' && r.entry.name === 'l7');
    const top = scrollTopForPinned(l7, 7, h, 5);
    const pinned = stickyRows(rows, top, h, 5).rows;
    expect(pinned).not.toContain(l7);
    expect(pinned.length * h + top).toBe(l7 * h);
  });
});

describe('indentation', () => {
  it('grows by a full step up to the cap, then by a small one, then stops', () => {
    expect(indentFor(0)).toBe(INDENT.base);
    expect(indentFor(1) - indentFor(0)).toBe(INDENT.step);
    expect(indentFor(INDENT.cap) - indentFor(INDENT.cap - 1)).toBe(INDENT.step);
    expect(indentFor(INDENT.cap + 1) - indentFor(INDENT.cap)).toBe(INDENT.small);
    const max = indentFor(INDENT.cap + INDENT.compressed);
    expect(indentFor(INDENT.cap + INDENT.compressed + 1)).toBe(max);
    expect(indentFor(100)).toBe(max);
    expect(max).toBeLessThanOrEqual(100);
    expect(indentFor(-3)).toBe(INDENT.base);
  });

  it('pinned rows use a small fixed indent per stack position', () => {
    expect(stickyIndent(0)).toBe(INDENT.base);
    expect(stickyIndent(4)).toBeLessThan(indentFor(4));
    expect(stickyIndent(4) - stickyIndent(3)).toBe(6);
  });

  it('draws one guide per parent level, under its chevron, never more than the distinct positions', () => {
    expect(indentGuides(0)).toEqual([]);
    expect(indentGuides(2)).toEqual([indentFor(0) + TWISTIE / 2, indentFor(1) + TWISTIE / 2]);
    expect(indentGuides(40)).toHaveLength(INDENT.cap + INDENT.compressed);
    const guides = indentGuides(12);
    expect(guides).toEqual([...guides].sort((a, b) => a - b));
    expect(guides.at(-1)!).toBeLessThan(indentFor(12));
  });

  it('keeps rows and guides on whole pixels, with room between a guide and the child row it runs past', () => {
    for (let depth = 0; depth < 30; depth++) {
      expect(Number.isInteger(indentFor(depth))).toBe(true);
      expect(Number.isInteger(stickyIndent(depth))).toBe(true);
      for (const x of indentGuides(depth)) expect(Number.isInteger(x)).toBe(true);
    }
    // Full levels: the parent's guide runs left of the child's twistie slot, not through it.
    for (let level = 0; level < INDENT.cap - 1; level++) expect(indentGuides(level + 1).at(-1)!).toBeLessThan(indentFor(level + 1));
  });
});

describe('visible window', () => {
  it('covers the viewport plus overscan, clamped to the list', () => {
    expect(visibleRange(1000, 0, 200, 20, 5)).toEqual([0, 15]);
    expect(visibleRange(1000, 400, 200, 20, 5)).toEqual([15, 35]);
    expect(visibleRange(30, 400, 200, 20, 5)).toEqual([15, 30]);
    expect(visibleRange(0, 0, 200, 20)).toEqual([0, 0]);
  });

  it('scrolls only as far as needed, keeping room for the pinned rows', () => {
    expect(scrollToShow(10, 100, 200, 20)).toBe(100);
    expect(scrollToShow(2, 100, 200, 20)).toBe(40);
    expect(scrollToShow(6, 100, 200, 20, 60)).toBe(60);
    expect(scrollToShow(20, 100, 200, 20)).toBe(220);
    expect(scrollToShow(20, 100, 200, 20, 0, true)).toBe(320);
    expect(scrollToShow(2, 100, 200, 20, 0, true)).toBe(0);
  });
});
