import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_MAX_AGE_MS, installInProgress, shouldCopy, updateWindowAlive, SPLASH_EXE, stageRuntime, startSplash, waitForFile } from '../src/main/updateRuntime';
import type { UpdateSplashConfig } from '../src/shared/updateProgress';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ajza-runtime-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const put = (file: string, body = 'x') => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); };

function fakeInstall(): { installDir: string; appDir: string } {
  const installDir = join(root, 'install');
  for (const f of ['unimux.exe', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'dxcompiler.dll', 'dxil.dll', 'LICENSES.chromium.html',
    'Uninstall unimux.exe', 'locales/en-US.pak', 'locales/pl.pak', 'locales/de.pak', 'resources/elevate.exe', 'resources/app/package.json',
    'resources/app/node_modules/big/index.js']) put(join(installDir, f));
  const appDir = join(installDir, 'resources', 'app');
  put(join(appDir, 'out/main/updatesplash.js')); put(join(appDir, 'out/main/chunks/shared.js'), 'chunk'); put(join(appDir, 'out/preload/updatesplash.js'));
  put(join(appDir, 'resources/update-splash/index.html'), readFileSync(new URL('../resources/update-splash/index.html', import.meta.url), 'utf8'));
  put(join(appDir, 'resources/icon.png'));
  return { installDir, appDir };
}

describe('update window runtime', () => {
  it('carries its logo inside the page (the startup window loads it from resources/update-splash, with no icon next to it)', () => {
    const html = readFileSync(new URL('../resources/update-splash/index.html', import.meta.url), 'utf8');
    const logo = /<img class="logo" src="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(logo.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(logo.slice('data:image/png;base64,'.length), 'base64').equals(readFileSync(new URL('../resources/icon-64.png', import.meta.url)))).toBe(true);
    expect(html).toMatch(/img-src[^;"]*data:/);
  });

  it('copies only what a small window needs', () => {
    const dir = join(root, 'app');
    const keep = (path: string) => shouldCopy(dir, join(dir, path), 'unimux.exe');
    expect(keep('ffmpeg.dll')).toBe(true);
    expect(keep('locales')).toBe(true);
    expect(keep('locales/en-US.pak')).toBe(true);
    expect(keep('locales/pl.pak')).toBe(false);
    expect(keep('unimux.exe')).toBe(false);
    expect(keep('dxcompiler.dll')).toBe(false);
    expect(keep('Uninstall unimux.exe')).toBe(false);
    expect(keep('resources/app/package.json')).toBe(false);
    expect(keep('resources/elevate.exe')).toBe(false);
  });

  it('stages a runtime under a name the installer will not terminate and writes the window app', async () => {
    const { installDir, appDir } = fakeInstall();
    const runtimeDir = join(root, 'update', 'runtime');
    const exe = await stageRuntime({ installDir, exeName: 'unimux.exe', appDir, runtimeDir, fingerprint: 'e1' });
    expect(exe).toBe(join(runtimeDir, SPLASH_EXE));
    expect(existsSync(join(runtimeDir, 'ffmpeg.dll'))).toBe(true);
    expect(existsSync(join(runtimeDir, 'unimux.exe'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'dxil.dll'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'locales', 'pl.pak'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'resources', 'app', 'node_modules'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(runtimeDir, 'resources', 'app', 'package.json'), 'utf8'));
    expect(manifest.main).toBe('main/updatesplash.js');
    for (const file of ['main/updatesplash.js', 'main/chunks/shared.js', 'preload/updatesplash.js', 'ui/index.html', 'ui/icon.png']) expect(existsSync(join(runtimeDir, 'resources', 'app', file))).toBe(true);
    const uiDir = join(runtimeDir, 'resources', 'app', 'ui');
    const logoSrc = readFileSync(join(uiDir, 'index.html'), 'utf8').match(/<img\b[^>]*class="logo"[^>]*src="([^"]+)"/)?.[1];
    expect(logoSrc).toBeTruthy();
    // Inlined (see the test above) or a file the copy brought along.
    expect(logoSrc!.startsWith('data:image/') || existsSync(join(uiDir, logoSrc!))).toBe(true);
    expect(existsSync(`${runtimeDir}.partial`)).toBe(false);
  });

  it('reuses a complete runtime for the same fingerprint and rebuilds it otherwise', async () => {
    const { installDir, appDir } = fakeInstall();
    const runtimeDir = join(root, 'update', 'runtime');
    const options = { installDir, exeName: 'unimux.exe', appDir, runtimeDir, fingerprint: 'e1' };
    await stageRuntime(options);
    put(join(runtimeDir, 'sentinel.txt'));
    await stageRuntime(options);
    expect(existsSync(join(runtimeDir, 'sentinel.txt'))).toBe(true);
    await stageRuntime({ ...options, fingerprint: 'e2' });
    expect(existsSync(join(runtimeDir, 'sentinel.txt'))).toBe(false);
  });

  it('reports whether the window process could be started and clears stale signals', async () => {
    const workDir = join(root, 'work');
    const stale = join(root, 'ready'); put(stale);
    const config = { workDir } as UpdateSplashConfig;
    expect(await startSplash(join(root, 'missing.exe'), config, [stale])).toBe(false);
    put(stale);
    expect(await startSplash(process.execPath, config, [stale])).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(workDir, 'config.json'))).toBe(true);
  });

  it('waits for a file to appear and gives up at the deadline', async () => {
    const file = join(root, 'shown');
    setTimeout(() => put(file), 60);
    expect(await waitForFile(file, 1000, 10)).toBe(true);
    expect(await waitForFile(join(root, 'never'), 60, 10)).toBe(false);
  });
});

