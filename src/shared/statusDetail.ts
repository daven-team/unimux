// The label of a cell status with its detail ("czeka na zgodę: Bash", "praca: Edit", "limit osiągnięty"): what the most precise
// signal said about the current state. The tracker (status.ts) keeps the detail; the cell card shows this as secondary text.
import { errorPhrase } from './alerts';
import type { MessageKey, MessageParams } from './i18n';
import type { CellStatus, StatusDetail, StatusReason } from './status';

export type { StatusDetail, StatusDetailKind } from './status';

/** What the card shows for a status: a message key (Polish) and its parameters. */
export interface StatusText {
  key: MessageKey;
  params?: MessageParams;
}

/**
 * The label of a status and its detail. `error` is the code of a waiting-with-error (StopFailure code, usage-limit).
 * Returns null where nothing needs saying (an idle cell without a detail).
 */
export function statusText(status: CellStatus, reason: StatusReason | undefined, detail: StatusDetail | undefined, error?: string): StatusText | null {
  if (status === 'exited') return detail?.kind === 'exit-code' && detail.code ? { key: 'zakończony (kod {code})', params: { code: detail.code } } : { key: 'zakończony' };
  if (status === 'working') {
    if (detail?.kind === 'tool' && detail.tool) return { key: 'praca: {tool}', params: { tool: detail.tool } };
    if (detail?.kind === 'subagent') return detail.tool ? { key: 'subagent: {name}', params: { name: detail.tool } } : { key: 'subagent pracuje' };
    if (detail?.kind === 'compact') return { key: 'kompaktuje kontekst' };
    if (detail?.kind === 'background') return { key: 'zadania w tle' };
    if (detail?.kind === 'command') return { key: 'polecenie działa' };
    return { key: 'pracuje' };
  }
  if (status === 'waiting') {
    if (reason === 'error') return { key: errorPhrase(error) };
    switch (detail?.kind) {
      case 'permission': return detail.tool ? { key: 'czeka na zgodę: {tool}', params: { tool: detail.tool } } : { key: 'czeka na zgodę' };
      case 'question': return { key: 'pyta Cię o coś' };
      case 'elicitation': return { key: 'serwer MCP prosi o dane' };
      case 'input': return { key: 'czeka na Twoją odpowiedź' };
      case 'interrupted': return { key: 'przerwane' };
      case 'exit-code': return detail.code !== undefined ? { key: 'kod wyjścia {code}', params: { code: detail.code } } : { key: 'czeka na Ciebie' };
      default: return reason === 'attention' ? { key: 'czeka na Twoją odpowiedź' } : { key: 'czeka na Ciebie' };
    }
  }
  if (detail?.kind === 'cli-exited') return detail.code ? { key: 'CLI zakończył działanie (kod {code})', params: { code: detail.code } } : { key: 'CLI zakończył działanie' };
  if (detail?.kind === 'exit-code' && detail.code !== undefined) return { key: 'kod wyjścia {code}', params: { code: detail.code } };
  return null;
}

/**
 * 1.0.7: a non-zero exit code (of the last command, of the agent CLI, of the cell's process) is an error wherever it shows:
 * the pill, the dot and the badges of the tab and the project use the error colour; code 0 stays neutral.
 */
export function failedExit(detail: StatusDetail | undefined): boolean {
  return (detail?.kind === 'exit-code' || detail?.kind === 'cli-exited') && !!detail.code;
}
