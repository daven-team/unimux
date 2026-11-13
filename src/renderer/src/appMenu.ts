// The menus of the title bar's menu bar (components/MenuBar.tsx): File, Edit and View. Every item runs an action that exists
// elsewhere (the shortcuts' runShortcut, the actions, the files module); this file only lists them. The Edit items act on what
// had the keyboard before the menu opened: the code editor (CodeMirror), a text field, or a terminal.
import { displayCombo, parseDefault } from '../../shared/shortcuts';
import { tr } from './i18n';
import { getS, getUi, setUi } from './store';
import type { MenuItem } from './components/ContextMenu';
import { runShortcut, shortcutText } from './shortcuts';
import { createProject } from './actions';
import { canSaveAs, isFileDirty, openExternalFile, saveFile, saveFileAs, useFileStore } from './files';
import { frontKey } from './workspaceStrip';
import { terminals } from './terminals/TerminalManager';
import { openTerminalFind } from './terminals/terminalFind';
import { setUiZoom, stepUiZoom, uiZoom } from './uiZoom';

// ── what had the keyboard ───────────────────────────────────────────────────

/** The element that had the keyboard before a menu of the bar opened (the menu takes the focus while it is open). */
let remembered: HTMLElement | null = null;
export function rememberFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && !el.closest('.menu, [data-menubar]')) remembered = el;
  else if (!(el instanceof HTMLElement) || el === document.body) remembered = null;
}

type TextField = HTMLInputElement | HTMLTextAreaElement;
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);
export type EditTarget =
  | { kind: 'code'; el: HTMLElement; editor: HTMLElement }
  | { kind: 'field'; el: TextField }
  | { kind: 'editable'; el: HTMLElement }
  | { kind: 'terminal'; el: HTMLElement; cellId: string }
  | { kind: 'none' };

/** What an Edit command acts on, from the element that has (had) the keyboard. */
export function editTargetOf(el: Element | null): EditTarget {
  if (!(el instanceof HTMLElement) || !el.isConnected) return { kind: 'none' };
  if (el.closest('.xterm')) {
    const cellId = el.closest('[data-cell-id]')?.getAttribute('data-cell-id');
    return cellId && terminals.xterm(cellId) ? { kind: 'terminal', el, cellId } : { kind: 'none' };
  }
  const editor = el.closest<HTMLElement>('.cm-editor');
  if (editor) return { kind: 'code', el, editor };
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type))) return { kind: 'field', el };
  if (el.isContentEditable) return { kind: 'editable', el };
  return { kind: 'none' };
}

type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'find';

const writable = (t: EditTarget): boolean =>
  t.kind === 'field' ? !t.el.readOnly && !t.el.disabled : t.kind === 'code' ? t.editor.querySelector('[contenteditable="true"]') !== null : t.kind === 'editable';
const fieldSelection = (el: TextField): string => {
  try { return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0); } catch { return ''; } // number fields have no selection
};
const pageSelection = (): string => window.getSelection()?.toString() ?? '';

/** Which Edit items make sense for this target (the others are greyed out). */
export function editEnabled(t: EditTarget, command: EditCommand): boolean {
  if (command === 'find') return true;
  switch (t.kind) {
    case 'terminal': return command === 'copy' ? !!terminals.xterm(t.cellId)?.hasSelection() : command === 'paste' || command === 'selectAll';
    case 'field': return command === 'copy' ? t.el.type !== 'password' : command === 'selectAll' ? true : writable(t) && (command !== 'cut' || t.el.type !== 'password');
    case 'code': case 'editable': return command === 'copy' || command === 'selectAll' || writable(t);
    default: return command === 'copy' && pageSelection() !== '';
  }
}

