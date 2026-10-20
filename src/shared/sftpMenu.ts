// The menus of an SFTP pane, like Termius and Finder: a right click on entries offers what can be done with them,
// a right click on the empty list what can be done in the folder, and the Actions button of the toolbar both plus the host
// (change host, disconnect: never in a right-click menu). Actions that cannot run are left out, not greyed out.
// Pure: the view turns the action ids into labels and handlers. No DOM or Electron imports: tested in Node.
import { isFileLike } from './editorSource';
import { isFolderLike, type PaneEntry } from './sftpView';

export type PaneAction =
  /** Selected entries: open (a folder goes there, a file opens in an editor tab), download or upload them... */
  | 'open' | 'transfer' | 'rename' | 'copyPath' | 'reveal' | 'cut'
  /** ...paste the cut entries into the one selected folder, change permissions, delete them (last, red). */
  | 'pasteInto' | 'permissions' | 'delete'
  /** The shown folder: a new folder in it, the cut entries pasted into it, list it again, copy its path, show it in Explorer. */
  | 'newFolder' | 'paste' | 'refresh' | 'copyFolderPath' | 'revealFolder'
  /** The remote host (the toolbar only). */
  | 'changeHost' | 'disconnect';
export type PaneMenuEntry = PaneAction | 'sep';

export interface PaneMenuInput {
  side: 'local' | 'remote';
  /** A right click on (selected) entries or on the empty list, or the Actions button of the toolbar. */
  place: 'entries' | 'empty' | 'toolbar';
  /** The entries the menu acts on (the selection; a right click selects the clicked entry first). */
  selection: ReadonlyArray<Pick<PaneEntry, 'kind' | 'target' | 'unsafeName'>>;
  /** The listing is live: always for the local pane, a connected session for the remote one. */
  live: boolean;
  /** Entries can be created, renamed, moved and deleted here: live, and (local) not the drive list. */
  writable: boolean;
  /** The pane shows a folder (null path before the first listing). */
  hasFolder: boolean;
  /** Upload (local) or download (remote) has a target folder on the other side. */
  canTransfer: boolean;
  /** Entries cut from this pane wait for a paste. */
  canPaste: boolean;
  /** Remote: a session exists (Disconnect). */
  hasSession: boolean;
}

/** Groups in order, empty groups and the separators around them dropped. */
const joinGroups = (groups: ReadonlyArray<ReadonlyArray<PaneAction | false>>): PaneMenuEntry[] => {
  const out: PaneMenuEntry[] = [];
  for (const group of groups) {
    const items = group.filter((a): a is PaneAction => a !== false);
    if (!items.length) continue;
    if (out.length) out.push('sep');
    out.push(...items);
  }
  return out;
};

/** The actions of the selected entries, in the order of Termius: open, transfer, rename, path, cut, paste, permissions, delete. */
function entryGroups(m: PaneMenuInput): Array<Array<PaneAction | false>> {
  const sel = m.selection;
  const one = sel.length === 1 ? sel[0] : null;
  const remote = m.side === 'remote';
  const safe = !sel.some((e) => e.unsafeName);
  const openable = !!one && !one.unsafeName && (isFolderLike(one) || isFileLike(one));
  const folder = !!one && !one.unsafeName && isFolderLike(one);
  return [
    [m.live && openable && 'open', m.canTransfer && 'transfer'],
    [m.writable && !!one && 'rename', 'copyPath', !remote && m.writable && 'reveal'],
    [m.writable && 'cut', m.writable && m.canPaste && (folder ? 'pasteInto' : 'paste')],
    [remote && m.writable && safe && 'permissions', m.writable && 'delete'],
  ];
}

/** The actions of the shown folder; the toolbar adds Copy path and keeps them in one group (below the entry actions). */
function folderGroups(m: PaneMenuInput, toolbar: boolean): Array<Array<PaneAction | false>> {
  if (!m.hasFolder) return [];
  const create = [m.writable && 'newFolder', m.writable && m.canPaste && 'paste'] as const;
  const view = [m.live && 'refresh', toolbar && 'copyFolderPath', m.side === 'local' && m.writable && 'revealFolder'] as const;
  return toolbar ? [[...create, ...view]] : [[...create], [...view]];
}

/**
 * What a menu of the pane lists. A right click on entries never shows folder or host actions, a right click on the empty
 * list never shows entry or host actions; the toolbar menu lists the entry actions (with a selection), the folder actions
 * without the ones the selection already offers under the same name (Paste, Copy path, Show in Explorer), then the host.
 */
export function paneMenu(m: PaneMenuInput): PaneMenuEntry[] {
  const entries = m.place !== 'empty' && m.selection.length > 0;
  if (m.place !== 'toolbar') return joinGroups(entries ? entryGroups(m) : folderGroups(m, false));
  const own = entries ? entryGroups(m) : [];
  const taken = new Set(own.flat());
  const pasteTaken = taken.has('paste') || taken.has('pasteInto');
  const folder = folderGroups(m, true).map((group) => group.map((a) => (
    (a === 'paste' && pasteTaken) || (a === 'copyFolderPath' && taken.has('copyPath')) || (a === 'revealFolder' && taken.has('reveal')) ? false : a
  )));
  const host: Array<PaneAction | false> = m.side === 'remote' ? ['changeHost', m.hasSession && 'disconnect'] : [];
  return joinGroups([...own, ...folder, host]);
}
