import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatAgo } from '../../../shared/i18n';
import { GIT_LOG_PAGE, layoutGraph, type GitCommit, type GitCommitDetails, type GitRef, type GraphRow } from '../../../shared/git';
import type { Language } from '../../../shared/languages';
import { rowSlots, rowWindow, type RowWindow } from '../../../shared/virtualRows';
import { useI18n } from '../i18n';
import { openDiffTab } from '../files';
import { baseName, chipRefs, dirName, letterOf } from '../../../shared/gitUi';
import { openMenu } from './ContextMenu';
import { FileIcon } from './FileIcon';
import { GitGraph, GRAPH_ROW, graphLanes } from './GitGraph';
import { IBranch, IChevron, ICloud, ITag, IX } from './icons';

/** Loaded rows stop here: the list stays light, a filter or the search finds older commits. */
const MAX_LOADED = 3000;
/** Rows rendered above and below the visible ones (every row is GRAPH_ROW px high, see .git-rows in gitPanel.css). */
const OVERSCAN = 12;

/**
 * `historyKey` changes when HEAD or the branches moved (the list then starts again); `initial`: the repository has no commit yet;
 * `actions`: the repository buttons of the header (fetch, pull, push, refresh, more), kept there like Cursor's graph header.
 */
interface Props {
  projectId: string; historyKey: string; initial: boolean; opts: { worktree?: string }; nonce: number;
  collapsed?: boolean; onToggle?(): void; height?: number | null; actions?: ReactNode;
}