/** The keyboard back where it was, then `command` on it. */
export async function runEdit(t: EditTarget, command: EditCommand): Promise<void> {
  if (t.kind !== 'none') t.el.focus({ preventScroll: true });
  if (t.kind === 'terminal') {
    const term = terminals.xterm(t.cellId);
    if (command === 'copy' && term?.hasSelection()) window.mc.clipboardWrite(term.getSelection());
    else if (command === 'paste') { const text = await window.mc.clipboardRead(); if (text) terminals.paste(t.cellId, text, false); }
    else if (command === 'selectAll') term?.selectAll();
    else if (command === 'find') openTerminalFind(t.cellId);
    return;
  }
  if (t.kind === 'code') {
    // CodeMirror is loaded with the editor; these imports only pick up the loaded modules.
    const [{ EditorView }, commands] = await Promise.all([import('@codemirror/view'), import('@codemirror/commands')]);
    const view = EditorView.findFromDOM(t.editor);
    if (!view) return;
    view.focus();
    const selected = () => view.state.selection.ranges.filter((r) => !r.empty).map((r) => view.state.sliceDoc(r.from, r.to)).join(view.state.lineBreak);
    if (command === 'undo') commands.undo(view);
    else if (command === 'redo') commands.redo(view);
    else if (command === 'selectAll') commands.selectAll(view);
    else if (command === 'copy' || command === 'cut') {
      const text = selected();
      if (!text) return;
      window.mc.clipboardWrite(text);
      if (command === 'cut' && !view.state.readOnly) view.dispatch({ ...view.state.replaceSelection(''), userEvent: 'delete.cut', scrollIntoView: true });
    } else if (command === 'paste') {
      const text = await window.mc.clipboardRead();
      if (text && !view.state.readOnly) view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.paste', scrollIntoView: true });
    } else if (command === 'find') findWithKey(view.contentDOM);
    return;
  }
  if (t.kind === 'field' || t.kind === 'editable') {
    const selected = t.kind === 'field' ? fieldSelection(t.el) : pageSelection();
    // execCommand keeps the field's own undo history and fires the input events React listens to.
    if (command === 'undo' || command === 'redo') document.execCommand(command);
    else if (command === 'selectAll') { if (t.kind === 'field') t.el.select(); else document.execCommand('selectAll'); }
    else if (command === 'copy' || command === 'cut') {
      if (!selected) return;
      window.mc.clipboardWrite(selected);
      if (command === 'cut') document.execCommand('delete');
    } else if (command === 'paste') {
      const text = await window.mc.clipboardRead();
      if (text) document.execCommand('insertText', false, text);
    } else if (command === 'find') findWithKey(t.el);
    return;
  }
  if (command === 'copy') { const text = pageSelection(); if (text) window.mc.clipboardWrite(text); }
  else if (command === 'find') findWithKey(document.body);
}

/**
 * Find: the same key press the place would get (Ctrl+F / Cmd+F): the code editor and the file tab in front open their find
 * widgets. When nothing takes it, the palette searches everywhere.
 */
function findWithKey(target: HTMLElement): void {
  const mac = window.mc.platform === 'darwin';
  const event = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  if (!event.defaultPrevented) setUi({ palette: true });
}

// ── the menus ───────────────────────────────────────────────────────────────

export type MenuId = 'file' | 'edit' | 'view';
export const MENU_IDS: readonly MenuId[] = ['file', 'edit', 'view'];
export const menuTitle = (id: MenuId): string => (id === 'file' ? tr('Plik') : id === 'edit' ? tr('Edycja') : tr('Widok'));

const hint = (id: string): string | undefined => shortcutText(id) || undefined;
/** The fixed text-editing keys (not app shortcuts): Ctrl+Z on Windows, Cmd+Z on macOS. */
const editHint = (template: string): string | undefined => {
  const platform = window.mc.platform;
  const combo = parseDefault(template, platform);
  return combo ? displayCombo(combo, platform) : undefined;
};

/** The file tab in front of the strip, if one is. */
function frontDocument() {
  const key = frontKey();
  if (!key?.startsWith('file:')) return null;
  const id = key.slice(5);
  return useFileStore.getState().documents.find((d) => d.id === id) ?? null;
}

async function openFileFromDialog(): Promise<void> {
  const path = await window.mc.openFileDialog();
  if (path) await openExternalFile(path);
}

