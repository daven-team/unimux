import { describe, expect, it } from 'vitest';
import { layoutForCount, type GridLayout } from '../src/shared/layout';
import {
  applyTemplateCells, captureTemplate, cleanTemplateDir, normalizeCellDir, normalizePresets, normalizeTemplateCell, resolveTemplateDir,
  TEMPLATE_LIMITS, templateDir, templateFolders, templatesFor,
} from '../src/shared/gridTemplates';
import { addProject, addTab, cellCwd, defaultState, normalizeState, upsertPreset } from '../src/shared/state';
import { sessionSearchPaths } from '../src/shared/sessionTrack';
import type { Cell, Tab } from '../src/shared/types';

const ROOT = 'D:\\Projekty\\bot';
const sized: GridLayout = { ...layoutForCount(4), rowSizes: [2, 1], rowColSizes: [[3, 1], null] };

function grid(cells: Array<Partial<Cell>>, layout: GridLayout = sized): Tab {
  return { id: 'g', name: 'Team', layout, cells: cells.map((c, i) => ({ id: `c${i}`, profileId: 'claude', ...c })) };
}

describe('grid template folders', () => {
  it('stores folders relative to the project root, absolute outside it and nothing at the root', () => {
    expect(templateDir(ROOT, `${ROOT}\\web\\app`, 'win32')).toBe('web/app');
    expect(templateDir(ROOT, 'd:\\projekty\\BOT\\api', 'win32')).toBe('api');
    expect(templateDir(ROOT, ROOT, 'win32')).toBeUndefined();
    expect(templateDir(ROOT, `${ROOT}\\`, 'win32')).toBeUndefined();
    expect(templateDir(ROOT, 'E:\\shared\\tools\\', 'win32')).toBe('E:\\shared\\tools');
    expect(templateDir('/home/u/bot', '/home/u/bot/web', 'darwin')).toBe('web');
    expect(templateDir('/home/u/bot', '/home/u/BOT/web', 'darwin')).toBe('/home/u/BOT/web');
    expect(templateDir(ROOT, undefined, 'win32')).toBeUndefined();
  });

  it('cleans stored folders and refuses ones that climb out of the project', () => {
    expect(cleanTemplateDir(' web\\app/ ')).toBe('web/app');
    expect(cleanTemplateDir('./web/./app')).toBe('web/app');
    expect(cleanTemplateDir('../other')).toBeUndefined();
    expect(cleanTemplateDir('web/../../x')).toBeUndefined();
    expect(cleanTemplateDir('.')).toBeUndefined();
    expect(cleanTemplateDir('')).toBeUndefined();
    expect(cleanTemplateDir(5)).toBeUndefined();
    expect(cleanTemplateDir('C:')).toBeUndefined();
    expect(cleanTemplateDir('C:\\')).toBe('C:\\');
    expect(cleanTemplateDir('/')).toBe('/');
    expect(cleanTemplateDir('a'.repeat(TEMPLATE_LIMITS.dir + 1))).toBeUndefined();
    expect(normalizeCellDir('web')).toBeUndefined();
    expect(normalizeCellDir('D:\\x\\')).toBe('D:\\x');
  });

  it('resolves folders against another project', () => {
    expect(resolveTemplateDir('E:\\other', 'web/app', 'win32')).toBe('E:\\other\\web\\app');
    expect(resolveTemplateDir('/srv/other', 'web/app', 'linux')).toBe('/srv/other/web/app');
    expect(resolveTemplateDir('E:\\other', 'F:\\tools', 'win32')).toBe('F:\\tools');
    expect(resolveTemplateDir('E:\\other', undefined, 'win32')).toBeUndefined();
  });
});