/** The History section: commits in pages of 50 (loaded while scrolling), a thin graph, filters, and the details of one commit. */
export function GitHistory({ projectId, historyKey, initial, opts, nonce, collapsed = false, onToggle, height = null, actions }: Props) {
  const { tr, language, errorText } = useI18n();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The text of the search field, kept while a commit's details are shown (the field itself is HistorySearch). */
  const searchText = useRef('');
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const sequence = useRef(0);
  const loadingMore = useRef(false);
  const worktree = opts.worktree;

  // The first page again whenever HEAD moved, an operation finished or the filter changed.
  const key = `${historyKey}:${nonce}:${query}:${all}:${worktree ?? ''}`;
  useEffect(() => {
    const mine = ++sequence.current;
    loadingMore.current = false;
    setLoading(true);
    window.mc.git.log(projectId, { skip: 0, count: GIT_LOG_PAGE, ...(query ? { search: query } : {}), ...(all ? { all: true } : {}), ...(worktree ? { worktree } : {}) })
      .then((r) => {
        if (mine !== sequence.current) return;
        if (r.ok) { setCommits(r.data.commits); setHasMore(r.data.hasMore); setError(null); }
        else { setError(r.error); setCommits([]); setHasMore(false); }
      })
      .catch((e) => { if (mine === sequence.current) setError(String(e)); })
      .finally(() => { if (mine === sequence.current) setLoading(false); });
  }, [key, projectId, query, all, worktree]);

  const loadMore = useCallback(() => {
    if (loadingMore.current || !hasMore || commits.length >= MAX_LOADED) return;
    loadingMore.current = true;
    const mine = sequence.current;
    window.mc.git.log(projectId, { skip: commits.length, count: GIT_LOG_PAGE, ...(query ? { search: query } : {}), ...(all ? { all: true } : {}), ...(worktree ? { worktree } : {}) })
      .then((r) => {
        if (mine !== sequence.current) return;
        if (r.ok) { setCommits((prev) => [...prev, ...r.data.commits]); setHasMore(r.data.hasMore); }
        else setError(r.error);
      })
      .catch((e) => setError(String(e)))
      .finally(() => { loadingMore.current = false; });
  }, [projectId, commits.length, hasMore, query, all, worktree]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = useMemo(() => graphLanes(rows), [rows]);
  // Filters hide commits, so the graph of a filtered list would show lanes that do not connect: only the full history draws it.
  const graph = !query;

  // Only the rows in view (plus OVERSCAN) are rendered; the others are spacers of the same height.
  const logRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<RowWindow>({ start: 0, end: 2 * OVERSCAN });
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  const measure = useCallback(() => {
    const log = logRef.current;
    const list = rowsRef.current;
    if (!log || !list) return;
    const offset = list.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
    const next = rowWindow(log.scrollTop - offset, log.clientHeight, GRAPH_ROW, commits.length, OVERSCAN);
    setView((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [commits.length]);
  useLayoutEffect(measure, [measure, collapsed, selected, error, loading]);
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const observer = new ResizeObserver(measure);
    observer.observe(log);
    return () => observer.disconnect();
  }, [measure, collapsed, selected]);
  const focusedIndex = focusedHash ? commits.findIndex((c) => c.hash === focusedHash) : -1;
  const slots = rowSlots(view, commits.length, focusedIndex >= 0 ? [focusedIndex] : []);

  if (selected) return <GitCommitView projectId={projectId} commit={selected} opts={opts} actions={actions} onBack={() => setSelected(null)} />;

  return (
    <section className={`git-history ${collapsed ? 'collapsed' : height ? 'sized' : ''}`} aria-label={tr('Historia')} style={!collapsed && height ? { flex: `0 1 ${height}px` } : undefined}>
      {/* The whole header toggles the section (the button is its keyboard handle); the buttons on the right stop the click. */}
      <div className={onToggle ? 'git-pane-head' : 'git-pane-head static'} onClick={onToggle}>
        {onToggle
          ? <button className="git-pane-toggle" aria-expanded={!collapsed} title={collapsed ? tr('Rozwiń historię') : tr('Zwiń historię')}><span className={`tree-chevron ${collapsed ? '' : 'open'}`}><IChevron /></span><span className="git-pane-title">{tr('Historia')}</span></button>
          : <span className="git-pane-toggle"><span className="git-pane-title">{tr('Historia')}</span></span>}
        <span className="git-pane-actions" onClick={(e) => e.stopPropagation()}>
          {!collapsed && <button className={`btn ghost icon small ${all ? 'on' : ''}`} aria-pressed={all} title={tr('Pokaż commity wszystkich gałęzi')} aria-label={tr('Pokaż commity wszystkich gałęzi')} onClick={() => setAll((v) => !v)}>
            <IBranch />
          </button>}
          {actions}
        </span>
      </div>
      {!collapsed && <>
      <HistorySearch initial={searchText.current} onText={(text) => { searchText.current = text; }} onQuery={setQuery} />
      <div
        ref={logRef}
        className="git-log"
        onScroll={(e) => { const el = e.currentTarget; measure(); if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) loadMore(); }}
      >
        {error && <p className="git-note error">{errorText(error)}</p>}
        {!error && !loading && !commits.length && <p className="git-note muted">{initial ? tr('Repozytorium nie ma jeszcze commitów.') : tr('Brak commitów.')}</p>}
        <div ref={rowsRef} className="git-rows">
          {slots.map((slot) => slot.kind === 'gap'
            ? <div key={`gap:${slots.indexOf(slot)}`} style={{ height: slot.rows * GRAPH_ROW }} aria-hidden />
            : <CommitRow key={commits[slot.index].hash} commit={commits[slot.index]} row={graph ? rows[slot.index] : undefined} lanes={lanes}
                language={language} onSelect={setSelected} onFocusRow={setFocusedHash} />)}
        </div>
        {loading && <p className="git-note muted">{tr('Wczytywanie…')}</p>}
        {!loading && hasMore && <button className="btn small git-more" onClick={loadMore}>{tr('Wczytaj więcej')}</button>}
      </div>
      </>}
    </section>
  );
}

/** The search field: its text lives here, so typing re-renders only the field; the query follows 300 ms after the last key. */
function HistorySearch({ initial, onText, onQuery }: { initial: string; onText(text: string): void; onQuery(query: string): void }) {
  const { tr } = useI18n();
  const [search, setSearch] = useState(initial);
  useEffect(() => {
    onText(search);
    const timer = window.setTimeout(() => onQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="git-search">
      <input className="input" value={search} placeholder={tr('Szukaj w opisach commitów…')} aria-label={tr('Szukaj w opisach commitów…')} onChange={(e) => setSearch(e.target.value)} />
      {search && <button className="btn ghost icon small" aria-label={tr('Wyczyść')} title={tr('Wyczyść')} onClick={() => setSearch('')}><IX /></button>}
    </div>
  );
}

/** One history row (memoized: scrolling renders only the rows that come into view). */
const CommitRow = memo(function CommitRow({ commit, row, lanes, language, onSelect, onFocusRow }: {
  commit: GitCommit; row: GraphRow | undefined; lanes: number; language: Language;
  onSelect(commit: GitCommit): void; onFocusRow(hash: string | null): void;
}) {
  const { tr } = useI18n();
  const { shown, more } = chipRefs(commit.refs);
  return (
    <div
      className="git-commit"
      role="button"
      tabIndex={0}
      // The tooltip is built when the pointer arrives, so its relative time is current although the row is memoized.
      onMouseEnter={(e) => { e.currentTarget.title = `${commit.subject}\n${commit.short} · ${commit.author} · ${formatAgo(language, commit.at * 1000)}`; }}
      onClick={() => onSelect(commit)}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(commit); }}
      onFocus={() => onFocusRow(commit.hash)}
      onBlur={() => onFocusRow(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: tr('Pokaż szczegóły'), onClick: () => onSelect(commit) },
          { label: tr('Kopiuj hash'), onClick: () => window.mc.clipboardWrite(commit.hash) },
        ]);
      }}
    >
      {row && <GitGraph row={row} lanes={lanes} />}
      <div className="git-commit-text">
        <div className="git-commit-subject">
          <span className="git-subject-text">{commit.subject}</span>
          <span className="git-chips">
            {shown.map((ref) => <RefChip key={`${ref.kind}:${ref.name}`} gitRef={ref} />)}
            {more > 0 && <span className="git-chip more" title={tr('Pokaż commity wszystkich gałęzi')}>+{more}</span>}
          </span>
        </div>
      </div>
    </div>
  );
});

