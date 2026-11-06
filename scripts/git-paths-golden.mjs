// The TS reference answers for the canonical folder spelling (PLAN G1): the cargo test
// unimux-git/tests/canonical_paths.rs builds a lab of real folders (8.3 short names, junctions, a subst drive, missing
// children, odd letter case and slashes), writes the spellings to a JSON file and runs this script on it; Rust must answer
// exactly what src/main/gitPaths.ts answers on the same machine. Node 22.18+ strips the TypeScript types itself.
//
//   node scripts/git-paths-golden.mjs <input.json>   (input: {"paths": [...], "pairs": [[a, b], ...]})
//
// Prints {"canonical": {...}, "normalize": {...}, "pairs": [{same, inside, relative}, ...]}.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = await import(pathToFileURL(join(root, 'src', 'main', 'gitPaths.ts')).href);
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const canonical = {};
const normalize = {};
for (const p of input.paths ?? []) {
  canonical[p] = paths.canonicalPath(p);
  normalize[p] = paths.normalizeSpelling(p);
}
const pairs = (input.pairs ?? []).map(([a, b]) => ({
  same: paths.samePath(a, b),
  inside: paths.isInsidePath(a, b),
  relative: paths.relativeInside(a, b),
}));
process.stdout.write(JSON.stringify({ canonical, normalize, pairs }));
