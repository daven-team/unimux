import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DetachedApp } from './components/DetachedApp';
import { detachedId } from './windowRole';
import { ErrorBoundary, WindowFallback } from './components/ErrorBoundary';
import { TooltipHost } from './components/TooltipHost';
import { CaptionButtons } from './components/CaptionButtons';
import { installErrorReporting } from './errorReport';
import './styles.css';
import './components/statusStyles.css';
import { watchSpinners } from '../../shared/spinSync';
import { onWindowShown } from './windowShown';

installErrorReporting();
watchSpinners(document, requestAnimationFrame, onWindowShown);
// The last resort: a render error no inner boundary caught leaves a "reload the window" card, not a blank window.
// The tooltip host sits beside the app: titles get the styled bubble on the boot and language screens and the fallback too.
// So do the caption buttons of the Tauri build on Windows (W1): every screen of every window has them, like 1.1.4's overlay.
// A detached window (1.0.6, `?detached=<id>`) shows one tab with its own title bar instead of the whole app.
const Root = detachedId !== null ? DetachedApp : App;
createRoot(document.getElementById('root')!).render(<><ErrorBoundary name="window" fallback={() => <WindowFallback />}><Root /></ErrorBoundary><TooltipHost /><CaptionButtons /></>);

// Handle for automated smoke tests driven over the DevTools protocol.
import * as actions from './actions';
import { useStore } from './store';
import { terminals } from './terminals/TerminalManager';
import { useSftpStore } from './sftpStore';
import { useFileStore } from './files';
import * as files from './files';
import * as detach from './detach';
import * as dbTabs from './db/tabs';
import * as dbClient from './db/dbClient';
import * as redis from './redis/redisClient';
(window as unknown as { __mc: unknown }).__mc = { actions, useStore, terminals, useSftpStore, useFileStore, files, detach, dbTabs, dbClient, redis };

// A file dropped anywhere the app does not handle must never make the window navigate to it.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => { if (!e.defaultPrevented && e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
}
