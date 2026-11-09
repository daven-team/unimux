// Real-app check (Windows, check build, offscreen, scratch data dir and home): an outside close (WM_CLOSE to the process' windows,
// what Process.CloseMainWindow and taskkill without /F send) never destroys tao's event loop window. It either quits through
// the normal quit path or leaves a working app.
//   A. WM_CLOSE to the helper alone: the app quits by itself, exit code 0, the last edit saved.
//   B. WM_CLOSE to the helper while the quit question holds the quit (faked busy agent): the question shows, the helper
//      survives, the webview still answers; Cancel keeps the app; then WM_CLOSE to every top-level window asks again and Quit ends it.
//   C. WM_CLOSE to every top-level window with nothing busy: the app quits by itself, exit code 0.
//   D. Process.CloseMainWindow and taskkill without /F (on this script's own pid) both quit cleanly, exit code 0.
// Messages go only to windows of the process this script started (checked again right before each send), and only that
// process tree is ended afterwards, by pid.
//
//   npm run build:check && node scripts/verify-wm-close.mjs [--app <unimux.exe of another check build>]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, readText, sleep, waitExit, waitFor } from './tauri-app.mjs';

if (process.platform !== 'win32') throw new Error('verify-wm-close is Windows only');
const appArg = process.argv.indexOf('--app');
if (appArg >= 0) process.env.MC_APP_BINARY = process.argv[appArg + 1];

