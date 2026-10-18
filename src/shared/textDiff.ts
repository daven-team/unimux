// A small line diff of two texts (the file on disk vs the editor) in the line shape of the Git diff view.
import type { DiffLine } from './git';

/** The smallest single replacement turning `before` into `after` (common start and end kept), as an editor change. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/** Above this many cells the middle part is shown as removed + added instead of being matched line by line. */
const MAX_CELLS = 4_000_000;

/**
 * Unified-style lines from `before` to `after`: common lines as context (only `context` lines around each change, the
 * rest folded into a 'hunk' line), removed and added lines with their numbers. Line breaks are normalized first.
 */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before.replace(/\r\n|\r/g, '\n').split('\n');
  const b = after.replace(/\r\n|\r/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const all: DiffLine[] = [];
  for (let i = 0; i < start; i++) all.push({ kind: 'ctx', text: a[i], oldNo: i + 1, newNo: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    midA.forEach((text, i) => all.push({ kind: 'del', text, oldNo: start + i + 1 }));
    midB.forEach((text, j) => all.push({ kind: 'add', text, newNo: start + j + 1 }));
  } else {
    // lcs[i][j] = length of the longest common subsequence of midA[i..] and midB[j..]
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { all.push({ kind: 'ctx', text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 }); i++; j++; }
      else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { all.push({ kind: 'add', text: midB[j], newNo: start + j + 1 }); j++; }
      else { all.push({ kind: 'del', text: midA[i], oldNo: start + i + 1 }); i++; }
    }
  }
  for (let k = 0; k < a.length - endA; k++) all.push({ kind: 'ctx', text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  // Fold long runs of unchanged lines.
  const keep = all.map(() => false);
  all.forEach((line, k) => {
    if (line.kind === 'ctx') return;
    for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) keep[x] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, k) => {
    if (keep[k]) {
      if (skipped) out.push({ kind: 'hunk', text: '⋯' });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  return out;
}
