import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ajza-runtime-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('update window runtime', () => {
  it('carries its logo inside the page (the startup window loads it from resources/update-splash, with no icon next to it)', () => {
    const html = readFileSync(new URL('../resources/update-splash/index.html', import.meta.url), 'utf8');
    const logo = /<img class="logo" src="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(logo.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(logo.slice('data:image/png;base64,'.length), 'base64').equals(readFileSync(new URL('../resources/icon-64.png', import.meta.url)))).toBe(true);
    expect(html).toMatch(/img-src[^;"]*data:/);
  });
});

