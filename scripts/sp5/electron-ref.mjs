// SP5 reference of 1.1.4 (the Electron build of this tree, `npm run build` first): a PowerShell shell cell and a Claude
// Code cell side by side in a scratch data dir and home, the same checks as scripts/sp5/run.mjs "render" (win32-input-mode,
// typed echo, a wrapped command line reflowed by a narrower cell), screenshot and screen text into artifacts/sp5/.
//
//   node scripts/sp5/electron-ref.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, scratchRoot, sleep, sshState, writeState } from '../ssh-ui-lib.mjs';
import { removeScratch } from '../app-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'artifacts', 'sp5');
mkdirSync(out, { recursive: true });
const scratch = scratchRoot('sp5ref');
const state = sshState({ projectPath: join(scratch, 'project') });
state.projects[0].tabs = [{ id: 'tab-sp5', name: 'SP5', color: '#60a5fa', layout: { cols: 2, rows: 1, areas: [0, 1].map((i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) }, cells: [{ id: 'ps', profileId: 'shell' }, { id: 'claude', profileId: 'claude' }] }];
state.projects[0].activeTabId = 'tab-sp5';
state.settings = { ...state.settings, shell: 'pwsh', fontSize: 13 };
state.sidebarCollapsed = true;
writeState(scratch, state);
let app;
const result = {};
const screen = (id) => app.evaluate(`(() => { const t = window.__mc.terminals.entries.get(${JSON.stringify(id)})?.term; if (!t) return []; const b = t.buffer.active; const o = []; for (let y = 0; y < t.rows; y++) o.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? ''); return o; })()`);
const typeKey = async (ch) => {
  const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === ' ' ? 'Space' : /\d/.test(ch) ? `Digit${ch}` : '';
  const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const type = async (s) => { for (const ch of s) await typeKey(ch); };
try {
  app = await launchApp(scratch);
  await app.until(`(() => { const t = window.__mc.terminals.entries.get('ps')?.term; if (!t) return false; const b = t.buffer.active; for (let i = 0; i < b.length; i++) if (/PS .*>/.test(b.getLine(i)?.translateToString(true) ?? '')) return true; return false; })()`, 'powershell prompt', 40000);
  await app.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  result.win32 = await app.evaluate(`window.__mc.terminals.entries.get('ps').win32`);
  await app.evaluate(`window.__mc.terminals.entries.get('ps').term.focus(), true`);
  await sleep(300);
  await type('echo w32ok');
  await app.press('Enter');
  await sleep(1500);
  const long = 'echo ' + 'abcdefghij'.repeat(9);
  await type(long);
  await sleep(500);
  const before = await app.evaluate(`[window.__mc.terminals.entries.get('ps').term.cols, window.__mc.terminals.entries.get('ps').term.rows]`);
  // Narrow the viewport: both cells reflow.
  const [w, h] = await app.evaluate(`[innerWidth, innerHeight]`);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(w * 0.45), height: h, deviceScaleFactor: 0, mobile: false });
  await sleep(1500);
  const after = await app.evaluate(`[window.__mc.terminals.entries.get('ps').term.cols, window.__mc.terminals.entries.get('ps').term.rows]`);
  await type('XYZ');
  await app.press('Enter');
  await sleep(2000);
  const joined = (await screen('ps')).join('');
  result.resize = { before, after, commandIntact: joined.includes(long + 'XYZ'), outputIntact: joined.includes('abcdefghij'.repeat(9) + 'XYZ') };
  await app.cdp('Emulation.clearDeviceMetricsOverride');
  await sleep(8000);
  result.powershellScreen = (await screen('ps')).join('\n');
  result.claudeScreen = (await screen('claude')).join('\n');
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, 'electron-1.1.4-powershell-claude.png'), Buffer.from(data, 'base64'));
  writeFileSync(join(out, 'electron-1.1.4-render.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ ...result, powershellScreen: undefined, claudeScreen: undefined }));
} finally {
  await app?.close();
  removeScratch(scratch);
}
