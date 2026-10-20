import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GitFileChange, GitOpResult, GitResult, GitStatus } from '../../../shared/git';
import { useI18n } from '../i18n';
import { askChoice, toast } from '../store';
import { openFile } from '../files';
import {
  baseName, buildChangeTree, commitPlan, CONFLICT_LETTER, dirName, groupChanges, hasCommittable, letterOf, newRequestId, sortChanges,
  type ChangeGroup, type ChangeNode, type ChangesSort, type ChangesView, type Letter,
} from '../../../shared/gitUi';
import { openMenuAt } from './ContextMenu';
import { FileIcon } from './FileIcon';
import { ICheck, IChevron, IFolder } from './icons';
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
  /** `keep`: a double click keeps the diff tab; a single click opens it in the preview tab. */
  onOpen(file: GitFileChange, source: Source, keep?: boolean): void;
  onMenu(e: React.MouseEvent, file: GitFileChange, source: Source): void;
  /** The project-relative path to open a changed file in the editor; null when it has none (deleted, a folder, another worktree). */
  editPath(file: GitFileChange): string | null;
  view: ChangesView;
  sort: ChangesSort;
  /** The right end of the Changes header: the branch switcher (and the conflict count). */
  branch?: ReactNode;
  /**
   * Shown in the place of the Commit button when given, e.g. a "Publish" action while there is nothing to commit and no remote.
   * The panel decides when; without it the Commit button (with its menu) is shown.
   */
  commitSlot?: ReactNode;
  /** Push after a commit ("Commit and push" in the Commit button's menu); absent while the branch has nowhere to push. */
  onPush?(): Promise<void>;
}

/** The message box grows with the text up to this height (six lines), then scrolls. */
const MESSAGE_MAX = 106;

