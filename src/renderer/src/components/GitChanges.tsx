import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { GitFileChange, GitOpResult, GitResult, GitStatus } from '../../../shared/git';
import { useI18n } from '../i18n';
import { askChoice, toast } from '../store';
import { baseName, buildChangeTree, CONFLICT_LETTER, dirName, groupChanges, letterOf, newRequestId, sortChanges, type ChangeGroup, type ChangeNode, type ChangesSort, type ChangesView, type Letter } from '../../../shared/gitUi';
import { ICheck, IChevron } from './icons';
import { matchesShortcut, titleWithShortcut, useShortcutText } from '../shortcuts';

type Source = 'working' | 'staged' | 'untracked';

interface Props {
  projectId: string;
  status: GitStatus;
  busy: boolean;
  /** False in a repository above the project folder: files are listed but not staged or committed. */
  writable: boolean;
  /** Reminder that repository hooks and filters may run (a trusted repository with such configuration). */
  programsNote: string | null;
  opts: { worktree?: string };
  run(action: string, call: () => Promise<GitResult<GitOpResult>>, quiet?: boolean): Promise<boolean>;
  onOpen(file: GitFileChange, source: Source): void;
  onMenu(e: React.MouseEvent, file: GitFileChange, source: Source): void;
  view: ChangesView;
  sort: ChangesSort;
  /**
   * Shown in the place of the Commit button when given, e.g. a "Publish" action while there is nothing to commit and no remote.
   * The panel decides when; without it the Commit button is shown.
   */
  commitSlot?: ReactNode;
}

