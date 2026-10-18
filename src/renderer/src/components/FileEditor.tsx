import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditor } from './CodeEditor';
import { closeFile, editFile, fileErrorLabel, fileLabel, isFileDirty, loadDiskText, overwriteFileOnDisk, reloadFileFromDisk, retryFile, saveFile, setFileDataView, setFileMarkdownView, toggleFileWrap, useFileStore } from '../files';
import { detectDelimiter, isDelimitedPath, parseDelimited } from '../../../shared/csv';
import { DataTable, ImageView, LargeTextView } from './FileViews';
import { handleZoomKey, setFileZoom, stepFileZoom, useFileZoom } from '../fileZoom';
import { isMarkdownPath, MarkdownPreview } from './MarkdownPreview';
import { useI18n } from '../i18n';
import { getUi, useStore } from '../store';
import { matchesShortcut } from '../shortcuts';
import { fullProjectPath } from '../../../shared/platform';
import { FileActionIcon, FileBreadcrumb } from './FileIcon';
import { IX } from './icons';

const GitDiffView = lazy(() => import('./GitDiffView'));
const TextDiffView = lazy(() => import('./TextDiffView'));

const formatSize = (bytes: number, language: string): string =>
  bytes >= 1024 * 1024 ? `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB` : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;

export function FileEditor() {
  const { tr, language, errorText } = useI18n();
  const doc = useFileStore((s) => s.documents.find((d) => d.id === s.activeFileId));
  const zoom = useFileZoom();
  /** The tab whose disk vs editor diff is shown (a conflict's "Show diff"). */
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  // Ctrl + wheel zooms (a plain wheel scrolls); the listener is native because React's wheel events are passive.
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); stepFileZoom(e.deltaY < 0 ? 1 : -1); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [doc?.id]);
  const project = useStore((s) => s.s.projects.find((p) => p.id === doc?.projectId));
  useEffect(() => {
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (getUi().dialog || getUi().modal || getUi().palette) return;
      if (matchesShortcut('editor.save', event)) {
        event.preventDefault(); event.stopPropagation(); void saveFile(doc.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [doc?.id]);
  const delimited = !!doc && !doc.diff && isDelimitedPath(doc.relativePath) && (doc.status === 'ready' || doc.status === 'truncated');
  const table = useMemo(() => {
    if (!delimited || !doc) return null;
    const extension = doc.relativePath.slice(doc.relativePath.lastIndexOf('.') + 1).toLowerCase();
    return parseDelimited(doc.text, detectDelimiter(doc.text, extension));
  }, [delimited, doc?.text, doc?.relativePath]);
  if (!doc) return null;
  const dirty = isFileDirty(doc);
  const showDiff = diffFor === doc.id && !!doc.diskConflict && doc.externalText !== undefined;
  const markdown = isMarkdownPath(doc.relativePath);
  const preview = markdown && doc.markdownView !== 'source';
  const tableView = delimited && doc.dataView !== 'source' && !!table;
  const tableLabels = {
    en: ['Table', 'Source'], pl: ['Tabela', 'Źródło'], de: ['Tabelle', 'Quelltext'],
    es: ['Tabla', 'Código'], fr: ['Tableau', 'Source'], pt: ['Tabela', 'Fonte'],
  }[language];
  const viewLabels = {
    en: ['Preview', 'Edit source'], pl: ['Podgląd', 'Edytuj źródło'], de: ['Vorschau', 'Quelltext bearbeiten'],
    es: ['Vista previa', 'Editar código'], fr: ['Aperçu', 'Modifier la source'], pt: ['Pré-visualização', 'Editar fonte'],
  }[language];
  const path = project ? fullProjectPath(project.path, doc.relativePath, window.mc.platform) : doc.relativePath;
  if (doc.diff) {
    return (
      <section ref={section} className="file-editor file-workspace-editor" aria-label={doc.relativePath} style={{ ['--file-zoom' as string]: zoom }} onKeyDownCapture={(e) => { handleZoomKey(e); }}>
        <div className="file-editor-toolbar">
          <FileBreadcrumb projectName={project?.name} relativePath={doc.relativePath} fullPath={path} />
          <div className="file-editor-actions">
            <button className="btn ghost icon" title={tr('Zamknij podgląd pliku')} aria-label={tr('Zamknij podgląd pliku')} onClick={() => void closeFile(doc.id)}><IX /></button>
          </div>
        </div>
        <Suspense fallback={<div className="file-preview-message muted">{tr('Wczytywanie…')}</div>}>
          <GitDiffView key={doc.id} projectId={doc.projectId} {...doc.diff} />
        </Suspense>
      </section>
    );
  }
  const largeNotice = doc.status === 'truncated'
    ? fileLabel('largeNotice', language).replace('{shown}', formatSize(doc.text.length, language)).replace('{total}', formatSize(doc.size ?? doc.text.length, language))
    : '';
  return (
    <section ref={section} className="file-editor file-workspace-editor" aria-label={doc.relativePath} style={{ ['--file-zoom' as string]: zoom }} onKeyDownCapture={(e) => { handleZoomKey(e); }}>
      <div className="file-editor-toolbar">
        <FileBreadcrumb projectName={project?.name} relativePath={doc.relativePath} fullPath={path} />
        <span role="status" className={`editor-save-status ${dirty ? 'dirty' : ''}`}>{doc.saving ? fileLabel('saving', language) : dirty ? `● ${fileLabel('dirty', language)}` : doc.status === 'ready' ? fileLabel('saved', language) : ''}</span>
        <div className="file-editor-actions">
          {markdown && <div className="markdown-view-toggle" role="group" aria-label="Markdown">
            <button className={`btn ghost small ${preview ? 'active' : ''}`} aria-pressed={preview} onClick={() => setFileMarkdownView(doc.id, 'preview')}>{viewLabels[0]}</button>
            <button className={`btn ghost small ${!preview ? 'active' : ''}`} aria-pressed={!preview} onClick={() => setFileMarkdownView(doc.id, 'source')}>{viewLabels[1]}</button>
          </div>}
          {zoom !== 1 && <button className="btn ghost small" title={tr('Przywróć rozmiar 100%')} aria-label={tr('Przywróć rozmiar 100%')} onClick={() => setFileZoom(1)}>{Math.round(zoom * 100)}%</button>}
          {delimited && <div className="markdown-view-toggle" role="group" aria-label={tableLabels[0]}>
            <button className={`btn ghost small ${tableView ? 'active' : ''}`} aria-pressed={tableView} onClick={() => setFileDataView(doc.id, 'table')}>{tableLabels[0]}</button>
            <button className={`btn ghost small ${!tableView ? 'active' : ''}`} aria-pressed={!tableView} onClick={() => setFileDataView(doc.id, 'source')}>{tableLabels[1]}</button>
          </div>}
          {!preview && !tableView && doc.status === 'ready' && <button className={`btn ghost icon ${doc.wrap ? 'active' : ''}`} title={tr('Zawijaj wiersze')} aria-label={tr('Zawijaj wiersze')} aria-pressed={doc.wrap} onClick={() => toggleFileWrap(doc.id)}><FileActionIcon kind="wrap" /></button>}
          <button className={`btn ghost icon ${dirty ? 'save-dirty' : ''}`} title={tr('Zapisz')} aria-label={tr('Zapisz')} disabled={!dirty || doc.saving || doc.status !== 'ready'} onClick={() => void saveFile(doc.id)}><FileActionIcon kind="save" /></button>
          <button className="btn ghost icon" title={tr('Zamknij podgląd pliku')} aria-label={tr('Zamknij podgląd pliku')} onClick={() => void closeFile(doc.id)}><IX /></button>
        </div>
      </div>
      {doc.error && <div className="preview-notice error" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{errorText(fileErrorLabel(doc.error, language))}</div>}
      {doc.diskConflict && <div className={`preview-notice file-disk-conflict ${doc.diskConflict === 'save' ? 'error' : ''}`} role="alert">
        <span>{doc.diskConflict === 'save' ? tr('Nie zapisano: plik zmienił się na dysku w trakcie edycji.') : tr('Plik zmienił się na dysku. Masz tu niezapisane zmiany.')}</span>
        <span className="file-disk-conflict-actions">
          <button className="btn small" disabled={doc.saving} onClick={() => { setDiffFor(null); void reloadFileFromDisk(doc.id); }}>{tr('Wczytaj z dysku (odrzuć moje zmiany)')}</button>
          <button className={`btn small ${showDiff ? 'active' : ''}`} aria-pressed={showDiff} onClick={() => { if (showDiff) setDiffFor(null); else void loadDiskText(doc.id).then(() => setDiffFor(doc.id)); }}>{showDiff ? tr('Ukryj różnice') : tr('Pokaż różnice')}</button>
          <button className="btn small danger" disabled={doc.saving} onClick={() => { setDiffFor(null); void overwriteFileOnDisk(doc.id); }}>{tr('Nadpisz (zachowaj moje)')}</button>
        </span>
      </div>}
      {doc.status === 'loading' && <div className="file-preview-message muted">{tr('Wczytywanie pliku…')}</div>}
      {tableView && table && <DataTable columns={table.rows[0] ?? []} rows={table.rows.slice(1)} {...(table.truncated ? { note: fileLabel('largeNotice', language).replace('{shown}', `${table.rows.length}`).replace('{total}', formatSize(doc.size ?? doc.text.length, language)) } : {})} />}
      {showDiff && <Suspense fallback={<div className="file-preview-message muted">{tr('Wczytywanie…')}</div>}>
        <TextDiffView disk={doc.externalText ?? ''} editor={doc.text} path={doc.relativePath} />
      </Suspense>}
      {!tableView && !showDiff && doc.status === 'ready' && (preview
        ? <MarkdownPreview key={doc.id} text={doc.text} projectId={doc.projectId} path={doc.relativePath} />
        : <CodeEditor key={doc.id} path={doc.relativePath} text={doc.text} wrap={doc.wrap} onChange={text => editFile(doc.id, text)} />)}
      {doc.status === 'image' && doc.view?.kind === 'image' && <ImageView src={doc.view.dataUrl} name={doc.name} size={doc.size} />}
      {doc.status === 'table' && doc.view?.kind === 'table' && <DataTable columns={doc.view.columns} types={doc.view.types} rows={doc.view.rows} note={`${doc.view.format.toUpperCase()} · ${doc.view.totalRows.toLocaleString(language)} ${{ en: 'rows', pl: 'wierszy', de: 'Zeilen', es: 'filas', fr: 'lignes', pt: 'linhas' }[language]} · ${doc.view.columns.length} ${{ en: 'columns', pl: 'kolumn', de: 'Spalten', es: 'columnas', fr: 'colonnes', pt: 'colunas' }[language]}${doc.view.rows.length < doc.view.totalRows ? ` · ${{ en: 'showing the first', pl: 'pokazano pierwsze', de: 'angezeigt: die ersten', es: 'mostrando las primeras', fr: 'affichage des premières', pt: 'a mostrar as primeiras' }[language]} ${doc.view.rows.length.toLocaleString(language)}` : ''}`} />}
      {doc.status === 'binary' && <div className="file-preview-message muted">{tr('Ten plik jest binarny lub ma nieobsługiwane kodowanie. Otwórz go w edytorze albo menedżerze plików.')}</div>}
      {doc.status === 'truncated' && !tableView && <LargeTextView key={doc.id} text={doc.text} notice={largeNotice} />}
      {doc.status !== 'loading' && doc.status !== 'ready' && doc.status !== 'image' && doc.status !== 'table' && <div style={{ padding: 16, display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => void retryFile(doc.id)}>{tr('Spróbuj ponownie')}</button>
        {project && <button className="btn" onClick={() => window.mc.openInEditor(path)}>{tr('Otwórz w edytorze')}</button>}
      </div>}
    </section>
  );
}
