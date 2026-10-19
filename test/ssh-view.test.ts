import { describe, expect, it } from 'vitest';
import type { SshHost, SshSessionState } from '../src/shared/ssh';
import { filterHosts, formDirty, hostFormDirty, hostToDraft } from '../src/shared/ssh';
import {
  chooseSshSection, clickedDetail, DEFAULT_SSH_SECTION, detailKey, detailPaneOpen, groupTiles, hostsInGroup, hostTileState, liveDetail, liveGroupFilter, menuHosts,
  newKeyDetail, paneDetail, paneEscape, paneLeaves, sectionChange, sectionForDetail, showGroupHeadings, showGroupRow, SSH_NAV, sshModeActive, toggleGroupFilter, visibleSelection,
} from '../src/shared/sshView';

const host = (id: string, label: string, group?: string): SshHost => ({ id, label, address: `${label}.example`, port: 22, username: 'u', createdAt: 0, updatedAt: 0, ...(group ? { group } : {}) });
const session = (cellId: string, phase: SshSessionState['phase']): SshSessionState => ({ cellId, hostId: 'h1', phase, since: 0 });

describe('hostTileState', () => {
  it('shows the best state of the cells that run the host', () => {
    const cells = [{ id: 'c1', ssh: { hostId: 'h1' } }, { id: 'c2', ssh: { hostId: 'h1' } }, { id: 'c3' }];
    expect(hostTileState('h1', cells, {})).toBe('idle');
    expect(hostTileState('h1', cells, { c1: session('c1', 'error') })).toBe('error');
    expect(hostTileState('h1', cells, { c1: session('c1', 'error'), c2: session('c2', 'authenticating') })).toBe('connecting');
    expect(hostTileState('h1', cells, { c1: session('c1', 'connected'), c2: session('c2', 'error') })).toBe('connected');
    expect(hostTileState('h2', cells, { c1: session('c1', 'connected') })).toBe('idle');
  });
});

describe('details pane', () => {
  it('forgets a deleted host or key and keys a pane by what it shows', () => {
    expect(liveDetail({ kind: 'host', hostId: 'gone' }, [host('h1', 'a')], [])).toBeNull();
    expect(liveDetail({ kind: 'host' }, [], [])).toEqual({ kind: 'host' });
    expect(liveDetail({ kind: 'key', keyId: 'k' }, [], ['k'])).toEqual({ kind: 'key', keyId: 'k' });
    expect(liveDetail({ kind: 'key', keyId: 'k' }, [], [])).toBeNull();
    expect(detailKey({ kind: 'host' })).toBe('host:new');
    expect(detailKey({ kind: 'host', hostId: 'h1' })).toBe('host:h1');
    expect(detailKey({ kind: 'newKey' })).toBe('newKey:generate');
  });
});

describe('menuHosts', () => {
  it('lists groups first, at most 12, and says when there are more (R14)', () => {
    const hosts = [host('a', 'zeta'), host('b', 'alpha', 'prod'), ...Array.from({ length: 12 }, (_, i) => host(`x${i}`, `h${String(i).padStart(2, '0')}`, 'lab'))];
    const { shown, more } = menuHosts(hosts);
    expect(shown).toHaveLength(12);
    expect(shown[0].group).toBe('lab');
    expect(more).toBe(true);
    expect(menuHosts([host('a', 'one')])).toEqual({ shown: [host('a', 'one')], more: false });
  });
});

describe('newKeyDetail (W3)', () => {
  it('opens the asked mode; an open new-key pane always becomes a fresh pane in that mode', () => {
    const first = newKeyDetail(null, 'file');
    expect(first).toEqual({ kind: 'newKey', mode: 'file' });
    expect(detailKey(first)).toBe('newKey:file');
    expect(newKeyDetail({ kind: 'host', hostId: 'h1' }, 'paste')).toEqual({ kind: 'newKey', mode: 'paste' });
    const again = newKeyDetail(first, 'file');
    expect(again.mode).toBe('file');
    expect(detailKey(again)).not.toBe(detailKey(first));
    const other = newKeyDetail(again, 'generate');
    expect(other.mode).toBe('generate');
    expect(new Set([detailKey(first), detailKey(again), detailKey(other)]).size).toBe(3);
  });
});

