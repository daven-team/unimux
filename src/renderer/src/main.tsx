import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary, WindowFallback } from './components/ErrorBoundary';
import { TooltipHost } from './components/TooltipHost';
import { installErrorReporting } from './errorReport';
import './styles.css';

installErrorReporting();
// The last resort: a render error no inner boundary caught leaves a "reload the window" card, not a blank window.
// The tooltip host sits beside the app: titles get the styled bubble on the boot and language screens and the fallback too.
createRoot(document.getElementById('root')!).render(<><ErrorBoundary name="window" fallback={() => <WindowFallback />}><App /></ErrorBoundary><TooltipHost /></>);

// Handle for automated smoke tests driven over the DevTools protocol.
import * as actions from './actions';
import { useStore } from './store';
import { terminals } from './terminals/TerminalManager';
import { useSftpStore } from './sftpStore';
import { useFileStore } from './files';
(window as unknown as { __mc: unknown }).__mc = { actions, useStore, terminals, useSftpStore, useFileStore };

// A file dropped anywhere the app does not handle must never make the window navigate to it.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => { if (!e.defaultPrevented && e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
}
