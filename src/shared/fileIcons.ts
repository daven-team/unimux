// File-type icons of the Files tree, the file tabs and the breadcrumbs: which glyph a file name gets, and the pixel-grid
// helper the glyphs are drawn with (whole-pixel shapes stay sharp at 16 px). Pure functions, no DOM.

export const FILE_ICON_IDS = [
  'file', 'text', 'log', 'ts', 'tsx', 'js', 'jsx', 'json', 'markdown', 'mdx', 'css', 'scss', 'less', 'html', 'xml',
  'yaml', 'toml', 'config', 'env', 'lock', 'shell', 'powershell', 'batch', 'python', 'go', 'rust', 'java',
  'c', 'cpp', 'header', 'csharp', 'php', 'ruby', 'sql', 'csv', 'svg', 'image', 'pdf', 'archive', 'docker',
  'make', 'license', 'git', 'npm', 'node', 'tsconfig', 'jsconfig', 'vite', 'vitest', 'vue', 'svelte',
] as const;
export type FileIconId = (typeof FILE_ICON_IDS)[number];

const ids = (map: Record<string, string>): Record<string, FileIconId> => {
  const out: Record<string, FileIconId> = {};
  for (const [id, keys] of Object.entries(map)) for (const key of keys.split(' ')) out[key] = id as FileIconId;
  return out;
};

/** Whole file names (lower case) that win over the extension. */
const BY_NAME = ids({
  node: 'package.json package-lock.json .nvmrc .node-version',
  npm: '.npmrc .npmignore',
  git: '.gitignore .gitattributes .gitmodules .gitkeep .gitconfig .git-blame-ignore-revs .mailmap',
  config: '.editorconfig .prettierrc .eslintrc .babelrc .stylelintrc .browserslistrc',
  docker: '.dockerignore',
  lock: 'yarn.lock pnpm-lock.yaml bun.lockb cargo.lock poetry.lock uv.lock gemfile.lock composer.lock flake.lock',
  make: 'makefile gnumakefile cmakelists.txt',
  shell: '.bashrc .bash_profile .zshrc .profile',
  go: 'go.mod go.sum go.work',
  ruby: 'gemfile rakefile',
});

const BY_EXTENSION = ids({
  ts: 'ts mts cts', tsx: 'tsx', js: 'js mjs cjs', jsx: 'jsx',
  json: 'json jsonc json5 jsonl ndjson tsbuildinfo webmanifest',
  markdown: 'md markdown mdown mkd', mdx: 'mdx',
  css: 'css', scss: 'scss sass', less: 'less styl',
  html: 'html htm xhtml', xml: 'xml xsd xsl xslt plist csproj vcxproj',
  yaml: 'yml yaml', toml: 'toml', config: 'ini conf cfg properties', env: 'env', lock: 'lock',
  shell: 'sh bash zsh fish ksh', powershell: 'ps1 psm1 psd1', batch: 'bat cmd',
  python: 'py pyw pyi ipynb', go: 'go', rust: 'rs', java: 'java',
  c: 'c', cpp: 'cc cpp cxx c++', header: 'h hh hpp hxx', csharp: 'cs csx', php: 'php', ruby: 'rb erb rake gemspec',
  sql: 'sql psql pgsql db sqlite sqlite3', csv: 'csv tsv parquet',
  svg: 'svg', image: 'png jpg jpeg gif webp ico bmp avif tif tiff icns',
  pdf: 'pdf', archive: 'zip tar gz tgz 7z rar bz2 xz zst jar asar',
  text: 'txt text', log: 'log', docker: 'dockerfile', make: 'mk mak cmake', vue: 'vue', svelte: 'svelte',
});

/** The icon of a file: its name or path (either separator), case-insensitive. */
export function fileIconId(name: string): FileIconId {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const named = BY_NAME[base];
  if (named) return named;
  if (base === '.env' || base.startsWith('.env.')) return 'env';
  if (/^tsconfig(\..+)?\.json$/.test(base)) return 'tsconfig';
  if (/^jsconfig(\..+)?\.json$/.test(base)) return 'jsconfig';
  if (/^vite\.config\.[cm]?[jt]s$/.test(base)) return 'vite';
  if (/^vitest\.(config|workspace)\.[cm]?[jt]s$/.test(base)) return 'vitest';
  if (/^(docker|container)file([.-].+)?$/.test(base) || /^(docker-)?compose(\..+)?\.ya?ml$/.test(base)) return 'docker';
  if (/^(licen[cs]e|copying|unlicense)([.-].+)?$/.test(base)) return 'license';
  const dot = base.lastIndexOf('.');
  return (dot >= 0 && BY_EXTENSION[base.slice(dot + 1)]) || 'file';
}

/**
 * SVG path of a pixel bitmap: `rows` are strings where `#` is a filled pixel (any other character is empty), placed with
 * its top-left corner at (`x`, `y`). Runs of pixels become rectangles on whole pixels (a run repeated on the rows below
 * grows the same rectangle), so the shape has no anti-aliased edge at 1x.
 */
export function pixelPath(rows: readonly string[], x = 0, y = 0, on = '#'): string {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  /** Rectangles still growing, by "start:width" of their run on the previous row. */
  let open = new Map<string, (typeof rects)[number]>();
  rows.forEach((row, r) => {
    const next = new Map<string, (typeof rects)[number]>();
    for (let c = 0; c < row.length;) {
      if (row[c] !== on) { c++; continue; }
      let end = c;
      while (end < row.length && row[end] === on) end++;
      const key = `${c}:${end - c}`;
      const rect = open.get(key) ?? { x: x + c, y: y + r, w: end - c, h: 0 };
      if (!open.has(key)) rects.push(rect);
      rect.h++;
      next.set(key, rect);
      c = end;
    }
    open = next;
  });
  return rects.map((q) => `M${q.x} ${q.y}h${q.w}v${q.h}h${-q.w}z`).join('');
}
