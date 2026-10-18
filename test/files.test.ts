import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join, relative } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATCH_LIMIT, listProjectDirectories, listProjectDirectory, listProjectDirectoryBatch, PREVIEW_BYTES, readProjectFile, writeProjectFile } from '../src/main/files';

let fixture: string;
let root: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'mc-files-'));
  root = join(fixture, 'project');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested', 'hello.txt'), 'Cześć, świecie!\n');
  await writeFile(join(root, 'file10.txt'), 'ten');
  await writeFile(join(root, 'file2.txt'), 'two');
  await writeFile(join(fixture, 'outside.txt'), 'outside the project');
});

afterAll(async () => {
  const rel = relative(tmpdir(), fixture);
  if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('mc-files-')) throw new Error('Unsafe test cleanup target');
  await rm(fixture, { recursive: true, force: true });
});

describe('project file browsing', () => {
  it('lists folders first and sorts file names naturally', async () => {
    const listing = await listProjectDirectory(root);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.entries.map((x) => x.name)).toEqual(['nested', 'file2.txt', 'file10.txt']);
    expect((await listProjectDirectory(root, 'nested'))).toMatchObject({ ok: true, entries: [{ path: 'nested/hello.txt', kind: 'file' }] });
  });

  it('reads text without altering the file', async () => {
    expect(await readProjectFile(root, 'nested/hello.txt')).toMatchObject({ kind: 'text', text: 'Cześć, świecie!\n', truncated: false });
  });

  it('blocks traversal and absolute paths', async () => {
    expect(await readProjectFile(root, '../outside.txt')).toMatchObject({ kind: 'error' });
    expect(await readProjectFile(root, join(fixture, 'outside.txt'))).toMatchObject({ kind: 'error' });
    expect(await listProjectDirectory(root, '..')).toMatchObject({ ok: false });
  });

  it('blocks directory junctions leading outside the project', async () => {
    const outside = join(fixture, 'external');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'not in this project');
    await symlink(outside, join(root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await listProjectDirectory(root, 'external-link')).toMatchObject({ ok: false });
    expect(await readProjectFile(root, 'external-link/secret.txt')).toMatchObject({ kind: 'error' });
  });

  it('limits large previews and handles a UTF-8 character cut at the limit', async () => {
    await writeFile(join(root, 'large.txt'), 'a'.repeat(PREVIEW_BYTES - 1) + 'ą' + 'tail');
    const preview = await readProjectFile(root, 'large.txt');
    expect(preview.kind).toBe('text');
    if (preview.kind !== 'text') return;
    expect(preview.truncated).toBe(true);
    expect(preview.text).toBe('a'.repeat(PREVIEW_BYTES - 1));
  });

  it('supports UTF-16 Windows text files and distinguishes binary content', async () => {
    await writeFile(join(root, 'utf16.txt'), Buffer.from('\ufeffPolskie znaki: ąęć\n', 'utf16le'));
    expect(await readProjectFile(root, 'utf16.txt')).toMatchObject({ kind: 'text', text: 'Polskie znaki: ąęć\n' });
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
    expect(await readProjectFile(root, 'binary.dat')).toMatchObject({ kind: 'binary', size: 4 });
  });

  it('returns useful errors for missing files and prevents previewing directories', async () => {
    expect(await readProjectFile(root, 'missing.txt')).toMatchObject({ kind: 'error', message: expect.stringContaining('nie istnieje') });
    expect(await listProjectDirectory(root, 'missing')).toMatchObject({ ok: false });
    expect(await readProjectFile(root, 'nested')).toMatchObject({ kind: 'error' });
  });
});

describe('tree listings in batches', () => {
  it('lists many folders in one call, each like a single listing', async () => {
    const result = await listProjectDirectoryBatch(root, ['', 'nested', 'missing', '../', 'nested']);
    expect(Object.keys(result).sort()).toEqual(['', '../', 'missing', 'nested']);
    expect(result['']).toEqual(await listProjectDirectory(root, ''));
    expect(result.nested).toMatchObject({ ok: true, entries: [{ path: 'nested/hello.txt' }] });
    expect(result.missing).toMatchObject({ ok: false });
    expect(result['../']).toMatchObject({ ok: false });
  });

  it('ignores malformed input and caps the number of folders', async () => {
    expect(await listProjectDirectoryBatch(root, 'nested')).toEqual({});
    expect(Object.keys(await listProjectDirectoryBatch(root, [1, null, 'nested']))).toEqual(['nested']);
    const many = Array.from({ length: BATCH_LIMIT + 5 }, (_, i) => `missing-${i}`);
    expect(Object.keys(await listProjectDirectoryBatch(root, many))).toHaveLength(BATCH_LIMIT);
  });

  it('walks every folder breadth first in natural order (read level by level in parallel)', async () => {
    const walk = join(fixture, 'walk');
    for (const dir of ['b/x', 'a10', 'a2/y/z', 'node_modules/pkg']) await mkdir(join(walk, dir), { recursive: true });
    expect(await listProjectDirectories(walk)).toEqual({ ok: true, paths: ['a2', 'a10', 'b', 'a2/y', 'b/x', 'a2/y/z'], truncated: false });
  });
});