describe('capturing a grid as a template', () => {
  it('keeps layout, sizes, profiles, names, colours, folders, worktree and muted flags, never sessions or secrets', () => {
    const tab = grid([
      { profileId: 'claude', name: 'Front', color: '#60a5fa', dir: `${ROOT}\\web`, role: 'worker', model: 'opus', session: { cli: 'claude', id: 's1', confirmed: true }, startupPrompt: 'go', promptQueue: { items: [], paused: false } as unknown as Cell['promptQueue'] },
      { profileId: 'codex', worktree: { path: 'D:\\wt\\1', branch: 'mc/1' }, dir: `${ROOT}\\ignored`, muted: true },
      { profileId: 'shell', ssh: { hostId: 'h1', cwd: '/var/www', resume: true }, role: 'worker', dir: `${ROOT}\\x` },
      { profileId: 'shell', dir: 'E:\\tools' },
    ]);
    const t = captureTemplate({ id: 't1', name: '  Full stack  ', project: { path: ROOT }, tab, platform: 'win32' });
    expect(t).toEqual({
      id: 't1', name: 'Full stack', layout: sized,
      cells: [
        { profileId: 'claude', worktree: false, role: 'worker', model: 'opus', name: 'Front', color: '#60a5fa', dir: 'web' },
        { profileId: 'codex', worktree: true, muted: true },
        { profileId: 'shell', worktree: false, sshHostId: 'h1' },
        { profileId: 'shell', worktree: false, dir: 'E:\\tools' },
      ],
    });
    expect(t.projectId).toBeUndefined();
    expect(JSON.stringify(t)).not.toMatch(/session|startupPrompt|promptQueue|\/var\/www|resume/);
    // The template is a copy: later divider drags do not change it.
    (tab.layout.rowSizes as number[])[0] = 9;
    expect(t.layout.rowSizes).toEqual([2, 1]);
  });

  it('rebuilds a layout that does not fit the cells', () => {
    const t = captureTemplate({ id: 't', name: 'x', project: { path: ROOT }, tab: grid([{}, {}], layoutForCount(4)), platform: 'win32' });
    expect(t.layout.areas).toHaveLength(2);
  });
});

describe('applying a template in another project', () => {
  const cells = [
    { profileId: 'claude', worktree: false, dir: 'web' },
    { profileId: 'codex', worktree: false, dir: 'missing/dir' },
    { profileId: 'shell', worktree: false, dir: 'F:\\tools' },
    { profileId: 'shell', worktree: false, sshHostId: 'h1', dir: 'web' },
    { profileId: 'codex', worktree: true, dir: 'web' },
    { profileId: 'shell', worktree: false, muted: true as const },
  ];
  it('lists the folders to check and resolves the existing ones, falling back to the root with a note', () => {
    expect(templateFolders(cells, 'E:\\other', 'win32')).toEqual(['E:\\other\\web', 'E:\\other\\missing\\dir', 'F:\\tools']);
    const exists = new Set(['E:\\other\\web', 'F:\\tools']);
    const r = applyTemplateCells(cells, 'E:\\other', 'win32', (f) => exists.has(f));
    expect(r.missing).toEqual(['missing/dir']);
    expect(r.cells.map((c) => c.dir)).toEqual(['E:\\other\\web', undefined, 'F:\\tools', undefined, undefined, undefined]);
    expect(r.cells[5].muted).toBe(true);
    expect(r.cells[3].sshHostId).toBe('h1');
  });

  it('a captured grid opened in another project gives cells with the same setup in that project', () => {
    let s = addProject(defaultState(), { name: 'a', path: ROOT });
    s = addProject(s, { name: 'b', path: 'E:\\other' });
    const t = captureTemplate({ id: 't', name: 'T', project: { path: ROOT }, tab: grid([{ dir: `${ROOT}\\web` }, { profileId: 'codex', muted: true }, { profileId: 'shell', ssh: { hostId: 'h' } }, { profileId: 'shell' }]), platform: 'win32' });
    const { cells: applied } = applyTemplateCells(t.cells, 'E:\\other', 'win32', () => true);
    s = addTab(s, s.projects[1].id, { layout: t.layout, cells: applied.map((c) => ({ ...c, worktree: undefined, ssh: c.sshHostId ? { hostId: c.sshHostId } : undefined })) });
    const tab = s.projects[1].tabs[0];
    expect(tab.layout).toEqual(sized);
    expect(tab.cells.map((c) => c.profileId)).toEqual(['claude', 'codex', 'shell', 'shell']);
    expect(tab.cells[0].dir).toBe('E:\\other\\web');
    expect(cellCwd(s.projects[1], tab.cells[0])).toBe('E:\\other\\web');
    expect(cellCwd(s.projects[1], tab.cells[1])).toBe('E:\\other');
    expect(tab.cells[1].muted).toBe(true);
    expect(tab.cells[2].ssh).toEqual({ hostId: 'h' });
    expect(sessionSearchPaths('E:\\other', s)).toEqual(['E:\\other', 'E:\\other\\web']);
  });
});

