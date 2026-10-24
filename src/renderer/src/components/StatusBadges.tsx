import { useI18n } from '../i18n';
import type { StatusCounts } from '../../../shared/status';

/**
 * ◐ working · ● waiting for you · ✕ exited. 1.0.7: an exit with a non-zero code is a red ✕ (like the cell's pill and dot),
 * a clean exit a grey one.
 */
export function StatusBadges({ counts }: { counts: StatusCounts }) {
  const { tr } = useI18n();
  const failed = counts.failed ?? 0;
  const items: Array<[string, string, number, string]> = [
    ['working', '◐', counts.working, tr("pracuje")],
    ['waiting', '●', counts.waiting, tr("czeka na Ciebie")],
    ['failed', '✕', failed, tr("zakończony z błędem")],
    ['exited', '✕', counts.exited - failed, tr("zakończony")],
  ];
  const shown = items.filter(([, , n]) => n > 0);
  if (!shown.length) return null;
  return (
    <span className="badges">
      {shown.map(([k, icon, n, label]) => (
        <span key={k} className={`badge ${k}`} title={`${n} ${label}`}>
          {icon}
          <span>{n}</span>
        </span>
      ))}
    </span>
  );
}
