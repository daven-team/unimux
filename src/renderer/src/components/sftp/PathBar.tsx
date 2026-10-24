// The path of a pane (1.0.8), like the address bar of a file manager: crumbs to click while browsing; a click on the bar (or
// Ctrl+L, F4, Alt+D) turns it into a field with the whole path selected to copy, edit or replace. Enter goes there (a file
// opens its folder with the file selected), Escape gives the crumbs back, a path that cannot be opened keeps the field with
// its error under it. Typing suggests the folder names of the typed folder (Tab completes, arrows pick).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { applyCompletion, completionMatches, completionQuery, editablePath, tabCompletion } from '../../../../shared/sftpPathInput';
import type { Crumb, PathFlavor } from '../../../../shared/sftpView';
import { displayCombo, parseDefault } from '../../../../shared/shortcuts';
import { useI18n } from '../../i18n';
import { toast } from '../../store';
import { openMenu } from '../ContextMenu';
import { FolderIcon } from '../FileIcon';
import { IEdit } from '../icons';
import { ICopy } from '../menuIcons';

/** What Enter in the field did: the folder is shown (and `select` names the file to select in it), or why it is not. */
export type PathSubmit = { ok: true; select?: string } | { ok: false; error: string };

/** How a pane reads and completes typed paths. */
export interface PathInput {
  flavor: PathFlavor;
  /** Names differ only in case on this side (Windows, macOS): the completion ignores case. */
  insensitive: boolean;
  submit(text: string): Promise<PathSubmit>;
  /** The folder names of the folder `dir` names as typed ('' = the shown folder); null when it cannot be listed. */
  folders(dir: string): Promise<string[] | null>;
}

/** A pause in typing (ms) before the typed folder is listed for suggestions. */
const SUGGEST_DELAY = 140;
const SUGGEST_MAX = 50;

interface PathBarProps {
  path: string | null;
  crumbs: Crumb[];
  /** The folder a drag is over (a crumb lights up as a drop target). */
  over: string | null;
  input: PathInput;
  editing: boolean;
  onEditing(editing: boolean): void;
  onOpen(path: string): void;
  /** Enter opened a file's folder: this entry gets selected. */
  onSelect(name: string): void;
  /** The field closed by the keyboard: the focus goes back to the list. */
  onDone(): void;
}