describe('SSH mode sections (0.9.2)', () => {
  it('lists Hosty, Klucze, Znane hosty and SFTP (enabled since 0.9.8), in that order', () => {
    expect(SSH_NAV.map((e) => e.id)).toEqual(['hosts', 'keys', 'knownHosts', 'sftp']);
    expect(SSH_NAV.filter((e) => e.disabled).map((e) => e.id)).toEqual([]);
    expect(DEFAULT_SSH_SECTION).toBe('hosts');
  });

  it('selects SFTP like any section, never an unknown entry', () => {
    expect(chooseSshSection('keys', 'sftp')).toBe('sftp');
    expect(chooseSshSection('hosts', 'nope')).toBe('hosts');
    expect(chooseSshSection('hosts', 'knownHosts')).toBe('knownHosts');
    expect(chooseSshSection('knownHosts', 'keys')).toBe('keys');
    for (const junk of ['', 'SFTP', 'Hosts', '__proto__', 'constructor']) expect(chooseSshSection('keys', junk)).toBe('keys');
  });

  it('puts a detail into its section and shows only the own detail of a section', () => {
    expect(sectionForDetail(null)).toBeNull();
    expect(sectionForDetail({ kind: 'host' })).toBe('hosts');
    expect(sectionForDetail({ kind: 'key', keyId: 'k' })).toBe('keys');
    expect(sectionForDetail({ kind: 'newKey', mode: 'paste' })).toBe('keys');
    expect(paneDetail('hosts', { kind: 'host', hostId: 'h1' })).toEqual({ kind: 'host', hostId: 'h1' });
    expect(paneDetail('hosts', { kind: 'newKey' })).toBeNull();
    expect(paneDetail('keys', { kind: 'host', hostId: 'h1' })).toBeNull();
    expect(paneDetail('knownHosts', { kind: 'key', keyId: 'k' })).toBeNull();
  });

  it('drops a new-key draft and the host selection when the section changes (selectSshSection)', () => {
    const st = { section: 'keys' as const, detail: { kind: 'newKey' as const, mode: 'paste' as const }, selectedHosts: ['h1'] };
    expect(sectionChange(st, 'hosts')).toEqual({ section: 'hosts', detail: null, selectedHosts: ['h1'] });
    expect(sectionChange(st, 'knownHosts')).toEqual({ section: 'knownHosts', detail: null, selectedHosts: [] });
    expect(sectionChange({ section: 'hosts', detail: { kind: 'host', hostId: 'h1' }, selectedHosts: ['h1', 'h2'] }, 'keys')).toEqual({ section: 'keys', detail: null, selectedHosts: [] });
    expect(sectionChange(st, 'keys')).toEqual({});
    expect(sectionChange(st, 'sftp')).toEqual({ section: 'sftp', detail: null, selectedHosts: [] });
    expect(sectionChange({ ...st, section: 'sftp' }, 'sftp')).toEqual({});
  });

  it('is SSH mode only while the view is in front and Settings is not', () => {
    expect(sshModeActive({ viewActive: true, settingsActive: false })).toBe(true);
    expect(sshModeActive({ viewActive: true, settingsActive: true })).toBe(false);
    expect(sshModeActive({ viewActive: false, settingsActive: false })).toBe(false);
  });
});

