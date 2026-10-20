import { useId, type ReactNode } from 'react';
import { fileIconId, pixelPath, type FileIconId } from '../../../shared/fileIcons';
import './file-workspace.css';

// Every glyph is drawn for a 16 px box at 1:1 (never scaled): fills sit on whole pixels and 1 px outlines on half
// pixels, so the straight edges stay sharp; only diagonals and curves are anti-aliased. Letters come from a small pixel
// font (2 px strokes) instead of SVG text, which blurs at these sizes.

const BLUE = '#4f9fe3', CYAN = '#5ccfe6', YELLOW = '#e6cf4f', AMBER = '#e2b34a', ORANGE = '#e8804a', RED = '#e8634f';
const GREEN = '#8bc46a', PURPLE = '#b48ae0', PINK = '#e7739f', GREY = '#9aa4b2', BROWN = '#c49a6c';

/** Pixel font: 6×8 cells (M is 7 wide). */
const FONT: Record<string, readonly string[]> = {
  T: ['######', '######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  S: ['.#####', '######', '##....', '#####.', '.#####', '....##', '######', '#####.'],
  J: ['....##', '....##', '....##', '....##', '....##', '##..##', '######', '.####.'],
  G: ['.#####', '######', '##....', '##.###', '##.###', '##..##', '######', '.####.'],
  O: ['.####.', '######', '##..##', '##..##', '##..##', '##..##', '######', '.####.'],
  C: ['.#####', '######', '##....', '##....', '##....', '##....', '######', '.#####'],
  H: ['##..##', '##..##', '##..##', '######', '######', '##..##', '##..##', '##..##'],
  R: ['#####.', '######', '##..##', '##..##', '#####.', '##.##.', '##..##', '##..##'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##', '##...##', '##...##'],
  '↓': ['..##..', '..##..', '..##..', '..##..', '..##..', '######', '.####.', '..##..'],
  '#': ['.#..#.', '.#..#.', '######', '.#..#.', '.#..#.', '######', '.#..#.', '.#..#.'],
  '+': ['', '..##..', '..##..', '######', '######', '..##..', '..##..', ''],
};

/** A word in the pixel font, centred horizontally, 1 px between letters, its top on row `y`. */
function word(text: string, y = 4): string {
  const letters = [...text].map((ch) => FONT[ch]);
  const widths = letters.map((rows) => Math.max(...rows.map((row) => row.length)));
  let x = Math.floor((16 - widths.reduce((sum, w) => sum + w + 1, -1)) / 2);
  return letters.map((rows, i) => { const d = pixelPath(rows, x, y); x += widths[i] + 1; return d; }).join('');
}

/** A gear centred in the box, with a round hole (drawn with the even-odd rule). */
function gear(outer = 7, inner = 5, hole = 2.25, teeth = 8): string {
  const step = (Math.PI * 2) / teeth;
  const at = (r: number, a: number) => `${+(8 + r * Math.cos(a)).toFixed(2)} ${+(8 + r * Math.sin(a)).toFixed(2)}`;
  const points: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    points.push(at(inner, a - step * 0.3), at(outer, a - step * 0.17), at(outer, a + step * 0.17), at(inner, a + step * 0.3));
  }
  return `M${points.join('L')}ZM${8 - hole} 8a${hole} ${hole} 0 1 0 ${hole * 2} 0a${hole} ${hole} 0 1 0 ${-hole * 2} 0z`;
}

const DOC = 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3';
const GEAR = gear();
/** Small gear on the bottom right of a config variant (tsconfig.json), clear of the word drawn on rows 0..7. */
const GEAR_BADGE = pixelPath(['..#.#..', '.#####.', '##...##', '.#...#.', '##...##', '.#####.', '..#.#..'], 9, 9);
const PYTHON = [
  '................', '.....bbbbb......', '....b.bbbbb.....', '....bbbbbbb.....', '....bbbbbbb.yy..', '..bbbbbbbbb.yyy.',
  '.bbbbbbbbb..yyy.', '.bbb........yyy.', '.bbb........yyy.', '.bbb..yyyyyyyyy.', '.bbb.yyyyyyyyy..', '..bb.yyyyyyy....',
  '.....yyyyyyy....', '.....yyyyy.y....', '......yyyyy.....',
];

const pixels = (d: string) => <path d={d} shapeRendering="crispEdges" />;
const strokes = (d: string, width = 1) =>
  <path d={d} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />;
const letters = (text: string) => () => pixels(word(text));
const gearIcon = () => <path d={GEAR} />;
const braces = () => pixels(pixelPath(['..###', '.####', '.##..', '.##..', '##...', '##...', '.##..', '.##..', '.####', '..###'], 1, 3)
  + pixelPath(['###..', '####.', '..##.', '..##.', '...##', '...##', '..##.', '..##.', '####.', '###..'], 10, 3));
const hash = () => pixels(pixelPath(['..##..##..', '..##..##..', '##########', '##########', '..##..##..', '..##..##..', '##########', '##########', '..##..##..', '..##..##..'], 3, 3));
const terminal = () => <><path d="M2 4h2.5l4 4-4 4H2l4-4z" />{pixels(pixelPath(['######', '######'], 9, 11))}</>;
const atom = () => <>
  <g fill="none" stroke="currentColor">
    <ellipse cx="8" cy="8" rx="6.5" ry="2.5" />
    <ellipse cx="8" cy="8" rx="6.5" ry="2.5" transform="rotate(60 8 8)" />
    <ellipse cx="8" cy="8" rx="6.5" ry="2.5" transform="rotate(120 8 8)" />
  </g>
  <circle cx="8" cy="8" r="1.5" />
</>;
const picture = () => <>{strokes('M1.5 2.5h13v11h-13z')}<circle cx="5.5" cy="6" r="1.5" /><path d="M2 13 6 9l3 3 2-2 3 3z" /></>;

interface Glyph { color: string; body: (maskId: string) => ReactNode }

const GLYPHS: Record<FileIconId, Glyph> = {
  file: { color: GREY, body: () => strokes(DOC) },
  text: { color: '#b4bcc8', body: () => <>{strokes(DOC)}{pixels(pixelPath(['######', '', '######', '', '####'], 5, 7))}</> },
  log: { color: '#8d9cae', body: () => pixels(pixelPath(['##.###########', '', '', '##.########', '', '', '##.##########', '', '', '##.#######'], 1, 3)) },
  ts: { color: BLUE, body: letters('TS') },
  tsx: { color: BLUE, body: atom },
  js: { color: YELLOW, body: letters('JS') },
  jsx: { color: CYAN, body: atom },
  json: { color: AMBER, body: braces },
  markdown: { color: BLUE, body: letters('M↓') },
  mdx: { color: '#f0a94b', body: letters('M↓') },
  css: { color: BLUE, body: hash },
  scss: { color: PINK, body: hash },
  less: { color: '#6f8fe0', body: hash },
  html: { color: ORANGE, body: () => strokes('M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4', 1.5) },
  xml: { color: '#e5a04a', body: () => strokes('M5 4.5 1.5 8 5 11.5M11 4.5l3.5 3.5-3.5 3.5M9.5 3l-3 10', 1.25) },
  yaml: { color: PURPLE, body: () => pixels(pixelPath(['#########', '#########', '', '', '##.#########', '##.#########', '', '', '##.#######', '##.#######'], 2, 3)) },
  toml: { color: BROWN, body: gearIcon },
  config: { color: GREY, body: gearIcon },
  env: { color: '#e5c07b', body: gearIcon },
  make: { color: '#e0884f', body: gearIcon },
  lock: {
    color: '#cfa85e',
    body: () => <>
      <path d="M5 7.5V5.5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="2" />
      {pixels(pixelPath(['##########', '##########', '####..####', '####..####', '####..####', '##########', '.########.'], 3, 7))}
    </>,
  },
  shell: { color: GREEN, body: terminal },
  powershell: { color: BLUE, body: terminal },
  batch: { color: '#b9c27a', body: terminal },
  python: {
    color: '#5a9be0',
    body: () => <>{pixels(pixelPath(PYTHON, 0, 0, 'b'))}<path d={pixelPath(PYTHON, 0, 0, 'y')} fill="#f0cc4a" shapeRendering="crispEdges" /></>,
  },
  go: { color: '#56c2dd', body: letters('GO') },
  rust: { color: '#e0936b', body: letters('RS') },
  java: {
    color: '#e0695a',
    body: () => <>
      {pixels(pixelPath(['.#..#.', '#..#..', '.#..#.'], 4, 2) + pixelPath(['##########', '##########', '##########', '##########', '.########.', '..######..'], 2, 7) + pixelPath(['#############'], 1, 14))}
      {strokes('M12 8.5h1.5v3H12')}
    </>,
  },
  c: { color: '#6aa6e8', body: letters('C') },
  cpp: { color: '#8a9cf0', body: letters('C+') },
  header: { color: '#c08ad8', body: letters('H') },
  csharp: { color: '#a682e6', body: letters('C#') },
  php: {
    color: '#8f93e8',
    body: () => {
      const p = ['###.', '#..#', '#..#', '###.', '#...', '#...', '#...'];
      return pixels(pixelPath(p, 1, 5) + pixelPath(['#..#', '#..#', '#..#', '####', '#..#', '#..#', '#..#'], 6, 5) + pixelPath(p, 11, 5));
    },
  },
  ruby: { color: '#e0535b', body: () => <path d="M4 3h8l2 3H2zM2 7h12l-6 7z" /> },
  sql: {
    color: '#8fa8f0',
    body: () => {
      const disc = ['.########.', '##########', '.########.'];
      return pixels(pixelPath([...disc, '', ...disc, '', ...disc], 3, 3));
    },
  },
  csv: { color: '#7cc36e', body: () => strokes('M1.5 1.5h13v12h-13zM1.5 5.5h13M1.5 9.5h13M5.5 1.5v12') },
  svg: { color: AMBER, body: picture },
  image: { color: PURPLE, body: picture },
  pdf: { color: '#e0585b', body: () => <>{strokes(DOC)}{pixels(pixelPath(['#########', '#########', '#########', '#########'], 2, 8))}</> },
  archive: {
    color: BROWN,
    body: () => <>{strokes('M2.5 1.5h11v13h-11z')}{pixels(pixelPath(['#.', '.#', '#.', '.#', '#.', '.#'], 7, 2) + pixelPath(['####', '#..#', '####'], 6, 8))}</>,
  },
  docker: {
    color: '#4aa8ec',
    body: () => <>
      {pixels(pixelPath(['##', '##'], 6, 2) + pixelPath(['##.##.##', '##.##.##'], 3, 5))}
      <path d="M1 8h12.3c.3-1 1.1-1.5 2.2-1.2-.2 1-.8 1.5-1.6 1.8C13.2 11.8 10.6 13.5 7 13.5 3.6 13.5 1.6 11.6 1 8z" />
    </>,
  },
  license: { color: '#c5cbd3', body: () => <><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" />{strokes('M10.1 6.2a2.75 2.75 0 1 0 0 3.6', 1.5)}</> },
  git: {
    color: RED,
    body: (id) => <>
      <mask id={id}>
        <rect width="16" height="16" fill="#fff" />
        <path d="M6.5 5.5v5.5M6.5 5.5l4 3" fill="none" stroke="#000" strokeWidth="1.25" strokeLinecap="round" />
        <circle cx="6.5" cy="5.5" r="1.4" fill="#000" /><circle cx="6.5" cy="11" r="1.4" fill="#000" /><circle cx="10.5" cy="8.5" r="1.4" fill="#000" />
      </mask>
      <g mask={`url(#${id})`}><rect x="3" y="3" width="10" height="10" rx="1.6" transform="rotate(45 8 8)" /></g>
    </>,
  },
  npm: {
    color: '#d9474a',
    body: () => pixels(pixelPath(['############', '############', '############', '###......###', '###......###', '###..##..###', '###..##..###', '###..##..###', '###..##..###', '###..##..###', '############', '############'], 2, 2)),
  },
  node: { color: '#5fb88a', body: () => <>{strokes('M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z')}<path d="M8 4.5l3 1.75v3.5L8 11.5l-3-1.75v-3.5z" /></> },
  tsconfig: { color: BLUE, body: () => pixels(word('TS', 0) + GEAR_BADGE) },
  jsconfig: { color: YELLOW, body: () => pixels(word('JS', 0) + GEAR_BADGE) },
  vite: {
    color: '#a77ef3',
    body: () => <>{strokes('M1.5 2.5h13L8 14.5z')}<path d="M9 4 6 8.5h2.2L7.3 12l2.9-4.5H8z" fill="#f5c542" /></>,
  },
  vitest: {
    color: '#8fc04a',
    body: () => <><path d="M1 3h3.5L8 9l3.5-6H15L8 14z" /><path d="M8.8 1.5 6 6.5h2l-.8 3.5 3.3-5h-2z" fill="#f5c542" /></>,
  },
  vue: { color: '#4fc08d', body: () => <path d="M1 2h3.2L8 8.5 11.8 2H15L8 14z" /> },
  svelte: { color: '#f0764a', body: letters('S') },
};

/** The glyph of one icon id (the Files tree, tabs and breadcrumbs go through {@link FileIcon}). */
export function FileTypeIcon({ id }: { id: FileIconId }) {
  const maskId = `fi${useId().replace(/[^\w-]/g, '')}`;
  const glyph = GLYPHS[id];
  return (
    <span className="file-type-icon" data-icon={id} style={{ color: glyph.color }} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" fillRule="evenodd">{glyph.body(maskId)}</svg>
    </span>
  );
}

/** Decorative, consistent file-type marks for the tree, the tabs and the editor breadcrumb. */
export function FileIcon({ name }: { name: string }) {
  return <FileTypeIcon id={fileIconId(name)} />;
}

const FOLDER = 'M1.5 3.5h4l2 2h7v7h-13z';
const FOLDER_OPEN = 'M1.5 12.5v-9h4l2 2h5v2M1.5 12.5l2.5-5h11l-2.5 5z';

/** Thin outline folder (open when expanded); `dot` is the git class of the most important change inside, drawn on its corner. */
export function FolderIcon({ open = false, dot }: { open?: boolean; dot?: string | null }) {
  const maskId = `fo${useId().replace(/[^\w-]/g, '')}`;
  return (
    <span className={`explorer-folder-icon ${open ? 'open' : ''}`} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinejoin="round">
        {dot && <mask id={maskId}><rect width="16" height="16" fill="#fff" stroke="none" /><circle cx="13" cy="12" r="3.5" fill="#000" stroke="none" /></mask>}
        <path d={open ? FOLDER_OPEN : FOLDER} mask={dot ? `url(#${maskId})` : undefined} />
        {dot && <circle className={`folder-dot ${dot}`} cx="13" cy="12" r="2.25" stroke="none" />}
      </svg>
    </span>
  );
}

/** Tree twistie: a thin chevron pointing right (CSS turns it down for an open folder). */
export function TreeChevron() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>;
}

export function FileBreadcrumb({ projectName, relativePath, fullPath }: { projectName?: string; relativePath: string; fullPath: string }) {
  const parts = [...(projectName ? [projectName] : []), ...relativePath.split(/[\\/]/).filter(Boolean)];
  return <nav className="file-breadcrumb" aria-label={fullPath} title={fullPath}>
    <ol>{parts.map((part, index) => <li key={index} aria-current={index === parts.length - 1 ? 'page' : undefined}>
      {index > 0 && <svg className="breadcrumb-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>}
      {index === parts.length - 1 && <FileIcon name={relativePath} />}
      <span className="breadcrumb-name">{part}</span>
    </li>)}</ol>
  </nav>;
}

export function FileActionIcon({ kind }: { kind: 'save' | 'wrap' }) {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'save' ? <><path d="M12 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4z" /><path d="M5 2v4h6V2M5 14V9h6v5" /></> : <><path d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8M2 12h3" /><path d="m10 11-2 2 2 2" /></>}
  </svg>;
}
