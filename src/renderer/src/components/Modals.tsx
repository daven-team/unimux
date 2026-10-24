import { matchesShortcut, shortcutText } from '../shortcuts';
import { tr, useI18n } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeLayout } from '../../../shared/layout';
import {
  deleteArchived, getProfile, PROJECT_COLORS, removeSnippet, uid, updateProject, upsertSnippet,
} from '../../../shared/state';
import { fuzzyFilter } from '../../../shared/fuzzy';
import type { ProjectIcon, SessionInfo, Snippet } from '../../../shared/types';
import { restoreArchived, resumeSession } from '../actions';
import { closeDialog, closeModal, setUi, update, useStore, type Dialog } from '../store';
import { AuthModal } from './AuthModal';
import { closeInstall, InstallModal } from './InstallModal';
import { ChangelogModal } from './Changelog';
import { FindReplaceModal } from './FindReplace';
import { GridDialog } from './GridDialog';
import { BroadcastDialog } from './ssh/BroadcastDialog';
import { DbConnectionEditor } from './db/DbConnectionEditor';
import { IEdit, IGrip, IX } from './icons';
import { ProjectIconView } from './ProjectIcon';
import { FilePreview } from './FilePreview';
import { formatAgo } from '../../../shared/i18n';
import { CODE_LANGUAGES, codeLanguageLabel, normalizeCodeLanguage } from '../../../shared/codeLanguages';
import { fillSnippetVars, SNIPPET_BUILTINS } from '../../../shared/snippetVars';
import { LazyTextCodeEditor } from './LazyTextCodeEditor';
import { fillTokens } from './PanelEmpty';
import { Select } from './Select';

export function Modals() {
  const modal = useStore((st) => st.ui.modal);
  const dialog = useStore((st) => st.ui.dialog);
  const install = useStore((st) => st.ui.install);

  useEffect(() => {
    if (!modal && !dialog && !install) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (dialog) closeDialog();
      // A running install is never dismissed by accident (its X asks to cancel).
      else if (install) { if (!install.locked) closeInstall(); }
      else closeModal();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modal, dialog, install]);

  return (
    <>
      {modal && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
          {modal.kind === 'grid' && <GridDialog projectId={modal.projectId} />}
          {modal.kind === 'history' && <HistoryModal projectId={modal.projectId} />}
          {modal.kind === 'changelog' && <ChangelogModal />}
          {modal.kind === 'search' && <FindReplaceModal key={modal.projectId} projectId={modal.projectId} />}
          {modal.kind === 'snippet' && <SnippetEditor key={modal.snippetId ?? modal.projectId ?? 'new'} snippetId={modal.snippetId} projectId={modal.projectId} />}
          {modal.kind === 'project' && <ProjectEditor key={modal.projectId} projectId={modal.projectId} />}
          {modal.kind === 'file' && <FilePreview projectId={modal.projectId} relativePath={modal.relativePath} />}
          {modal.kind === 'broadcast' && <BroadcastDialog key={modal.tabId} projectId={modal.projectId} tabId={modal.tabId} />}
          {modal.kind === 'dbConnection' && <DbConnectionEditor key={modal.connectionId ?? 'new'} connectionId={modal.connectionId} kind={modal.dbKind} />}
          {modal.kind === 'auth' && <AuthModal key={`${modal.provider}:${JSON.stringify(modal.target)}`} provider={modal.provider} target={modal.target} />}
        </div>
      )}
      {install && (
        <div className="overlay" style={{ zIndex: 54 }} onMouseDown={(e) => e.target === e.currentTarget && !install.locked && closeInstall()}>
          <InstallModal key={install.cli} cli={install.cli} />
        </div>
      )}
      {dialog && (
        <div className="overlay" style={{ zIndex: 55 }} onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
          <DialogView key={dialog.id} dialog={dialog} />
        </div>
      )}
    </>
  );
}