const HELPER_CLASS = 'Tao Thread Event Target';
const WM_CLOSE = 0x0010;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const scratch = mkdtempSync(join(tmpdir(), 'unimux-wm-close-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const stateFile = join(dataDir, 'state.json');
const crashLog = join(dataDir, 'crash.log');
console.log(`scratch: ${scratch}`);

function writeFixture() {
  const state = {
    version: 1,
    projects: [{ id: 'proj', name: 'close', path: scratch, color: '#7c5cff', tabs: [{ id: 'tab', name: 'Agents', cells: [{ id: 'cell-1', profileId: 'claude' }, { id: 'cell-2', profileId: 'shell' }] }], archive: [], activeTabId: 'tab' }],
    activeProjectId: 'proj',
    settings: { language: 'en', confirmCloseWorking: true },
  };
  writeFileSync(stateFile, JSON.stringify(state));
}

const NATIVE = `Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class WmClose {
  public delegate bool Enum(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Enum f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@`;
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
/** The top-level windows of `pid`: [{ hwnd, cls, visible, owned }]. */
function topLevel(pid) {
  const out = ps(`${NATIVE}
$out = @()
$cb = [WmClose+Enum]{ param($h, $l)
  [uint32]$p = 0; [void][WmClose]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq ${Number(pid)}) {
    $s = New-Object System.Text.StringBuilder 256; [void][WmClose]::GetClassNameW($h, $s, 256)
    $owner = [WmClose]::GetWindow($h, 4)
    $script:out += ('{0}|{1}|{2}|{3}' -f $h.ToInt64(), [int][WmClose]::IsWindowVisible($h), [int]($owner -ne [IntPtr]::Zero), $s.ToString())
  }
  $true }
[void][WmClose]::EnumWindows($cb, [IntPtr]::Zero)
$out -join [char]10`);
  return out.split('\n').filter(Boolean).map((l) => { const [hwnd, visible, owned, ...cls] = l.trim().split('|'); return { hwnd, visible: visible === '1', owned: owned === '1', cls: cls.join('|') }; });
}
/** Posts WM_CLOSE to `hwnds`, each only if it still belongs to `pid`. */
function postClose(pid, hwnds) {
  ps(`${NATIVE}
foreach ($v in @(${hwnds.join(',')})) {
  $h = [IntPtr][Int64]$v; [uint32]$p = 0
  [void][WmClose]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq ${Number(pid)}) { [void][WmClose]::PostMessageW($h, ${WM_CLOSE}, [IntPtr]::Zero, [IntPtr]::Zero) }
}`);
}

const children = [];
async function start() {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  await sleep(1500);
  return { child, page };
}
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
const edit = (page, key, value) => page.evaluate(`window.__mc.useStore.getState().update((s) => ({ ...s, settings: { ...s.settings, ${JSON.stringify(key)}: ${JSON.stringify(value)} } }))`);
const setBusy = (page) => page.evaluate(`(() => { const st = window.__mc.useStore.getState(); window.__mc.useStore.setState({ ui: { ...st.ui, statuses: { ...st.ui.statuses, 'cell-1': 'working' } } }); })()`);
const savedSetting = (key) => { try { return JSON.parse(readText(stateFile)).settings?.[key]; } catch { return undefined; } };
const crashLines = () => (existsSync(crashLog) ? readText(crashLog).split('\n').filter(Boolean) : []);
const helperOf = (windows) => windows.find((w) => w.cls === HELPER_CLASS);
const question = (page) => waitFor(page, `(() => { const d = window.__mc.useStore.getState().ui.dialog; return d && d.kind === 'confirm' ? d.title : null; })()`, 10000, 'quit question').catch(() => null);

let failed = false;
try {
  writeFixture();
  // ── A. the helper alone ─────────────────────────────────────────────────
  {
    const { child, page } = await start();
    const before = topLevel(child.pid);
    console.log(before.map((w) => `  ${w.hwnd} visible=${w.visible} owned=${w.owned} ${w.cls}`).join('\n'));
    const helper = helperOf(before);
    check('the helper window exists', !!helper);
    check('the helper is not a visible unowned top-level window', helper && !(helper.visible && !helper.owned), JSON.stringify(helper));
    check('every visible unowned top-level window is an app window, not the helper', before.filter((w) => w.visible && !w.owned).every((w) => w.cls !== HELPER_CLASS));
    await edit(page, 'fontSize', 15);
    await sleep(700); // past the save debounce
    postClose(child.pid, [helper.hwnd]);
    const code = await waitExit(child, 20000);
    check('WM_CLOSE to the helper alone quits the normal way, exit code 0', code === 0, `exit ${code}`);
    if (code === null) console.log(`  helper still there: ${!!helperOf(topLevel(child.pid))}`);
    check('the last edit is saved', savedSetting('fontSize') === 15);
    check('no dead event loop in crash.log', !crashLines().some((l) => /failed to send message|nie odpowiada/.test(l)));
    killTree(child);
  }
  // ── B. held by the quit question ───────────────────────────────────────
  {
    writeFixture();
    const { child, page } = await start();
    await setBusy(page);
    await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'lifecycle', args: null }).then((l) => l.guard)`, 10000, 'quit guard');
    const helper = helperOf(topLevel(child.pid));
    postClose(child.pid, [helper.hwnd]);
    const asked = await question(page);
    check('WM_CLOSE to the helper while an agent works asks the quit question', !!asked, asked ?? '');
    const lc = await bridge(page, 'lifecycle').catch(() => null);
    check('the helper survives and the webview still answers', !!helperOf(topLevel(child.pid)) && lc?.pending === true && child.exitCode === null, `pending ${lc?.pending}`);
    await page.evaluate(`window.__mc.useStore.getState().ui.dialog.onChoose(null, false)`);
    await sleep(3500);
    const afterCancel = await bridge(page, 'lifecycle').catch(() => null);
    check('Cancel keeps the app working', child.exitCode === null && afterCancel?.pending === false && afterCancel?.quitting === false);
    check('the helper is still there after Cancel', !!helperOf(topLevel(child.pid)));
    await edit(page, 'fontSize', 18);
    postClose(child.pid, topLevel(child.pid).map((w) => w.hwnd));
    const again = await question(page);
    check('WM_CLOSE to every window asks again', !!again, again ?? '');
    check('nothing was torn down by the close', !!helperOf(topLevel(child.pid)) && child.exitCode === null);
    await page.evaluate(`window.__mc.useStore.getState().ui.dialog.onChoose('close', false)`).catch(() => undefined);
    const code = await waitExit(child, 25000);
    check('Quit winds down and exits 0', code === 0, `exit ${code}`);
    check('the last edit is saved after Quit', savedSetting('fontSize') === 18);
    killTree(child);
  }
  // ── C. every window, nothing busy ──────────────────────────────────────
  {
    writeFixture();
    const { child, page } = await start();
    await edit(page, 'fontSize', 21);
    await sleep(700);
    postClose(child.pid, topLevel(child.pid).map((w) => w.hwnd));
    const code = await waitExit(child, 20000);
    check('WM_CLOSE to every top-level window quits cleanly, exit code 0', code === 0, `exit ${code}`);
    check('the last edit is saved', savedSetting('fontSize') === 21);
    check('no dead event loop in crash.log', !crashLines().some((l) => /failed to send message|nie odpowiada/.test(l)));
    killTree(child);
  }
  // ── D. the two common outside closes ───────────────────────────────────
  for (const how of ['Process.CloseMainWindow', 'taskkill without /F']) {
    writeFixture();
    const { child, page } = await start();
    await edit(page, 'fontSize', 22);
    await sleep(700);
    if (how === 'Process.CloseMainWindow') {
      const main = topLevel(child.pid).find((w) => w.visible && !w.owned);
      const out = ps(`$p = Get-Process -Id ${Number(child.pid)}; $h = $p.MainWindowHandle.ToInt64(); $ok = $p.CloseMainWindow(); "$h $ok"`);
      check('Process.MainWindowHandle is the app window, CloseMainWindow is delivered', out.split(' ')[0] === main.hwnd && out.endsWith('True'), `${out}, expected ${main.hwnd}`);
    } else {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch (e) { console.log(`  taskkill: ${e.message}`); }
    }
    const code = await waitExit(child, 20000);
    check(`${how} quits cleanly, exit code 0`, code === 0, `exit ${code}`);
    check(`the last edit is saved after ${how}`, savedSetting('fontSize') === 22);
    killTree(child);
  }
} catch (error) {
  failed = true;
  console.log(`ERROR ${error.stack ?? error}`);
} finally {
  for (const child of children) killTree(child);
  await sleep(500);
  removeScratch(scratch);
}
failed ||= results.some((r) => !r.ok);
console.log(`${failed ? 'FAILED' : 'OK'}: ${results.filter((r) => r.ok).length}/${results.length}`);
process.exit(failed ? 1 : 0);