describe('normalising saved templates', () => {
  it('repairs cells, drops broken templates and unknown fields, and caps the count', () => {
    const raw = [
      { id: 'a', name: ' A ', layout: layoutForCount(2), cells: [
        { profileId: 'claude', worktree: 'yes', role: 'boss', muted: 1, dir: '../up', name: '', extra: 1, session: { id: 'x' } },
        { profileId: 'codex', worktree: true, role: 'worker', muted: true, dir: 'web\\app', sshHostId: 7, prompt: 'hi' },
        { name: 'no profile' },
      ], secret: 'x' },
      { id: 'a', name: 'duplicate id', layout: layoutForCount(1), cells: [{ profileId: 'claude' }] },
      { id: 'b', name: '', layout: layoutForCount(1), cells: [{ profileId: 'claude' }] },
      { id: 'c', name: 'no cells', layout: layoutForCount(1), cells: [] },
      { id: 'd', name: 'bad layout', layout: { cols: 1 }, cells: [{ profileId: 'claude' }, { profileId: 'claude' }], projectId: 'p1' },
      'junk',
    ];
    const out = normalizePresets(raw);
    expect(out.map((p) => p.id)).toEqual(['a', 'd']);
    expect(out[0]).toEqual({ id: 'a', name: 'A', layout: layoutForCount(2), cells: [
      { profileId: 'claude', worktree: false },
      { profileId: 'codex', worktree: true, role: 'worker', prompt: 'hi', dir: 'web/app', muted: true },
    ] });
    expect(out[1].layout.areas).toHaveLength(2);
    expect(out[1].projectId).toBe('p1');
    const many = Array.from({ length: TEMPLATE_LIMITS.count + 5 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, layout: layoutForCount(1), cells: [{ profileId: 'claude' }] }));
    expect(normalizePresets(many)).toHaveLength(TEMPLATE_LIMITS.count);
    expect(normalizePresets('nope')).toEqual([]);
    expect(normalizeTemplateCell({ profileId: 'old' }, (id) => (id === 'old' ? 'claude' : id))?.profileId).toBe('claude');
  });

  it('survives a state round trip with sizes, folders and muted flags; cell folders stay absolute only', () => {
    let s = addProject(defaultState(), { name: 'a', path: ROOT });
    s = addTab(s, s.projects[0].id, { layout: layoutForCount(2), cells: [{ profileId: 'claude', dir: `${ROOT}\\web`, muted: true }, { profileId: 'shell' }] });
    const t = captureTemplate({ id: 't', name: 'T', project: s.projects[0], tab: { ...s.projects[0].tabs[0], layout: { ...layoutForCount(2), colSizes: [2, 1] } }, platform: 'win32' });
    s = upsertPreset(s, t);
    const raw = JSON.parse(JSON.stringify(s));
    raw.projects[0].tabs[0].cells[1].dir = 'relative/not/allowed';
    const back = normalizeState(raw)!;
    expect(back.presets).toEqual([t]);
    expect(back.presets[0].layout.colSizes).toEqual([2, 1]);
    expect(back.projects[0].tabs[0].cells[0]).toMatchObject({ dir: `${ROOT}\\web`, muted: true });
    expect(back.projects[0].tabs[0].cells[1].dir).toBeUndefined();
  });

  it('offers global and own-project templates', () => {
    const list = [{ id: 'g', name: 'g', layout: layoutForCount(1), cells: [] }, { id: 'p', name: 'p', layout: layoutForCount(1), cells: [], projectId: 'p1' }];
    expect(templatesFor(list, 'p1').map((t) => t.id)).toEqual(['g', 'p']);
    expect(templatesFor(list, 'p2').map((t) => t.id)).toEqual(['g']);
  });
});