function DialogView({ dialog }: { dialog: Dialog }) {
  const { tr } = useI18n();
  const [value, setValue] = useState(dialog.kind === 'prompt' ? dialog.value : '');
  const [checked, setChecked] = useState(false);
  if (dialog.kind === 'snippetVars') return <SnippetVarsDialog dialog={dialog} />;
  if (dialog.kind === 'prompt') {
    return (
      <div className="modal" style={{ width: 440 }}>
        <div className="modal-head"><h3>{dialog.title}</h3></div>
        <div className="modal-body">
          <input
            className="input"
            autoFocus
            value={value}
            placeholder={dialog.placeholder}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && dialog.onSubmit(value)}
          />
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={closeDialog}>{tr("Anuluj")}</button>
          <button className="btn primary" onClick={() => dialog.onSubmit(value)}>OK</button>
        </div>
      </div>
    );
  }
  return (
    <div className="modal" style={{ width: 460 }}>
      <div className="modal-head"><h3>{dialog.title}</h3></div>
      <div className="modal-body">
        <div className="muted" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{dialog.body}</div>
        {dialog.check && (
          <label className="dialog-check" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {dialog.check}
          </label>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeDialog}>{tr("Anuluj")}</button>
        {dialog.actions.map((a) => (
          <button key={a.value} autoFocus={a.primary} className={`btn ${a.danger ? 'danger' : ''} ${a.primary ? 'primary' : ''}`} onClick={() => dialog.onChoose(a.value, checked)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The values of a snippet's variables before it is sent (snippetSend.ts): one field per variable and the text it gives. */
function SnippetVarsDialog({ dialog }: { dialog: Extract<Dialog, { kind: 'snippetVars' }> }) {
  const { tr } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(dialog.fields.map((f) => [f.name, f.value])));
  // The built-ins are filled in per cell when sending; the preview keeps them as they are written.
  const shown = fillSnippetVars(dialog.text, { ...Object.fromEntries(dialog.builtins.map((name) => [name, `{{${name}}}`])), ...values });
  const submit = () => dialog.onSubmit(values);
  return (
    <div className="modal snippet-vars" style={{ width: 480 }}>
      <div className="modal-head"><h3>{dialog.title}</h3></div>
      <div className="modal-body">
        {dialog.fields.map((field, i) => (
          <div className="field" key={field.name}>
            <label htmlFor={`snippet-var-${i}`}><code>{field.name}</code></label>
            <input id={`snippet-var-${i}`} className="input" autoFocus={i === 0} value={values[field.name] ?? ''} data-var={field.name}
              placeholder={field.fallback ? tr('Domyślnie: {value}', { value: field.fallback }) : undefined}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
          </div>
        ))}
        {dialog.builtins.length > 0 && (
          <div className="muted snippet-vars-builtins">
            {fillTokens(tr("Uzupełniane dla każdej komórki: {names}"), { names: <code>{dialog.builtins.map((name) => `{{${name}}}`).join(' ')}</code> })}
          </div>
        )}
        <div className="field">
          <label>{tr("Do wysłania")}</label>
          <pre className="snippet-vars-preview">{shown}</pre>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeDialog}>{tr("Anuluj")}</button>
        <button className="btn primary" onClick={submit}>{tr("Wstaw")}</button>
      </div>
    </div>
  );
}

// ── history ─────────────────────────────────────────────────────────────────

function HistoryModal({ projectId }: { projectId: string }) {
  const { tr, language } = useI18n();
  const s = useStore((st) => st.s);
  const focused = useStore((st) => st.ui.focusedCellId);
  const project = s.projects.find((p) => p.id === projectId);
  const [view, setView] = useState<'archive' | 'sessions'>('sessions');
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (project) void window.mc.listSessions(project.path).then(setSessions);
  }, [project?.path]);

  const openIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) if (c.session) ids.add(c.session.id);
    return ids;
  }, [s.projects]);

  if (!project) return null;
  const isActive = s.activeProjectId === projectId;
  const list = fuzzyFilter(sessions ?? [], q, (x) => x.title, 300);
  const archive = fuzzyFilter(project.archive, q, (t) => t.name, 300);

  return (
    <div className="modal wide">
      <div className="modal-head">
        <h3>{tr('Historia')} · {project.name}</h3>
        {/* 1.0.7: a segmented switch (two views of one list), not two buttons of which one looks like the main action. */}
        <div className="tabs-switch" role="tablist" aria-label={tr('Historia')}>
          <button type="button" role="tab" aria-selected={view === 'sessions'} className={view === 'sessions' ? 'on' : ''} onClick={() => setView('sessions')}>{tr("Czaty Claude / Codex")} {sessions ? `(${sessions.length})` : ''}</button>
          <button type="button" role="tab" aria-selected={view === 'archive'} className={view === 'archive' ? 'on' : ''} onClick={() => setView('archive')}>{tr('Zamknięte gridy ({count})', { count: project.archive.length })}</button>
        </div>
        <button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <input className="input" autoFocus placeholder={tr("Szukaj…")} value={q} onChange={(e) => setQ(e.target.value)} />
        {view === 'archive' && (
          <div className="hist-list">
            {archive.map((t) => (
              <div key={t.id} className="hist-item">
                <span className="htitle">{t.name} <span className="muted">· {describeLayout(t.layout)}</span></span>
                <span className="row" style={{ gap: 4 }}>
                  {t.cells.slice(0, 6).map((c) => {
                    const cli = getProfile(s, c.profileId).cli;
                    return <span key={c.id} className={`cli ${cli}`}>{cli}</span>;
                  })}
                  {t.cells.length > 6 && <span className="muted">+{t.cells.length - 6}</span>}
                </span>
                <span className="hmeta">{formatAgo(language, t.closedAt)}</span>
                <button className="btn small primary" onClick={() => { closeModal(); restoreArchived(projectId, t.id); }}>{tr("Przywróć")}</button>
                <button className="btn small ghost icon" title={tr("Usuń z historii")} onClick={() => update((st) => deleteArchived(st, projectId, t.id))}><IX /></button>
              </div>
            ))}
            {!project.archive.length && <div className="muted">{tr("Zamknięte zakładki pojawią się tutaj razem z rozmowami, które w nich były.")}</div>}
          </div>
        )}
        {view === 'sessions' && (
          <div className="hist-list">
            {!sessions && <div className="muted">{tr("Wczytywanie…")}</div>}
            {list.map((x) => (
              <div key={x.cli + x.id} className="hist-item">
                <span className={`cli ${x.cli}`}>{x.cli}</span>
                <span className="htitle" title={x.title}>{x.title}</span>
                {x.worktree && <span className={`tag hist-worktree ${x.worktree.exists ? '' : 'gone'}`} title={x.worktree.path}>
                  {x.worktree.exists ? tr('worktree {name}', { name: x.worktree.label }) : tr('worktree {name} (usunięty)', { name: x.worktree.label })}
                </span>}
                {openIds.has(x.id) && <span className="tag">{tr("otwarta")}</span>}
                <span className="hmeta">{formatAgo(language, x.updatedAt)}</span>
                {isActive && (
                  <>
                    {focused && <button className="btn small" onClick={() => { closeModal(); resumeSession(x, 'cell'); }}>{tr("W aktywnej")}</button>}
                    <button className="btn small" onClick={() => { closeModal(); resumeSession(x, 'newCell'); }}>{tr("Nowa komórka")}</button>
                  </>
                )}
                <button className="btn small primary" onClick={() => { closeModal(); resumeSession(x, 'newTab'); }} disabled={!isActive}>{tr("Nowa zakładka")}</button>
              </div>
            ))}
            {sessions && !sessions.length && <div className="muted">{tr("Brak zapisanych rozmów Claude/Codex dla tego folderu.")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const SNIPPET_EMOJIS = ['🔍', '🧪', '🐛', '✨', '📝', '🚀', '♻️', '🔒', '📦', '🎨', '⚡', '🧹', '💬', '📊', '🛠️', '✅', '🔥', '🧠', '📋'];

// ── snippet editor ──────────────────────────────────────────────────────────

function SnippetEditor({ snippetId, projectId }: { snippetId: string | null; projectId?: string }) {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const existing = s.snippets.find((x) => x.id === snippetId);
  const [draft, setDraft] = useState<Snippet>(existing ?? { id: uid(), name: '', text: '', autoSend: false, projectId });
  const project = s.projects.find((p) => p.id === s.activeProjectId);
  const language = normalizeCodeLanguage(draft.language) ?? 'shell';
  const save = () => {
    if (!draft.text.trim()) return;
    // Shell is the default and is not stored.
    const { language: _language, ...rest } = draft;
    const saved: Snippet = language === 'shell' ? rest : { ...rest, language };
    update((st) => upsertSnippet(st, { ...saved, name: draft.name.trim() || draft.text.trim().split('\n')[0].slice(0, 40) }));
    closeModal();
  };
  return (
    <div className="modal">
      <div className="modal-head">
        <h3>{existing ? tr("Edytuj snippet") : tr("Nowy snippet")}</h3>
        <button className="btn ghost icon" onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <div className="field">
          <label>{tr("Nazwa")}</label>
          <input className="input" autoFocus value={draft.name} placeholder={tr("np. Review zmian")} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="field">
          <div className="snippet-text-head">
            <label id="snippet-text-label">{tr("Treść promptu")}</label>
            <span style={{ flex: 1 }} />
            <Select className="select snippet-language" value={language} aria-label={tr("Język snippetu")} title={tr("Język snippetu")}
              onChange={(e) => setDraft({ ...draft, language: e.target.value })}>
              {CODE_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.id === 'text' ? tr("Zwykły tekst") : codeLanguageLabel(l.id)}</option>)}
            </Select>
          </div>
          <LazyTextCodeEditor className="snippet-code" value={draft.text} language={language} markVariables ariaLabel={tr("Treść promptu")}
            onChange={(text) => setDraft((d) => ({ ...d, text }))} onKeyDown={(e) => { if (matchesShortcut('modal.save', e)) { e.preventDefault(); e.stopPropagation(); save(); } }} />
          <div className="snippet-vars-hint muted">
            {fillTokens(tr("Zmienne: {example} pyta o wartość przy wysyłaniu, {builtins} wstawia aplikacja."), {
              example: <code>{`{{${tr("nazwa")}:${tr("domyślna")}}}`}</code>,
              builtins: <code>{SNIPPET_BUILTINS.map((name) => `{{${name}}}`).join(' ')}</code>,
            })}
          </div>
        </div>
        <div className="field">
          <label>{tr("Kolor")}</label>
          <div className="color-row">
            <button className={!draft.color ? 'on' : ''} style={{ background: '#2a2a2a' }} title={tr("Bez koloru")} onClick={() => setDraft({ ...draft, color: undefined })} />
            {PROJECT_COLORS.map((c) => (
              <button key={c} className={draft.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setDraft({ ...draft, color: c })} />
            ))}
          </div>
        </div>
        <div className="field">
          <label>{tr("Ikona")}</label>
          <div className="emoji-grid">
            <button className={!draft.icon ? 'on' : ''} title={tr("Bez ikony")} onClick={() => setDraft({ ...draft, icon: undefined })}><IX /></button>
            {SNIPPET_EMOJIS.map((e) => (
              <button key={e} className={draft.icon === e ? 'on' : ''} onClick={() => setDraft({ ...draft, icon: e })}>{e}</button>
            ))}
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={draft.autoSend} onChange={(e) => setDraft({ ...draft, autoSend: e.target.checked })} />  {tr("Od razu wyślij (Enter po wklejeniu)")}</label>
        {project && (
          <label className="check">
            <input type="checkbox" checked={!!draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.checked ? project.id : undefined })} />
            {tr('Tylko w projekcie „{name}”', { name: project.name })}
          </label>
        )}
      </div>
      <div className="modal-foot">
        {existing && <button className="btn danger" onClick={() => { update((st) => removeSnippet(st, existing.id)); closeModal(); }}>{tr("Usuń")}</button>}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>{tr("Anuluj")}</button>
        <button className="btn primary" onClick={save}>{tr("Zapisz")} {shortcutText('modal.save') && <span className="kbd">{shortcutText('modal.save')}</span>}</button>
      </div>
    </div>
  );
}

// ── project editor ──────────────────────────────────────────────────────────

const EMOJIS = ['📁', '🚀', '🤖', '⚡', '🔥', '🎯', '💎', '🧠', '🛠️', '🌐', '📦', '🎮', '🧪', '📊', '💬', '🔒', '🎨', '🦄', '🐙', '☕'];

/** Downscales an image file to a 96×96 PNG data URL (keeps state.json small). */
function readIcon(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const size = 96;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx || !img.width || !img.height) throw new Error(tr("Nie udało się odczytać obrazka"));
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL('image/png'));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(tr("Nie udało się wczytać obrazka. Wybierz plik PNG, JPG, GIF, WebP lub SVG."))); };
    img.src = url;
  });
}