function fileMenu(): MenuItem[] {
  const doc = frontDocument();
  const textTab = !!doc && canSaveAs(doc) && !doc.saving;
  return [
    { label: tr('Nowy plik tekstowy'), hint: hint('file.new'), onClick: () => runShortcut('file.new') },
    { label: tr('Otwórz plik') + '…', onClick: () => void openFileFromDialog() },
    { sep: true },
    { label: tr('Zapisz'), hint: hint('editor.save'), disabled: !doc || !textTab || !(isFileDirty(doc) || !!doc.untitled), onClick: () => { if (doc) void saveFile(doc.id); } },
    { label: tr('Zapisz jako…'), hint: hint('editor.saveAs'), disabled: !textTab, onClick: () => { if (doc) void saveFileAs(doc.id); } },
    { label: tr('Zamknij kartę'), hint: hint('tab.close'), disabled: !frontKey(), onClick: () => runShortcut('tab.close') },
    { sep: true },
    { label: tr('Nowy projekt') + '…', onClick: () => void createProject() },
    { label: tr('Nowy folder projektów'), hint: hint('folder.new'), onClick: () => runShortcut('folder.new') },
    { sep: true },
    { label: tr('Ustawienia'), onClick: () => setUi({ settingsTabOpen: true, settingsActive: true }) },
    // The main window's close: the same quit as its close button (the quit question when agents work).
    { label: tr('Zakończ'), onClick: () => window.mc.windowControls.close() },
  ];
}

function editMenu(): MenuItem[] {
  const target = editTargetOf(remembered);
  const mac = window.mc.platform === 'darwin';
  const item = (label: string, command: EditCommand, keys?: string): MenuItem =>
    ({ label, hint: keys, disabled: !editEnabled(target, command), onClick: () => void runEdit(target, command) });
  // Find: in a terminal its own find (Mod+Shift+F), elsewhere the editor's or the file's (Mod+F).
  const findHint = target.kind === 'terminal' ? hint('terminal.find') : editHint('Mod+F');
  return [
    item(tr('Cofnij'), 'undo', editHint('Mod+Z')),
    item(tr('Wykonaj ponownie'), 'redo', editHint(mac ? 'Mod+Shift+Z' : 'Mod+Y')),
    { sep: true },
    item(tr('Wytnij'), 'cut', editHint('Mod+X')),
    item(tr('Kopiuj'), 'copy', editHint('Mod+C')),
    item(tr('Wklej'), 'paste', editHint('Mod+V')),
    item(tr('Zaznacz wszystko'), 'selectAll', editHint('Mod+A')),
    { sep: true },
    item(tr('Znajdź'), 'find', findHint),
  ];
}

function viewMenu(): MenuItem[] {
  const zoom = uiZoom();
  const project = getS().projects.some((p) => p.id === getS().activeProjectId);
  return [
    { label: tr('Pokaż / ukryj panel boczny'), hint: hint('sidebar.toggle'), onClick: () => runShortcut('sidebar.toggle') },
    { label: tr('Pokaż / ukryj snippety'), hint: hint('snippets.toggle'), onClick: () => runShortcut('snippets.toggle') },
    { label: tr('Pokaż / ukryj notatki'), hint: hint('notes.toggle'), onClick: () => runShortcut('notes.toggle') },
    { label: tr('Pokaż / ukryj zespół AI'), onClick: () => setUi((ui) => ({ automationOpen: !ui.automationOpen })) },
    { label: tr('Paleta poleceń'), hint: hint('palette.open'), onClick: () => setUi({ palette: true }) },
    { sep: true },
    { label: tr('Powiększ'), disabled: zoom >= 2, onClick: () => stepUiZoom(1) },
    { label: tr('Pomniejsz'), disabled: zoom <= 0.67, onClick: () => stepUiZoom(-1) },
    { label: tr('Rzeczywisty rozmiar'), hint: `${Math.round(zoom * 100)}%`, disabled: zoom === 1, onClick: () => setUiZoom(1) },
    { label: tr('Pełny ekran'), onClick: () => window.mc.windowControls.toggleFullscreen() },
    { sep: true },
    { label: tr('Maksymalizuj / przywróć komórkę'), hint: hint('cell.maximize'), disabled: !project || getUi().settingsActive, onClick: () => runShortcut('cell.maximize') },
    { label: tr('Szukaj w rozmowach Claude i Codex…'), hint: hint('conversations.search'), onClick: () => runShortcut('conversations.search') },
  ];
}

export function menuItems(id: MenuId): MenuItem[] {
  return id === 'file' ? fileMenu() : id === 'edit' ? editMenu() : viewMenu();
}
