// The zoom of the whole window (View > Zoom in / Zoom out / Actual size of the title bar menu). The webview itself zooms
// (window:setZoom), so terminals, canvases and hit tests stay exact; the level is kept in localStorage, which every window of
// the app shares, and applied when a window starts. `--ui-zoom` lets the CSS keep native things (the Windows caption buttons,
// the macOS traffic lights) at their real size.
import { create } from 'zustand';
import { readZoomLevel, stepZoomLevel } from '../../shared/uiZoomLevels';

const KEY = 'mc-ui-zoom';
function stored(): number {
  try { return readZoomLevel(localStorage.getItem(KEY)); } catch { return 1; }
}

export const useUiZoom = create<{ zoom: number }>(() => ({ zoom: stored() }));
export const uiZoom = (): number => useUiZoom.getState().zoom;

function apply(zoom: number): void {
  document.documentElement.style.setProperty('--ui-zoom', String(zoom));
  useUiZoom.setState({ zoom });
  window.mc?.windowControls?.setZoom?.(zoom);
}

export function setUiZoom(zoom: number): void {
  const level = readZoomLevel(String(zoom));
  try {
    if (level === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(level));
  } catch { /* the level still applies to this window */ }
  apply(level);
}

export const stepUiZoom = (dir: 1 | -1): void => setUiZoom(stepZoomLevel(uiZoom(), dir));

let started = false;
/** At the start of every window: the saved level, and the level another window sets later. */
export function initUiZoom(): void {
  if (started) return;
  started = true;
  const zoom = uiZoom();
  document.documentElement.style.setProperty('--ui-zoom', String(zoom));
  if (zoom !== 1) apply(zoom);
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) apply(stored()); });
}
