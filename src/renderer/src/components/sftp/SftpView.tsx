// The SFTP view (0.9.8): the "SFTP" section of SSH mode. Termius-like two panes: the local computer on the left (drives on
// Windows, home on macOS), the server on the right ("Połącz z hostem" with "Wybierz host" until a saved host is connected;
// login prompts appear in the pane), and the transfer queue at the bottom. One session at a time (src/renderer/src/sftp.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { planRemoteMove, safeEntryName, sftpErrorText, validRemoteName, posixJoin, posixParent, type SftpErrorCode, type TransferRequest } from '../../../../shared/sftp';
import {
  deleteCountText, deleteNames, DRIVES, dropRequest, isFolderLike, outsideFolder, localCrumbs, localJoin, localParent, planLocalMove, rememberLocalPath, rememberRemotePath, remoteCrumbs,
  type PaneEntry, type SftpDragPayload,
} from '../../../../shared/sftpView';
import { sshErrorText, userAtEndpoint } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { askChoice, askText, getS, toast, update, useStore } from '../../store';
import { sshContext } from '../../ssh';
import { useSshStore } from '../../sshStore';
import { connectSftp, disconnectSftp, enqueueTransfer, openHostPicker, pathFlavor } from '../../sftp';
import { useSftpStore } from '../../sftpStore';
import type { MenuItem } from '../ContextMenu';
import { openMenuAt } from '../ContextMenu';
import { IDownload, IDrive, IHome, IServer, IUpload } from '../icons';
import { BusyRing } from '../Spinner';
import { AuthPrompt } from '../ssh/AuthPrompt';
import { HostKeyPrompt } from '../ssh/HostKeyPrompt';
import { sftpPromptReply } from '../ssh/promptReply';
import { SshNav } from '../ssh/SshNav';
import { FilePane } from './FilePane';
import { HostPicker } from './HostPicker';
import { PermissionsDialog } from './PermissionsDialog';
import { TransferPanel } from './TransferPanel';
import { useFolder, type Listing } from './useFolder';
import './sftp.css';
import { isFileLike } from '../../../../shared/editorSource';
import { openLocalEntry, openRemoteEntry } from '../../remoteOpen';
import { followMoves, markDeleted } from '../../files';

/** Sessions whose start folder a mounted view already showed (kept across remounts of the view). */
const shownSessions = new Set<string>();

