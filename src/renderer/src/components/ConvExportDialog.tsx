// "Export the conversation to Markdown" (1.1.1): reads the conversation on the search thread, shows the start of the Markdown
// and saves it to a file, to the clipboard or as a note. Opened from a cell (menu, palette) or from the conversation search.
import { useEffect, useMemo, useState } from 'react';
import type { ConvExportData, ConvExportSource } from '../../../shared/convExport';
import { copyExport, renderExport, saveExportAsNote, saveExportToFile } from '../convExport';
import { useI18n } from '../i18n';
import { closeModal, setUi } from '../store';
import { IX } from './icons';
import './convExport.css';

/** The preview shows only the beginning: the whole text of a long conversation is for the file. */
const PREVIEW_CHARS = 24_000;
let lastTools = false;

export function ConvExportDialog({ source, back }: { source: ConvExportSource; back?: 'conversations' }) {
  const { tr } = useI18n();
  const [data, setData] = useState<ConvExportData | null>(null);
  const [tools, setTools] = useState(lastTools);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void window.mc.conversations.exportData(source).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [JSON.stringify(source)]); // eslint-disable-line react-hooks/exhaustive-deps

  const markdown = useMemo(() => (data?.ok ? renderExport(data, tools) : ''), [data, tools, tr]);
  const counts = useMemo(() => {
    let messages = 0, calls = 0;
    for (const item of data?.items ?? []) if (item.kind === 'tool') calls++; else messages++;
    return { messages, calls };
  }, [data]);

  const close = () => { if (back) setUi({ modal: { kind: 'conversations', restore: true } }); else closeModal(); };
  const toggleTools = (on: boolean) => { lastTools = on; setTools(on); };
  const run = async (action: 'file' | 'copy' | 'note') => {
    if (!data?.ok || busy) return;
    if (action === 'copy') { copyExport(markdown); return; }
    if (action === 'note') { saveExportAsNote(data, markdown); closeModal(); return; }
    setBusy(true);
    try { if (await saveExportToFile(data, markdown)) close(); } finally { setBusy(false); }
  };

  const failed = data && !data.ok;
  return (
    <div className="modal convx-dialog" role="dialog" aria-label={tr('Eksportuj rozmowę do Markdown')}>
      <div className="modal-head">
        <h3>{tr('Eksportuj rozmowę do Markdown')}</h3>
        <button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={close}><IX /></button>
      </div>
      <div className="modal-body convx-body">
        {!data && <div className="muted">{tr('Wczytywanie rozmowy…')}</div>}
        {failed && <div className="convx-error">{data.error === 'not-found' || data.error === 'unknown' ? tr('Nie znaleziono pliku tej rozmowy.') : tr('Nie udało się odczytać tej rozmowy.')}</div>}
        {data?.ok && (
          <>
            <div className="convx-summary">
              <span className="convx-title" title={data.title}>{data.title || tr('Rozmowa bez tytułu')}</span>
              <span className="muted">{tr('Wiadomości: {count}', { count: counts.messages })} · {tr('Wywołania narzędzi: {count}', { count: counts.calls })} · {tr('Znaki: {count}', { count: markdown.length.toLocaleString() })}</span>
            </div>
            <label className="check convx-tools">
              <input type="checkbox" checked={tools} onChange={(e) => toggleTools(e.target.checked)} />
              {tr('Dołącz wywołania narzędzi')}
              <span className="muted">{tr('(jedna linia na wywołanie, bez wyników narzędzi)')}</span>
            </label>
            {data.capped && <div className="convx-note muted">{tr('Rozmowa jest bardzo długa: wyeksportowano tylko jej początek.')}</div>}
            <pre className="convx-preview" aria-label={tr('Podgląd')}>{markdown.length > PREVIEW_CHARS ? `${markdown.slice(0, PREVIEW_CHARS)}\n…` : markdown}</pre>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={close}>{back ? tr('Wróć') : tr('Anuluj')}</button>
        <button className="btn" disabled={!data?.ok} onClick={() => void run('note')}>{tr('Zapisz jako notatkę')}</button>
        <button className="btn" disabled={!data?.ok} onClick={() => void run('copy')}>{tr('Kopiuj do schowka')}</button>
        <button className="btn primary" disabled={!data?.ok || busy} onClick={() => void run('file')}>{tr('Zapisz do pliku…')}</button>
      </div>
    </div>
  );
}
