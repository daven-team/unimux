// Which app-wide action (if any) a key press triggers: the pure decision behind the renderer's global keydown listener.
// Scope rules live here so they can be tested with fake events.
import { matchShortcut, SHORTCUT_DEFS, type ShortcutDef, type ShortcutResolution } from './shortcuts';

export interface DispatchEvent {
  code: string; key?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
  getModifierState?(key: string): boolean;
}

export interface DispatchContext {
  resolution: ShortcutResolution;
  /** The first-run language choice is still pending: no shortcuts. */
  languageChosen: boolean;
  /** The Settings screen records a new combination: the app must not react to it. */
  recording: boolean;
  /** A dialog or modal is open (only the palette shortcut that closes the palette still works). */
  overlayOpen: boolean;
  paletteOpen: boolean;
  settingsActive: boolean;
  hasProject: boolean;
  /** A tab of the strip is in front (a grid, a file, the SSH view or Settings). */
  hasTab: boolean;
  /** What has the focus: the terminal, a text field (input, textarea, editor), or something else. */
  target: 'terminal' | 'input' | 'other';
  defs?: readonly ShortcutDef[];
}

const PALETTE = new Set(['palette.open', 'palette.openAlt']);
const DISPATCHED = new Set(['global', 'cell']);

/** Id of the action to run (the caller then stops the event), or null to let the key through to whatever has the focus. */
export function decideShortcut(event: DispatchEvent, ctx: DispatchContext): string | null {
  if (!ctx.languageChosen || ctx.recording) return null;
  const defs = ctx.defs ?? SHORTCUT_DEFS;
  const modified = event.ctrlKey || event.altKey || event.metaKey;
  for (const def of defs) {
    if (!DISPATCHED.has(def.scope) || !matchShortcut(event, ctx.resolution, def.id)) continue;
    // Over a dialog, modal or the palette itself only the palette key works, and it closes the palette.
    if (ctx.overlayOpen || ctx.paletteOpen) return ctx.paletteOpen && PALETTE.has(def.id) ? def.id : null;
    // Plain keys (F-keys) belong to the terminal and to text fields.
    if (!modified && ctx.target !== 'other') continue;
    if (ctx.target === 'input' && def.allowInInput === false) continue;
    if (def.terminalOnly && ctx.target !== 'terminal') continue;
    if (def.id === 'tab.close') {
      // It closes the tab in front of the strip (Settings, the SSH view, a file or a grid), if there is one.
      if (ctx.settingsActive || ctx.hasTab) return def.id;
      continue;
    }
    if (def.requiresProject && !ctx.hasProject) continue;
    if (def.blockedInSettings && ctx.settingsActive) continue;
    return def.id;
  }
  return null;
}
