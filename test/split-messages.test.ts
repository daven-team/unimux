import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseAst, transformWithOxc } from 'vite';
import { describe, expect, it } from 'vitest';
import { splitMessages } from '../vite.messages';
import { MESSAGE_COLUMN, translate, type MessageKey } from '../src/shared/i18n';
import { messages } from '../src/shared/messages';

const plugin = splitMessages();
const warnings: string[] = [];
const context = {
  parse: (code: string) => parseAst(code),
  warn: (message: string) => warnings.push(message),
  error: (message: string) => { throw new Error(message); },
  addWatchFile: () => undefined,
};
const call = <T>(hook: unknown, ...args: unknown[]) => (hook as (...a: unknown[]) => T).call(context, ...args);
const shared = join(__dirname, '../src/shared');

describe('per-language message chunks of the renderer build', () => {
  it('each language chunk holds exactly what translate() returns for that language', async () => {
    for (const language of Object.keys(MESSAGE_COLUMN) as Array<keyof typeof MESSAGE_COLUMN>) {
      const id = call<string>(plugin.resolveId, `virtual:mc-messages/${language}`);
      const code = await call<Promise<string>>(plugin.load, id);
      const column = Number(/export const column = (\d+);/.exec(code)![1]);
      const table = JSON.parse(code.slice(code.indexOf('export default ') + 15).trim().replace(/;$/, '')) as Record<string, string>;
      expect(column).toBe(MESSAGE_COLUMN[language]);
      expect(Object.keys(table)).toEqual(Object.keys(messages));
      for (const key of Object.keys(messages) as MessageKey[]) expect(table[key]).toBe(translate(language, key));
    }
  }, 60000);

  it('replaces every shared message table, keeping the rest of the module', async () => {
    const files = readdirSync(shared).filter((file) => /^(messages|\w+Messages)\.ts$/.test(file));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const path = join(shared, file);
      const { code } = await transformWithOxc(readFileSync(path, 'utf8'), path, { lang: 'ts' });
      const result = call<{ code: string } | null>(plugin.transform, code, path);
      expect(result, file).not.toBeNull();
      expect(result!.code).toContain('__mcMessageTable');
      // No translation row ([en, de, es, fr, pt]) is left; keys may stay where code uses them.
      const str = String.raw`"(?:[^"\\]|\\.)*"`;
      expect(code, file).toMatch(new RegExp(String.raw`\[\s*${str}(?:,\s*${str}){4},?\s*\]`));
      expect(result!.code, file).not.toMatch(new RegExp(String.raw`\[\s*${str}(?:,\s*${str}){4},?\s*\]`));
      // Still valid JavaScript.
      expect(() => parseAst(result!.code)).not.toThrow();
    }
    expect(warnings).toEqual([]);
    // Helpers next to a table keep working on keys only.
    const swap = await transformWithOxc(readFileSync(join(shared, 'swapMessages.ts'), 'utf8'), 'swapMessages.ts', { lang: 'ts' });
    expect(call<{ code: string }>(plugin.transform, swap.code, join(shared, 'swapMessages.ts')).code).toContain('function swapErrorKey');
  }, 60000);

  it('leaves other modules alone', () => {
    expect(call(plugin.transform, 'export const messages = { a: 1 };', join(shared, 'state.ts'))).toBeNull();
  });
});
