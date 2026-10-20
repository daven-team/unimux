import { Select } from './Select';
// The Git panel of the left rail: the state of the active project's repository (branch, changes) and its history, with the
// everyday actions (fetch, pull --ff-only, push with confirmation, stage, commit, switch branch). Nothing destructive lives here.
// A repository whose own configuration can start programs stays read-only (history only) until the user trusts it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { activeProject, findCell } from '../../../shared/state';
import {
  projectRelativePath, type GitBranch, type GitFileChange, type GitOpResult, type GitResult, type GitStatus, type GitTrustInfo, type GitWorktree,
} from '../../../shared/git';
import { useI18n } from '../i18n';
import { askChoice, toast, useStore } from '../store';
import { openDiffTab, openFile } from '../files';
import { locateInFiles } from '../explorer';
import { useGitProbe } from '../git/gitProbe';
import { newRequestId, type ChangesSort, type ChangesView } from '../../../shared/gitUi';
import { useGitRepo } from '../git/useGitRepo';
import { openMenu, openMenuAt } from './ContextMenu';
import { GitChanges } from './GitChanges';
import { GitHistory } from './GitHistory';
import { GitSetup } from './GitSetup';
import { refreshGitBadges } from '../git/gitBadges';
import { IBranch, IChevron, IMore } from './icons';
import { RefreshIcon, useHoldBusy } from './Spinner';
import './gitPanel.css';

export function GitPanel() {
  const { tr } = useI18n();
  const project = useStore((st) => activeProject(st.s));
  const probe = useGitProbe(project?.id);
  if (!project) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Najpierw dodaj projekt')}</p></div>;
  if (probe === 'no-repo' || probe === 'no-git') return <GitSetup key={`${project.id}:${probe}`} projectId={project.id} projectName={project.name} kind={probe} />;
  return <RepoView key={`${project.id}:${project.path}`} projectId={project.id} projectPath={project.path} />;
}

const MAX_KEYS_SHOWN = 8;
/** Small, distinct transfer marks for the repository buttons of the History header; labels and confirmations live on the buttons. */
function GitTransferIcon({ kind }: { kind: 'fetch' | 'pull' | 'push' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'push' ? <path d="M8 11V2M5 5l3-3 3 3" /> : <path d="M8 2v9M5 8l3 3 3-3" />}
      {kind === 'fetch' ? <path d="M3 14h2m2 0h2m2 0h2" /> : <path d="M3 11v3h10v-3" />}
    </svg>
  );
}

/** Why the repository is read-only, what in its configuration can start programs, and the way out: an explicit "trust". */
function TrustBanner({ keys, folded, onFold, onTrust }: { keys: string[]; folded: boolean; onFold(): void; onTrust(): void }) {
  const { tr } = useI18n();
  if (folded) {
    return (
      <div className="git-trust folded" role="note">
        <span>{tr('Tryb tylko do odczytu: historia działa, a zmiany, fetch, pull, push i commit są wyłączone, dopóki nie zaufasz repozytorium.')}</span>
        <button className="btn small" onClick={onTrust}>{tr('Zaufaj temu repozytorium')}</button>
      </div>
    );
  }
  return (
    <div className="git-trust" role="alert">
      <strong>{tr('To repozytorium ma w konfiguracji programy, które git może uruchomić')}</strong>
      <ul className="git-trust-keys">
        {keys.slice(0, MAX_KEYS_SHOWN).map((key) => <li key={key}><code>{key}</code></li>)}
        {keys.length > MAX_KEYS_SHOWN && <li>+{keys.length - MAX_KEYS_SHOWN}</li>}
      </ul>
      <div className="git-trust-actions">
        <button className="btn small primary" onClick={onTrust}>{tr('Zaufaj temu repozytorium')}</button>
        <button className="btn small" onClick={onFold}>{tr('Tryb tylko do odczytu')}</button>
      </div>
    </div>
  );
}