function ProjectEditor({ projectId }: { projectId: string }) {
  const { tr } = useI18n();
  const project = useStore((st) => st.s.projects.find((p) => p.id === projectId));
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [icon, setIcon] = useState<ProjectIcon | undefined>(project?.icon);
  const [path, setPath] = useState(project?.path ?? '');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  if (!project) return null;
  const save = () => {
    if (!name.trim() || uploading) return;
    update((st) => updateProject(st, projectId, { name: name.trim(), color, icon, path }));
    if (path !== project.path) setUi((ui) => {
      const missingPaths = { ...ui.missingPaths };
      delete missingPaths[projectId];
      return { missingPaths };
    });
    closeModal();
  };
  const preview = { name, color, icon };
  return (
    <div className="modal" onKeyDown={(e) => { if (matchesShortcut('modal.save', e)) { e.preventDefault(); save(); } }}>
      <div className="modal-head">
        <h3>{tr("Edytuj projekt")}</h3>
        <button className="btn ghost icon" aria-label={tr("Zamknij edytor projektu")} onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <input ref={fileInput} className="hidden-file-input" type="file" accept="image/*" disabled={uploading} aria-label={tr("Wgraj własną ikonę")} onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!file) return;
          setUploading(true);
          setError('');
          try {
            setIcon({ kind: 'image', dataUrl: await readIcon(file) });
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : tr("Nie udało się wczytać ikony."));
          } finally {
            setUploading(false);
          }
        }} />
        <div className="project-editor-heading">
          <button className="project-avatar-picker" title={tr("Kliknij, aby wybrać własną ikonę")} aria-label={tr("Wybierz własną ikonę projektu")} disabled={uploading} onClick={() => fileInput.current?.click()}>
            <ProjectIconView project={preview} size="xl" />
            <span className="avatar-edit"><IEdit /></span>
          </button>
          <div className="field project-name-field">
            <label htmlFor="project-name">{tr("Nazwa")}</label>
            <input id="project-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
            <span className="project-editor-path muted" title={path}>{path}</span>
            <div className="row project-icon-actions">
              <button className="btn small" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? tr("Wczytywanie…") : tr("Wgraj własną ikonę") + '…'}</button>
              {icon && <button className="btn ghost small" onClick={() => setIcon(undefined)}>{tr("Użyj inicjału")}</button>}
            </div>
          </div>
        </div>
        {error && <div className="icon-error" role="alert">{error}</div>}
        <div className="field">
          <label>{tr("Podgląd na liście projektów")}</label>
          <div className="project active project-sample">
            <span className="list-drag-grip" aria-hidden="true"><IGrip /></span>
            <ProjectIconView project={preview} />
            <span className="name">{name.trim() || tr("Nazwa projektu")}</span>
          </div>
        </div>
        <div className="field">
          <label>{tr("Kolor")}</label>
          <div className="color-row">
            {PROJECT_COLORS.map((c) => (
              <button key={c} className={c === color ? 'on' : ''} style={{ background: c }} title={c} aria-label={tr('Kolor {color}', { color: c })} aria-pressed={c === color} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <div className="field">
          <label>{tr("Ikona")}</label>
          <div className="emoji-grid">
            <button className={!icon ? 'on' : ''} title={tr("Inicjał projektu")} aria-label={tr("Inicjał projektu")} onClick={() => setIcon(undefined)}>{name.trim().charAt(0).toUpperCase() || '?'}</button>
            {EMOJIS.map((e) => (
              <button key={e} className={icon?.kind === 'emoji' && icon.value === e ? 'on' : ''} title={tr('Ikona {icon}', { icon: e })} aria-label={tr('Ikona {icon}', { icon: e })} onClick={() => setIcon({ kind: 'emoji', value: e })}>{e}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={async () => {
          try {
            const selected = await window.mc.pickFolder();
            if (selected) setPath(selected);
          } catch {
            setError(tr("Nie udało się otworzyć wyboru folderu."));
          }
        }}>{tr("Zmień folder…")}</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>{tr("Anuluj")}</button>
        <button className="btn white" disabled={!name.trim() || uploading} onClick={save}>{tr("Zapisz")}</button>
      </div>
    </div>
  );
}
