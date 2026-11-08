// PLAN R1: scripts/check-bundle-contents.mjs (npm run check:bundle) keeps Node out of the shipped app.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { forbidden, nsisFiles } from '../scripts/check-bundle-contents.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('bundle contents', () => {
  it('refuses a Node runtime, native addons, loose JavaScript, node_modules and Electron archives', () => {
    for (const path of ['node.exe', 'resources/node', 'lib/libnode.so.127', 'resources/pty.node', 'resources/app/main.js', 'x/chunk.mjs',
      'x/y.cjs', 'resources/node_modules/zod/package.json', 'resources/app.asar']) expect(forbidden(path), path).not.toBeNull();
    for (const path of ['unimux.exe', 'resources/conpty/x64/conpty.dll', 'resources/conpty/x64/OpenConsole.exe', 'Contents/MacOS/unimux',
      'Contents/Info.plist', 'Contents/Resources/icon.icns', 'uninstall.exe', 'resources/json.txt']) expect(forbidden(path), path).toBeNull();
  });

  it('lists what an NSIS script installs: the main binary, renamed resources and included hooks, not $TEMP helpers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unimux-bundle-check-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'hooks.nsh'), '!macro NSIS_HOOK_POSTINSTALL\n  File "/oname=$INSTDIR\\extra\\helper.js" "C:\\src\\helper.js"\n!macroend\n');
    writeFileSync(join(dir, 'installer.nsi'), [
      '!define MAINBINARYSRCPATH "C:\\build\\release\\unimux.exe"',
      '!define WEBVIEW2BOOTSTRAPPERPATH "C:\\cache\\MicrosoftEdgeWebview2Setup.exe"',
      `!include "${join(dir, 'hooks.nsh')}"`,
      'Section Install',
      '  File "/oname=$TEMP\\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"',
      '  File "${MAINBINARYSRCPATH}"',
      '  CreateDirectory "$INSTDIR\\resources\\conpty\\x64"',
      '  File /a "/oname=resources\\conpty\\x64\\conpty.dll" "C:\\src\\conpty.dll"',
      'SectionEnd',
    ].join('\r\n'));
    const files = nsisFiles(join(dir, 'installer.nsi'));
    expect(files.sort()).toEqual(['extra/helper.js', 'resources/conpty/x64/conpty.dll', 'unimux.exe']);
    expect(files.filter((f: string) => forbidden(f))).toEqual(['extra/helper.js']);
  });
});