describe('group tiles (0.9.2)', () => {
  const hosts = [host('a', 'web-2', 'lab'), host('b', 'web-1', 'lab'), host('c', 'pi'), host('d', 'db', 'prod')];
  it('has one tile per named group and no "Bez grupy" tile (0.9.2 polish)', () => {
    expect(groupTiles(hosts)).toEqual([{ key: 'lab', name: 'lab', count: 2 }, { key: 'prod', name: 'prod', count: 1 }]);
    expect(groupTiles(hosts).some((t) => t.key === '')).toBe(false);
    expect(showGroupRow(groupTiles(hosts))).toBe(true);
    expect(groupTiles([])).toEqual([]);
  });

  it('hides the group row and the list headings when no host has a group', () => {
    const ungrouped = [host('c', 'pi'), host('e', 'nas')];
    expect(groupTiles(ungrouped)).toEqual([]);
    expect(showGroupRow(groupTiles(ungrouped))).toBe(false);
    expect(showGroupHeadings(ungrouped)).toBe(false);
    expect(showGroupHeadings(hosts)).toBe(true);
    expect(showGroupHeadings([])).toBe(false);
  });

  it('filters by a group tile, toggles it off and forgets a group that has no hosts any more', () => {
    expect(hostsInGroup(hosts, null).map((h) => h.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(hostsInGroup(hosts, 'lab').map((h) => h.id)).toEqual(['a', 'b']);
    expect(hostsInGroup(hosts, '').map((h) => h.id)).toEqual(['c']);
    expect(toggleGroupFilter(null, 'lab')).toBe('lab');
    expect(toggleGroupFilter('lab', 'lab')).toBeNull();
    expect(toggleGroupFilter('lab', 'prod')).toBe('prod');
    expect(liveGroupFilter('lab', hosts)).toBe('lab');
    expect(liveGroupFilter('gone', hosts)).toBeNull();
    expect(liveGroupFilter('', [host('a', 'x', 'lab')])).toBeNull();
    expect(liveGroupFilter(null, hosts)).toBeNull();
  });
});

describe('details pane visibility (0.9.2 polish)', () => {
  const h1 = { kind: 'host' as const, hostId: 'h1' };
  const k1 = { kind: 'key' as const, keyId: 'k1' };
  it('is open only while a host or key of the section is chosen (nothing chosen: the tiles use the whole width)', () => {
    expect(detailPaneOpen('hosts', null)).toBe(false);
    expect(detailPaneOpen('keys', null)).toBe(false);
    expect(detailPaneOpen('hosts', h1)).toBe(true);
    expect(detailPaneOpen('hosts', { kind: 'host' })).toBe(true); // "Nowy host"
    expect(detailPaneOpen('keys', k1)).toBe(true);
    expect(detailPaneOpen('keys', { kind: 'newKey', mode: 'paste' })).toBe(true); // "Nowy klucz"
    expect(detailPaneOpen('keys', h1)).toBe(false);
    expect(detailPaneOpen('hosts', k1)).toBe(false);
    expect(detailPaneOpen('knownHosts', h1)).toBe(false);
    expect(detailPaneOpen('knownHosts', k1)).toBe(false);
    // A deleted host closes the pane.
    expect(detailPaneOpen('hosts', liveDetail(h1, [host('h2', 'b')], []))).toBe(false);
  });

  it('closes again on a click on the tile it shows (deselect) and switches on any other tile', () => {
    expect(clickedDetail(null, h1)).toEqual(h1);
    expect(clickedDetail(h1, { kind: 'host', hostId: 'h1' })).toBeNull();
    expect(clickedDetail(h1, { kind: 'host', hostId: 'h2' })).toEqual({ kind: 'host', hostId: 'h2' });
    expect(clickedDetail({ kind: 'host' }, h1)).toEqual(h1);
    expect(clickedDetail(k1, { kind: 'key', keyId: 'k1' })).toBeNull();
    expect(clickedDetail({ kind: 'newKey' }, k1)).toEqual(k1);
  });

  it('closes on Esc only when the focus is in the pane and it shows something', () => {
    expect(paneEscape(true, h1)).toBe(true);
    expect(paneEscape(false, h1)).toBe(false);
    expect(paneEscape(true, null)).toBe(false);
  });
});

describe('search and the multi-selection (0.9.2 polish)', () => {
  const hosts = [host('a', 'web-1', 'lab'), host('b', 'web-2', 'lab'), host('c', 'pi')];
  it('keeps only the selected hosts the search still shows, so the grid count matches what is visible', () => {
    expect(visibleSelection(['a', 'c'], filterHosts(hosts, 'pi'))).toEqual(['c']);
    expect(visibleSelection(['a', 'b'], filterHosts(hosts, 'web'))).toEqual(['a', 'b']);
    expect(visibleSelection(['a', 'b'], filterHosts(hosts, 'zzz'))).toEqual([]);
    expect(visibleSelection(['a', 'c'], filterHosts(hosts, ''))).toEqual(['a', 'c']);
    expect(visibleSelection([], hosts)).toEqual([]);
  });
});

describe('unsaved changes in the pane (0.9.2 final)', () => {
  const saved: SshHost = { ...host('h1', 'web', 'lab'), tags: ['prod'], startupCommand: 'ls' };
  it('counts a host form as unsaved only when it differs from the saved host or something is typed', () => {
    expect(hostFormDirty(saved, hostToDraft(saved), { tag: '', password: '' })).toBe(false);
    expect(hostFormDirty(saved, { ...hostToDraft(saved), label: 'web ' }, { tag: '', password: '' })).toBe(false);
    expect(hostFormDirty(saved, { ...hostToDraft(saved), address: 'other.example' }, { tag: '', password: '' })).toBe(true);
    expect(hostFormDirty(saved, { ...hostToDraft(saved), tags: [] }, { tag: '', password: '' })).toBe(true);
    expect(hostFormDirty(saved, { ...hostToDraft(saved), color: '#ff0000' }, { tag: '', password: '' })).toBe(true);
    expect(hostFormDirty(saved, hostToDraft(saved), { tag: 'x', password: '' })).toBe(true);
    expect(hostFormDirty(saved, hostToDraft(saved), { tag: '', password: 'typed' })).toBe(true);
    // "Nowy host": clean until something is typed.
    expect(hostFormDirty(undefined, hostToDraft(undefined), { tag: '', password: '' })).toBe(false);
    expect(hostFormDirty(undefined, { ...hostToDraft(undefined), address: 'a' }, { tag: '', password: '' })).toBe(true);
  });

  it('counts a key form as unsaved when any field holds text or an import draft waits', () => {
    expect(formDirty(['', '  ', undefined, null, false])).toBe(false);
    expect(formDirty(['', 'label'])).toBe(true);
    expect(formDirty(['', 'draft-id'])).toBe(true);
  });
});

describe('host form after Zapisz (0.9.2 final)', () => {
  it('is clean when the form equals what was saved, also with an empty label or a padded port', () => {
    const saved: SshHost = { ...host('h1', 'web.example'), label: 'web.example', address: 'web.example' };
    expect(hostFormDirty(saved, { ...hostToDraft(saved), label: '' }, { tag: '', password: '' })).toBe(false);
    expect(hostFormDirty(saved, { ...hostToDraft(saved), port: '022' }, { tag: '', password: '' })).toBe(false);
    expect(hostFormDirty(saved, { ...hostToDraft(saved), port: 'x' }, { tag: '', password: '' })).toBe(true);
  });
});

describe('paneLeaves (0.9.3)', () => {
  const on = { viewOpen: true, section: 'hosts' as const, detail: { kind: 'host' as const, hostId: 'h1' } };
  it('another tile, a section without the item or closing the SSH tab drop the item', () => {
    expect(paneLeaves(on, { ...on, detail: { kind: 'host', hostId: 'h2' } })).toBe(true);
    expect(paneLeaves(on, { ...on, detail: { kind: 'key', keyId: 'k1' } })).toBe(true);
    expect(paneLeaves(on, { ...on, section: 'keys' })).toBe(true);
    expect(paneLeaves(on, { ...on, section: 'knownHosts' })).toBe(true);
    expect(paneLeaves(on, { ...on, detail: null })).toBe(true);
    expect(paneLeaves(on, { ...on, viewOpen: false, detail: null })).toBe(true);
  });
  it('the view going to the background (grid, file, Settings, connect, open as grid) keeps the pane and its drafts, as in 0.9.2', () => {
    const background = { ...on, viewActive: false };
    expect(paneLeaves({ ...on, viewActive: true } as typeof on, background)).toBe(false);
    expect(paneLeaves(background, { ...on, viewActive: true } as typeof on)).toBe(false);
  });
  it('the same item or an empty pane keep it', () => {
    expect(paneLeaves(on, { ...on, detail: { kind: 'host', hostId: 'h1' } })).toBe(false);
    expect(paneLeaves({ ...on, detail: null }, { ...on, detail: { kind: 'host', hostId: 'h2' } })).toBe(false);
    expect(paneLeaves({ ...on, section: 'keys' }, { ...on, section: 'hosts' })).toBe(false);
  });
});