describe('installInProgress', () => {
  const dir = () => join(root, 'update');
  const attempt = (version: string) => put(join(dir(), 'work', 'config.json'), JSON.stringify({ version }));

  it('is true for a fresh attempt targeting another version', () => {
    attempt('0.5.8');
    expect(installInProgress(dir(), '0.5.7', 60_000)).toBe(true);
  });

  it('is false without an attempt, for the target version itself and for stale attempts', () => {
    expect(installInProgress(dir(), '0.5.7', 60_000)).toBe(false);
    attempt('0.5.8');
    expect(installInProgress(dir(), '0.5.8', 60_000)).toBe(false);
    expect(installInProgress(dir(), '0.5.7', 60_000, Date.now() + 120_000)).toBe(false);
  });

  it('stays true past the usual age while the update window still beats, and is false once the beat stops', () => {
    attempt('0.5.8');
    expect(installInProgress(dir(), '0.5.7', 60_000, Date.now() + 120_000)).toBe(false);
    put(join(dir(), 'work', 'heartbeat'));
    expect(installInProgress(dir(), '0.5.7', 60_000, Date.now() + 5_000)).toBe(true);
    expect(installInProgress(dir(), '0.5.7', 60_000, Date.now() + 61_000)).toBe(false);
    // Not even a beating window is trusted forever.
    expect(installInProgress(dir(), '0.5.7', 60_000, Date.now() + HEARTBEAT_MAX_AGE_MS + 1_000)).toBe(false);
  });

  it('is false once the installer, the new app or an abort signalled', () => {
    attempt('0.5.8');
    for (const flag of [['installer-done'], ['ready'], ['work', 'abort']]) {
      put(join(dir(), ...flag));
      expect(installInProgress(dir(), '0.5.7', 60_000)).toBe(false);
      rmSync(join(dir(), ...flag));
      expect(installInProgress(dir(), '0.5.7', 60_000)).toBe(true);
    }
  });
});

describe('updateWindowAlive', () => {
  it('is true only while the update window of an earlier update still beats (the new start waits for it)', () => {
    const dir = join(root, 'update');
    expect(updateWindowAlive(dir)).toBe(false);
    put(join(dir, 'work', 'heartbeat'));
    expect(updateWindowAlive(dir)).toBe(true);
    expect(updateWindowAlive(dir, Date.now() + 60_000)).toBe(false);
    rmSync(join(dir, 'work', 'heartbeat'));
    expect(updateWindowAlive(dir)).toBe(false);
  });
});
