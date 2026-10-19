// The DB vault (1.0.0): database passwords sealed with safeStorage in <data>/db/vault.json, next to the SSH vault.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbVault } from '../src/main/db/vault';
import { fakeCipher } from './helpers/sshKeys';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
let dir: string;
const file = () => join(dir, 'db', 'vault.json');
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-dbvault-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('DbVault', () => {
  it('stores passwords sealed, never in plain text or base64, and reads them back', () => {
    const vault = new DbVault(file(), fakeCipher(), () => 5);
    expect(vault.setPassword(A, 'p@ss-word-1')).toEqual({ ok: true, ephemeral: false });
    const raw = readFileSync(file(), 'utf8');
    expect(raw).not.toContain('p@ss-word-1');
    expect(raw).not.toContain(Buffer.from('p@ss-word-1').toString('base64'));
    const again = new DbVault(file(), fakeCipher());
    expect(again.password(A)).toEqual({ ok: true, password: 'p@ss-word-1' });
    expect(again.info()).toEqual({ storage: 'dpapi', saved: [A], locked: [], readOnly: false });
    expect(again.password(B)).toEqual({ ok: false, error: 'none' });
  });

  it('copies, clears and prunes passwords', () => {
    const vault = new DbVault(file(), fakeCipher());
    vault.setPassword(A, 'one');
    expect(vault.copyPassword(A, B)).toBe(true);
    expect(vault.password(B)).toEqual({ ok: true, password: 'one' });
    expect(vault.clearPassword(A)).toBe(true);
    expect(vault.clearPassword(A)).toBe(false);
    expect(vault.prune(new Set([A]))).toBe(true);
    expect(new DbVault(file(), fakeCipher()).info().saved).toEqual([]);
  });

  it('keeps passwords in memory only without encryption (D8) and marks undecryptable ones locked', () => {
    const memory = new DbVault(file(), fakeCipher({ available: false }));
    expect(memory.setPassword(A, 'x')).toEqual({ ok: true, ephemeral: true });
    expect(memory.password(A)).toEqual({ ok: true, password: 'x' });
    expect(existsSync(file())).toBe(false);
    new DbVault(file(), fakeCipher()).setPassword(A, 'y');
    const broken = new DbVault(file(), fakeCipher({ broken: true }));
    expect(broken.password(A)).toEqual({ ok: false, error: 'locked' });
    expect(broken.info().locked).toEqual([A]);
  });

  it('opens a newer or damaged file read-only and never writes over it', () => {
    mkdirSync(join(dir, 'db'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ version: 9, passwords: [] }));
    const newer = new DbVault(file(), fakeCipher());
    expect(newer.readOnly()).toBe(true);
    expect(newer.setPassword(A, 'x')).toEqual({ ok: false, error: 'readOnly' });
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBe(9);
    writeFileSync(file(), JSON.stringify({ version: 1, passwords: [{ connectionId: A }] }));
    expect(new DbVault(file(), fakeCipher()).readOnly()).toBe(true);
    writeFileSync(file(), '{ not json');
    const fresh = new DbVault(file(), fakeCipher());
    expect(fresh.readOnly()).toBe(false); // the unparsable file was kept as a backup
  });
});
