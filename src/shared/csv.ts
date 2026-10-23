// A small CSV / TSV reader for the table view: quoted fields, doubled quotes, CRLF, a delimiter chosen from the file.
export interface ParsedTable { rows: string[][]; delimiter: string; truncated: boolean }

/** Comma, semicolon, tab or pipe: the one that splits the first lines into the most (and a steady number of) fields. */
export function detectDelimiter(text: string, extension = ''): string {
  if (extension === 'tsv') return '\t';
  const lines = text.split(/\r\n|\r|\n/).slice(0, 5).filter(Boolean);
  let best = ',';
  let bestScore = 0;
  for (const candidate of [',', ';', '\t', '|']) {
    const counts = lines.map((line) => line.split(candidate).length - 1);
    const min = Math.min(...counts, Infinity);
    const score = Number.isFinite(min) ? min : 0;
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

/**
 * Rows the table view of a CSV / TSV tab parses: it draws only the rows on screen and its find searches all of them, so the
 * whole file that was read fits (a 50 000-row export), while a runaway file still stops somewhere.
 */
export const TABLE_VIEW_ROWS = 200_000;

export function parseDelimited(text: string, delimiter: string, maxRows = 5000): ParsedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  const end = (): boolean => {
    row.push(field); field = '';
    rows.push(row); row = [];
    if (rows.length >= maxRows) { truncated = true; return true; }
    return false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (end()) return { rows, delimiter, truncated };
    } else field += ch;
  }
  if (field !== '' || row.length) end();
  return { rows, delimiter, truncated };
}

export const isDelimitedPath = (path: string): boolean => /\.(csv|tsv)$/i.test(path);