/** Thin row icons in the weight of the panel's other row actions. */
const RowIcon = ({ children }: { children: ReactNode }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IStage = () => <RowIcon><path d="M8 3v10M3 8h10" /></RowIcon>;
const IUnstage = () => <RowIcon><path d="M3 8h10" /></RowIcon>;
const IOpenFile = () => <RowIcon><path d="M9 1.8H4.2a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h3.3M9 1.8V5.5h3.8M9 1.8l3.8 3.7v2.3" /><path d="M9.5 12h5M12.5 10l2 2-2 2" /></RowIcon>;

/** The Changes section: a Cursor-like pane with the commit box and the files grouped as conflicts, staged, changed and untracked. */
export function GitChanges({ projectId, status, busy, writable, programsNote, opts, run, onOpen, onMenu, editPath, view, sort, branch, commitSlot, onPush }: Props) {
  const { tr } = useI18n();
  useShortcutText(); // the commit shortcut in the tooltips and the placeholder follows the settings
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState('');
  const messageBox = useRef<HTMLTextAreaElement>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [folded, setFolded] = useState<Set<ChangeGroup>>(new Set());
  const toggleDir = (key: string) => setClosed((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const toggleGroup = (id: ChangeGroup) => setFolded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const groups = useMemo(() => groupChanges(status.files), [status.files]);
  const committable = hasCommittable(groups);

  // The message box is one line high and grows with what is typed (like Cursor's), up to MESSAGE_MAX.
  useLayoutEffect(() => {
    const box = messageBox.current;
    if (!box) return;
    box.style.height = '';
    box.style.height = `${Math.min(box.scrollHeight + box.offsetHeight - box.clientHeight, MESSAGE_MAX)}px`;
  }, [message, open]);

  const stage = (paths: string[], all = false) => void run('Stage', () => window.mc.git.stage(projectId, { requestId: newRequestId(), paths, ...(all ? { all: true } : {}), ...opts }), true);
  const unstage = (paths: string[], all = false) => void run('Unstage', () => window.mc.git.unstage(projectId, { requestId: newRequestId(), paths, ...(all ? { all: true } : {}), ...opts }), true);
  const pathsOf = (files: GitFileChange[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));

  /**
   * The Commit button, its shortcut and the check mark of the header: commits what is staged; without a message it asks for one,
   * without staged files it offers to add everything first, never while conflicts are left. `andPush` pushes afterwards (with the
   * usual confirmation).
   */
  const commitNow = async (andPush = false) => {
    const plan = commitPlan(message, groups);
    if (plan === 'conflicts') { toast(tr('Najpierw rozwiąż konflikty i dodaj rozwiązane pliki do commita.'), 'error'); return; }
    if (plan === 'nothing') { toast(tr('Brak zmian do zatwierdzenia.')); return; }
    if (plan === 'ask') { messageBox.current?.focus(); toast(tr('Wpisz opis commita.')); return; }
    if (plan === 'stage-all') {
      const choice = await askChoice(tr('Dodać wszystkie zmiany do commita?'), tr('Żadne pliki nie są jeszcze dodane. Wszystkie zmiany (także nowe pliki) zostaną dodane i zatwierdzone razem.'), [{ label: tr('Dodaj i zatwierdź'), value: 'all', primary: true }]);
      if (choice !== 'all') return;
      if (!await run('Stage', () => window.mc.git.stage(projectId, { requestId: newRequestId(), paths: [], all: true, ...opts }), true)) return;
    }
    const ok = await run('Commit', () => window.mc.git.commit(projectId, { requestId: newRequestId(), message, ...opts }));
    if (!ok) return;
    setMessage('');
    if (andPush) await onPush?.();
  };

  const openCommitMenu = (button: HTMLElement) => openMenuAt(button, [
    { label: tr('Commit'), onClick: () => void commitNow() },
    { label: tr('Commit i push'), onClick: () => void commitNow(true) },
  ]);

  const letterOfGroup = (id: ChangeGroup, file: GitFileChange): Letter => (id === 'conflict' ? CONFLICT_LETTER : id === 'staged' ? letterOf(file.x) : letterOf(file.untracked ? '?' : file.y));

  const group = (id: ChangeGroup, title: string, files: GitFileChange[]) => {
    if (!files.length) return null;
    const source: Source = id === 'staged' ? 'staged' : id === 'untracked' ? 'untracked' : 'working';
    const letterFor = (file: GitFileChange): string => letterOfGroup(id, file).letter;
    const stageLabel = id === 'staged' ? tr('Usuń z commita') : tr('Dodaj do commita');
    const fileRow = (file: GitFileChange, depth: number, tree: boolean) => {
      const letter = letterOfGroup(id, file);
      const folder = file.path.endsWith('/');
      const editable = editPath(file);
      return (
        <div
          key={`${id}:${file.path}`}
          className={`git-file git-row ${letter.letter === 'D' ? 'deleted' : ''}`}
          role="button"
          tabIndex={0}
          style={tree ? { paddingLeft: 28 + depth * 12 } : undefined}
          title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          onClick={(e) => onOpen(file, source, e.detail >= 2)}
          onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(file, source); }}
          onContextMenu={(e) => onMenu(e, file, source)}
        >
          {folder ? <span className="explorer-folder-icon"><IFolder /></span> : <FileIcon name={file.path} />}
          <span className="git-file-name"><span className="git-file-base">{baseName(file.path)}</span>{!tree && <span className="git-file-dir">{dirName(file.path)}</span>}</span>
          {(editable || writable) && (
            <span className="git-row-actions">
              {editable && <button className="btn ghost icon small" aria-label={tr('Otwórz w edytorze')} title={tr('Otwórz w edytorze')} onClick={(e) => { e.stopPropagation(); void openFile(projectId, editable); }}><IOpenFile /></button>}
              {writable && <button
                className="btn ghost icon small"
                disabled={busy}
                aria-label={stageLabel}
                title={stageLabel}
                onClick={(e) => { e.stopPropagation(); if (id === 'staged') unstage(pathsOf([file])); else stage(pathsOf([file])); }}
              >{id === 'staged' ? <IUnstage /> : <IStage />}</button>}
            </span>
          )}
          <span className={`git-letter ${letter.cls}`} title={tr(letter.title)}>{letter.letter}</span>
        </div>
      );
    };
    const renderNodes = (nodes: ChangeNode[], depth: number): React.ReactNode[] => nodes.map((node) => {
      if (node.file) return fileRow(node.file, depth, true);
      const key = `${id}:${node.path}`;
      const open = !closed.has(key);
      return (
        <div key={key}>
          <div className="git-file git-row git-dir" role="button" tabIndex={0} style={{ paddingLeft: 12 + depth * 12 }} aria-expanded={open} onClick={() => toggleDir(key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDir(key); } }}>
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
    const shut = folded.has(id);
    // The whole row toggles the group (the button inside is its keyboard and screen reader handle); the actions stop the click.
    return (
      <div className="git-group" key={id}>
        <div className="git-group-head git-row" onClick={() => toggleGroup(id)}>
          <button className="git-row-toggle" aria-expanded={!shut}>
            <span className={`tree-chevron ${shut ? '' : 'open'}`}><IChevron /></span>
            <span className="git-group-title">{title}</span>
          </button>
          {writable && id !== 'conflict' && (
            <span className="git-row-actions">
              <button className="btn ghost icon small" disabled={busy} onClick={(e) => { e.stopPropagation(); bulk.onClick(); }} title={bulk.label} aria-label={bulk.label}>{id === 'staged' ? <IUnstage /> : <IStage />}</button>
            </span>
          )}
          <span className={`git-count ${id === 'conflict' ? 'conflict' : ''}`}>{files.length}</span>
        </div>
        {!shut && (view === 'tree' ? renderNodes(buildChangeTree(files), 0) : sortChanges(files, sort, letterFor).map((file) => fileRow(file, 0, false)))}
      </div>
    );
  };

  // The file rows are built again only when what they show changed: typing the commit message re-renders just the box.
  // No changes: nothing at all (no "no changes" line, no zero count), like Cursor.
  const list = useMemo(() => (
    <div className="git-changes-body">
      {group('conflict', tr('Konflikty'), groups.conflict)}
      {group('staged', tr('Do zatwierdzenia'), groups.staged)}
      {group('unstaged', tr('Niedodane'), groups.unstaged)}
      {group('untracked', tr('Nieśledzone'), groups.untracked)}
      {status.truncated && <p className="git-note muted">{tr('Pokazano pierwsze {count} zmian.', { count: status.files.length })}</p>}
    </div>
  ), [groups, status.truncated, status.files.length, view, sort, closed, folded, busy, writable, tr, onOpen, onMenu, editPath, run, projectId, opts]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitButton = (
    <div className="git-split">
      <button className="git-action-btn" disabled={busy || !committable} onClick={() => void commitNow()} title={titleWithShortcut(tr('Zatwierdź dodane pliki'), 'git.commit')}>
        <ICheck />{tr('Commit')}
      </button>
      {onPush && (
        <button className="git-action-btn git-split-more" disabled={busy || !committable} onClick={(e) => openCommitMenu(e.currentTarget)} title={tr('Więcej opcji commita')} aria-label={tr('Więcej opcji commita')} aria-haspopup="menu">
          <IChevron />
        </button>
      )}
    </div>
  );

  return (
    <section className={`git-changes ${open ? '' : 'collapsed'}`} aria-label={tr('Zmiany')}>
      <div className="git-pane-head with-branch" onClick={() => setOpen((v) => !v)}>
        <button className="git-pane-toggle" aria-expanded={open}>
          <span className={`tree-chevron ${open ? 'open' : ''}`}><IChevron /></span>
          <span className="git-pane-title">{tr('Zmiany')}</span>
        </button>
        <span className="git-pane-actions" onClick={(e) => e.stopPropagation()}>
          {/* Only with the section open: the message it commits (or asks for) is in the box below. */}
          {open && writable && committable && (
            <button className="btn ghost icon small git-hover-action" disabled={busy} onClick={() => void commitNow()} title={titleWithShortcut(tr('Zatwierdź zmiany (commit)'), 'git.commit')} aria-label={tr('Zatwierdź zmiany (commit)')}><ICheck /></button>
          )}
          {branch}
        </span>
      </div>
      {open && writable && (
        <div className="git-commit-box">
          <textarea
            ref={messageBox}
            className="git-message-input"
            rows={1}
            value={message}
            placeholder={titleWithShortcut(tr('Opis commita'), 'git.commit')}
            aria-label={tr('Opis commita')}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (matchesShortcut('git.commit', e)) { e.preventDefault(); void commitNow(); } }}
          />
          {/* The commit slot: the Commit button, or what the panel shows in its place (commitSlot). */}
          <div className="git-commit-slot">{commitSlot ?? commitButton}</div>
          {programsNote && <span className="git-note muted">{programsNote}</span>}
        </div>
      )}
      {open && list}
    </section>
  );
}