describe('safe project file editing', () => {
  it.each(['utf8', 'utf8-bom', 'utf16le', 'utf16be'])('preserves encoding, BOM and CRLF for %s', async (encoding) => {
    const path = `edit-${encoding}.txt`;
    const original = 'Cześć\r\nświat\r\n';
    const updated = 'Cześć\r\nnowy świat\r\n';
    const encode = (text: string) => {
      if (encoding.startsWith('utf16')) {
        const bytes = Buffer.from('\ufeff' + text, 'utf16le');
        return encoding === 'utf16be' ? bytes.swap16() : bytes;
      }
      return Buffer.from((encoding === 'utf8-bom' ? '\ufeff' : '') + text, 'utf8');
    };
    await writeFile(join(root, path), encode(original));
    expect(await writeProjectFile(root, path, 'Cześć\nnowy świat\n', original)).toEqual({ ok: true });
    expect(await readFile(join(root, path))).toEqual(encode(updated));
  });

  it('preserves mixed line endings and empty files', async () => {
    await writeFile(join(root, 'mixed.txt'), 'one\r\ntwo\nthree\r');
    expect(await writeProjectFile(root, 'mixed.txt', 'ONE\nTWO\nTHREE\n', 'one\r\ntwo\nthree\r')).toEqual({ ok: true });
    expect(await readFile(join(root, 'mixed.txt'), 'utf8')).toBe('ONE\r\nTWO\nTHREE\r');
    await writeFile(join(root, 'empty.txt'), '');
    expect(await writeProjectFile(root, 'empty.txt', 'ą\n', '')).toEqual({ ok: true });
    expect(await writeProjectFile(root, 'empty.txt', '', 'ą\n')).toEqual({ ok: true });
    expect(await readFile(join(root, 'empty.txt'), 'utf8')).toBe('');
  });

  it('rejects an external edit without changing bytes or leaving temporary files', async () => {
    await writeFile(join(root, 'conflict.txt'), 'external');
    // The renderer tells a conflict by its code, never by the (Polish) message.
    expect(await writeProjectFile(root, 'conflict.txt', 'draft', 'original')).toMatchObject({ ok: false, code: 'conflict', error: expect.stringContaining('zmienił') });
    expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('external');
    expect((await readdir(root)).filter((name) => name.includes('.mc-save-'))).toEqual([]);
    // "Overwrite (keep mine)": the same draft against the text now on disk is written.
    expect(await writeProjectFile(root, 'conflict.txt', 'draft', 'external')).toEqual({ ok: true });
    expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('draft');
  });

  it('other save failures carry no conflict code', async () => {
    await writeFile(join(root, 'bad-text.txt'), 'ok');
    const result = await writeProjectFile(root, 'bad-text.txt', 'a\u0001b', 'ok');
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty('code');
  });

  it('serializes concurrent saves to the same baseline', async () => {
    await writeFile(join(root, 'concurrent.txt'), 'initial');
    const results = await Promise.all([
      writeProjectFile(root, 'concurrent.txt', 'first', 'initial'),
      writeProjectFile(root, 'concurrent.txt', 'second', 'initial'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(['first', 'second']).toContain(await readFile(join(root, 'concurrent.txt'), 'utf8'));
  });

  it('rejects binary, truncated, oversized output and invalid text without damage', async () => {
    for (const [path, original] of [
      ['edit-binary.dat', Buffer.from([0, 1, 2, 255])],
      ['edit-large.txt', Buffer.from('a'.repeat(PREVIEW_BYTES + 1))],
      ['edit-invalid.txt', Buffer.from([0xc3, 0x28])],
    ] as const) {
      await writeFile(join(root, path), original);
      expect(await writeProjectFile(root, path, 'replacement', '')).toMatchObject({ ok: false });
      expect(await readFile(join(root, path))).toEqual(original);
    }
    await writeFile(join(root, 'edit-output.txt'), 'original');
    for (const text of ['a'.repeat(PREVIEW_BYTES + 1), 'null\0byte', '\ud800']) {
      expect(await writeProjectFile(root, 'edit-output.txt', text, 'original')).toMatchObject({ ok: false });
      expect(await readFile(join(root, 'edit-output.txt'), 'utf8')).toBe('original');
    }
  });

  it('rejects missing files, directories, traversal, absolute paths and external junctions', async () => {
    for (const path of ['missing-edit.txt', 'nested', '../outside.txt', join(fixture, 'outside.txt'), 'external-link/secret.txt']) {
      expect(await writeProjectFile(root, path, 'overwrite', '')).toMatchObject({ ok: false });
    }
    expect(await readFile(join(fixture, 'outside.txt'), 'utf8')).toBe('outside the project');
  });
});
