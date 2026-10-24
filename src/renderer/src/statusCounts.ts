import { useMemo } from 'react';
import { NO_COUNTS, statusCountsKey } from '../../shared/statusCounts';
import type { StatusCounts } from '../../shared/status';
import { useStore } from './store';

/** Badge counts by tab id and projectCountsKey(project id); re-renders only when a count changes, not on every status flip. */
export function useStatusCounts(): (key: string) => StatusCounts {
  const key = useStore((st) => statusCountsKey(st.s.projects, st.ui.statuses, st.ui.statusDetails));
  return useMemo(() => {
    const counts = JSON.parse(key) as Record<string, StatusCounts>;
    return (id: string) => counts[id] ?? NO_COUNTS;
  }, [key]);
}