/** A branch or tag of a commit: local branches and tags show their name, remote ones only a cloud (the name is in the tooltip). */
function RefChip({ gitRef }: { gitRef: GitRef }) {
  const remote = gitRef.kind === 'remote';
  return (
    <span className={`git-chip ${gitRef.kind} ${gitRef.current ? 'current' : ''} ${remote ? 'icon-only' : ''}`} title={gitRef.name}>
      {remote ? <ICloud /> : gitRef.kind === 'tag' ? <ITag /> : <IBranch />}
      {!remote && <span className="git-chip-name">{gitRef.name}</span>}
    </span>
  );
}

/** One commit: message, stats and its files (a click on a file opens the diff). The header keeps the repository buttons. */
function GitCommitView({ projectId, commit, opts, actions, onBack }: { projectId: string; commit: GitCommit; opts: { worktree?: string }; actions?: ReactNode; onBack(): void }) {
  const { tr, language, errorText } = useI18n();
  const [details, setDetails] = useState<GitCommitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const worktree = opts.worktree;

  useEffect(() => {
    let cancelled = false;
    window.mc.git.show(projectId, { hash: commit.hash, ...(worktree ? { worktree } : {}) })
      .then((r) => { if (cancelled) return; if (r.ok) setDetails(r.data); else setError(r.error); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, commit.hash, worktree]);

  const { shown } = chipRefs(commit.refs, 8);
  return (
    <section className="git-history git-details" aria-label={tr('Szczegóły commita')}>
      <div className="git-pane-head" onClick={onBack}>
        <button className="git-pane-toggle"><span className="tree-chevron git-back-chevron"><IChevron /></span><span className="git-pane-title">{tr('Historia')}</span></button>
        {actions && <span className="git-pane-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </div>
      <div className="git-details-body">
        <div className="git-details-subject">{commit.subject}</div>
        <div className="git-commit-meta muted" title={commit.hash}>{commit.short} · {commit.author} · {formatAgo(language, commit.at * 1000)}</div>
        {shown.length > 0 && <div className="git-details-chips">{shown.map((ref) => <RefChip key={`${ref.kind}:${ref.name}`} gitRef={ref} />)}</div>}
        {error && <p className="git-note error">{errorText(error)}</p>}
        {!details && !error && <p className="git-note muted">{tr('Wczytywanie…')}</p>}
        {details && (
          <>
            {details.message.includes('\n') && <pre className="git-message">{details.message.split('\n').slice(1).join('\n').trim()}</pre>}
            <div className="git-stats muted">
              {tr('Pliki: {count}', { count: details.files.length + (details.filesTruncated ? 1 : 0) })}{details.filesTruncated ? '+' : ''}
              {' · '}<span className="plus">+{details.added}</span> <span className="minus">-{details.deleted}</span>
            </div>
            <div className="git-files">
              {details.files.map((file) => {
                const letter = letterOf(file.status);
                return (
                  <div
                    key={`${file.status}:${file.path}`}
                    className={`git-file git-row ${letter.letter === 'D' ? 'deleted' : ''}`}
                    role="button"
                    tabIndex={0}
                    title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                    // A single click opens the diff in the preview tab, a double click keeps it (like VS Code's timeline).
                    onClick={(e) => openDiffTab(projectId, { source: 'commit', hash: commit.hash, path: file.path, ...(file.origPath ? { oldPath: file.origPath } : {}), ...(worktree ? { worktree } : {}) }, e.detail >= 2 ? 'keep' : 'preview')}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLElement).click(); }}
                  >
                    <FileIcon name={file.path} />
                    <span className="git-file-name"><span className="git-file-base">{baseName(file.path)}</span><span className="git-file-dir">{dirName(file.path)}</span></span>
                    <span className="git-file-stat muted">{file.added === null ? 'bin' : <><span className="plus">+{file.added}</span> <span className="minus">-{file.deleted}</span></>}</span>
                    <span className={`git-letter ${letter.cls}`} title={tr(letter.title)}>{letter.letter}</span>
                  </div>
                );
              })}
              {details.filesTruncated && <p className="git-note muted">{tr('Pokazano pierwsze {count} plików.', { count: details.files.length })}</p>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
