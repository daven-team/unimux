import { useI18n } from '../i18n';
import type { StatusCounts } from '../../../shared/status';
import { StatusMark, type StatusKind } from './StatusMark';

/**
 * The counts of a tab or a project: working, waiting for you, exited. 1.0.7: an exit with a non-zero code counts as an error
 * (like the cell's mark), a clean exit as a grey one. 1.1.2: a status mark and a plain number, no tinted pill (StatusMark.tsx).
 */
export function StatusBadges({ counts }: { counts: StatusCounts }) {
  const { tr } = useI18n();
  const failed = counts.failed ?? 0;
  const items: Array<[string, StatusKind, number, string]> = [
    ['working', 'working', counts.working, tr("pracuje")],
    ['waiting', 'done', counts.waiting, tr("czeka na Ciebie")],
    ['failed', 'error', failed, tr("zakończony z błędem")],
    ['exited', 'exited', counts.exited - failed, tr("zakończony")],
  ];
  const shown = items.filter(([, , n]) => n > 0);
  if (!shown.length) return null;
  return (
    <span className="badges">
      {shown.map(([k, kind, n, label]) => (
        <span key={k} className={`badge ${k}`} title={`${n} ${label}`}>
          <StatusMark kind={kind} />
          <span className="n">{n}</span>
        </span>
      ))}
    </span>
  );
}
