// Central registry of every keyboard shortcut of the app, plus the pure helpers around it: combo parsing and formatting,
// matching keyboard events, conflict and reserved-key detection, and the normalisation of the user's overrides.
// The renderer (dispatcher, tooltips, palette, Settings) and the persisted state all go through this file.
import type { MessageKey } from './i18n';
import type { AppPlatform } from './platform';

// ---------------------------------------------------------------------------------------------------------------------
// Combos

/** `key` is a canonical token (see KEY_TOKENS); the modifiers are the literal keys (on macOS `meta` is Cmd). */
export interface Combo { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

const NAMED: Record<string, string> = {
  Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`',
};
const PUNCTUATION = new Set([',', '.', '/', '\\', ';', "'", '[', ']', '-', '=', '`']);
const ALIASES: Record<string, string> = {
  esc: 'Escape', del: 'Delete', ins: 'Insert', return: 'Enter', pgup: 'PageUp', pgdn: 'PageDown', arrowleft: 'Left', arrowright: 'Right',
  arrowup: 'Up', arrowdown: 'Down', spacebar: 'Space', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', quote: "'",
  bracketleft: '[', bracketright: ']', minus: '-', equal: '=', backquote: '`',
};
const NAMED_TOKENS = new Set(['Tab', 'Enter', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Left', 'Right', 'Up', 'Down']);
const MODIFIER_NAMES: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta',
};

/** The numpad with NumLock off reports the navigation key in `key` (code Numpad4, key ArrowLeft): those count as the navigation key. */
const NUMPAD_NAVIGATION: Record<string, string> = {
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
};

/**
 * Canonical key token of a `KeyboardEvent.code` (layout independent), or null for keys that cannot be a shortcut (modifiers, numpad
 * digits, media...). With `key` given, a numpad key that acts as Delete, an arrow, Home... (NumLock off) maps to that key.
 */
export function keyFromCode(code: string, key?: string): string | null {
  if (key && code.startsWith('Numpad') && code !== 'NumpadEnter' && Object.hasOwn(NUMPAD_NAVIGATION, key)) return NUMPAD_NAVIGATION[key];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

const normalizeKey = (text: string): string | null => {
  if (/^[a-z]$/i.test(text)) return text.toUpperCase();
  if (/^\d$/.test(text)) return text;
  if (/^f([1-9]|1\d|2[0-4])$/i.test(text)) return text.toUpperCase();
  if (PUNCTUATION.has(text)) return text;
  const alias = ALIASES[text.toLowerCase()];
  if (alias) return alias;
  const named = [...NAMED_TOKENS].find((token) => token.toLowerCase() === text.toLowerCase());
  return named ?? null;
};

/** Parses a persisted combo such as `Ctrl+Shift+E`; modifier names are case-insensitive and may come in any order. */
export function parseCombo(text: unknown): Combo | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = text.trim().split('+').map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  const combo: Combo = { key: '', ctrl: false, alt: false, shift: false, meta: false };
  for (let i = 0; i < parts.length; i++) {
    const modifier = MODIFIER_NAMES[parts[i].toLowerCase()];
    if (modifier && i < parts.length - 1) {
      if (combo[modifier]) return null;
      combo[modifier] = true;
    } else if (i === parts.length - 1 && !modifier) {
      const key = normalizeKey(parts[i]);
      if (!key) return null;
      combo.key = key;
    } else return null;
  }
  return combo.key ? combo : null;
}

/** The stable persisted form: `Ctrl+Alt+Shift+Meta+Key`. */
export function formatCombo(combo: Combo): string {
  return [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', combo.meta && 'Meta', combo.key].filter(Boolean).join('+');
}

/** Round trip through the stable form (modifier order, key case); null when the text is not a combo. */
export function normalizeCombo(text: unknown): string | null {
  const combo = parseCombo(text);
  return combo ? formatCombo(combo) : null;
}

export const sameCombo = (a: Combo | null | undefined, b: Combo | null | undefined): boolean =>
  !!a && !!b && a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;

/** What the user reads: macOS says Cmd and Option, Windows says Win, Linux says Super. */
export function comboParts(combo: Combo, platform: AppPlatform): string[] {
  const meta = platform === 'darwin' ? 'Cmd' : platform === 'win32' ? 'Win' : 'Super';
  const alt = platform === 'darwin' ? 'Option' : 'Alt';
  const modifiers = platform === 'darwin'
    ? [combo.ctrl && 'Ctrl', combo.meta && meta, combo.alt && alt, combo.shift && 'Shift']
    : [combo.ctrl && 'Ctrl', combo.alt && alt, combo.shift && 'Shift', combo.meta && meta];
  return [...modifiers.filter((part): part is string => !!part), combo.key];
}
export const displayCombo = (combo: Combo, platform: AppPlatform): string => comboParts(combo, platform).join('+');

interface KeyEventLike {
  code: string; key?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
  getModifierState?(key: string): boolean;
}

/** The combo a key press makes, or null while only modifiers are held (or for a key that cannot be a shortcut). */
export function eventToCombo(event: KeyEventLike): Combo | null {
  const key = keyFromCode(event.code, event.key);
  return key ? { key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey } : null;
}

/** Exact match: every modifier must agree. Ctrl+Alt made by AltGr (which types characters) never counts as Ctrl+Alt. */
export function matchCombo(event: KeyEventLike, combo: Combo | null | undefined): boolean {
  if (!combo) return false;
  if (event.ctrlKey !== combo.ctrl || event.altKey !== combo.alt || event.shiftKey !== combo.shift || event.metaKey !== combo.meta) return false;
  if (combo.ctrl && combo.alt && event.getModifierState?.('AltGraph')) return false;
  return keyFromCode(event.code, event.key) === combo.key;
}

/** Defaults are written with `Mod`: Ctrl on Windows and Linux, Cmd on macOS. */
export function parseDefault(template: string, platform: AppPlatform): Combo | null {
  return parseCombo(template.replace(/\bMod\b/g, platform === 'darwin' ? 'Meta' : 'Ctrl'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry

export type ShortcutScope = 'global' | 'cell' | 'files-tree' | 'editor' | 'modal' | 'git-panel' | 'terminal-passthrough';
export type ShortcutGroup = 'general' | 'grid' | 'files' | 'panels' | 'terminal';
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['general', 'grid', 'panels', 'files', 'terminal'];
export const GROUP_LABEL: Record<ShortcutGroup, MessageKey> = {
  general: 'Ogólne', grid: 'Siatka i komórki', panels: 'Panele', files: 'Pliki i edytor', terminal: 'Terminal',
};

export interface ShortcutDef {
  id: string;
  label: MessageKey;
  group: ShortcutGroup;
  scope: ShortcutScope;
  /** Template with `Mod`; null for a row that has no key combination (see `fixedText`). */
  default: string | null;
  rebindable: boolean;
  /** Fires while a text field has the focus (default true: today every app shortcut works there). */
  allowInInput?: boolean;
  /** The action is meaningless without an open project / is not available on the Settings screen. */
  requiresProject?: boolean;
  blockedInSettings?: boolean;
  /**
   * Older keys that keep working while the action is on its default (not shown in Settings), as templates like `default`:
   * on macOS the file tree and dialogs used to accept Ctrl as well as Cmd.
   */
  aliases?: readonly string[];
  /** Fires only while the keyboard is in a terminal (the terminal's find): elsewhere the key stays with the focused field. */
  terminalOnly?: boolean;
  /** Why a read-only row cannot be changed. */
  reason?: MessageKey;
  /** Read-only row that is not a key press at all (Ctrl+wheel); `Mod` as above. */
  fixedText?: string;
}

export const SHORTCUTS = [
  { id: 'palette.open', label: 'Otwórz paletę poleceń', group: 'general', scope: 'global', default: 'Mod+K', rebindable: true },
  { id: 'palette.openAlt', label: 'Otwórz paletę poleceń (drugi skrót)', group: 'general', scope: 'global', default: 'Mod+Shift+P', rebindable: true },
  { id: 'modal.save', label: 'Zapisz w oknie dialogowym (np. snippet, projekt)', group: 'general', scope: 'modal', default: 'Mod+Enter', rebindable: true, aliases: ['Ctrl+Enter'] },
  { id: 'terminal.new', label: 'Nowa zakładka z jednym terminalem', group: 'grid', scope: 'global', default: 'Mod+Shift+T', rebindable: true },
  { id: 'agent.add', label: 'Dodaj agenta do siatki', group: 'grid', scope: 'global', default: 'Mod+Shift+N', rebindable: true },
  { id: 'grid.new', label: 'Nowy grid lub preset', group: 'grid', scope: 'global', default: 'Mod+Shift+G', rebindable: true, requiresProject: true },
  { id: 'history.open', label: 'Historia czatów i gridów', group: 'grid', scope: 'global', default: 'Mod+Shift+H', rebindable: true, requiresProject: true },
  { id: 'tab.close', label: 'Zamknij kartę na wierzchu (grid, plik, SSH, ustawienia)', group: 'grid', scope: 'global', default: 'Mod+Shift+W', rebindable: true },
  { id: 'tab.next', label: 'Następna karta', group: 'grid', scope: 'global', default: 'Mod+Tab', rebindable: true },
  { id: 'tab.prev', label: 'Poprzednia karta', group: 'grid', scope: 'global', default: 'Mod+Shift+Tab', rebindable: true },
  { id: 'cell.maximize', label: 'Maksymalizuj lub przywróć komórkę', group: 'grid', scope: 'cell', default: 'Mod+Shift+M', rebindable: true, blockedInSettings: true },
  { id: 'cell.focus.left', label: 'Przejdź do komórki po lewej', group: 'grid', scope: 'cell', default: 'Mod+Alt+Left', rebindable: true, blockedInSettings: true },
  { id: 'cell.focus.right', label: 'Przejdź do komórki po prawej', group: 'grid', scope: 'cell', default: 'Mod+Alt+Right', rebindable: true, blockedInSettings: true },
  { id: 'cell.focus.up', label: 'Przejdź do komórki wyżej', group: 'grid', scope: 'cell', default: 'Mod+Alt+Up', rebindable: true, blockedInSettings: true },
  { id: 'cell.focus.down', label: 'Przejdź do komórki niżej', group: 'grid', scope: 'cell', default: 'Mod+Alt+Down', rebindable: true, blockedInSettings: true },
  { id: 'cell.move.left', label: 'Przesuń komórkę w lewo', group: 'grid', scope: 'cell', default: 'Mod+Alt+Shift+Left', rebindable: true, blockedInSettings: true },
  { id: 'cell.move.right', label: 'Przesuń komórkę w prawo', group: 'grid', scope: 'cell', default: 'Mod+Alt+Shift+Right', rebindable: true, blockedInSettings: true },
  { id: 'cell.move.up', label: 'Przesuń komórkę w górę', group: 'grid', scope: 'cell', default: 'Mod+Alt+Shift+Up', rebindable: true, blockedInSettings: true },
  { id: 'cell.move.down', label: 'Przesuń komórkę w dół', group: 'grid', scope: 'cell', default: 'Mod+Alt+Shift+Down', rebindable: true, blockedInSettings: true },
  // 1.0.9: the cells that wait for you (shared/waiting.ts), longest waiting first, across every grid and window.
  { id: 'waiting.next', label: 'Następna komórka, która czeka na Ciebie', group: 'grid', scope: 'global', default: 'Mod+Alt+PageDown', rebindable: true },
  { id: 'waiting.prev', label: 'Poprzednia komórka, która czeka na Ciebie', group: 'grid', scope: 'global', default: 'Mod+Alt+PageUp', rebindable: true },
  // Ctrl+F itself belongs to the program in the terminal (readline: forward one character), so the terminal finds with Shift.
  { id: 'terminal.find', label: 'Znajdź w terminalu', group: 'terminal', scope: 'cell', default: 'Mod+Shift+F', rebindable: true, blockedInSettings: true, terminalOnly: true },
  { id: 'snippets.toggle', label: 'Pokaż lub ukryj snippety', group: 'panels', scope: 'global', default: 'Mod+Shift+B', rebindable: true },
  { id: 'notes.toggle', label: 'Pokaż lub ukryj notatki', group: 'panels', scope: 'global', default: 'Mod+Shift+O', rebindable: true },
  // 1.0.7: quick capture; the selection of the terminal in focus (or of an editor) becomes a note.
  { id: 'notes.capture', label: 'Nowa notatka z zaznaczonego tekstu', group: 'panels', scope: 'global', default: 'Mod+Shift+L', rebindable: true },
  { id: 'sidebar.toggle', label: 'Pokaż lub ukryj panel boczny', group: 'panels', scope: 'global', default: 'Mod+Shift+E', rebindable: true },
  { id: 'git.commit', label: 'Git: zatwierdź zmiany (commit)', group: 'panels', scope: 'git-panel', default: 'Mod+Enter', rebindable: true, aliases: ['Ctrl+Enter'] },
  { id: 'editor.save', label: 'Zapisz plik w edytorze', group: 'files', scope: 'editor', default: 'Mod+S', rebindable: true },
  { id: 'tree.rename', label: 'Drzewo plików: zmień nazwę', group: 'files', scope: 'files-tree', default: 'F2', rebindable: true },
  { id: 'tree.delete', label: 'Drzewo plików: przenieś do kosza', group: 'files', scope: 'files-tree', default: 'Delete', rebindable: true },
  { id: 'tree.copy', label: 'Drzewo plików: kopiuj', group: 'files', scope: 'files-tree', default: 'Mod+C', rebindable: true, aliases: ['Ctrl+C'] },
  { id: 'tree.cut', label: 'Drzewo plików: wytnij', group: 'files', scope: 'files-tree', default: 'Mod+X', rebindable: true, aliases: ['Ctrl+X'] },
  { id: 'tree.paste', label: 'Drzewo plików: wklej', group: 'files', scope: 'files-tree', default: 'Mod+V', rebindable: true, aliases: ['Ctrl+V'] },
  { id: 'tree.undo', label: 'Drzewo plików: cofnij ostatnią operację', group: 'files', scope: 'files-tree', default: 'Mod+Z', rebindable: true, aliases: ['Ctrl+Z'] },
  { id: 'tree.selectAll', label: 'Drzewo plików: zaznacz wszystko', group: 'files', scope: 'files-tree', default: 'Mod+A', rebindable: true, aliases: ['Ctrl+A'] },
  {
    id: 'terminal.copy', label: 'Kopiuj zaznaczenie w terminalu', group: 'terminal', scope: 'terminal-passthrough', default: 'Mod+C', rebindable: false,
    reason: 'Kopiuje zaznaczony tekst. Bez zaznaczenia klawisz trafia do programu w terminalu (np. przerwanie).',
  },
  {
    id: 'terminal.copyAlways', label: 'Kopiuj w terminalu (zawsze)', group: 'terminal', scope: 'terminal-passthrough', default: 'Mod+Shift+C', rebindable: false,
    reason: 'Kopiuje zaznaczony tekst terminala zawsze, bez przerywania programu.',
  },
  {
    id: 'terminal.paste', label: 'Wklej do terminala', group: 'terminal', scope: 'terminal-passthrough', default: 'Mod+V', rebindable: false,
    reason: 'Wkleja tekst ze schowka. Bez tekstu (np. obraz) klawisz trafia do agenta.',
  },
  {
    id: 'terminal.pasteShift', label: 'Wklej do terminala (z Shift)', group: 'terminal', scope: 'terminal-passthrough', default: 'Mod+Shift+V', rebindable: false,
    reason: 'Wkleja tekst ze schowka tak samo jak skrót bez Shift.',
  },
  {
    id: 'terminal.zoom', label: 'Powiększ lub pomniejsz czcionkę komórki', group: 'terminal', scope: 'terminal-passthrough', default: null, rebindable: false,
    fixedText: 'Mod+Wheel', reason: 'To kółko myszy z przytrzymanym klawiszem, a nie skrót klawiszowy.',
  },
] as const satisfies readonly ShortcutDef[];

export type ShortcutId = typeof SHORTCUTS[number]['id'];
export const SHORTCUT_DEFS: readonly ShortcutDef[] = SHORTCUTS;
export const shortcutDef = (id: string): ShortcutDef | undefined => SHORTCUT_DEFS.find((def) => def.id === id);

export const defaultCombo = (def: ShortcutDef, platform: AppPlatform): Combo | null => (def.default ? parseDefault(def.default, platform) : null);

/** Everything the app handles in a given focus area is exclusive within it; the file tree and the editor are never active together. */
export function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === 'global' || a === 'cell' || b === 'global' || b === 'cell') return true;
  return a === b;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reserved combos

const isFunctionKey = (key: string) => /^F\d+$/.test(key);
const isLetter = (key: string) => /^[A-Z]$/.test(key);
const isPrintable = (key: string) => isLetter(key) || /^\d$/.test(key) || PUNCTUATION.has(key) || key === 'Space';
/** Bare keys that make sense as a shortcut inside the file tree (it has no text input). */
const TREE_BARE = new Set(['Delete', 'Insert', 'Enter', 'Backspace']);
/** Text-editing keys of the editor and of text fields. */
const EDIT_LETTERS = new Set(['Z', 'Y', 'A', 'C', 'V', 'X']);
const EDITOR_LETTERS = new Set(['F', 'G', 'D', 'L', 'I', 'U', 'H', 'K', 'J', 'M', '/', '[', ']', '\\', 'Enter', 'Backspace', 'Delete', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'Space']);

/**
 * Why a combo can never be a shortcut for an action of this scope (a message key), or null when it is allowed.
 * `own` is the action's default: a default that the app already ships is never "reserved" (Ctrl+K opens the palette today).
 */
export function reservedReason(combo: Combo, platform: AppPlatform, scope: ShortcutScope, own?: Combo | null): MessageKey | null {
  if (own && sameCombo(combo, own)) return null;
  const { key, ctrl, alt, shift, meta } = combo;
  const mac = platform === 'darwin';
  if (key === 'Escape' && !ctrl && !alt && !meta) return 'Esc zamyka okna i anuluje operacje.';
  const modified = ctrl || alt || meta;
  if (!modified) {
    if (isFunctionKey(key)) return null;
    if (scope === 'files-tree' && !shift && TREE_BARE.has(key)) return null;
    return 'Klawisz bez Ctrl, Alt lub Cmd służy do pisania. Dodaj modyfikator albo użyj klawisza funkcyjnego (F1-F12).';
  }
  // The operating system takes these before the app sees them.
  if (platform === 'win32') {
    if (meta) return 'Klawisz Windows jest zajęty przez system.';
    if (alt && !ctrl && ['F4', 'Tab', 'Escape', 'Space'].includes(key)) return 'Ten skrót należy do systemu.';
    if (ctrl && !alt && key === 'Escape') return 'Ten skrót należy do systemu.';
    if (ctrl && alt && key === 'Delete') return 'Ten skrót należy do systemu.';
  } else if (platform === 'linux') {
    if (meta) return 'Klawisz Super jest zajęty przez system.';
    if (alt && !ctrl && ['F4', 'Tab', 'Escape', 'Space'].includes(key)) return 'Ten skrót należy do systemu.';
  } else if (meta && !ctrl && !alt && ['Q', 'H', 'M', 'W', 'Tab', 'Space', '`'].includes(key)) {
    return 'Ten skrót należy do systemu.';
  } else if (meta && alt && !ctrl && key === 'H') {
    // Option+Cmd+H hides the other apps (the app menu's role).
    return 'Ten skrót należy do systemu.';
  }
  // AltGr (Ctrl+Alt) and Option type characters.
  if (isPrintable(key) && ((!mac && ctrl && alt && !meta) || (mac && alt && !ctrl && !meta))) {
    return 'Ten skrót wpisuje znaki (AltGr lub Option), więc nie może być skrótem.';
  }
  const mod = mac ? meta && !ctrl && !alt : ctrl && !alt && !meta;
  if (mac && (scope === 'global' || scope === 'cell') && meta && !ctrl && !alt && !shift && EDIT_LETTERS.has(key)) return 'Standardowe skróty edycji tekstu (kopiuj, wklej, cofnij, zaznacz).';
  if (scope === 'global' || scope === 'cell') {
    // The terminal pastes on Ctrl+V (Cmd+V) with or without Shift (see TerminalManager.handleKey).
    if (key === 'V' && ((ctrl && !alt && !meta) || (mac && meta && !ctrl && !alt))) return 'Wklejanie w terminalu należy do terminala (także z Shift).';
    // These reach the program in the focused terminal (Claude Code, Codex, the shell).
    if (ctrl && !alt && !shift && !meta && (isLetter(key) || ['[', '\\', ']', '/', '-', 'Space'].includes(key))) {
      return 'Skróty Ctrl+litera należą do terminala i agentów (Claude Code, Codex).';
    }
    // Also with Shift: PSReadLine and readline select text with Ctrl+Shift+arrows.
    if (ctrl && !alt && !meta && ['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'Backspace', 'Delete', 'Enter', 'PageUp', 'PageDown'].includes(key)) {
      return 'Ctrl ze strzałkami, Home, End, Backspace i Enter należy do terminala.';
    }
    // Ctrl+2..8 are the control codes NUL, FS, GS, RS and US of the terminal.
    if (ctrl && !alt && !meta && /^[2-8]$/.test(key)) return 'Ctrl z cyframi 2-8 wysyła do terminala znaki sterujące.';
    if (alt && !ctrl && !meta) return 'Skróty z samym Alt (Option) należą do terminala i agentów.';
  } else if (scope === 'modal' || scope === 'editor' || scope === 'git-panel') {
    if (mod && !shift && EDIT_LETTERS.has(key)) return 'Standardowe skróty edycji tekstu (kopiuj, wklej, cofnij, zaznacz).';
    if (mod && key === 'Z' && shift) return 'Standardowe skróty edycji tekstu (kopiuj, wklej, cofnij, zaznacz).';
    if (scope === 'editor' && mod && EDITOR_LETTERS.has(key)) return 'Ten skrót jest używany przez edytor kodu.';
    if (scope === 'editor' && key === 'Tab') return 'Ten skrót jest używany przez edytor kodu.';
  } else if (scope === 'files-tree') {
    if (['Left', 'Right', 'Up', 'Down', 'Home', 'End'].includes(key) && !ctrl && !alt && !meta) return 'Strzałki i Home/End poruszają się po drzewie plików.';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution of the persisted overrides

export type Overrides = Record<string, string | null>;
export type ShortcutProblemKind = 'malformed' | 'fixed' | 'reserved' | 'conflict';
export interface ShortcutProblem { kind: ShortcutProblemKind; stored: string; reason?: MessageKey; with?: string }
export interface ShortcutResolution {
  combos: Record<string, Combo | null>;
  source: Record<string, 'default' | 'custom' | 'disabled'>;
  /** Overrides found in the saved settings that cannot be used (they fall back to the default). */
  problems: Record<string, ShortcutProblem>;
  /** The older keys that still work for an action on its default (see `ShortcutDef.aliases`). */
  aliases: Record<string, Combo[]>;
  /** The overrides that survive: exactly what normalisation writes back. */
  overrides: Overrides;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Turns the saved overrides into the combos in force. Unknown ids and malformed combos are ignored, an override that is reserved
 * or collides with another action falls back to the default (when two collide, the one later in the registry loses), so the
 * result never contains two actions on the same key and never depends on the order of the stored keys.
 */
export function resolveShortcuts(raw: unknown, platform: AppPlatform, defs: readonly ShortcutDef[] = SHORTCUT_DEFS): ShortcutResolution {
  const stored = isRecord(raw) ? raw : {};
  const problems: Record<string, ShortcutProblem> = {};
  const defaults = new Map(defs.map((def) => [def.id, defaultCombo(def, platform)]));
  const candidates = new Map<string, Combo | null>();
  for (const def of defs) {
    if (!Object.hasOwn(stored, def.id)) continue;
    const value = stored[def.id];
    const text = value === null ? 'null' : String(value);
    if (!def.rebindable) { problems[def.id] = { kind: 'fixed', stored: text }; continue; }
    if (value === null) { candidates.set(def.id, null); continue; }
    const combo = parseCombo(value);
    if (!combo) { problems[def.id] = { kind: 'malformed', stored: text }; continue; }
    const reason = reservedReason(combo, platform, def.scope, defaults.get(def.id));
    if (reason) { problems[def.id] = { kind: 'reserved', stored: formatCombo(combo), reason }; continue; }
    if (sameCombo(combo, defaults.get(def.id))) continue;
    candidates.set(def.id, combo);
  }
  const current = () => defs.map((def) => [def, (candidates.has(def.id) ? candidates.get(def.id) : defaults.get(def.id)) ?? null] as const);
  for (;;) {
    const list = current();
    let victim: ShortcutDef | null = null;
    let other = '';
    search: for (let j = 1; j < list.length; j++) {
      for (let i = 0; i < j; i++) {
        const [a, ca] = list[i], [b, cb] = list[j];
        if (!ca || !cb || !sameCombo(ca, cb) || !scopesOverlap(a.scope, b.scope)) continue;
        victim = candidates.has(b.id) ? b : candidates.has(a.id) ? a : null;
        other = victim === b ? a.id : b.id;
        if (victim) break search;
      }
    }
    if (!victim) break;
    problems[victim.id] = { kind: 'conflict', stored: formatCombo(candidates.get(victim.id)!), with: other };
    candidates.delete(victim.id);
  }
  const combos: ShortcutResolution['combos'] = {};
  const source: ShortcutResolution['source'] = {};
  const overrides: Overrides = {};
  for (const [def, combo] of current()) {
    combos[def.id] = combo;
    source[def.id] = !candidates.has(def.id) ? 'default' : combo ? 'custom' : 'disabled';
    if (candidates.has(def.id)) overrides[def.id] = combo ? formatCombo(combo) : null;
  }
  const aliases: ShortcutResolution['aliases'] = {};
  for (const def of defs) {
    if (source[def.id] !== 'default' || !def.aliases) continue;
    const extra = def.aliases.map((text) => parseDefault(text, platform)).filter((alias): alias is Combo => !!alias && !sameCombo(alias, combos[def.id]));
    if (extra.length) aliases[def.id] = extra;
  }
  return { combos, source, problems, aliases, overrides };
}

/** Does this key press trigger the action: its combo, or (on its default) one of the older aliases. */
export function matchShortcut(event: KeyEventLike, resolution: ShortcutResolution, id: string): boolean {
  return matchCombo(event, resolution.combos[id]) || (resolution.aliases[id] ?? []).some((alias) => matchCombo(event, alias));
}

/** Bare Backspace switches a shortcut off while recording, except in the file tree, where Backspace is a key that can be assigned. */
export const backspaceDisables = (def: ShortcutDef): boolean => def.scope !== 'files-tree';

/**
 * Keeps auto-repeat of the keys that just finished recording from firing the new action: armed when a recording ends, it swallows
 * repeated key presses until a fresh press or the release of a non-modifier key.
 */
export class RepeatGuard {
  private armed = false;
  arm(): void { this.armed = true; }
  /** For a keydown: true when it is an auto-repeat to ignore. */
  swallow(event: { repeat?: boolean }): boolean {
    if (!this.armed) return false;
    if (event.repeat) return true;
    this.armed = false;
    return false;
  }
  /** For a keyup. */
  release(event: { code: string }): void {
    if (!/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(event.code)) this.armed = false;
  }
}

/** The overrides that may be stored: what `resolveShortcuts` keeps. */
export const normalizeShortcutOverrides = (raw: unknown, platform: AppPlatform): Overrides => resolveShortcuts(raw, platform).overrides;

export type ShortcutCheck =
  | { ok: true; same: boolean }
  | { ok: false; kind: 'fixed' }
  | { ok: false; kind: 'reserved'; reason: MessageKey }
  | { ok: false; kind: 'conflict'; with: ShortcutDef[]; swappable: boolean };

/** Can `combo` be assigned to `id` right now? Never a silent yes for a reserved key or a key another action uses. */
export function checkAssignment(id: string, combo: Combo, resolution: ShortcutResolution, platform: AppPlatform, defs: readonly ShortcutDef[] = SHORTCUT_DEFS): ShortcutCheck {
  const def = defs.find((d) => d.id === id);
  if (!def || !def.rebindable) return { ok: false, kind: 'fixed' };
  const reason = reservedReason(combo, platform, def.scope, defaultCombo(def, platform));
  if (reason) return { ok: false, kind: 'reserved', reason };
  const clashing = defs.filter((other) => other.id !== id && sameCombo(resolution.combos[other.id], combo) && scopesOverlap(def.scope, other.scope));
  if (clashing.length) return { ok: false, kind: 'conflict', with: clashing, swappable: clashing.every((other) => other.rebindable) };
  return { ok: true, same: sameCombo(resolution.combos[id], combo) };
}

/** New overrides with `id` set to a combo, disabled (null) or back to its default (`undefined`). */
export function setOverride(overrides: Overrides, id: string, value: Combo | null | undefined, platform: AppPlatform): Overrides {
  const next = { ...overrides };
  const def = shortcutDef(id);
  if (value === undefined || (value && def && sameCombo(value, defaultCombo(def, platform)))) delete next[id];
  else next[id] = value ? formatCombo(value) : null;
  return next;
}

/** Assigns `combo` to `id` and disables the actions that had it. */
export function swapShortcut(overrides: Overrides, id: string, combo: Combo, taken: readonly ShortcutDef[], platform: AppPlatform): Overrides {
  let next = setOverride(overrides, id, combo, platform);
  for (const other of taken) next = setOverride(next, other.id, null, platform);
  return next;
}
