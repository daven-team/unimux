// "Kontekst 32%" with a tiny bar among the muted details of an agent cell's header; hidden while the usage is unknown.
import { useEffect } from 'react';
import { contextLevel, groupDigits } from '../../../shared/contextUsage';
import type { Cell } from '../../../shared/types';
import { loadContext, useContextStore } from '../contextStore';
import { useI18n } from '../i18n';
import './contextMeter.css';

export function ContextMeter({ cell }: { cell: Cell }) {
  const { tr } = useI18n();
  const usage = useContextStore((st) => st.usage[cell.id]);
  const session = cell.session ? `${cell.session.cli}:${cell.session.id}` : '';
  // A new conversation (or the first one bound to the cell) is read at once; later changes come from main's hooks.
  useEffect(() => { if (session) loadContext(cell.id); else useContextStore.getState().set(cell.id, null); }, [cell.id, session]);
  if (!usage || !session) return null;
  const level = contextLevel(usage.percent);
  const title = [
    tr('Kontekst rozmowy: {tokens} / {window} tokenów', { tokens: groupDigits(usage.tokens), window: groupDigits(usage.window) }),
    usage.model ? tr('Model: {model}', { model: usage.model }) : '',
    level === 'high' ? tr('Kontekst prawie pełny: agent wkrótce go skompaktuje.') : '',
  ].filter(Boolean).join('\n');
  return (
    <span className={`meta-item context-meter ${level}`} title={title}>
      <span className="context-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, usage.percent)}%` }} /></span>
      <span className="context-text">{tr('Kontekst {percent}%', { percent: usage.percent })}</span>
    </span>
  );
}
