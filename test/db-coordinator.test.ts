// The SSH coordinator with SFTP sessions and DB tunnels side by side (1.0.0): each kind is routed to its own host process,
// listed in its own snapshot and ended only by its own host's restart.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshCoordinator, sessionHostOf, type SshHostCommand } from '../src/main/ssh/coordinator';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { SshVault } from '../src/main/ssh/vault';
import { dbSessionId } from '../src/shared/db';
import { sftpSessionId } from '../src/shared/sftp';
import type { SshSessionState } from '../src/shared/ssh';
import { addSshHost, defaultState } from '../src/shared/state';
import { fakeCipher } from './helpers/sshKeys';

const HOST = '00000000-0000-4000-8000-0000000000aa';
const SFTP = sftpSessionId('11111111-0000-4000-8000-000000000001');
const DB = dbSessionId('22222222-0000-4000-8000-000000000002');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-coord-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(deliver: { sftp?: boolean; db?: boolean } = {}) {
  const state = addSshHost(defaultState(), { id: HOST, label: 'vps', address: '127.0.0.1', port: 22, username: 'alice', createdAt: 0, updatedAt: 0 });
  const routed: Array<{ to: string; m: SshHostCommand }> = [];
  const sessions: SshSessionState[] = [];
  const coordinator = new SshCoordinator({
    state: () => state, vault: new SshVault(join(dir, 'vault.json'), fakeCipher()), knownHosts: new KnownHostsStore(join(dir, 'kh.json')),
    // What main/index.ts does: route by the session id prefix.
    host: (m) => {
      const id = m.t === 'sshConnect' ? m.req.id : m.id;
      const to = sessionHostOf(id) ?? 'pty';
      routed.push({ to, m });
      return to === 'sftp' ? deliver.sftp !== false : to === 'db' ? deliver.db !== false : true;
    },
    events: { session: (s) => sessions.push(s), prompt: () => undefined, vaultChanged: () => undefined },
  });
  const last = (id: string) => sessions.filter((s) => s.cellId === id).at(-1);
  return { coordinator, routed, last };
}

describe('SSH coordinator: SFTP sessions and DB tunnels', () => {
  it('routes db: ids to the DB Host and sftp: ids to the SFTP Host', async () => {
    const t = setup();
    expect(await t.coordinator.connectSession({ sessionId: SFTP, hostId: HOST })).toEqual({ ok: true });
    expect(await t.coordinator.connectSession({ sessionId: DB, hostId: HOST })).toEqual({ ok: true });
    expect(t.routed.map((r) => [r.to, r.m.t === 'sshConnect' ? r.m.req.id : '']).sort()).toEqual([['db', DB], ['sftp', SFTP]]);
    expect(await t.coordinator.connectSession({ sessionId: 'cell-1', hostId: HOST })).toEqual({ ok: false, error: 'unknown' });
  });

  it('an undelivered DB tunnel login reads dbHostCrashed', async () => {
    const t = setup({ db: false });
    expect(await t.coordinator.connectSession({ sessionId: DB, hostId: HOST })).toEqual({ ok: false, error: 'dbHostCrashed' });
    expect(t.last(DB)).toMatchObject({ phase: 'error', error: 'dbHostCrashed' });
  });

  it('keeps the snapshots apart and ends only the sessions of the host that restarted', async () => {
    const t = setup();
    await t.coordinator.connectSession({ sessionId: SFTP, hostId: HOST });
    await t.coordinator.connectSession({ sessionId: DB, hostId: HOST });
    t.coordinator.onHostMessage({ t: 'sshStatus', id: SFTP, phase: 'connected' });
    t.coordinator.onHostMessage({ t: 'sshStatus', id: DB, phase: 'connected' });
    expect(t.coordinator.sessionSnapshot().sessions.map((s) => s.cellId)).toEqual([SFTP]);
    expect(t.coordinator.sessionSnapshot('db').sessions.map((s) => s.cellId)).toEqual([DB]);
    expect(t.coordinator.sessions().sessions).toEqual([]);
    t.coordinator.sessionHostCrashed('sftp');
    expect(t.last(SFTP)).toMatchObject({ phase: 'error', error: 'sftpHostCrashed' });
    expect(t.last(DB)?.phase).toBe('connected');
    t.coordinator.sessionHostCrashed('db');
    expect(t.last(DB)).toMatchObject({ phase: 'error', error: 'dbHostCrashed' });
    // The Pty Host restarting touches neither.
    t.coordinator.hostCrashed();
    expect(t.last(SFTP)?.error).toBe('sftpHostCrashed');
  });
});
