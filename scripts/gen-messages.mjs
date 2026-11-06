// Writes src-tauri/gen/messages.json from the shared message tables (src/shared/messages.ts and the *Messages files it spreads):
// { "<Polish key>": [en, de, es, fr, pt] }. Rust's unimux_core::i18n::translate reads it, so dialogs shown by the Rust side
// use exactly the texts of the TS tables. `--check` fails (exit 1) when the committed file differs (CI drift check).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'src-tauri/gen/messages.json');

const { module } = await runnerImport(resolve(root, 'src/shared/messages.ts'), { configFile: false, logLevel: 'silent', root });
const rows = Object.entries(module.messages);
const text = `{\n${rows.map(([key, row]) => `${JSON.stringify(key)}:${JSON.stringify(row)}`).join(',\n')}\n}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(out, 'utf8'); } catch { /* missing counts as a difference */ }
  if (current !== text) {
    console.error('src-tauri/gen/messages.json is out of date: run `npm run gen:messages`.');
    process.exit(1);
  }
  console.log(`messages.json up to date (${rows.length} rows)`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out} (${rows.length} rows)`);
}
