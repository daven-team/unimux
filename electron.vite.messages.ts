// Renderer build only: every language's translations sit in their own chunk instead of the main one.
//
// The message tables in src/shared (`messages` and the `*Messages` files: Polish key -> [en, de, es, fr, pt]) are
// replaced in the renderer bundle by one shared object (src/renderer/src/messageTable.ts). Each language becomes a
// chunk `virtual:mc-messages/<lang>` with { key: translation } built from the evaluated tables, so the result is exactly
// what `translate()` reads in main and in the tests. The renderer loads the active language before its first render and
// a new one before switching to it (src/renderer/src/i18n.ts). Main, the preload and the tests keep the full tables.
import { resolve } from 'path';
import { runnerImport, type Plugin } from 'vite';

const RUNTIME = resolve(__dirname, 'src/renderer/src/messageTable.ts').replace(/\\/g, '/');
const VIRTUAL = 'virtual:mc-messages/';
const RESOLVED = `\0${VIRTUAL}`;
const TABLE_FILE = /[\\/]src[\\/]shared[\\/](?:messages|\w+Messages)\.ts$/;
const TABLE_NAME = /^(?:messages|\w+Messages)$/;

type Tables = { messages: Record<string, readonly string[]>; column: Record<string, number>; files: string[] };

/** Loads the shared tables (and the column of each language) with Vite's module runner, the way main uses them. */
async function loadTables(): Promise<Tables> {
  const shared = resolve(__dirname, 'src/shared');
  const inline = { configFile: false as const, logLevel: 'silent' as const, root: __dirname };
  const [table, i18n] = await Promise.all([
    runnerImport<typeof import('./src/shared/messages')>(resolve(shared, 'messages.ts'), inline),
    runnerImport<typeof import('./src/shared/i18n')>(resolve(shared, 'i18n.ts'), inline),
  ]);
  return { messages: table.module.messages, column: i18n.module.MESSAGE_COLUMN, files: [...table.dependencies, ...i18n.dependencies] };
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };

export function splitMessages(): Plugin {
  let tables: Promise<Tables> | undefined;
  return {
    name: 'mc-split-messages',
    // After the TypeScript transform (Oxc since Vite 8): the table files are plain JavaScript by then (no `as const satisfies`).
    enforce: 'post',
    buildStart() { tables = undefined; },
    resolveId(id) { return id.startsWith(VIRTUAL) ? `\0${id}` : null; },
    async load(id) {
      if (!id.startsWith(RESOLVED)) return null;
      const language = id.slice(RESOLVED.length);
      const { messages, column: columns, files } = await (tables ??= loadTables());
      for (const file of files) this.addWatchFile(file);
      const column = columns[language];
      if (column === undefined) this.error(`No message column for language "${language}"`);
      const table = Object.fromEntries(Object.entries(messages).map(([key, row]) => [key, row[column]]));
      return `export const column = ${column};\nexport default ${JSON.stringify(table)};\n`;
    },
    transform(code, id) {
      if (!TABLE_FILE.test(id.split('?')[0])) return null;
      const program = this.parse(code) as unknown as { body: Node[] };
      const ranges: Array<[number, number]> = [];
      for (const statement of program.body) {
        const declaration = (statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement) as Node | null;
        if (declaration?.type !== 'VariableDeclaration') continue;
        for (const declarator of declaration.declarations as Node[]) {
          const name = (declarator.id as Node & { name?: string }).name;
          const init = declarator.init as Node | null;
          if (name && TABLE_NAME.test(name) && init?.type === 'ObjectExpression') ranges.push([init.start, init.end]);
        }
      }
      if (!ranges.length) {
        this.warn(`${id}: no message table found; its translations stay in the main chunk`);
        return null;
      }
      let out = code;
      for (const [start, end] of ranges.reverse()) out = `${out.slice(0, start)}__mcMessageTable${out.slice(end)}`;
      // No source maps are shipped (the renderer build has none), so the shifted positions need no map.
      return { code: `import { messageTable as __mcMessageTable } from ${JSON.stringify(RUNTIME)};\n${out}`, map: null };
    },
  };
}
