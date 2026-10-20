import { describe, expect, it } from 'vitest';
import { paneMenu, type PaneMenuInput } from '../src/shared/sftpMenu';
import type { PaneEntry } from '../src/shared/sftpView';

const file: Pick<PaneEntry, 'kind' | 'target' | 'unsafeName'> = { kind: 'file' };
const dir: Pick<PaneEntry, 'kind' | 'target' | 'unsafeName'> = { kind: 'dir' };
const dirLink: Pick<PaneEntry, 'kind' | 'target' | 'unsafeName'> = { kind: 'symlink', target: 'dir' };
const socket: Pick<PaneEntry, 'kind' | 'target' | 'unsafeName'> = { kind: 'other' };

/** A connected remote pane with a folder, a download target and nothing cut. */
const remote = (patch: Partial<PaneMenuInput> = {}): PaneMenuInput => ({
  side: 'remote', place: 'entries', selection: [file], live: true, writable: true, hasFolder: true, canTransfer: true, canPaste: false, hasSession: true, ...patch,
});
const local = (patch: Partial<PaneMenuInput> = {}): PaneMenuInput => remote({ side: 'local', hasSession: false, ...patch });

describe('SFTP pane menus', () => {
  it('offers the entry actions in Termius order on a right click on a remote file, Delete last', () => {
    expect(paneMenu(remote())).toEqual(['open', 'transfer', 'sep', 'rename', 'copyPath', 'sep', 'cut', 'sep', 'permissions', 'delete']);
  });

  it('never lists folder or host actions on a right click on entries', () => {
    for (const input of [remote(), remote({ canPaste: true }), remote({ selection: [dir, file] }), local()]) {
      const menu = paneMenu(input);
      for (const action of ['newFolder', 'refresh', 'copyFolderPath', 'changeHost', 'disconnect'] as const) expect(menu).not.toContain(action);
    }
  });

  it('shows Paste only while something is cut; on one folder it pastes into that folder', () => {
    expect(paneMenu(remote())).not.toContain('paste');
    expect(paneMenu(remote({ canPaste: true }))).toContain('paste');
    const onFolder = paneMenu(remote({ canPaste: true, selection: [dir] }));
    expect(onFolder).toContain('pasteInto');
    expect(onFolder).not.toContain('paste');
    expect(paneMenu(remote({ canPaste: true, selection: [dirLink] }))).toContain('pasteInto');
    expect(paneMenu(remote({ canPaste: true, selection: [dir, dir] }))).toContain('paste');
  });

  it('opens one file or folder only, and renames one entry only', () => {
    expect(paneMenu(remote({ selection: [dir] }))[0]).toBe('open');
    const many = paneMenu(remote({ selection: [file, dir] }));
    expect(many).not.toContain('open');
    expect(many).not.toContain('rename');
    expect(many).toContain('delete');
    expect(paneMenu(remote({ selection: [socket] }))).not.toContain('open');
  });

  it('leaves out what cannot run instead of greying it out', () => {
    expect(paneMenu(remote({ canTransfer: false }))).not.toContain('transfer');
    // Permissions need names that are safe to address.
    expect(paneMenu(remote({ selection: [file, { kind: 'file', unsafeName: true }] }))).not.toContain('permissions');
    // A pane that cannot change its folder (the drive list) keeps only what reads.
    expect(paneMenu(local({ writable: false, selection: [dir] }))).toEqual(['open', 'transfer', 'sep', 'copyPath']);
  });

  it('gives the local pane Upload, Show in Explorer and Move to trash, but no Permissions', () => {
    const menu = paneMenu(local());
    expect(menu).toEqual(['open', 'transfer', 'sep', 'rename', 'copyPath', 'reveal', 'sep', 'cut', 'sep', 'delete']);
  });

  it('offers New folder, Paste (when available) and Refresh on the empty list', () => {
    expect(paneMenu(remote({ place: 'empty', selection: [] }))).toEqual(['newFolder', 'sep', 'refresh']);
    expect(paneMenu(remote({ place: 'empty', selection: [], canPaste: true }))).toEqual(['newFolder', 'paste', 'sep', 'refresh']);
    expect(paneMenu(local({ place: 'empty', selection: [] }))).toEqual(['newFolder', 'sep', 'refresh', 'revealFolder']);
    // The selection does not matter for a right click on the empty list.
    expect(paneMenu(remote({ place: 'empty', selection: [file] }))).toEqual(['newFolder', 'sep', 'refresh']);
    // The drive list: nothing to create there.
    expect(paneMenu(local({ place: 'empty', selection: [], writable: false }))).toEqual(['refresh']);
    expect(paneMenu(remote({ place: 'empty', selection: [], hasFolder: false }))).toEqual([]);
  });

  it('treats a right click on entries without a selection (an unsafe row) as one on the empty list', () => {
    expect(paneMenu(remote({ selection: [] }))).toEqual(['newFolder', 'sep', 'refresh']);
  });

  it('lists everything in the toolbar menu: the selection, the folder, then the host', () => {
    expect(paneMenu(remote({ place: 'toolbar' }))).toEqual([
      'open', 'transfer', 'sep', 'rename', 'copyPath', 'sep', 'cut', 'sep', 'permissions', 'delete', 'sep', 'newFolder', 'refresh', 'sep', 'changeHost', 'disconnect',
    ]);
    expect(paneMenu(remote({ place: 'toolbar', selection: [] }))).toEqual(['newFolder', 'refresh', 'copyFolderPath', 'sep', 'changeHost', 'disconnect']);
    expect(paneMenu(local({ place: 'toolbar', selection: [] }))).toEqual(['newFolder', 'refresh', 'copyFolderPath', 'revealFolder']);
  });

  it('offers no folder path on the drive list (it has none to copy), only the drives themselves', () => {
    expect(paneMenu(local({ place: 'toolbar', selection: [], writable: false }))).toEqual(['refresh']);
    expect(paneMenu(local({ place: 'toolbar', selection: [dir], writable: false }))).toEqual(['open', 'transfer', 'sep', 'copyPath', 'sep', 'refresh']);
  });

  it('pastes into the shown folder from the toolbar, like Ctrl+V, even with one folder selected', () => {
    for (const side of [remote, local]) {
      const menu = paneMenu(side({ place: 'toolbar', canPaste: true, selection: [dir] }));
      expect(menu).toContain('paste');
      expect(menu).not.toContain('pasteInto');
    }
    // The right click on that folder still pastes into it.
    expect(paneMenu(remote({ canPaste: true, selection: [dir] }))).toContain('pasteInto');
  });

  it('never shows two items of the same name in the toolbar menu', () => {
    const named = (menu: string[]) => menu.map((a) => (a === 'pasteInto' ? 'paste' : a === 'copyFolderPath' ? 'copyPath' : a === 'revealFolder' ? 'reveal' : a)).filter((a) => a !== 'sep');
    for (const input of [remote({ place: 'toolbar', canPaste: true }), remote({ place: 'toolbar', canPaste: true, selection: [dir] }), local({ place: 'toolbar', canPaste: true })]) {
      const names = named(paneMenu(input));
      expect(new Set(names).size, names.join()).toBe(names.length);
    }
    // Without a selection the folder's own Paste is there.
    expect(paneMenu(remote({ place: 'toolbar', selection: [], canPaste: true }))).toContain('paste');
  });

  it('keeps Change host in the toolbar menu of a remote pane without a session, Disconnect only with one', () => {
    const menu = paneMenu(remote({ place: 'toolbar', selection: [], live: false, writable: false, hasFolder: false, hasSession: false }));
    expect(menu).toEqual(['changeHost']);
  });

  it('still offers the host actions when a session could not list its start folder', () => {
    expect(paneMenu(remote({ place: 'toolbar', selection: [], writable: false, hasFolder: false }))).toEqual(['changeHost', 'disconnect']);
    // The right-click menus never carry them.
    expect(paneMenu(remote({ place: 'empty', selection: [], writable: false, hasFolder: false }))).toEqual([]);
  });
});
