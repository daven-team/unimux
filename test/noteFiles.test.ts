import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readNoteImage, registerNoteFilesIpc, saveNoteImage } from '../src/main/noteFiles';
import type { IpcGuard } from '../src/main/ipcGuard';

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'unimux-note-files-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('note images in the data folder', () => {
  it('saves a pasted image under a random name and reads it back as a data URL', async () => {
    const data = scratch();
    const name = await saveNoteImage(data, png, 'image/png');
    expect(name).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(readdirSync(join(data, 'note-images'))).toEqual([name]);
    expect(await readNoteImage(data, name)).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  });

  it('refuses what is not a small image of a known type', async () => {
    const data = scratch();
    expect(await saveNoteImage(data, png, 'image/svg+xml')).toBeNull();
    expect(await saveNoteImage(data, 'text', 'image/png')).toBeNull();
    expect(await saveNoteImage(data, new Uint8Array(0), 'image/png')).toBeNull();
    expect(await saveNoteImage(data, new Uint8Array(8 * 1024 * 1024 + 1), 'image/png')).toBeNull();
  });

  it('reads only names the app gave, never a path', async () => {
    const data = scratch();
    writeFileSync(join(data, 'secret.png'), 'x');
    expect(await readNoteImage(data, '../secret.png')).toBeNull();
    expect(await readNoteImage(data, 42)).toBeNull();
    expect(await readNoteImage(data, '0f8fad5b-d9cb-469f-a165-70867728950e.png')).toBeNull();
  });
});

describe('note export', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const guard = {
    guardedHandle: (channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => unknown) => { handlers.set(channel, (...args) => handler({ sender: null }, ...args)); },
    guardedOn: () => {},
  } as unknown as IpcGuard;

  it('writes the note where the dialog points and refuses names with a path', async () => {
    const data = scratch();
    let asked = '';
    registerNoteFilesIpc(guard, { dataDir: data, pickSavePath: async (name) => { asked = name; return join(data, 'out.md'); } });
    expect(await handlers.get('notes:export')!('Plan.md', '# Plan')).toEqual({ ok: true, path: join(data, 'out.md') });
    expect(asked).toBe('Plan.md');
    expect(await handlers.get('notes:export')!('../x.md', 'x')).toEqual({ ok: false });
    registerNoteFilesIpc(guard, { dataDir: data, pickSavePath: async () => null });
    expect(await handlers.get('notes:export')!('Plan.md', 'x')).toEqual({ ok: false, cancelled: true });
  });
});
