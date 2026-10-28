import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL, gitPanelReason, normalizeSidePanels, optionalPanelOn, panelOpenable, railClick, railTileAction, railTileShown, railFocusTarget, resolvePanelId, sidePanelContent, visiblePanels, type PanelContext, type PanelDef,
} from '../src/shared/sidebarPanels';
import { defaultState, normalizeState } from '../src/shared/state';

const withProject: PanelContext = { hasProject: true, platform: 'win32' };
const noProject: PanelContext = { hasProject: false, platform: 'win32' };
const defs: PanelDef[] = [
  { id: 'projects' },
  { id: 'files', unavailableReason: (ctx) => (ctx.hasProject ? null : 'Najpierw dodaj projekt') },
  { id: 'git', available: () => false },
  { id: 'ssh', available: (ctx) => ctx.platform !== 'darwin' },
];

describe('sidebar panel registry helpers', () => {
  it('hides tiles of panels that are not available and keeps the order', () => {
    expect(visiblePanels(defs, withProject).map((d) => d.id)).toEqual(['projects', 'files', 'ssh']);
    expect(visiblePanels(defs, { ...withProject, platform: 'darwin' }).map((d) => d.id)).toEqual(['projects', 'files']);
  });

  it('shows a tile that cannot be opened yet but does not open it', () => {
    expect(visiblePanels(defs, noProject).map((d) => d.id)).toContain('files');
    expect(panelOpenable(defs[1], noProject)).toBe(false);
    expect(panelOpenable(defs[1], withProject)).toBe(true);
  });

  it('keeps the old view ids valid and falls back to the default for anything else', () => {
    expect(resolvePanelId(defs, 'projects', withProject)).toBe('projects');
    expect(resolvePanelId(defs, 'files', withProject)).toBe('files');
    expect(resolvePanelId(defs, 'files', noProject)).toBe(DEFAULT_PANEL);
    expect(resolvePanelId(defs, 'git', withProject)).toBe(DEFAULT_PANEL);
    for (const junk of [undefined, null, 5, {}, '', 'Files', '__proto__', 'constructor']) expect(resolvePanelId(defs, junk, withProject)).toBe(DEFAULT_PANEL);
  });

  it('opens a panel on click, folds the open one and reopens when collapsed', () => {
    expect(railClick({ collapsed: false, view: 'projects' }, 'files')).toEqual({ collapsed: false, view: 'files' });
    expect(railClick({ collapsed: false, view: 'files' }, 'files')).toEqual({ collapsed: true, view: 'files' });
    expect(railClick({ collapsed: true, view: 'files' }, 'files')).toEqual({ collapsed: false, view: 'files' });
    expect(railClick({ collapsed: true, view: 'files' }, 'projects')).toEqual({ collapsed: false, view: 'projects' });
  });

  it('a tile that opens a view is never the panel shown on the left (R13)', () => {
    const ctx: PanelContext = { hasProject: true, platform: 'win32' };
    const defs = [{ id: 'projects' }, { id: 'terminal', opensView: true }];
    expect(resolvePanelId(defs, 'terminal', ctx)).toBe(DEFAULT_PANEL);
    expect(visiblePanels(defs, ctx).map((d) => d.id)).toEqual(['projects', 'terminal']);
  });

  it('moves focus along the rail with wrapping and Home/End', () => {
    expect(railFocusTarget(3, 0, 'ArrowDown')).toBe(1);
    expect(railFocusTarget(3, 2, 'ArrowDown')).toBe(0);
    expect(railFocusTarget(3, 0, 'ArrowUp')).toBe(2);
    expect(railFocusTarget(3, 1, 'Home')).toBe(0);
    expect(railFocusTarget(3, 1, 'End')).toBe(2);
    expect(railFocusTarget(3, 1, 'a')).toBeNull();
    expect(railFocusTarget(0, 0, 'ArrowDown')).toBeNull();
  });
});

describe('persisted layout of the left panel', () => {
  it('keeps sidebarCollapsed and the content width, and repairs bad values', () => {
    const state = normalizeState(JSON.parse(JSON.stringify({ ...defaultState(), sidebarCollapsed: true, sidebarWidth: 300 })))!;
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.sidebarWidth).toBe(300);
    const repaired = normalizeState(JSON.parse(JSON.stringify({ ...defaultState(), sidebarCollapsed: 'yes', sidebarWidth: 5000 })))!;
    expect(typeof repaired.sidebarCollapsed).toBe('boolean');
    expect(repaired.sidebarWidth).toBe(480);
  });
});