export function SftpView({ compactNav }: { compactNav: boolean }) {
  const { tr } = useI18n();
  const flavor = pathFlavor();
  const hosts = useStore((st) => st.s.sshHosts);
  const sessionId = useSftpStore((st) => st.sessionId);
  const hostId = useSftpStore((st) => st.hostId);
  const session = useSftpStore((st) => st.session);
  const prompt = useSftpStore((st) => st.prompt);
  const pickerOpen = useSftpStore((st) => st.pickerOpen);
  const remoteGoto = useSftpStore((st) => st.remoteGoto);
  const storage = useSshStore((st) => st.vault?.storage ?? 'unavailable');
  const host = hosts.find((h) => h.id === hostId);
  const connected = !!sessionId && session?.state === 'connected';
  const errorText = (code: SftpErrorCode) => { const t = sftpErrorText(code); return tr(t.key, t.params); };

  // ── local pane ──
  const [roots, setRoots] = useState<{ home: string; drives: string[] } | null>(null);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const listLocal = useCallback(async (path: string): Promise<Listing> => {
    if (path === DRIVES) {
      const drives = rootsRef.current?.drives ?? [];
      return { ok: true, path: DRIVES, truncated: false, entries: drives.map((d) => ({ name: d.replace(/\\$/, ''), path: d, kind: 'dir', size: 0, mtime: 0, permissions: '' })) };
    }
    const r = await window.mc.localFs.list(path);
    return r.ok ? { ok: true, path: r.value.path, entries: r.value.entries, truncated: r.value.truncated } : { ok: false, error: errorText(r.error) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tr]);
  const local = useFolder(listLocal, (p) => localParent(p, flavor), (p) => { if (p !== DRIVES) update((s) => ({ ...s, sftp: rememberLocalPath(s.sftp, p) })); });
  useEffect(() => {
    let live = true;
    void window.mc.localFs.roots().then(async (r) => {
      if (!live) return;
      setRoots(r);
      rootsRef.current = r;
      const saved = getS().sftp?.localPath;
      if (!(saved && await local.go(saved, { history: false }))) await local.go(r.home, { history: false });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── remote pane ──
  const listRemote = useCallback(async (path: string): Promise<Listing> => {
    const id = useSftpStore.getState().sessionId;
    if (!id) return { ok: false, error: errorText('notConnected') };
    const r = await window.mc.sftp.list(id, path);
    return r.ok ? { ok: true, path: r.value.path, entries: r.value.entries, truncated: r.value.truncated } : { ok: false, error: errorText(r.error) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tr]);
  const remote = useFolder(listRemote, (p) => (p === '/' ? null : posixParent(p)), (p) => {
    const h = useSftpStore.getState().hostId;
    if (h) update((s) => ({ ...s, sftp: rememberRemotePath(s.sftp, h, p) }));
  });
  // A new session starts empty; once connected it shows its start folder.
  useEffect(() => { remote.reset(); }, [sessionId, remote.reset]);
  const startPath = connected ? session?.path ?? '/' : null;
  useEffect(() => {
    if (!startPath || !sessionId) return;
    const remembered = hostId ? getS().sftp?.remotePaths[hostId] : undefined;
    const seen = shownSessions.has(sessionId);
    shownSessions.add(sessionId);
    void (async () => {
      if (seen && remembered && remembered !== startPath && await remote.go(remembered, { history: false })) return;
      await remote.go(startPath, { history: false });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, startPath, remote.go]);
  useEffect(() => { if (remoteGoto && connected) void remote.go(remoteGoto.path); }, [remoteGoto, connected, remote.go]);

  // Finished transfers show up in the panes without a manual refresh.
  const done = useSftpStore((st) => st.transfers.filter((i) => i.state === 'done').length);
  const lastDone = useRef(done);
  useEffect(() => {
    if (done <= lastDone.current) { lastDone.current = done; return; }
    lastDone.current = done;
    const timer = setTimeout(() => { void local.refresh(); if (connected) void remote.refresh(); }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  // ── transfers ──
  const enqueue = (queue: string | null, req: TransferRequest) => enqueueTransfer(queue, req);
  const upload = (sources: string[], targetDir: string) => { if (sessionId && connected) void enqueue(sessionId, { direction: 'upload', sources, targetDir }); };
  const download = (sources: string[], targetDir: string) => { if (sessionId && targetDir !== DRIVES) void enqueue(sessionId, { direction: 'download', sources, targetDir }); };
  const onDropEntries = (payload: SftpDragPayload, onto: 'local' | 'remote', targetDir: string) => {
    const req = dropRequest(payload, onto, targetDir);
    if (!req || !sessionId) return;
    if (req.direction === 'upload') upload(req.sources, req.targetDir); else download(req.sources, req.targetDir);
  };

  // ── moves (0.9.9): a drag onto a folder of the same pane, or Cut and Paste ──
  /** Entries cut with Ctrl+X / "Wytnij" (one side at a time; a remote cut belongs to its session). */
  const [cut, setCut] = useState<{ side: 'local' | 'remote'; paths: string[]; sessionId: string | null } | null>(null);
  useEffect(() => { setCut((c) => (c?.side === 'remote' ? null : c)); }, [sessionId]);
  const cutOf = (side: 'local' | 'remote') => (cut && cut.side === side && (side === 'local' || cut.sessionId === sessionId) ? cut.paths : null);
  const localCut = useMemo(() => new Set(cutOf('local') ?? []), [cut]);
  const remoteCut = useMemo(() => new Set(cutOf('remote') ?? []), [cut, sessionId]);
  const moveEntries = (side: 'local' | 'remote', paths: string[], targetDir: string): boolean => {
    if (!paths.length || (side === 'local' && targetDir === DRIVES)) return false;
    const plan = side === 'remote' ? planRemoteMove(paths, targetDir) : planLocalMove(paths, targetDir, flavor);
    if (plan.problem) { toast(errorText(plan.problem), 'error'); return false; }
    if (!plan.sources.length) { toast(tr('Te elementy już są w tym folderze'), 'info'); return false; }
    if (side === 'remote') {
      if (!sessionId || !connected) return false;
      void enqueue(sessionId, { direction: 'move', sources: plan.sources, targetDir });
    } else void enqueue(null, { direction: 'local-move', sources: plan.sources, targetDir });
    return true;
  };
  const cutEntries = (side: 'local' | 'remote', sel: PaneEntry[]) => {
    if (!sel.length || (side === 'local' && local.folder.path === DRIVES)) return;
    setCut({ side, paths: sel.map((e) => e.path), sessionId: side === 'remote' ? sessionId : null });
    toast(tr('Wycięte: {count}', { count: sel.length }), 'info');
  };
  const paste = (side: 'local' | 'remote', targetDir: string | null) => {
    const paths = cutOf(side);
    if (!paths || targetDir === null) return;
    if (moveEntries(side, paths, targetDir)) setCut(null);
  };

  // ── permissions (0.9.9) ──
  const [perms, setPerms] = useState<PaneEntry[] | null>(null);

  // ── file operations ──
  const validName = (side: 'local' | 'remote', name: string) => (side === 'remote' ? validRemoteName(name) : safeEntryName(name, { windows: flavor === 'win32' }));
  const askName = async (side: 'local' | 'remote', title: string, value = ''): Promise<string | null> => {
    const name = (await askText(title, value))?.trim();
    if (!name || name === value) return null;
    if (!validName(side, name)) { toast(errorText('invalid'), 'error'); return null; }
    return name;
  };
  const localDir = local.folder.path;
  const remoteDir = remote.folder.path;

  const localNewFolder = async () => {
    if (!localDir || localDir === DRIVES) return;
    const name = await askName('local', tr('Nowy folder'));
    if (!name) return;
    const r = await window.mc.localFs.mkdir(localJoin(localDir, name, flavor));
    if (!r.ok) toast(errorText(r.error), 'error');
    await local.refresh();
  };
  const localRename = async (e: PaneEntry) => {
    if (!localDir || localDir === DRIVES) return;
    const name = await askName('local', tr('Zmień nazwę'), e.name);
    if (!name) return;
    const to = localJoin(localDir, name, flavor);
    const r = await window.mc.localFs.rename(e.path, to);
    if (!r.ok) toast(errorText(r.error), 'error');
    else followMoves({ kind: 'local' }, [{ from: e.path, to }]);
    await local.refresh();
  };
  const localDelete = async (sel: PaneEntry[]) => {
    if (!sel.length || localDir === DRIVES) return;
    const { shown, more } = deleteNames(sel.map((e) => e.name));
    const body = [...shown, ...(more ? [tr('i {count} innych', { count: more })] : [])].join('\n');
    const choice = await askChoice(tr('Przenieść do kosza ({count})?', { count: sel.length }), body, [{ label: tr('Przenieś do kosza'), value: 'yes', danger: true }]);
    if (choice !== 'yes') return;
    const r = await window.mc.localFs.trash(sel.map((e) => e.path));
    if (!r.ok) toast(errorText(r.error), 'error');
    else markDeleted({ kind: 'local' }, sel.map((e) => e.path));
    await local.refresh();
  };
  const remoteNewFolder = async () => {
    if (!sessionId || !remoteDir) return;
    const name = await askName('remote', tr('Nowy folder'));
    if (!name) return;
    const r = await window.mc.sftp.mkdir(sessionId, posixJoin(remoteDir, name));
    if (!r.ok) toast(errorText(r.error), 'error');
    await remote.refresh();
  };
  const remoteRename = async (e: PaneEntry) => {
    if (!sessionId || !remoteDir) return;
    const name = await askName('remote', tr('Zmień nazwę'), e.name);
    if (!name) return;
    const to = posixJoin(remoteDir, name);
    const r = await window.mc.sftp.rename(sessionId, e.path, to);
    if (!r.ok) toast(errorText(r.error), 'error');
    else if (hostId) followMoves({ kind: 'remote', hostId }, [{ from: e.path, to }]);
    await remote.refresh();
  };
  const remoteDelete = async (sel: PaneEntry[]) => {
    if (!sessionId || !sel.length) return;
    const paths = sel.map((e) => e.path);
    const count = await window.mc.sftp.deleteCount(sessionId, paths);
    if (!count.ok) { toast(errorText(count.error), 'error'); return; }
    const { shown, more } = deleteNames(sel.map((e) => e.name));
    const what = deleteCountText(count.value);
    const body = [...shown, ...(more ? [tr('i {count} innych', { count: more })] : []), '', tr(what.key, what.params), tr('Tej operacji nie można cofnąć.')].join('\n');
    const choice = await askChoice(tr('Usunąć z serwera ({count})?', { count: sel.length }), body, [{ label: tr('Usuń z serwera'), value: 'yes', danger: true }]);
    if (choice !== 'yes') return;
    const r = await window.mc.sftp.delete(sessionId, paths, count.value);
    if (!r.ok) toast(errorText(r.error), 'error');
    else if (hostId) markDeleted({ kind: 'remote', hostId }, paths);
    await remote.refresh();
  };

  /** Cut, Paste and (on one folder) Paste here. */
  const moveItems = (side: 'local' | 'remote', sel: PaneEntry[], dir: string | null, off: boolean): MenuItem[] => {
    const pasteable = !off && !!cutOf(side);
    const into = sel.length === 1 && isFolderLike(sel[0]) && !sel[0].unsafeName ? sel[0] : null;
    return [
      { label: tr('Wytnij'), disabled: off || !sel.length, onClick: () => cutEntries(side, sel) },
      { label: tr('Wklej'), disabled: !pasteable || !dir, onClick: () => paste(side, dir) },
      ...(into ? [{ label: tr('Wklej tutaj'), disabled: !pasteable, onClick: () => paste(side, into.path) }] : []),
    ];
  };
  // ── editor tabs (0.9.9): a file opens in a tab at the top ──
  const openRemote = (e: PaneEntry) => { if (hostId && connected && isFileLike(e)) void openRemoteEntry(hostId, e.path, e.kind === 'file' ? e.size : undefined); };
  const openLocal = (e: PaneEntry) => { if (isFileLike(e)) openLocalEntry(e.path); };
  const openItem = (sel: PaneEntry[], open: (e: PaneEntry) => void, enabled = true): MenuItem =>
    ({ label: tr('Otwórz'), disabled: !enabled || sel.length !== 1 || !isFileLike(sel[0]), onClick: () => open(sel[0]) });

  const localActions = (sel: PaneEntry[]): MenuItem[] => {
    const drives = localDir === DRIVES;
    return [
      openItem(sel, openLocal),
      { label: tr('Nowy folder'), disabled: drives, onClick: () => void localNewFolder() },
      { label: tr('Zmień nazwę'), disabled: drives || sel.length !== 1, onClick: () => void localRename(sel[0]) },
      { label: tr('Przenieś do kosza'), danger: true, disabled: drives || !sel.length, onClick: () => void localDelete(sel) },
      { sep: true },
      ...moveItems('local', sel, localDir, drives),
      { sep: true },
      { label: tr('Wyślij na serwer'), disabled: !connected || !sel.length || !remoteDir, onClick: () => upload(sel.map((e) => e.path), remoteDir!) },
      { label: tr('Odśwież'), onClick: () => void local.refresh() },
      { label: tr(flavor === 'win32' ? 'Otwórz w Eksploratorze' : 'Pokaż w Finderze'), disabled: drives, onClick: () => { const target = sel[0]?.path ?? localDir; if (target) void window.mc.localFs.reveal(target); } },
    ];
  };
  const remoteActions = (sel: PaneEntry[]): MenuItem[] => [
    openItem(sel, openRemote, connected),
    { label: tr('Nowy folder'), disabled: !connected, onClick: () => void remoteNewFolder() },
    { label: tr('Zmień nazwę'), disabled: !connected || sel.length !== 1, onClick: () => void remoteRename(sel[0]) },
    { label: tr('Usuń'), danger: true, disabled: !connected || !sel.length, onClick: () => void remoteDelete(sel) },
    { label: tr('Uprawnienia…'), disabled: !connected || !sel.length || sel.some((e) => e.unsafeName), onClick: () => setPerms(sel) },
    { sep: true },
    ...moveItems('remote', sel, remoteDir, !connected),
    { sep: true },
    { label: tr('Pobierz'), disabled: !connected || !sel.length || !localDir || localDir === DRIVES, onClick: () => download(sel.map((e) => e.path), localDir!) },
    { label: tr('Odśwież'), disabled: !connected, onClick: () => void remote.refresh() },
    { label: tr('Kopiuj ścieżkę'), disabled: !remoteDir, onClick: () => window.mc.clipboardWrite(sel[0]?.path ?? remoteDir ?? '') },
    { sep: true },
    { label: tr('Zmień host'), onClick: openHostPicker },
    { label: tr('Rozłącz'), disabled: !sessionId, onClick: () => void disconnectSftp() },
  ];

  // ── heads ──
  const goLocal = (path: string) => void local.go(path);
  const localHead = (
    <div className="sftp-title">
      <strong>{tr('Lokalne')}</strong>
      <button type="button" className="btn ghost icon" aria-label={tr('Folder domowy')} title={tr('Folder domowy')} disabled={!roots} onClick={() => roots && goLocal(roots.home)}><IHome /></button>
      {!!roots?.drives.length && (
        <button type="button" className="btn ghost icon" aria-label={tr('Dyski')} title={tr('Dyski')} onClick={(e) => openMenuAt(e.currentTarget, [
          { label: tr('Wszystkie dyski'), onClick: () => goLocal(DRIVES) },
          { sep: true },
          ...roots.drives.map((d) => ({ label: d.replace(/\\$/, ''), onClick: () => goLocal(d) })),
        ])}><IDrive /></button>
      )}
    </div>
  );
  const status = !session ? '' : session.state === 'connected' ? tr('połączono') : session.state === 'connecting' ? tr('łączenie…') : session.state === 'error' ? tr('błąd połączenia') : tr('rozłączono');
  const remoteHead = (
    <div className="sftp-title">
      {host ? (
        <button type="button" className="sftp-host-chip" title={`${host.label} · ${userAtEndpoint(host)}${status ? ` · ${status}` : ''}\n${tr('Zmień host')}`} onClick={openHostPicker}>
          <span className={`sftp-dot ${session?.state ?? 'closed'}`} aria-label={status || undefined} />
          <strong>{host.label}</strong>
          <span className="muted sftp-host-address">{userAtEndpoint(host)}</span>
          {connected && session?.sudo && <span className="sftp-sudo-badge" title={`${tr('SFTP działa przez sudo')}. ${tr('Karty edytora otwierają pliki z uprawnieniami użytkownika SSH (bez sudo).')}`}>sudo</span>}
        </button>
      ) : <strong>{tr('Serwer')}</strong>}
    </div>
  );

  // ── the remote pane without a listing ──
  const sessionError = session?.error ? sshErrorText(session.error, sshContext(session.hostId)) : null;
  let remotePlaceholder: React.ReactNode = undefined;
  if (pickerOpen) {
    remotePlaceholder = <HostPicker hosts={hosts} currentHostId={connected ? hostId : null} onPick={(id) => void connectSftp(id)} onCancel={sessionId ? () => useSftpStore.setState({ pickerOpen: false }) : undefined} />;
  } else if (sessionId && prompt) {
    const respond = sftpPromptReply(sessionId);
    remotePlaceholder = (
      <div className={`sftp-center sftp-prompt${prompt.kind === 'hostKey' && prompt.reason === 'changed' ? ' danger' : ''}`} role="dialog" aria-label={host?.label}>
        <div className="sftp-card">
          {prompt.kind === 'hostKey'
            ? <HostKeyPrompt key={prompt.id} cellId={sessionId} prompt={prompt} respond={respond} />
            : <AuthPrompt key={prompt.id} cellId={sessionId} prompt={prompt} storage={storage} respond={respond} />}
        </div>
      </div>
    );
  } else if (!session || (!sessionId && session.state !== 'error')) {
    remotePlaceholder = (
      <div className="sftp-center sftp-connect">
        <span className="sftp-connect-icon"><IServer /></span>
        <h3>{tr('Połącz z hostem')}</h3>
        <p>{tr('Zacznij od połączenia z zapisanym hostem, aby zarządzać plikami przez SFTP')}</p>
        <button type="button" className="btn primary" onClick={openHostPicker}>{tr('Wybierz host')}</button>
      </div>
    );
  } else if (session.state === 'connecting') {
    remotePlaceholder = (
      <div className="sftp-center sftp-connecting" role="status">
        <BusyRing className="sftp-spinner" />
        <p>{tr('Łączenie z {host}…', { host: host?.label ?? '' })}</p>
        <button type="button" className="btn small" onClick={() => void disconnectSftp()}>{tr('Anuluj')}</button>
      </div>
    );
  } else if (session.state !== 'connected') {
    remotePlaceholder = (
      <div className="sftp-center sftp-ended" role="status">
        <h3>{session.state === 'error' ? tr('Nie udało się połączyć') : tr('Rozłączono')}</h3>
        {sessionError && <p className="sftp-error">{tr(sessionError.key, sessionError.params)}</p>}
        <div className="ssh-actions">
          {host && <button type="button" className="btn primary" onClick={() => void connectSftp(host.id)}>{tr('Połącz ponownie')}</button>}
          <button type="button" className="btn" onClick={openHostPicker}>{tr('Wybierz host')}</button>
        </div>
      </div>
    );
  }

  const localCrumbList = useMemo(() => (localDir === null ? [] : localCrumbs(localDir, flavor)), [localDir, flavor]);
  const remoteCrumbList = useMemo(() => (remoteDir === null || remotePlaceholder ? [] : remoteCrumbs(remoteDir)), [remoteDir, !!remotePlaceholder]);
  return (
    <div className="sftp-view">
      {compactNav && <div className="sftp-nav"><SshNav compact /></div>}
      <div className="sftp-panes">
        <FilePane side="local" label={tr('Lokalne pliki')} head={localHead} folder={local.folder} crumbs={localCrumbList} extraColumns={false}
          onOpen={goLocal} onOpenFile={openLocal} onBack={local.back} onForward={local.forward} onUp={local.up}
          actions={localActions}
          transfer={{ label: tr('Wyślij'), icon: <IUpload />, disabled: !connected || !remoteDir, run: (sel) => upload(sel.map((e) => e.path), remoteDir!) }}
          onDelete={(sel) => void localDelete(sel)} onRename={(e) => void localRename(e)}
          onDropEntries={(payload, dir) => onDropEntries(payload, 'local', dir)}
          onMoveEntries={(paths, dir) => void moveEntries('local', paths, dir)}
          onRefresh={() => void local.refresh()} onCut={(sel) => cutEntries('local', sel)} onPaste={() => paste('local', localDir)} cutPaths={localCut}
          onDropFiles={(paths, dir) => {
            // Files dropped onto the folder they already live in would only conflict with themselves.
            const sources = outsideFolder(paths, dir, flavor);
            if (!sources.length) { toast(tr('Te pliki już są w tym folderze'), 'info'); return; }
            void enqueue(null, { direction: 'local-copy', sources, targetDir: dir });
          }}
          dropDisabled={localDir === DRIVES} />
        <FilePane side="remote" label={tr('Pliki na serwerze')} head={remoteHead} folder={remote.folder} crumbs={remoteCrumbList} extraColumns
          onOpen={(p) => void remote.go(p)} onOpenFile={openRemote} onBack={remote.back} onForward={remote.forward} onUp={remote.up}
          actions={remoteActions}
          transfer={{ label: tr('Pobierz'), icon: <IDownload />, disabled: !connected || !localDir || localDir === DRIVES, run: (sel) => download(sel.map((e) => e.path), localDir!) }}
          onDelete={(sel) => void remoteDelete(sel)} onRename={(e) => void remoteRename(e)}
          onDropEntries={(payload, dir) => onDropEntries(payload, 'remote', dir)}
          onDropFiles={(paths, dir) => upload(paths, dir)}
          onMoveEntries={(paths, dir) => void moveEntries('remote', paths, dir)}
          onRefresh={() => { if (connected) void remote.refresh(); }} onCut={(sel) => { if (connected) cutEntries('remote', sel); }} onPaste={() => paste('remote', remoteDir)} cutPaths={remoteCut}
          dropDisabled={!connected || !!remotePlaceholder} placeholder={remotePlaceholder} />
      </div>
      <TransferPanel />
      {perms && sessionId && connected && (
        <PermissionsDialog sessionId={sessionId} entries={perms} sudo={session?.sudo === true} onClose={(changed) => { setPerms(null); if (changed) void remote.refresh(); }} />
      )}
    </div>
  );
}
