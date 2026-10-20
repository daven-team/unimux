import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPattern, expandReplacement, type ReplaceResult, type SearchFile, type SearchMatch, type SearchOptions, type SearchResult } from '../../../shared/search';
import { useI18n } from '../i18n';
import { isFileDirty, openFile, retryFile, useFileStore } from '../files';
import { askChoice, closeModal, toast, useStore } from '../store';
import { IX } from './icons';
import { RefreshIcon, useHoldBusy } from './Spinner';

const PAGE = 300;
/** Remembered for the next time the window opens. */
let remembered: Pick<SearchOptions, 'query' | 'caseSensitive' | 'wholeWord' | 'regex'> & { replacement: string } = { query: '', replacement: '', caseSensitive: false, wholeWord: false, regex: false };

/** What a match turns into: literal text, or the regular-expression replacement expanded for that match. */
function replacementFor(match: SearchMatch, options: SearchOptions, replacement: string): string {
  if (!options.regex) return replacement;
  const pattern = buildPattern(options);
  if ('error' in pattern) return replacement;
  pattern.regex.lastIndex = match.matchStart;
  const found = pattern.regex.exec(match.preview);
  return found && found.index === match.matchStart ? expandReplacement(replacement, found) : replacement;
}

function MatchLine({ match, options, replacement }: { match: SearchMatch; options: SearchOptions; replacement: string }) {
  const before = match.preview.slice(0, match.matchStart);
  const hit = match.preview.slice(match.matchStart, match.matchStart + match.matchLength);
  const after = match.preview.slice(match.matchStart + match.matchLength);
  const next = replacementFor(match, options, replacement);
  return <span className="fr-line">
    <span>{before}</span>
    {replacement !== '' || options.regex ? <><del>{hit}</del><ins>{next}</ins></> : <mark>{hit}</mark>}
    <span>{after}</span>
  </span>;
}

