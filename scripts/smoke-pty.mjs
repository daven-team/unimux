// Load node-pty with the packaged Electron runtime to catch ABI/architecture mismatches.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// The packaged node-pty must carry the conout Worker limits and error listener added at install time (scripts/patch-node-pty.cjs).
const { PATCHED } = createRequire(import.meta.url)('./patch-node-pty.cjs');

const mac = process.platform === 'darwin';
const bundle = resolve('release', mac ? `mac${process.arch === 'arm64' ? '-arm64' : ''}/unimux.app/Contents` : 'win-unpacked');
const executable = resolve(bundle, mac ? 'MacOS/unimux' : 'unimux.exe');
// The Windows build packs the app into resources/app.asar (node-pty itself stays in app.asar.unpacked), so load it
// through the archive like the app does; macOS keeps a plain resources/app directory.
const resources = resolve(bundle, mac ? 'Resources' : 'resources');
const asar = resolve(resources, 'app.asar');
const appRoot = existsSync(asar) ? asar : resolve(resources, 'app');
const modulePath = existsSync(asar) ? resolve(asar, 'node_modules/node-pty') : resolve(resources, 'app/node_modules/node-pty');
if (!existsSync(executable) || !(existsSync(asar) || existsSync(modulePath))) throw new Error('Packaged Electron or node-pty is missing');
if (mac) {
  // mac.files drops node-pty's Windows prebuilds and its build/ folder: the app must load the darwin prebuild of its arch.
  for (const dropped of ['prebuilds/win32-x64', 'prebuilds/win32-arm64', 'build', 'third_party']) {
    if (existsSync(resolve(modulePath, dropped))) throw new Error(`node-pty/${dropped} should not be packaged on macOS`);
  }
  const helper = resolve(modulePath, `prebuilds/darwin-${process.arch}/spawn-helper`);
  if (!existsSync(helper) || !(statSync(helper).mode & 0o111)) throw new Error('node-pty spawn-helper is missing or not executable');
}

const script = `
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const appRoot = ${JSON.stringify(appRoot)};
  for (const [name, size] of [['icon.png', 1024], ['icon-64.png', 64]]) {
    const png = fs.readFileSync(path.join(appRoot, 'resources', name));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', name + ' signature');
    assert.equal(png.readUInt32BE(16), size, name + ' width');
    assert.equal(png.readUInt32BE(20), size, name + ' height');
  }
  const ico = fs.readFileSync(path.join(appRoot, 'resources', 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  const splash = fs.readFileSync(path.join(appRoot, 'resources/update-splash/index.html'), 'utf8');
  assert.match(splash, /class="logo" src="icon.png"/);
  process.stdout.write('Packaged branding assets OK\\n');
  // Every package out/main requires must resolve inside the package (the file lists drop type declarations, the MCP SDK's
  // ESM copy and zod's ESM files): the pure ones are loaded too, so their own requires are checked as well.
  const { builtinModules, createRequire } = require('node:module');
  const mainDir = path.join(appRoot, 'out', 'main');
  const mainFiles = [...fs.readdirSync(mainDir), ...fs.readdirSync(path.join(mainDir, 'chunks')).map((f) => 'chunks/' + f)].filter((f) => f.endsWith('.js'));
  const mainSource = mainFiles.map((f) => fs.readFileSync(path.join(mainDir, f), 'utf8')).join('\\n');
  const external = [...new Set([...mainSource.matchAll(/require\\("([^".][^"]*)"\\)/g)].map((m) => m[1]))]
    .filter((id) => id !== 'electron' && !id.startsWith('node:') && !builtinModules.includes(id.split('/')[0]));
  const appRequire = createRequire(path.join(mainDir, 'index.js'));
  for (const id of ['@modelcontextprotocol/sdk/server/index.js', 'zod', 'ssh2', 'node-pty', 'pg', 'pg-cursor', 'ioredis']) assert.ok(external.includes(id), id + ' is required by out/main');
  for (const id of external) {
    appRequire.resolve(id);
    // electron-updater needs a running Electron app, node-pty is started below.
    if (id !== 'electron-updater' && id !== 'node-pty') appRequire(id);
  }
  for (const id of ['zod/v3', 'zod/v4']) appRequire(id);
  process.stdout.write('Packaged main dependencies OK (' + external.join(', ') + ')\\n');
  const conout = fs.readFileSync(path.join(${JSON.stringify(modulePath)}, 'lib', 'windowsConoutConnection.js'), 'utf8');
  assert.ok(conout.includes(${JSON.stringify(PATCHED)}), 'packaged node-pty lacks the conout Worker patch (limits and error listener)');
  process.stdout.write('Packaged node-pty conout Worker patch OK\\n');
  const pty = require(${JSON.stringify(modulePath)});
  const windows = process.platform === 'win32';
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const terminal = pty.spawn(windows ? 'cmd.exe' : '/bin/bash',
    windows ? ['/d', '/c', 'echo unimux-pty-ok'] : ['-c', 'printf "unimux-pty-%s\\n" ok'],
    { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env,
      ...(windows ? { useConpty: true, useConptyDll: true } : {}) });
  let output = '';
  const timeout = setTimeout(() => { terminal.kill(); process.exit(1); }, 15000);
  terminal.onData((data) => { output += data; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    if (exitCode !== 0 || !output.includes('unimux-pty-ok')) {
      process.stderr.write(output);
      process.exit(1);
    }
    process.stdout.write('Packaged terminal OK (' + process.platform + '/' + process.arch + ')\\n', () => process.exit(0));
  });
`;
execFileSync(executable, ['-e', script], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit', windowsHide: true, timeout: 20000,
});