export function PathBar(p: PathBarProps) {
  const { tr } = useI18n();
  const crumbBar = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Folder names per typed folder of this edit ('' = the shown folder); null: it could not be listed. */
  const [names, setNames] = useState<ReadonlyMap<string, string[] | null>>(new Map());
  /** The suggestions show once the user typed (not for the whole path the field starts with). */
  const [suggest, setSuggest] = useState(false);
  const [active, setActive] = useState(-1);
  const pending = useRef(new Set<string>());
  const busyRef = useRef(false);
  const selectAll = useRef(false);
  const listId = useId();
  const shown = editablePath(p.path);
  const editKey = useMemo(() => { const c = parseDefault('Mod+L', window.mc.platform); return c ? displayCombo(c, window.mc.platform) : 'Ctrl+L'; }, []);
  const copyable = shown !== '';

  // The end of a long path (the current folder) stays in view.
  useLayoutEffect(() => { const el = crumbBar.current; if (el) el.scrollLeft = el.scrollWidth; }, [p.crumbs, p.editing]);

  // Each edit starts with the whole path selected.
  useLayoutEffect(() => {
    if (!p.editing) return;
    setText(shown); setError(null); setNames(new Map()); setSuggest(false); setActive(-1);
    pending.current.clear();
    selectAll.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.editing]);
  // Once the field holds the path (the render after the one that opened it).
  useLayoutEffect(() => {
    const el = field.current;
    if (!selectAll.current || !el || el.value !== shown) return;
    selectAll.current = false;
    el.focus();
    el.select();
  });

  const query = useMemo(() => completionQuery(text, p.input.flavor), [text, p.input.flavor]);
  const listed = names.get(query.dir);
  const matches = useMemo(() => {
    if (!listed) return [];
    const found = completionMatches(listed, query.partial, p.input.insensitive, SUGGEST_MAX);
    // A typed name that is already whole needs no suggestion of itself.
    return found.length === 1 && found[0] === query.partial ? [] : found;
  }, [listed, query.partial, p.input.insensitive]);
  const open = p.editing && suggest && !busy && matches.length > 0;
  useEffect(() => { setActive(-1); }, [query.dir, query.partial]);

  // The typed folder is listed once per edit, after a short pause in typing.
  useEffect(() => {
    if (!p.editing || !suggest || names.has(query.dir) || pending.current.has(query.dir)) return;
    const dir = query.dir;
    const timer = setTimeout(() => {
      pending.current.add(dir);
      void p.input.folders(dir).catch(() => null).then((found) => setNames((m) => new Map(m).set(dir, found)));
    }, SUGGEST_DELAY);
    return () => clearTimeout(timer);
  }, [p.editing, suggest, query.dir, names, p.input]);

  const close = (refocus: boolean) => {
    p.onEditing(false);
    if (refocus) p.onDone();
  };
  const submit = async (value: string) => {
    if (busyRef.current) return;
    if (!value.trim()) { close(true); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const r = await p.input.submit(value).catch((): PathSubmit => ({ ok: false, error: tr('Operacja nie powiodła się') }));
    busyRef.current = false;
    setBusy(false);
    if (r.ok) {
      close(true);
      if (r.select) p.onSelect(r.select);
      return;
    }
    setError(r.error);
    setSuggest(false);
    requestAnimationFrame(() => field.current?.focus());
  };
  const pick = (name: string) => { setText(applyCompletion(text, name, p.input.flavor)); setSuggest(true); field.current?.focus(); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const handled = (() => {
      switch (e.key) {
        case 'Enter':
          if (open && active >= 0) { void submit(applyCompletion(text, matches[active], p.input.flavor)); return true; }
          void submit(text);
          return true;
        case 'Escape':
          if (open) { setSuggest(false); return true; }
          close(true);
          return true;
        case 'Tab': {
          if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
          if (open && active >= 0) { pick(matches[active]); return true; }
          const next = tabCompletion(text, matches, p.input.flavor, p.input.insensitive);
          if (next !== null) { setText(next); setSuggest(true); return true; }
          if (matches.length) { setSuggest(true); setActive(0); return true; }
          return !!text; // Tab stays in the field while there is something to complete
        }
        case 'ArrowDown':
        case 'ArrowUp': {
          if (!matches.length) return false;
          if (!open) { setSuggest(true); setActive(e.key === 'ArrowDown' ? 0 : matches.length - 1); return true; }
          const step = e.key === 'ArrowDown' ? 1 : -1;
          setActive((a) => (a < 0 ? (step > 0 ? 0 : matches.length - 1) : (a + step + matches.length) % matches.length));
          return true;
        }
        default: return false;
      }
    })();
    // The pane's own keys (Backspace goes up, Ctrl+A selects all entries...) never see the field's keys.
    e.stopPropagation();
    if (handled) e.preventDefault();
  };

  const copy = () => { if (copyable) { window.mc.clipboardWrite(shown); toast(tr('Skopiowano ścieżkę'), 'info'); } };
  const barMenu = (x: number, y: number) => openMenu(x, y, [
    { label: tr('Edytuj ścieżkę'), icon: <IEdit />, hint: editKey, onClick: () => p.onEditing(true) },
    { label: tr('Kopiuj ścieżkę'), icon: <ICopy />, disabled: !copyable, onClick: copy },
  ]);

  if (p.editing) {
    return (
      <div className={`sftp-path-edit${error ? ' invalid' : ''}`}>
        <input ref={field} className="sftp-path-input" value={text} spellCheck={false} autoComplete="off" aria-label={tr('Ścieżka')} placeholder={tr('Wpisz ścieżkę')}
          role="combobox" aria-expanded={open} aria-autocomplete="list" aria-controls={open ? listId : undefined} aria-invalid={!!error} aria-busy={busy}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => { setText(e.target.value); setError(null); setSuggest(true); }}
          onKeyDown={onKeyDown}
          onBlur={() => { if (!busyRef.current) close(false); }} />
        {open && (
          <ul id={listId} className="sftp-path-suggestions" role="listbox" aria-label={tr('Pasujące foldery')}>
            {matches.map((name, i) => (
              <li key={name} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : undefined}
                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(name)}>
                <FolderIcon /><span>{name}</span>
              </li>
            ))}
          </ul>
        )}
        {error && !open && <div className="sftp-path-error" role="alert">{error}</div>}
      </div>
    );
  }
  return (
    <>
      <nav ref={crumbBar} className="sftp-crumbs" aria-label={tr('Ścieżka')} title={tr('Kliknij, aby wpisać ścieżkę ({key})', { key: editKey })}
        onClick={(e) => { if (!(e.target as Element).closest('button')) p.onEditing(true); }}
        onContextMenu={(e) => { e.preventDefault(); barMenu(e.clientX, e.clientY); }}>
        {p.crumbs.map((c, i) => (
          <span key={c.path} className="sftp-crumb">
            {i > 0 && c.label !== '/' && p.crumbs[i - 1].label !== '/' && <span className="sftp-crumb-sep">/</span>}
            <button type="button" className={`${i === p.crumbs.length - 1 ? 'on' : ''}${p.over === c.path && c.path !== p.path ? ' drop' : ''}`} title={c.path} data-folder-path={c.path} onClick={() => p.onOpen(c.path)}>{c.label}</button>
          </span>
        ))}
        <span className="sftp-crumbs-rest" aria-hidden />
      </nav>
      <button type="button" className="btn ghost icon sftp-copy-path" aria-label={tr('Kopiuj ścieżkę')} title={tr('Kopiuj ścieżkę')} disabled={!copyable} onClick={copy}><ICopy /></button>
    </>
  );
}
