import type { ReactElement } from 'react';
import type { GraphRow } from '../../../shared/git';
import { LANE_COLORS } from '../../../shared/gitUi';

/** The height of one history row (22px like Cursor's rows; .git-rows .git-commit in gitPanel.css uses the same). */
export const GRAPH_ROW = 22;
const LANE = 11;
const MAX_LANES = 6;

/** How many lanes the graph column of a list needs (the same for every row, so the commit texts line up). */
export function graphLanes(rows: readonly GraphRow[]): number {
  let lanes = 1;
  for (const row of rows) lanes = Math.max(lanes, row.bottom.length, row.top.length, row.col + 1);
  return Math.min(MAX_LANES, lanes);
}

/** The graph cell of one history row: the lanes passing by and the commit's dot. Lanes beyond the sixth are not drawn. */
export function GitGraph({ row, lanes }: { row: GraphRow; lanes: number }) {
  const x = (lane: number): number => 6 + Math.min(lane, MAX_LANES - 1) * LANE;
  const mid = GRAPH_ROW / 2;
  const color = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length];
  const lines: ReactElement[] = [];
  row.top.forEach((hash, lane) => {
    if (hash === null || lane >= MAX_LANES) return;
    const toDot = row.toDot.includes(lane);
    lines.push(<line key={`t${lane}`} x1={x(lane)} y1={0} x2={toDot ? x(row.col) : x(lane)} y2={mid} stroke={color(lane)} />);
  });
  row.bottom.forEach((hash, lane) => {
    if (hash === null || lane >= MAX_LANES) return;
    const fromDot = row.fromDot.includes(lane);
    // a lane that passed by the dot continues straight; one that starts at the dot leaves it towards its own column
    const passing = !fromDot || lane === row.col;
    lines.push(<line key={`b${lane}`} x1={passing ? x(lane) : x(row.col)} y1={mid} x2={x(lane)} y2={GRAPH_ROW} stroke={color(lane)} />);
  });
  const width = 12 + (Math.max(lanes, 1) - 1) * LANE;
  return (
    <svg className="git-graph" width={width} height={GRAPH_ROW} viewBox={`0 0 ${width} ${GRAPH_ROW}`} aria-hidden>
      <g strokeWidth="1.6" strokeLinecap="round">{lines}</g>
      <circle cx={x(row.col)} cy={mid} r="3.2" fill={color(row.col)} stroke="var(--bg)" strokeWidth="1.5" />
    </svg>
  );
}