/** Find and replace across a project: search as you type, replace one match, one file or everything. */
export function FindReplaceModal({ projectId }: { projectId: string }) {
  const { tr } = useI18n();
  const project = useStore((st) => st.s.projects.find((p) => p.id === projectId));
  const [query, setQuery] = useState(remembered.query);
  const [replacement, setReplacement] = useState(remembered.replacement);
  const [caseSensitive, setCaseSensitive] = useState(!!remembered.caseSensitive);
  const [wholeWord, setWholeWord] = useState(!!remembered.wholeWord);
  const [regex, setRegex] = useState(!!remembered.regex);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [filters, setFilters] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [working, setWorking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [visible, setVisible] = useState(PAGE);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [rerun, setRerun] = useState(0);
  const spinning = useHoldBusy(searching, 500);
  const token = useRef(0);

  const options: SearchOptions = useMemo(() => ({ query, caseSensitive, wholeWord, regex, include, exclude, includeIgnored }), [query, caseSensitive, wholeWord, regex, include, exclude, includeIgnored]);

  useEffect(() => {
    remembered = { query, replacement, caseSensitive, wholeWord, regex };
  }, [query, replacement, caseSensitive, wholeWord, regex]);

  useEffect(() => {
    const mine = ++token.current;
    if (!query) { setResult(null); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      window.mc.searchProject(projectId, options)
        .then((found) => { if (token.current === mine) { setResult(found); setVisible(PAGE); setClosed(new Set()); } })
        .catch((error) => { if (token.current === mine) setResult({ ok: false, error: String(error) }); })
        .finally(() => { if (token.current === mine) setSearching(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [projectId, options, query, rerun]);

  if (!project) return null;
  const files: SearchFile[] = result?.ok ? result.files : [];
  const total = result?.ok ? result.matches : 0;

  /** Files with unsaved editor changes must not be rewritten behind the editor's back. */
  const dirtyAmong = (paths: string[]): string[] => {
    const set = new Set(paths);
    return useFileStore.getState().documents.filter((d) => d.projectId === projectId && isFileDirty(d) && set.has(d.relativePath)).map((d) => d.relativePath);
  };

  const apply = async (scope: Parameters<typeof window.mc.replaceInProject>[1]['scope'], paths: string[]) => {
    const dirty = dirtyAmong(paths);
    if (dirty.length) { setProblems([tr('Zapisz lub zamknij pliki z niezapisanymi zmianami: {files}', { files: dirty.join(', ') })]); return; }
    setWorking(true); setProblems([]);
    let outcome: ReplaceResult;
    try { outcome = await window.mc.replaceInProject(projectId, { options, replacement, scope }); }
    catch (error) { outcome = { ok: false, error: String(error) }; }
    setWorking(false);
    if (!outcome.ok) { setProblems([outcome.error]); return; }
    for (const file of outcome.files) {
      const document = useFileStore.getState().documents.find((d) => d.projectId === projectId && d.relativePath === file.path);
      if (file.replaced && document) void retryFile(document.id);
    }
    setProblems(outcome.files.filter((f) => f.error).map((f) => `${f.path}: ${f.error}`));
    if (outcome.replaced) toast(tr('Zamieniono: {count}', { count: outcome.replaced }));
    setRerun((n) => n + 1);
  };

  const replaceAll = async () => {
    const choice = await askChoice(tr('Zamienić wszystkie wystąpienia?'), tr('Zamienić {matches} wystąpień w {files} plikach? Tej operacji nie można cofnąć.', { matches: total, files: files.length }), [
      { label: tr('Zamień wszystko'), value: 'replace', danger: true },
    ]);
    if (choice === 'replace') await apply({ kind: 'all' }, files.map((f) => f.path));
  };

  let budget = visible;
  const toggle = (path: string) => setClosed((previous) => { const next = new Set(previous); if (!next.delete(path)) next.add(path); return next; });

  return (
    <div className="modal find-replace">
      <div className="modal-head">
        <h3>{tr('Znajdź i zamień w projekcie')} <span className="fr-project">{project.name}</span></h3>
        <button className="btn ghost icon" onClick={closeModal} aria-label={tr('Zamknij')}><IX /></button>
      </div>
      <div className="fr-controls">
        <div className="fr-row">
          <div className="fr-field">
            <input className="input" autoFocus value={query} placeholder={tr('Znajdź')} aria-label={tr('Znajdź')}
              onChange={(e) => setQuery(e.target.value)} onFocus={(e) => e.target.select()} />
            <div className="fr-toggles">
              <button className={`fr-toggle ${caseSensitive ? 'on' : ''}`} aria-pressed={caseSensitive} title={tr('Uwzględnij wielkość liter')} onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
              <button className={`fr-toggle ${wholeWord ? 'on' : ''}`} aria-pressed={wholeWord} title={tr('Całe słowa')} onClick={() => setWholeWord(!wholeWord)}><u>ab</u></button>
              <button className={`fr-toggle ${regex ? 'on' : ''}`} aria-pressed={regex} title={tr('Wyrażenie regularne')} onClick={() => setRegex(!regex)}>.*</button>
            </div>
          </div>
          <button className="btn" onClick={() => setRerun((n) => n + 1)} disabled={!query || spinning} title={tr('Szukaj ponownie')}><RefreshIcon spinning={spinning} />{tr('Szukaj')}</button>
        </div>
        <div className="fr-row">
          <div className="fr-field">
            <input className="input" value={replacement} placeholder={tr('Zamień na')} aria-label={tr('Zamień na')} onChange={(e) => setReplacement(e.target.value)} />
          </div>
          <button className="btn danger" onClick={() => void replaceAll()} disabled={!total || working}>{tr('Zamień wszystko')}{total ? ` (${total})` : ''}</button>
        </div>
        <button className="fr-filters-toggle" onClick={() => setFilters(!filters)} aria-expanded={filters}>{filters ? '▾' : '▸'} {tr('Filtry plików')}</button>
        {filters && (
          <div className="fr-filters">
            <input className="input" value={include} placeholder={tr('Pliki (np. *.ts, src/**)')} aria-label={tr('Pliki (np. *.ts, src/**)')} onChange={(e) => setInclude(e.target.value)} />
            <input className="input" value={exclude} placeholder={tr('Wyklucz (np. docs/, *.min.js)')} aria-label={tr('Wyklucz (np. docs/, *.min.js)')} onChange={(e) => setExclude(e.target.value)} />
            <label className="check"><input type="checkbox" checked={includeIgnored} onChange={(e) => setIncludeIgnored(e.target.checked)} />{tr('Szukaj też w node_modules, dist i podobnych')}</label>
          </div>
        )}
      </div>
      <div className="fr-status" role="status">
        {searching && !result ? tr('Wyszukiwanie…')
          : result?.ok ? (total ? tr('Znaleziono {matches} w {files} plikach', { matches: total, files: files.length }) : tr('Brak wyników'))
          : result && !result.ok ? <span className="fr-error">{result.error}</span>
          : tr('Wpisz, czego szukać.')}
        {result?.ok && result.truncated && <span className="fr-note"> · {tr('Wyniki ograniczono, zawęź wyszukiwanie.')}</span>}
        {result?.ok && result.skipped > 0 && <span className="fr-note"> · {tr('Pominięto {count} plików (binarne lub duże).', { count: result.skipped })}</span>}
      </div>
      {problems.length > 0 && <ul className="fr-problems" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="fr-results">
        {files.map((file) => {
          if (budget <= 0) return null;
          const open = !closed.has(file.path);
          const shown = open ? file.matches.slice(0, budget) : [];
          budget -= open ? shown.length : 1;
          return (
            <section key={file.path} className="fr-file">
              <header>
                <button className="fr-file-name" onClick={() => toggle(file.path)} aria-expanded={open}>
                  <span className="fr-caret">{open ? '▾' : '▸'}</span>{file.path}<span className="fr-count">{file.matches.length}</span>
                </button>
                <button className="btn small ghost" onClick={() => { void openFile(projectId, file.path); closeModal(); }}>{tr('Otwórz plik')}</button>
                <button className="btn small" disabled={working} onClick={() => void apply({ kind: 'file', path: file.path }, [file.path])}>{tr('Zamień w pliku')}</button>
              </header>
              {shown.map((match) => (
                <div key={`${match.line}:${match.column}`} className="fr-match">
                  <span className="fr-lineno">{match.line}</span>
                  <MatchLine match={match} options={options} replacement={replacement} />
                  <button className="btn small" disabled={working} onClick={() => void apply({ kind: 'match', path: file.path, line: match.line, column: match.column, text: match.text }, [file.path])}>{tr('Zamień')}</button>
                </div>
              ))}
            </section>
          );
        })}
        {budget <= 0 && total > visible && <button className="btn" onClick={() => setVisible(visible + PAGE)}>{tr('Pokaż więcej')}</button>}
      </div>
    </div>
  );
}

