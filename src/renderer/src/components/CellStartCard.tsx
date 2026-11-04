// 1.1.5: the start card of an agent cell (shared/startScreen.ts). While the CLI starts it covers the shell with the long launch
// line: the provider mark, "Uruchamianie Claude…", a quiet spinner. A CLI that ends at its start turns it into an error card
// in the same panel (the code, the lines it printed, its recent output) with Uruchom ponownie, Pokaż terminal, Kopiuj błąd.
// The card never takes the keyboard: a click on it focuses the terminal underneath, so typing reaches the CLI (it reads the
// keys once it is up) and the card stays until the agent is up.
import { useState, useSyncExternalStore } from 'react';
import type { UsageProvider } from '../../../shared/usage';
import type { StartScreen } from '../../../shared/startScreen';
import { useI18n } from '../i18n';
import { toast } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { BusyRing } from './Spinner';
import { ProviderIcon } from './ProviderIcons';
import { StatusMark } from './StatusMark';
import './cellStart.css';

/** The start card of a cell as the terminal manager has it (null: the terminal shows). */
export function useStartScreen(cellId: string): StartScreen | null {
  return useSyncExternalStore(
    (changed) => terminals.onStartScreen((id) => { if (id === cellId) changed(); }),
    () => terminals.startScreen(cellId),
  );
}

export function CellStartCard({ cellId, cli, name, screen, onRestart }: {
  cellId: string; cli: UsageProvider; name: string; screen: StartScreen; onRestart: () => void;
}) {
  const { tr } = useI18n();
  const [outputOpen, setOutputOpen] = useState(false);
  const failed = screen.phase === 'failed' ? screen : null;
  const title = failed ? tr('Nie udało się uruchomić {name}', { name }) : tr('Uruchamianie {name}…', { name });
  const sub = failed
    ? (failed.code ? tr('kod wyjścia {code}', { code: failed.code }) : tr('CLI zakończył działanie'))
    : tr(screen.phase === 'starting' && screen.resume ? 'Wznawianie rozmowy' : 'Nowa rozmowa');
  // A click anywhere but a control or the copyable text gives the keyboard to the terminal under the card.
  const toTerminal = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, pre, summary')) return;
    e.preventDefault();
    terminals.focus(cellId);
  };
  const copy = () => {
    if (!failed) return;
    window.mc.clipboardWrite([title + (failed.code ? ` (${tr('kod wyjścia {code}', { code: failed.code })})` : ''), ...(failed.tail.length ? failed.tail : failed.errorLines)].join('\n'));
    toast(tr('Skopiowano'));
  };
  return (
    <div className={`cell-start${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'} aria-label={title} onMouseDown={toTerminal}>
      <div className="cell-start-frame"><div className="cell-start-panel">
        <div className="cell-start-head">
          <span className="cell-start-mark" aria-hidden="true">
            <ProviderIcon provider={cli} size={16} />
            {failed && <StatusMark kind="error" className="cell-start-badge" />}
          </span>
          <div className="cell-start-name">
            <strong title={title}>{title}</strong>
            <span>{sub}</span>
          </div>
          {!failed && <BusyRing className="cell-start-ring" />}
        </div>
        {failed && failed.errorLines.length > 0 && <pre className="cell-start-error">{failed.errorLines.join('\n')}</pre>}
        {failed && failed.tail.length > 0 && (
          <div className="cell-start-output">
            <button type="button" className="cell-start-toggle" aria-expanded={outputOpen} onClick={() => setOutputOpen(!outputOpen)}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={outputOpen ? 'M2 3.5l3 3 3-3' : 'M3.5 2l3 3-3 3'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>{tr('Ostatnie polecenia / wyjście')}</span>
            </button>
            {outputOpen && <pre className="cell-start-tail">{failed.tail.join('\n')}</pre>}
          </div>
        )}
        <div className="cell-start-actions">
          {failed && <button type="button" className="btn small ghost" onClick={copy}>{tr('Kopiuj błąd')}</button>}
          <button type="button" className={`btn small${failed ? '' : ' ghost'}`} onClick={() => { terminals.showTerminal(cellId); terminals.focus(cellId); }}>{tr('Pokaż terminal')}</button>
          {failed && <button type="button" className="btn small primary" onClick={onRestart}>{tr('Uruchom ponownie')}</button>}
        </div>
      </div></div>
    </div>
  );
}