function RepoView({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const { tr, errorText } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const spinning = useHoldBusy(refreshing, 700);
  const panel = useRef<HTMLDivElement>(null);
  const [historyLayout, setHistoryLayout] = useState(readHistoryLayout);
  const [changesLayout, setChangesLayout] = useState(readChangesLayout);
  const updateChangesLayout = (next: ChangesLayout) => { setChangesLayout(next); try { localStorage.setItem(CHANGES_KEY, JSON.stringify(next)); } catch { /* the choice just is not remembered */ } };
  const updateHistoryLayout = (next: HistoryLayout) => { setHistoryLayout(next); try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* the layout just is not remembered */ } };
  const [trust, setTrust] = useState<GitTrustInfo | null>(null);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  const [readOnlyHead, setReadOnlyHead] = useState<{ name: string | null; hash: string } | null>(null);
  const cellWorktree = useStore((st) => { const id = st.ui.focusedCellId; return id ? findCell(st.s, id)?.cell.worktree?.path : undefined; });

  // The worktree to show: the one the user picked, else the one of the focused cell, else the project folder itself.
  // Folders are matched in main by canonical path (short names, links and letter case do not matter), the answer comes as flags.
  const known = picked ? worktrees.find((w) => w.path === picked && w.allowed) : worktrees.find((w) => w.preferred && w.allowed);
  const worktree = known && !known.isProject ? known.path : undefined;
  const opts = worktree ? { worktree } : {};

  // Trust first: the status runs the repository's filters, so it is only asked for in a repository that is safe or trusted.
  const loadTrust = useCallback(async () => {
    try {
      const result = await window.mc.git.trust(projectId, worktree ? { worktree } : {});
      if (result.ok) { setTrust(result.data); setTrustError(null); }
      else setTrustError(result.error);
    } catch (e) { setTrustError(String(e)); }
  }, [projectId, worktree]);
  useEffect(() => {
    setTrust(null);
    void loadTrust();
    let timer: number | undefined;
    const onFocus = (): void => { window.clearTimeout(timer); timer = window.setTimeout(() => void loadTrust(), 300); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [loadTrust]);

  const untrusted = trust?.state === 'untrusted';
  const repo = useGitRepo(projectId, worktree, trust !== null && !untrusted);
  const { status } = repo;
  // The configuration changed under an open panel (the status was refused): look at the trust again.
  useEffect(() => { if (repo.error?.code === 'untrusted') void loadTrust(); }, [repo.error, loadTrust]);

  useEffect(() => {
    let cancelled = false;
    window.mc.git.worktrees(projectId, cellWorktree ? { prefer: cellWorktree } : {}).then((r) => { if (!cancelled && r.ok) setWorktrees(r.data); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, cellWorktree, status?.branch, status?.head, trust?.state]);

  // Read-only mode has no status: the branch comes from the branch list (which starts nothing).
  useEffect(() => {
    if (!untrusted) { setReadOnlyHead(null); return; }
    let cancelled = false;
    window.mc.git.branches(projectId, worktree ? { worktree } : {})
      .then((r) => { if (!cancelled && r.ok) { const current = r.data.find((b) => b.current); setReadOnlyHead(current ? { name: current.name, hash: current.hash } : { name: null, hash: '' }); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, worktree, untrusted, nonce]);

  const trustedWithPrograms = trust?.state === 'trusted' && trust.keys.length > 0;
  const programsNote = trustedWithPrograms ? tr('Hooki i filtry repozytorium mogą się przy tym uruchomić.') : null;
  const canWrite = !!status && !status.parent && !untrusted;

  /** Runs one user-initiated operation: one at a time, with its result (or git's own message) as a toast, then a refresh. */
  const run = useCallback(async (action: string, call: () => Promise<GitResult<GitOpResult>>, quiet = false): Promise<boolean> => {
    if (busy) return false;
    setBusy(action);
    let done = false;
    try {
      const result = await call();
      if (result.ok) { if (!quiet) toast(`${action}: ${result.data.message}`); done = true; }
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) {
      toast(tr('Git: {error}', { error: String(e) }), 'error');
    } finally {
      setBusy(null);
      setNonce((n) => n + 1);
      repo.refresh(0);
      void loadTrust();
      refreshGitBadges(projectId, 400);
    }
    return done;
  }, [busy, tr, errorText, repo, loadTrust]);

  /** The explicit "trust this repository": a confirmation naming the keys, then the dedicated request (main scans again and stores it). */
  const grantTrust = async () => {
    if (!trust) return;
    const keys = trust.keys.join(', ');
    const choice = await askChoice(
      tr('Zaufać temu repozytorium?'),
      tr('Git będzie mógł uruchamiać programy z konfiguracji tego repozytorium (hooki, filtry, polecenia) przy statusie, dodawaniu, commitach, fetch, pull i push. Zaufaj tylko repozytoriom, których autorom ufasz. Zmiana tej konfiguracji ponownie zapyta o zgodę.\n\nKlucze: {keys}', { keys }),
      [{ label: tr('Zaufaj'), value: 'trust', primary: true }],
    );
    if (choice !== 'trust') return;
    try {
      const result = await window.mc.git.trustGrant(projectId, { requestId: newRequestId(), ...opts });
      if (result.ok) { setTrust(result.data); setFolded(false); setNonce((n) => n + 1); }
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(tr('Git: {error}', { error: String(e) }), 'error'); }
  };

  const revokeTrust = async () => {
    try {
      const result = await window.mc.git.trustRevoke(projectId, { requestId: newRequestId(), ...opts });
      if (result.ok) setTrust(result.data);
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(tr('Git: {error}', { error: String(e) }), 'error'); }
  };

  /** The refresh button: reads everything again and shows it (the arrow turns for at least a moment). */
  const refreshNow = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setNonce((n) => n + 1);
    try { await Promise.all([repo.reload(), loadTrust()]); } finally { setRefreshing(false); }
  };

  /** Dragging the divider resizes the history (up = bigger); the arrow keys do the same in steps. */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const total = panel.current?.clientHeight ?? 600;
    const start = { y: e.clientY, height: historyLayout.height ?? Math.round(total * 0.45) };
    const move = (ev: PointerEvent) => updateHistoryLayout({ ...historyLayout, collapsed: false, height: clampHistory(start.height - (ev.clientY - start.y), total) });
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    e.preventDefault();
  };
  const resizeKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    const total = panel.current?.clientHeight ?? 600;
    updateHistoryLayout({ ...historyLayout, collapsed: false, height: clampHistory((historyLayout.height ?? Math.round(total * 0.45)) + step, total) });
  };
  const historyProps = { collapsed: historyLayout.collapsed, height: historyLayout.height, onToggle: () => updateHistoryLayout({ ...historyLayout, collapsed: !historyLayout.collapsed }) };

  const hasLocalChanges = !!status?.files.some((f) => !f.untracked);

  const fetchNow = () => void run('Fetch', () => window.mc.git.fetch(projectId, { requestId: newRequestId(), ...opts }));
  const pullNow = () => void run('Pull', () => window.mc.git.pull(projectId, { requestId: newRequestId(), ...opts }));
  /** Push with a confirmation naming the target; `current` is the status it describes (the one on screen unless given). */
  const pushNow = async (current: GitStatus | null = status) => {
    const push = current?.push;
    if (!current || !push) { toast(tr('Brak zdalnego repozytorium, do którego można wypchnąć tę gałąź.'), 'error'); return; }
    const lines = [
      tr('Gałąź {branch} zostanie wysłana do {target}.', { branch: current.branch ?? '', target: `${push.remote}/${push.branch}` }),
      tr('Adres docelowy: {url}', { url: push.url }),
    ];
    if (current.ahead) lines.push(tr('Commitów do wysłania: {count}', { count: current.ahead }));
    if (push.setUpstream) lines.push(tr('Ustawione zostanie też śledzenie gałęzi zdalnej.'));
    if (programsNote) lines.push(programsNote);
    const choice = await askChoice(tr('Wypchnąć zmiany?'), lines.join('\n'), [{ label: 'Push', value: 'push', primary: true }]);
    if (choice !== 'push') return;
    void run('Push', () => window.mc.git.push(projectId, { requestId: newRequestId(), remote: push.remote, branch: push.branch, urlId: push.urlId, ...opts }));
  };
  /** "Commit and push": the confirmation counts the commits from a fresh status (the one on screen is from before the commit). */
  const pushAfterCommit = async () => {
    const fresh = await window.mc.git.status(projectId, opts).catch(() => null);
    await pushNow(fresh?.ok ? fresh.data : status);
  };

  const switchBranch = async (branch: GitBranch) => {
    if (hasLocalChanges) { toast(tr('Masz niezatwierdzone zmiany. Zatwierdź je lub odłóż, zanim zmienisz gałąź.'), 'error'); return; }
    const body = [tr('Zmieni się zawartość plików w folderze projektu.'), ...(programsNote ? [programsNote] : [])].join('\n');
    const choice = await askChoice(tr('Przełączyć na gałąź „{branch}”?', { branch: branch.name }), body, [{ label: tr('Przełącz'), value: 'go', primary: true }]);
    if (choice !== 'go') return;
    void run(tr('Gałąź'), () => window.mc.git.checkout(projectId, { requestId: newRequestId(), branch: branch.name, ...(branch.remote ? { remote: true } : {}), ...opts }));
  };

  const openBranches = async (button: HTMLElement) => {
    const result = await window.mc.git.branches(projectId, opts);
    if (!result.ok) { toast(tr('Git: {error}', { error: errorText(result.error) }), 'error'); return; }
    const local = result.data.filter((b) => !b.remote).slice(0, 60);
    const remote = result.data.filter((b) => b.remote).slice(0, 40);
    openMenuAt(button, [
      { header: tr('Gałęzie') },
      ...local.map((b) => ({ label: b.name, hint: b.current ? tr('bieżąca') : b.track || undefined, disabled: b.current || !canWrite, onClick: () => void switchBranch(b) })),
      ...(remote.length ? [{ sep: true as const }, { header: tr('Zdalne') }, ...remote.map((b) => ({ label: b.name, disabled: !canWrite, onClick: () => void switchBranch(b) }))] : []),
    ]);
  };

  const openDiff = (file: GitFileChange, source: 'working' | 'staged' | 'untracked', keep = false) => {
    if (file.path.endsWith('/')) return;
    openDiffTab(projectId, { source, path: file.path, ...(file.origPath && source === 'staged' ? { oldPath: file.origPath } : {}), ...(worktree ? { worktree } : {}) }, keep ? 'keep' : 'preview');
  };

  /** Where a changed file lies in the project, to open it in the editor or the Files panel; null for a deleted file, a folder or another worktree. */
  const editPath = (file: GitFileChange): string | null => {
    if (!status || worktree || file.path.endsWith('/') || file.x === 'D' || file.y === 'D') return null;
    return projectRelativePath(status.projectRelation, file.path, window.mc.platform === 'win32');
  };

  const fileMenu = (e: React.MouseEvent, file: GitFileChange, source: 'working' | 'staged' | 'untracked') => {
    e.preventDefault();
    const relative = editPath(file);
    const folder = file.path.endsWith('/');
    openMenu(e.clientX, e.clientY, [
      { label: tr('Pokaż zmiany'), disabled: folder, onClick: () => openDiff(file, source) },
      { label: tr('Otwórz w edytorze'), disabled: !relative, onClick: () => { if (relative) void openFile(projectId, relative); } },
      { label: tr('Pokaż w panelu plików'), disabled: !relative, onClick: () => { if (relative) locateInFiles(projectId, relative); } },
      { sep: true },
      { label: tr('Kopiuj ścieżkę względną'), onClick: () => window.mc.clipboardWrite(file.path) },
    ]);
  };

  const selectValue = known?.path ?? worktrees.find((w) => w.isProject)?.path ?? worktrees[0]?.path ?? '';
  const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
  const worktreeSelect = worktrees.length > 1 && (
    // every option shows its full path, so the user sees which folder a choice means; the ones the project may not use are disabled
    <Select className="select git-worktree" aria-label={tr('Worktree')} value={selectValue} onChange={(e) => setPicked(e.target.value)}>
      {worktrees.map((w) => (
        <option key={w.path} value={w.path} disabled={!w.allowed} title={w.path}>
          {`${w.branch ?? tr('Odłączony HEAD ({head})', { head: w.head })} - ${folderName(w.path)} (${w.path})`}
        </option>
      ))}
    </Select>
  );

  /** The "..." menu of the panel: how the changes are shown and ordered, and the everyday actions (Cursor's menu, limited to what the panel can do). */
  const openOverflow = (button: HTMLElement) => {
    const mark = (on: boolean): string | undefined => (on ? '✓' : undefined);
    const idle = !busy && canWrite;
    openMenuAt(button, [
      { header: tr('Widok zmian') },
      { label: tr('Lista'), hint: mark(changesLayout.view === 'list'), onClick: () => updateChangesLayout({ ...changesLayout, view: 'list' }) },
      { label: tr('Drzewo'), hint: mark(changesLayout.view === 'tree'), onClick: () => updateChangesLayout({ ...changesLayout, view: 'tree' }) },
      { sep: true },
      { header: tr('Sortuj zmiany') },
      { label: tr('Według nazwy'), hint: mark(changesLayout.sort === 'name'), onClick: () => updateChangesLayout({ ...changesLayout, sort: 'name' }) },
      { label: tr('Według ścieżki'), hint: mark(changesLayout.sort === 'path'), onClick: () => updateChangesLayout({ ...changesLayout, sort: 'path' }) },
      { label: tr('Według statusu'), hint: mark(changesLayout.sort === 'status'), onClick: () => updateChangesLayout({ ...changesLayout, sort: 'status' }) },
      { sep: true },
      { label: tr('Pull'), disabled: !idle || !status?.upstream, onClick: pullNow },
      { label: 'Push', disabled: !idle || !status?.push || (!status.ahead && !status.push.setUpstream), onClick: () => void pushNow() },
      { label: 'Fetch', disabled: !idle, onClick: fetchNow },
      { label: tr('Przełącz na gałąź…'), onClick: () => void openBranches(button) },
      { sep: true },
      { label: tr('Odśwież'), onClick: () => void refreshNow() },
    ]);
  };

  /** `inMenu`: the "..." menu next to it has Refresh too, so a narrow panel may hide the button (gitPanel.css). */
  const refreshButton = (inMenu = false) => (
    <button className={`btn ghost icon small ${inMenu ? 'git-refresh' : ''} ${spinning ? 'busy' : ''}`} onClick={() => void refreshNow()} title={spinning ? tr('Odświeżanie…') : tr('Odśwież')} aria-label={tr('Odśwież')} aria-busy={spinning}><RefreshIcon spinning={spinning} /></button>
  );

  if (trustError && !trust) {
    return (
      <div className="sidebar-content git-panel">
        <p className="git-note error">{errorText(trustError)}</p>
        <div className="git-note"><button className="btn small" onClick={() => void loadTrust()}>{tr('Spróbuj ponownie')}</button></div>
      </div>
    );
  }
  if (!trust) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Wczytywanie…')}</p></div>;

  // ----- read-only: not trusted yet
  if (untrusted) {
    const branchLabel = readOnlyHead ? readOnlyHead.name ?? 'HEAD' : '';
    return (
      <div className="sidebar-content git-panel">
        {worktreeSelect}
        <div className="git-bar">
          <span className="git-branch static" title={branchLabel}><IBranch /><span className="git-branch-name">{branchLabel}</span></span>
          <span className="git-badge conflict" title={tr('Tryb tylko do odczytu')}>{tr('Tryb tylko do odczytu')}</span>
        </div>
        <TrustBanner keys={trust.keys} folded={folded} onFold={() => setFolded(true)} onTrust={() => void grantTrust()} />
        <GitHistory projectId={projectId} historyKey={`ro:${readOnlyHead?.name ?? ''}:${readOnlyHead?.hash ?? ''}`} initial={false} opts={opts} nonce={nonce} actions={refreshButton()} />
      </div>
    );
  }

  if (repo.error && !status) {
    return (
      <div className="sidebar-content git-panel">
        <p className="git-note error">{errorText(repo.error.message)}</p>
        <div className="git-note"><button className="btn small" onClick={() => repo.refresh(0)}>{tr('Spróbuj ponownie')}</button></div>
      </div>
    );
  }
  if (!status) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Wczytywanie…')}</p></div>;

  const branchLabel = status.branch ?? tr('Odłączony HEAD ({head})', { head: status.head });
  const conflicts = status.files.filter((f) => f.conflict).length;
  const historyKey = `${status.branch ?? ''}:${status.head}:${status.upstream ?? ''}:${status.ahead}:${status.behind}`;
  // The pull and push buttons carry the counts; the label says it too for the title and for screen readers.
  const pullLabel = status.behind > 0 ? tr('Pull (commitów do pobrania: {count})', { count: status.behind }) : tr('Pobierz i dołącz zmiany (pull, tylko fast-forward)');
  const pushLabel = status.ahead > 0 ? tr('Push (commitów do wysłania: {count})', { count: status.ahead }) : tr('Wyślij commity do zdalnego repozytorium (push)');

  // The branch switcher sits at the right end of the Changes header (commits go to it); the conflict count stays next to it.
  const branchControl = (
    <>
      {conflicts > 0 && <span className="git-badge conflict" title={tr('Konflikt scalania')}>!{conflicts}</span>}
      <button className="git-branch" onClick={(e) => void openBranches(e.currentTarget)} title={status.upstream ? `${tr('Zmień gałąź')}\n${tr('Śledzi: {upstream}', { upstream: status.upstream })}` : tr('Zmień gałąź')} aria-haspopup="menu">
        <IBranch /><span className="git-branch-name">{branchLabel}</span><span className="git-branch-chevron"><IChevron /></span>
      </button>
    </>
  );
  // The repository buttons live in the History header, like the ones of Cursor's graph header.
  const repoActions = (
    <>
      <button className="btn ghost icon small git-fetch" disabled={!!busy || !canWrite} onClick={fetchNow} aria-label="Fetch" title={tr('Pobierz zmiany ze zdalnego repozytorium (fetch)')}>{busy === 'Fetch' ? '…' : <GitTransferIcon kind="fetch" />}</button>
      <button className={`btn ghost icon small git-sync ${status.behind > 0 ? 'down' : ''}`} disabled={!!busy || !canWrite || !status.upstream} onClick={pullNow} aria-label={pullLabel} title={status.upstream ? pullLabel : tr('Ta gałąź nie śledzi gałęzi zdalnej')}>
        {busy === 'Pull' ? '…' : <><GitTransferIcon kind="pull" />{status.behind > 0 && <span className="git-sync-count">{status.behind}</span>}</>}
      </button>
      <button className={`btn ghost icon small git-sync ${status.ahead > 0 ? 'up' : ''}`} disabled={!!busy || !canWrite || !status.push || (!status.ahead && !status.push.setUpstream)} onClick={() => void pushNow()} aria-label={pushLabel} title={pushLabel}>
        {busy === 'Push' ? '…' : <><GitTransferIcon kind="push" />{status.ahead > 0 && <span className="git-sync-count">{status.ahead}</span>}</>}
      </button>
      {refreshButton(true)}
      <button className="btn ghost icon small" onClick={(e) => openOverflow(e.currentTarget)} title={tr('Więcej akcji Git')} aria-label={tr('Więcej akcji Git')} aria-haspopup="menu"><IMore /></button>
    </>
  );

  return (
    <div className="sidebar-content git-panel" ref={panel}>
      {worktreeSelect}
      {repo.error && <p className="git-note error" role="alert">{errorText(repo.error.message)}</p>}
      {status.parent && <p className="git-note error" role="note">{tr('Repozytorium nadrzędne: ten projekt jest podfolderem większego repozytorium ({root}). Zmiany w nim są wyłączone.', { root: status.root })}</p>}
      {trustedWithPrograms && (
        <div className="git-trust folded" role="note">
          <span>{tr('Zaufane repozytorium: hooki i filtry z jego konfiguracji mogą się uruchamiać przy tych operacjach.')}</span>
          <button className="btn small" onClick={() => void revokeTrust()}>{tr('Cofnij zaufanie')}</button>
        </div>
      )}
      {/* commitSlot (not set yet) takes the Commit button's place, e.g. for publishing a repository that has no remote. */}
      <GitChanges
        view={changesLayout.view} sort={changesLayout.sort} projectId={projectId} status={status} busy={!!busy} writable={canWrite} programsNote={programsNote}
        opts={opts} run={run} onOpen={openDiff} onMenu={fileMenu} editPath={editPath} branch={branchControl}
        onPush={status.push ? pushAfterCommit : undefined}
      />
      <div className="git-splitter" role="separator" aria-orientation="horizontal" aria-label={tr('Zmień wysokość historii')} tabIndex={0} onPointerDown={startResize} onKeyDown={resizeKey} />
      <GitHistory projectId={projectId} historyKey={historyKey} initial={status.initial} opts={opts} nonce={nonce} actions={repoActions} {...historyProps} />
    </div>
  );
}

const HISTORY_KEY = 'mc-git-history-v1';
interface HistoryLayout { collapsed: boolean; height: number | null }
function readHistoryLayout(): HistoryLayout {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null') as Partial<HistoryLayout> | null;
    return { collapsed: value?.collapsed === true, height: typeof value?.height === 'number' && value.height > 0 ? value.height : null };
  } catch { return { collapsed: false, height: null }; }
}
const clampHistory = (height: number, total: number): number => Math.round(Math.max(72, Math.min(total - 170, height)));

const CHANGES_KEY = 'mc-git-changes-v1';
interface ChangesLayout { view: ChangesView; sort: ChangesSort }
function readChangesLayout(): ChangesLayout {
  try {
    const value = JSON.parse(localStorage.getItem(CHANGES_KEY) ?? 'null') as Partial<ChangesLayout> | null;
    return {
      view: value?.view === 'tree' ? 'tree' : 'list',
      sort: value?.sort === 'name' || value?.sort === 'status' ? value.sort : 'path',
    };
  } catch { return { view: 'list', sort: 'path' }; }
}