/** The Changes section: files grouped as conflicts, staged, changed and untracked, with stage / unstage and a commit box. */
export function GitChanges({ projectId, status, busy, writable, programsNote, opts, run, onOpen, onMenu, view, sort, commitSlot }: Props) {
  const { tr } = useI18n();
  useShortcutText(); // the commit shortcut in the tooltips follows the settings
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState('');
  const messageBox = useRef<HTMLTextAreaElement>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggleDir = (key: string) => setClosed((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const groups = useMemo(() => groupChanges(status.files), [status.files]);
  const total = status.files.length;
  const staged = groups.staged.length;

  const stage = (paths: string[], all = false) => void run('Stage', () => window.mc.git.stage(projectId, { requestId: newRequestId(), paths, ...(all ? { all: true } : {}), ...opts }), true);
  const unstage = (paths: string[], all = false) => void run('Unstage', () => window.mc.git.unstage(projectId, { requestId: newRequestId(), paths, ...(all ? { all: true } : {}), ...opts }), true);
  const pathsOf = (files: GitFileChange[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));

  const commit = async () => {
    if (!message.trim() || !staged) return;
    const ok = await run('Commit', () => window.mc.git.commit(projectId, { requestId: newRequestId(), message, ...opts }));
    if (ok) setMessage('');
  };

  /** The check mark of the Changes header: commits what is staged; without a message it asks for one, without staged files it offers to add everything. */
  const commitFromHeader = async () => {
    if (!message.trim()) { messageBox.current?.focus(); toast(tr('Wpisz opis commita.')); return; }
    if (!staged) {
      if (!groups.unstaged.length && !groups.untracked.length) { toast(tr('Brak zmian do zatwierdzenia.')); return; }
      const choice = await askChoice(tr('Dodać wszystkie zmiany do commita?'), tr('Żadne pliki nie są jeszcze dodane. Wszystkie zmiany (także nowe pliki) zostaną dodane i zatwierdzone razem.'), [{ label: tr('Dodaj i zatwierdź'), value: 'all', primary: true }]);
      if (choice !== 'all') return;
      if (!await run('Stage', () => window.mc.git.stage(projectId, { requestId: newRequestId(), paths: [], all: true, ...opts }), true)) return;
    }
    const ok = await run('Commit', () => window.mc.git.commit(projectId, { requestId: newRequestId(), message, ...opts }));
    if (ok) setMessage('');
  };

  const letterOfGroup = (id: ChangeGroup, file: GitFileChange): Letter => (id === 'conflict' ? CONFLICT_LETTER : id === 'staged' ? letterOf(file.x) : letterOf(file.untracked ? '?' : file.y));

  const group = (id: ChangeGroup, title: string, files: GitFileChange[]) => {
    if (!files.length) return null;
    const source: Source = id === 'staged' ? 'staged' : id === 'untracked' ? 'untracked' : 'working';
    const letterFor = (file: GitFileChange): string => letterOfGroup(id, file).letter;
    const fileRow = (file: GitFileChange, depth: number, tree: boolean) => {
      const letter = letterOfGroup(id, file);
      return (
        <div
          key={`${id}:${file.path}`}
          className="git-file"
          role="button"
          tabIndex={0}
          style={tree ? { paddingLeft: 14 + depth * 12 } : undefined}
          title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          onClick={() => onOpen(file, source)}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpen(file, source); }}
          onContextMenu={(e) => onMenu(e, file, source)}
        >
          <span className={`git-letter ${letter.cls}`} title={tr(letter.title)}>{letter.letter}</span>
          <span className="git-file-name">{tree ? baseName(file.path) : <>{baseName(file.path)}<span className="git-file-dir">{dirName(file.path)}</span></>}</span>
          {writable && <button
            className="btn ghost small git-file-action"
            disabled={busy}
            aria-label={id === 'staged' ? tr('Usuń z commita') : tr('Dodaj do commita')}
            title={id === 'staged' ? tr('Usuń z commita') : tr('Dodaj do commita')}
            onClick={(e) => { e.stopPropagation(); if (id === 'staged') unstage(pathsOf([file])); else stage(pathsOf([file])); }}
          >{id === 'staged' ? '−' : '+'}</button>}
        </div>
      );
    };
    const renderNodes = (nodes: ChangeNode[], depth: number): React.ReactNode[] => nodes.map((node) => {
      if (node.file) return fileRow(node.file, depth, true);
      const key = `${id}:${node.path}`;
      const open = !closed.has(key);
      return (
        <div key={key}>
          <div className="git-file git-dir" role="button" tabIndex={0} style={{ paddingLeft: 14 + depth * 12 }} aria-expanded={open} onClick={() => toggleDir(key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDir(key); } }}>
            <span className={`tree-chevron ${open ? 'open' : ''}`}><IChevron /></span>
            <span className="git-file-name">{node.name}</span>
          </div>
          {open && renderNodes(node.children, depth + 1)}
        </div>
      );
    });
    const bulk = id === 'staged'
      ? { label: tr('Usuń wszystko z commita'), onClick: () => unstage([], true) }
      : { label: tr('Dodaj wszystko do commita'), onClick: () => stage([], true) };
    return (
      <div className="git-group" key={id}>
        <div className="git-group-head">
          <span>{title} <span className="git-count">{files.length}</span></span>
          {writable && id !== 'conflict' && <button className="btn ghost small" disabled={busy} onClick={bulk.onClick} title={bulk.label} aria-label={bulk.label}>{id === 'staged' ? '−' : '+'}</button>}
        </div>
        {view === 'tree' ? renderNodes(buildChangeTree(files), 0) : sortChanges(files, sort, letterFor).map((file) => fileRow(file, 0, false))}
      </div>
    );
  };

  // The file rows are built again only when what they show changed: typing the commit message re-renders just the box.
  const list = useMemo(() => (
    <div className="git-changes-body">
      {!total && <p className="git-note muted">{tr('Brak zmian.')}</p>}
      {group('conflict', tr('Konflikty'), groups.conflict)}
      {group('staged', tr('Do zatwierdzenia'), groups.staged)}
      {group('unstaged', tr('Niedodane'), groups.unstaged)}
      {group('untracked', tr('Nieśledzone'), groups.untracked)}
      {status.truncated && <p className="git-note muted">{tr('Pokazano pierwsze {count} zmian.', { count: status.files.length })}</p>}
    </div>
  ), [groups, total, status.truncated, status.files.length, view, sort, closed, busy, writable, tr, onOpen, onMenu, run, projectId, opts]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className={`git-changes ${open ? '' : 'collapsed'}`} aria-label={tr('Zmiany')}>
      {writable && (
        <div className="git-commit-box">
          <textarea
            ref={messageBox}
            className="input"
            rows={1}
            value={message}
            placeholder={tr('Opis commita')}
            aria-label={tr('Opis commita')}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (matchesShortcut('git.commit', e)) { e.preventDefault(); void commit(); } }}
          />
          {commitSlot ?? (
            <button className="btn small primary" disabled={busy || !staged || !message.trim()} onClick={() => void commit()} title={titleWithShortcut(tr('Zatwierdź dodane pliki'), 'git.commit')}>
              <ICheck />{tr('Commit')}{staged > 0 && ` (${staged})`}
            </button>
          )}
          {programsNote && <span className="git-note muted">{programsNote}</span>}
        </div>
      )}
      <div className="git-section-bar">
        <button className="git-section-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className={`tree-chevron ${open ? 'open' : ''}`}><IChevron /></span>
          <span>{tr('Zmiany')}</span>
          <span className="git-count">{total}</span>
        </button>
        {writable && (
          <button className="btn ghost icon small git-bar-action" disabled={busy || !total} onClick={() => void commitFromHeader()} title={titleWithShortcut(tr('Zatwierdź zmiany (commit)'), 'git.commit')} aria-label={tr('Zatwierdź zmiany (commit)')}><ICheck /></button>
        )}
      </div>
      {open && list}
    </section>
  );
}
