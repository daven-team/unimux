import { shortcutLabel } from '../../shared/platform';
import type { WebviewEngine } from '../../shared/terminalLimits';

export const keyLabel = (value: string) => shortcutLabel(window.mc.platform, value);

export const hasPrimaryModifier = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  window.mc.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/**
 * The browser engine this page runs in: WebKit only in the Tauri app on macOS (the bridge reports it in window.__MC_COMPAT__,
 * src/renderer/src/bridge/webkitCompat.ts); Electron (any OS) and WebView2 are Chromium.
 */
export const webviewEngine = (): WebviewEngine =>
  (window as { __MC_COMPAT__?: { engine?: WebviewEngine } }).__MC_COMPAT__?.engine === 'webkit' ? 'webkit' : 'chromium';
