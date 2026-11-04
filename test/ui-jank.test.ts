// UI smoothness guards (scripts/bench-jank.mjs measures them in the real app): WebGL contexts are created in slices of a
// frame budget, attached terminals are fitted together after the commit, resized cells are fitted within a frame budget and
// panel widths are not custom properties of the app root.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WEBGL_GRANT_BUDGET_MS } from '../src/shared/webglPool';

const manager = readFileSync('src/renderer/src/terminals/TerminalManager.ts', 'utf8');
const app = readFileSync('src/renderer/src/App.tsx', 'utf8');

describe('frame budgets of terminal work', () => {
  it('a plan of WebGL contexts is carried out in slices, one slice per frame', () => {
    expect(WEBGL_GRANT_BUDGET_MS).toBeGreaterThan(0);
    expect(WEBGL_GRANT_BUDGET_MS).toBeLessThanOrEqual(16);
    expect(manager).toMatch(/granted > 0 && performance\.now\(\) - started >= WEBGL_GRANT_BUDGET_MS/);
    expect(manager).toMatch(/if \(frame === this\.lastSlice\) \{ this\.queueSlice\(\); return; \}/);
  });

  it('attach does not fit at once (one layout for all terminals of a commit), size readers flush the due fits', () => {
    const attach = manager.slice(manager.indexOf('  attach(cellId: string'), manager.indexOf('  /** Terminals attached in this task'));
    expect(attach).not.toMatch(/this\.refit\(e\)/);
    expect(attach).toMatch(/queueMicrotask\(\(\) => this\.flushFits\(\)\)/);
    for (const fn of ['size(cellId: string)', 'xterm(cellId: string)', 'syncSize(cellId: string)']) {
      const body = manager.slice(manager.indexOf(`  ${fn}`), manager.indexOf(`  ${fn}`) + 200);
      expect(body).toMatch(/this\.flushFits\(\);/);
    }
  });

  it('resized cells are fitted through the budgeted queue', () => {
    expect(manager).toMatch(/else this\.queueFit\(e\); \}, 25\)/);
    expect(manager).toMatch(/fitted > 0 && performance\.now\(\) - started >= FIT_BUDGET_MS/);
  });

  it('the panel widths are not custom properties of .app (that restyled the whole grid at every move of an edge)', () => {
    expect(app).not.toMatch(/className="app" style=/);
    expect(app).toMatch(/className="app-width-scope" style=\{sidebarWidthVar\}/);
  });
});
