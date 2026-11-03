import { useId } from 'react';
import { useBlink } from '../blink';

/**
 * One visual language for a status wherever it shows (the badges of a tab and a project, the mark on a cell's icon, the
 * status in the cell header): working, waiting for you (a finished turn), asking (a permission, a question, an MCP form),
 * an error, exited, idle. Colours: --st-* in statusStyles.css. 1.1.2: crisp SVG marks (a turning arc, filled discs with a
 * cut-out check, "!" and cross, a ring), each state with its own shape, so they read apart without the colour too.
 */
export type StatusKind = 'working' | 'done' | 'ask' | 'error' | 'exited' | 'idle';
/** The kind of a cell's status for the mark. */
export function statusKind(status: string, error: boolean, detailKind?: string): StatusKind {
  if (error) return 'error';
  if (status === 'working') return 'working';
  if (status === 'waiting') return detailKind === 'permission' || detailKind === 'question' || detailKind === 'elicitation' ? 'ask' : 'done';
  if (status === 'exited') return 'exited';
  return 'idle';
}

/** The mark of a status; `className` places it (the badges, the header, the icon's corner). Decorative: the text says it. */
export function StatusMark({ kind, className = '' }: { kind: StatusKind; className?: string }) {
  // The working mark steps with the shared pulse (blink.ts): no CSS animation runs while agents work.
  useBlink(kind === 'working');
  const mask = `sm${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const cls = `smark ${kind}${className ? ` ${className}` : ''}`;
  // A 12-unit SVG drawn at the size the CSS gives it; the cut-outs are masks, so the mark sits on any background.
  return (
    <span className={cls} aria-hidden="true">
      <svg viewBox="0 0 12 12" width="100%" height="100%">
        {kind === 'working' && <>
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".25" />
          <path className="arc" d="M6 1.4a4.6 4.6 0 0 1 4.6 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>}
        {(kind === 'done' || kind === 'ask' || kind === 'error') && <>
          <mask id={mask}>
            <rect width="12" height="12" fill="#fff" />
            {kind === 'done' && <path d="M3.6 6.2l1.6 1.6 3.2-3.4" fill="none" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
            {kind === 'ask' && <><rect x="5.25" y="2.9" width="1.5" height="4" rx=".75" fill="#000" /><circle cx="6" cy="8.75" r=".85" fill="#000" /></>}
            {kind === 'error' && <path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" stroke="#000" strokeWidth="1.5" strokeLinecap="round" />}
          </mask>
          <circle cx="6" cy="6" r="5.6" fill="currentColor" mask={`url(#${mask})`} />
        </>}
        {kind === 'exited' && <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />}
        {kind === 'idle' && <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 2.42" />}
      </svg>
    </span>
  );
}
