// The SFTP view's session in the renderer (0.9.9 final review): a sudo session is never kept alive for editor tabs (they never
// use it), main learns which session the open view shows, and an editor session (plain) is never adopted after a reload.
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/src/ssh', () => ({ openSshView: () => undefined, selectSshSection: () => undefined }));

const renderer = (name: string) => `../src/renderer/src/${name}`;
const SUDO_HOST = '00000000-0000-4000-8000-0000000000a1';
const PLAIN_HOST = '00000000-0000-4000-8000-0000000000a2';
const OTHER_HOST = '00000000-0000-4000-8000-0000000000a3';
const EDITOR_SESSION = 'sftp:00000000-0000-4000-8000-0000000000e0';

let sftp: any;
let sftpStore: any;
let sshStore: any;
let remote: any;
const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
const emit = (channel: string, ...args: unknown[]) => { for (const cb of listeners.get(channel) ?? []) cb(...args); };
const calls: string[] = [];
let next = 0;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('navigator', { languages: ['en'] });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      on: (channel: string, cb: (...a: unknown[]) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), cb]); return () => undefined; },
      sftp: {
        // After a reload main still has an editor tab's plain session of a sudo host.
        sessions: async () => ({ sessions: [{ id: EDITOR_SESSION, hostId: SUDO_HOST, state: 'connected', phase: 'connected', since: 1, plain: true }], prompts: [] }),
        connect: async (hostId: string) => { const id = `sftp:00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`; calls.push(`connect:${hostId}`); return { ok: true, sessionId: id }; },
        disconnect: async (id: string) => { calls.push(`disconnect:${id}`); return { ok: true }; },
        cancel: async () => ({ ok: true }),
        pinHosts: (ids: string[]) => { calls.push(`pin:${ids.join(',')}`); },
        viewOpened: (id: string | null) => { calls.push(`viewOpened:${id}`); },
        viewClosed: () => { calls.push('viewClosed'); },
      },
    },
    addEventListener: () => undefined,
    setTimeout, clearTimeout,
  });
  const store = await import(/* @vite-ignore */ renderer('store'));
  store.useStore.setState((st: any) => ({ s: { ...st.s, sshHosts: [
    { id: SUDO_HOST, label: 'root', address: 'a', port: 22, username: 'u', sftpSudo: true },
    { id: PLAIN_HOST, label: 'plain', address: 'b', port: 22, username: 'u' },
    { id: OTHER_HOST, label: 'other', address: 'c', port: 22, username: 'u' },
  ] } }));
  sftp = await import(/* @vite-ignore */ renderer('sftp'));
  sftpStore = (await import(/* @vite-ignore */ renderer('sftpStore'))).useSftpStore;
  sshStore = (await import(/* @vite-ignore */ renderer('sshStore'))).useSshStore;
  remote = await import(/* @vite-ignore */ renderer('remoteSessions'));
  remote.initRemoteSessions();
  await sftp.initSftp();
});

const connected = (id: string, hostId: string, extra: Record<string, unknown> = {}) =>
  emit('sftp:session', { id, hostId, state: 'connected', phase: 'connected', since: 2, ...extra });

describe('the SFTP view session', () => {
  it('never adopts an editor session (plain) after a reload', () => {
    expect(sftpStore.getState().sessionId).toBeNull();
  });

  it('tells main which session the open view shows, again when it changes', async () => {
    sshStore.setState({ viewOpen: true, viewActive: true, section: 'sftp' });
    expect(calls.at(-1)).toBe('viewOpened:null');
    expect(await sftp.connectSftp(SUDO_HOST)).toBe(true);
    const id = sftpStore.getState().sessionId;
    expect(calls).toContain(`viewOpened:${id}`);
  });

  it('switching host from a sudo session disconnects it even when the host has unsaved editor tabs', async () => {
    const root = sftpStore.getState().sessionId;
    connected(root, SUDO_HOST, { sudo: true });
    remote.pinHosts([SUDO_HOST]);
    calls.length = 0;
    expect(await sftp.connectSftp(OTHER_HOST)).toBe(true);
    expect(calls).toContain(`disconnect:${root}`);
  });

  it('a plain session the unsaved tabs use is let go of, not disconnected', async () => {
    expect(await sftp.connectSftp(PLAIN_HOST)).toBe(true);
    const id = sftpStore.getState().sessionId;
    connected(id, PLAIN_HOST);
    remote.pinHosts([PLAIN_HOST]);
    calls.length = 0;
    expect(await sftp.connectSftp(OTHER_HOST)).toBe(true);
    expect(calls).not.toContain(`disconnect:${id}`);
    expect(calls.some((c) => c.startsWith('viewOpened:sftp:'))).toBe(true);
  });

  it('"Rozłącz" of a sudo session does not ask about unsaved tabs (they never use it)', async () => {
    expect(await sftp.connectSftp(SUDO_HOST)).toBe(true);
    const id = sftpStore.getState().sessionId;
    connected(id, SUDO_HOST, { sudo: true });
    remote.pinHosts([SUDO_HOST]);
    calls.length = 0;
    await sftp.disconnectSftp();
    expect(calls).toContain(`disconnect:${id}`);
  });
});
