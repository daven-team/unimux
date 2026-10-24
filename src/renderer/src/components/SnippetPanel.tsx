import { shortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { memo, useMemo, useState } from 'react';
import { fuzzyScore } from '../../../shared/fuzzy';
import { normalizeCodeLanguage } from '../../../shared/codeLanguages';
import { snippetVarMatches } from '../../../shared/snippetVars';
import { useCodeHighlight } from '../useCodeHighlight';
import type { Snippet } from '../../../shared/types';
import { sendSnippet } from '../actions';
import { moveSnippet, removeSnippet, uid, upsertSnippet, type DropEdge } from '../../../shared/state';
import { PANEL_LIMITS } from '../../../shared/panels';
import { askChoice, setUi, update, useStore } from '../store';
import { SNIPPET_MIME } from './CellView';
import { IEdit, IPlus } from './icons';
import { dropEdge, scrollDragList } from './listDrag';
import { openMenu } from './ContextMenu';
import { EmptyLink, fillTokens, PanelEmpty } from './PanelEmpty';
import type { PanelResizeProps } from './PanelResizeHandle';

export function SnippetPanel({ resize }: { resize: PanelResizeProps }) {
  const { tr } = useI18n();
  const snippets = useStore((st) => st.s.snippets);
  const projectId = useStore((st) => st.s.activeProjectId);
  const [q, setQ] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string | null; edge: DropEdge } | null>(null);
  // The library minus other projects' snippets; searching filters it while preserving the user's chosen order.
  const available = snippets.filter((sn) => !sn.projectId || sn.projectId === projectId);
  const visible = available.filter((sn) => fuzzyScore(q, `${sn.name} ${sn.text}`) !== null).slice(0, 500);
  const endDrag = () => { setDragId(null); setOver(null); };

  const use = (sn: Snippet, all: boolean) => sendSnippet(sn, all ? 'all' : 'focused');
  const create = (projectId?: string) => setUi({ modal: { kind: 'snippet', snippetId: null, projectId } });
  const backgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, .snippet')) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { header: tr("Snippety") },
      { label: tr("Nowy snippet") + '…', onClick: () => create() },
      ...(projectId ? [{ label: tr("Nowy snippet tylko w tym projekcie…"), onClick: () => create(projectId) }] : []),
      { sep: true },
      { label: tr("Przywróć szerokość panelu"), onClick: () => resize.onFinish(PANEL_LIMITS.snippets.default) },
      { label: tr("Ukryj panel snippetów"), hint: shortcutText('snippets.toggle') || undefined, onClick: () => update((st) => ({ ...st, snippetsOpen: false })) },
    ]);
  };
  const snippetMenu = (e: React.MouseEvent, sn: Snippet) => {
    e.preventDefault();
    e.stopPropagation();
    const index = visible.findIndex((item) => item.id === sn.id);
    openMenu(e.clientX, e.clientY, [
      { header: sn.name },
      { label: tr("Wklej do aktywnej komórki"), onClick: () => use(sn, false) },
      { label: tr("Wklej do wszystkich komórek"), onClick: () => use(sn, true) },
      { sep: true },
      { label: tr("Edytuj snippet") + '…', onClick: () => setUi({ modal: { kind: 'snippet', snippetId: sn.id } }) },
      { label: tr("Duplikuj snippet"), onClick: () => update((st) => upsertSnippet(st, { ...sn, id: uid(), name: tr('{name} (kopia)', { name: sn.name }) })) },
      { label: tr("Kopiuj treść"), onClick: () => window.mc.clipboardWrite(sn.text) },
      ...(index > 0 ? [{ label: tr("Przesuń wyżej"), onClick: () => update((st) => moveSnippet(st, sn.id, visible[index - 1].id, 'before')) }] : []),
      ...(index < visible.length - 1 ? [{ label: tr("Przesuń niżej"), onClick: () => update((st) => moveSnippet(st, sn.id, visible[index + 1].id, 'after')) }] : []),
      { sep: true },
      { label: tr("Usuń snippet"), danger: true, onClick: async () => {
        const choice = await askChoice(tr('Usunąć snippet „{name}”?', { name: sn.name }), tr("Zapisany prompt zostanie usunięty z biblioteki."), [{ label: tr("Usuń"), value: 'yes', danger: true }]);
        if (choice === 'yes') update((st) => removeSnippet(st, sn.id));
      } },
    ]);
  };

  return (
    <aside className="rpanel" aria-label={tr("Panel snippetów")} onContextMenu={backgroundMenu}>
      <div className="side-title">
        {/* 1.0.7: the title alone, like the other panels; each snippet's tooltip says what a click, Shift+click and a drag do. */}
        <span>{tr("Snippety")}</span>
        <button className="sq" title={tr("Nowy snippet")} aria-label={tr("Nowy snippet")} onClick={() => create()}><IPlus /></button>
      </div>
      {/* Nothing to show or search here (an empty library, or only other projects' snippets): the empty state. */}
      {!available.length ? (
        <PanelEmpty>
          <p>{snippets.length ? tr("Brak snippetów dostępnych w tym projekcie.") : tr("Zapisz prompty, których często używasz, i wklejaj je do terminali jednym kliknięciem.")}</p>
          <button className="btn primary" onClick={() => create()}>{tr("Nowy snippet")}</button>
          {projectId && <p>{fillTokens(tr("Możesz też {link}."), {
            link: <EmptyLink onClick={() => create(projectId)}>{tr("dodać snippet tylko dla tego projektu")}</EmptyLink>,
          })}</p>}
        </PanelEmpty>
      ) : (
      <>
      <input className="search" aria-label={tr("Szukaj snippetów")} placeholder={tr("Szukaj snippetów") + '…'} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="snippets"
        onDragOver={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(SNIPPET_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          scrollDragList(e.currentTarget, e.clientY);
          if (!(e.target as HTMLElement).closest('.snippet')) setOver({ id: null, edge: 'after' });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
        onDrop={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(SNIPPET_MIME)) return;
          e.preventDefault();
          update((st) => moveSnippet(st, dragId, visible.at(-1)?.id ?? null, 'after'));
          endDrag();
        }}
      >
        {visible.map((sn) => (
          <div
            key={sn.id}
            className={`snippet ${dragId === sn.id ? 'dragging' : ''} ${over?.id === sn.id && dragId !== sn.id ? `drop-${over.edge}` : ''}`}
            data-snippet-id={sn.id}
            style={sn.color ? ({ '--sc': sn.color } as React.CSSProperties) : undefined}
            data-colored={sn.color ? '' : undefined}
            role="button"
            tabIndex={0}
            aria-label={sn.name}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SNIPPET_MIME, JSON.stringify(sn));
              e.dataTransfer.effectAllowed = 'copyMove';
              setDragId(sn.id);
            }}
            onDragEnd={endDrag}
            onDragOver={(e) => {
              if (!dragId || !e.dataTransfer.types.includes(SNIPPET_MIME)) return;
              e.preventDefault();
              setOver({ id: sn.id, edge: dropEdge(e.currentTarget, e.clientY) });
            }}
            onDrop={(e) => {
              if (!dragId || !e.dataTransfer.types.includes(SNIPPET_MIME)) return;
              e.preventDefault();
              e.stopPropagation();
              update((st) => moveSnippet(st, dragId, sn.id, dropEdge(e.currentTarget, e.clientY)));
              endDrag();
            }}
            onClick={(e) => use(sn, e.shiftKey)}
            onContextMenu={(e) => snippetMenu(e, sn)}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                use(sn, e.shiftKey);
              }
            }}
            title={tr("Klik: wklej do aktywnej komórki · Shift+klik: do wszystkich · przeciągnij na komórkę")}
          >
            <div className="s-head">
              {sn.icon && <span className="s-icon">{sn.icon}</span>}
              <span className="s-name">{sn.name}</span>
              {sn.projectId && <span className="tag">{tr("Projekt")}</span>}
              <span style={{ flex: 1 }} />
              <button
                className="btn ghost icon small s-edit"
                title={tr("Edytuj snippet")}
                aria-label={tr('Edytuj snippet {name}', { name: sn.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  setUi({ modal: { kind: 'snippet', snippetId: sn.id } });
                }}
              >
                <IEdit />
              </button>
            </div>
            <SnippetCode text={sn.text} language={sn.language} />
          </div>
        ))}
        {visible.length > 0 && <div className={`snippet-drop-space ${over?.id === null ? 'drop-end' : ''}`} aria-hidden="true" />}
        {!visible.length && <div className="muted snippet-empty">{tr('Nic nie pasuje do „{query}”.', { query: q })}</div>}
      </div>
      </>
      )}
    </aside>
  );
}

/** Lines of a card's preview, and the characters kept of each (the card clips them anyway). */
const PREVIEW_LINES = 3;
const PREVIEW_LINE_CHARS = 200;

/** The first lines of a snippet on its card, highlighted in its language (shell by default) once the languages loaded, variables marked. */
const SnippetCode = memo(function SnippetCode({ text, language }: { text: string; language?: string }) {
  const highlighter = useCodeHighlight();
  const preview = useMemo(() => text.replace(/^\s*\n/, '').split(/\r?\n/, PREVIEW_LINES).map((line) => line.slice(0, PREVIEW_LINE_CHARS)).join('\n'), [text]);
  const html = useMemo(() => {
    if (!highlighter) return null;
    const marks = snippetVarMatches(preview).map((m) => ({ from: m.from, to: m.to, cls: 'snip-var' }));
    return highlighter.highlightHtml(preview, normalizeCodeLanguage(language) ?? 'shell', marks);
  }, [highlighter, preview, language]);
  return html === null
    ? <div className="s-text s-code">{preview}</div>
    : <div className="s-text s-code code-hl" dangerouslySetInnerHTML={{ __html: html }} />;
});