describe('git and terminal tiles', () => {
  const git: PanelDef = { id: 'git', unavailableReason: gitPanelReason };
  const base: PanelContext = { hasProject: true, platform: 'win32' };

  it('opens Git for every project: without a repository or git the panel itself offers git init / installing Git', () => {
    expect(gitPanelReason({ ...base, git: 'repo' })).toBeNull();
    expect(gitPanelReason({ ...base, git: null })).toBeNull();
    expect(gitPanelReason({ ...base, git: 'no-repo' })).toBeNull();
    expect(gitPanelReason({ ...base, git: 'no-git' })).toBeNull();
    expect(gitPanelReason({ hasProject: false, platform: 'win32', git: 'repo' })).toBe('Najpierw dodaj projekt');
  });

  it('keeps the Git tile openable without a repository, and disabled only without a project', () => {
    const ctx: PanelContext = { ...base, git: 'no-repo' };
    expect(visiblePanels([git], ctx).map((d) => d.id)).toEqual(['git']);
    expect(panelOpenable(git, ctx)).toBe(true);
    expect(resolvePanelId([git], 'git', ctx)).toBe('git');
    const none: PanelContext = { hasProject: false, platform: 'win32' };
    expect(panelOpenable(git, none)).toBe(false);
    expect(resolvePanelId([git], 'git', none)).toBe(DEFAULT_PANEL);
  });

  it('keeps the rail order Projects, Files, Git, Databases (1.0.0), SSH, Monitor (1.0.6), Czeka na Ciebie (1.0.9) and the SSH tile always available', () => {
    const source = readFileSync('src/renderer/src/panelRegistry.tsx', 'utf8');
    const entries = source.split(/\r?\n/).filter((line) => /^\s*\{ id: '/.test(line));
    expect(entries.map((line) => /id: '([a-z]+)'/.exec(line)![1])).toEqual(['projects', 'files', 'git', 'db', 'terminal', 'monitor', 'waiting']);
    const terminal = entries.find((line) => line.includes("id: 'terminal'"))!;
    expect(terminal).toContain("label: 'SSH'");
    expect(terminal).not.toContain('unavailableReason');
    expect(terminal).toContain('opensView: true');
    expect(entries.find((line) => line.includes("id: 'git'"))).toContain('unavailableReason: gitPanelReason');
  });

  it('draws the folder on the Files tile and a different icon on the Projects tile', () => {
    const registry = readFileSync('src/renderer/src/panelRegistry.tsx', 'utf8');
    expect(registry).toMatch(/id: 'projects'.*icon: TProjects/);
    expect(registry).toMatch(/id: 'files'.*icon: TFiles/);
    const icons = readFileSync('src/renderer/src/components/icons.tsx', 'utf8');
    const body = (name: string) => {
      const start = icons.indexOf(`export const ${name} =`);
      return icons.slice(start, icons.indexOf('</T>', start));
    };
    const folder = 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7';
    expect(body('TFiles')).toContain(folder);
    expect(body('TProjects')).not.toContain(folder);
  });
});

describe('railTileShown (W3)', () => {
  const panel = { id: 'projects' };
  const view = { id: 'terminal', opensView: true };
  const base = { collapsed: false, activeId: 'projects', viewActive: false, settingsActive: false };
  it('marks the open panel, never the panel tile of a folded rail', () => {
    expect(railTileShown(panel, base)).toBe(true);
    expect(railTileShown(panel, { ...base, collapsed: true })).toBe(false);
    expect(railTileShown({ id: 'files' }, base)).toBe(false);
  });
  it('marks a view tile only while its view is the workspace on screen (not behind Settings)', () => {
    expect(railTileShown(view, base)).toBe(false);
    expect(railTileShown(view, { ...base, viewActive: true })).toBe(true);
    expect(railTileShown(view, { ...base, viewActive: true, collapsed: true })).toBe(true);
    expect(railTileShown(view, { ...base, viewActive: true, settingsActive: true })).toBe(false);
  });
});

describe('SSH mode in the side panel (0.9.2)', () => {
  const view = { id: 'terminal', opensView: true };
  const base = { collapsed: false, activeId: 'projects', viewActive: true, settingsActive: false };
  it('selects no panel tile while the view is in front, and the open panel again behind Settings', () => {
    expect(railTileShown({ id: 'projects' }, base)).toBe(false);
    expect(railTileShown(view, base)).toBe(true);
    expect(railTileShown({ id: 'projects' }, { ...base, settingsActive: true })).toBe(true);
    expect(railTileShown(view, { ...base, settingsActive: true })).toBe(false);
  });

  it('shows the view navigation in the side panel in view mode, the panel otherwise, nothing when folded', () => {
    expect(sidePanelContent({ collapsed: false, viewMode: true, panelId: 'projects' })).toEqual({ kind: 'view' });
    expect(sidePanelContent({ collapsed: false, viewMode: false, panelId: 'files' })).toEqual({ kind: 'panel', id: 'files' });
    expect(sidePanelContent({ collapsed: true, viewMode: true, panelId: 'projects' })).toBeNull();
    expect(sidePanelContent({ collapsed: true, viewMode: false, panelId: 'projects' })).toBeNull();
  });

  const on = { viewActive: true, settingsActive: false };
  const off = { viewActive: false, settingsActive: false };
  it('enters view mode from the view tile without touching the fold; the tile then folds and unfolds the side panel', () => {
    expect(railTileAction({ collapsed: true, view: 'files', ...off }, view)).toEqual({ collapsed: true, view: 'files', openView: true, leaveView: false });
    expect(railTileAction({ collapsed: false, view: 'files', ...off }, view)).toEqual({ collapsed: false, view: 'files', openView: true, leaveView: false });
    expect(railTileAction({ collapsed: true, view: 'files', viewActive: true, settingsActive: true }, view)).toEqual({ collapsed: true, view: 'files', openView: true, leaveView: false });
    expect(railTileAction({ collapsed: false, view: 'files', ...on }, view)).toEqual({ collapsed: true, view: 'files', openView: false, leaveView: false });
    expect(railTileAction({ collapsed: true, view: 'files', ...on }, view)).toEqual({ collapsed: false, view: 'files', openView: false, leaveView: false });
  });

  it('leaves view mode from a panel tile and shows that panel, also the one that was open before (never folds it)', () => {
    expect(railTileAction({ collapsed: false, view: 'projects', ...on }, { id: 'projects' })).toEqual({ collapsed: false, view: 'projects', openView: false, leaveView: true });
    expect(railTileAction({ collapsed: true, view: 'projects', ...on }, { id: 'git' })).toEqual({ collapsed: false, view: 'git', openView: false, leaveView: true });
    expect(railTileAction({ collapsed: false, view: 'projects', ...off }, { id: 'projects' })).toEqual({ collapsed: true, view: 'projects', openView: false, leaveView: false });
  });

  it('sends a view that waits behind Settings to the background when a panel is chosen', () => {
    expect(railTileAction({ collapsed: false, view: 'projects', viewActive: true, settingsActive: true }, { id: 'files' })).toEqual({ collapsed: false, view: 'files', openView: false, leaveView: true });
  });
});

describe('optional panels (1.0.9)', () => {
  const defs = [{ id: 'projects' }, { id: 'monitor', available: optionalPanelOn('monitor') }, { id: 'waiting', available: optionalPanelOn('waiting') }];
  const base = { hasProject: true, platform: 'win32' as const };
  it('hides Monitor and "Czeka na Ciebie" until switched on', () => {
    expect(visiblePanels(defs, base).map((d) => d.id)).toEqual(['projects']);
    expect(visiblePanels(defs, { ...base, optional: { waiting: true } }).map((d) => d.id)).toEqual(['projects', 'waiting']);
    expect(visiblePanels(defs, { ...base, optional: { monitor: true, waiting: false } }).map((d) => d.id)).toEqual(['projects', 'monitor']);
  });
  it('keeps only true switches of known panels', () => {
    expect(normalizeSidePanels(undefined)).toBeUndefined();
    expect(normalizeSidePanels({ monitor: 'yes', waiting: false, other: true })).toBeUndefined();
    expect(normalizeSidePanels({ monitor: true, waiting: true, other: true })).toEqual({ monitor: true, waiting: true });
  });
});
