import { describe, expect, it } from 'vitest';
import {
  hostFormDirty, hostToDraft, normalizeSshHosts, reconnectAllTargets, reconnectAtStartCells, sshCellStart, sshStartEffects, validateHostDraft,
  type SshHost, type SshPhase,
} from '../src/shared/ssh';
import { normalizeState } from '../src/shared/state';
import { createAppStartClaim } from '../src/main/appStartClaim';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const host = (n: number, patch: Partial<SshHost> = {}): SshHost => ({ id: ID(n), label: `h${n}`, address: `h${n}.example`, port: 22, username: 'deploy', createdAt: 1, updatedAt: 1, ...patch });

describe('"Łącz ponownie po uruchomieniu aplikacji" on the saved host', () => {
  it('loads as off when missing or invalid and keeps only true', () => {
    expect(normalizeSshHosts([host(1)])[0].reconnectOnStart).toBeUndefined();
    expect(normalizeSshHosts([{ ...host(1), reconnectOnStart: true }])[0].reconnectOnStart).toBe(true);
    expect('reconnectOnStart' in normalizeSshHosts([{ ...host(1), reconnectOnStart: false }])[0]).toBe(false);
    for (const junk of ['true', 1, {}, null, [true]]) expect('reconnectOnStart' in normalizeSshHosts([{ ...host(1), reconnectOnStart: junk }])[0], String(junk)).toBe(false);
  });

  it('survives the state normalizer', () => {
    const s = normalizeState({ version: 1, projects: [], sshHosts: [{ ...host(1), reconnectOnStart: true }, { ...host(2), reconnectOnStart: 'yes' }, host(3)] });
    expect(s!.sshHosts.map((h) => h.reconnectOnStart)).toEqual([true, undefined, undefined]);
  });

  it('round-trips through the host form and counts as a change', () => {
    const on = host(1, { reconnectOnStart: true });
    expect(hostToDraft(on).reconnectOnStart).toBe(true);
    expect(hostToDraft(host(1)).reconnectOnStart).toBe(false);
    expect(hostToDraft(undefined).reconnectOnStart).toBe(false);
    const draft = hostToDraft(host(1));
    expect(validateHostDraft({ ...draft, reconnectOnStart: true })).toMatchObject({ ok: true, value: { reconnectOnStart: true } });
    const off = validateHostDraft(draft);
    expect(off.ok && 'reconnectOnStart' in off.value).toBe(false);
    expect(hostFormDirty(host(1), { ...draft, reconnectOnStart: true }, { tag: '', password: '' })).toBe(true);
    expect(hostFormDirty(on, hostToDraft(on), { tag: '', password: '' })).toBe(false);
  });
});

describe('the start decision of an SSH cell', () => {
  const base = { alive: false, connectOnMount: false, appStart: true, reconnectOnStart: true, mounted: true };
  it('connects at app start when the host asks for it and the cell view mounts', () => {
    expect(sshCellStart(base)).toBe('connect');
    expect(sshCellStart({ ...base, phase: 'idle' })).toBe('connect');
  });
  it('stays idle with the option off', () => {
    expect(sshCellStart({ ...base, reconnectOnStart: false })).toBe('idle');
    expect(sshCellStart({ ...base, reconnectOnStart: undefined })).toBe('idle');
  });
  it('stays idle after a renderer reload or a Pty Host restart (not an app start)', () => {
    expect(sshCellStart({ ...base, appStart: false })).toBe('idle');
  });
  it('attaches to a session that is alive (reload) or already live (reconnected meanwhile)', () => {
    expect(sshCellStart({ ...base, alive: true })).toBe('attach');
    for (const phase of ['connecting', 'verifying', 'authenticating', 'connected'] as SshPhase[]) expect(sshCellStart({ ...base, phase }), phase).toBe('attach');
  });
  it('does not connect in the background (automation, background loader)', () => {
    expect(sshCellStart({ ...base, mounted: false })).toBe('idle');
  });
  it('leaves an ended or failed session of this run alone', () => {
    expect(sshCellStart({ ...base, phase: 'closed' })).toBe('idle');
    expect(sshCellStart({ ...base, phase: 'error' })).toBe('idle');
  });
  it('still connects a cell the user just created, whatever the option', () => {
    expect(sshCellStart({ alive: false, connectOnMount: true })).toBe('connect');
    expect(sshCellStart({ ...base, appStart: false, reconnectOnStart: false, mounted: false, connectOnMount: true })).toBe('connect');
  });
});

describe('cells marked at app start', () => {
  it('lists SSH cells of hosts with the option on, in every project and tab', () => {
    const projects = [
      { tabs: [{ cells: [{ id: 'a', ssh: { hostId: ID(1) } }, { id: 'b' }, { id: 'c', ssh: { hostId: ID(2) } }] }] },
      { tabs: [{ cells: [] }, { cells: [{ id: 'd', ssh: { hostId: ID(1) } }, { id: 'e', ssh: { hostId: ID(9) } }] }] },
    ];
    expect(reconnectAtStartCells(projects, [host(1, { reconnectOnStart: true }), host(2)])).toEqual(['a', 'd']);
    expect(reconnectAtStartCells(projects, [host(1), host(2)])).toEqual([]);
  });
});

describe('"Połącz ponownie wszystkie SSH"', () => {
  const hosts = new Set([ID(1), ID(2)]);
  const cell = (id: string, hostId = ID(1)) => ({ id, ssh: { hostId } });
  it('picks idle, ended, failed and never started SSH cells only', () => {
    const cells = [cell('idle'), cell('closed'), cell('error'), cell('new'), cell('conn'), cell('ver'), cell('auth'), cell('up'), { id: 'local' }, cell('gone', ID(7))];
    const sessions = {
      idle: { phase: 'idle' as const }, closed: { phase: 'closed' as const }, error: { phase: 'error' as const },
      conn: { phase: 'connecting' as const }, ver: { phase: 'verifying' as const }, auth: { phase: 'authenticating' as const }, up: { phase: 'connected' as const },
    };
    expect(reconnectAllTargets(cells, sessions, hosts)).toEqual(['idle', 'closed', 'error', 'new']);
  });
  it('is empty when every SSH cell is connecting or connected', () => {
    expect(reconnectAllTargets([cell('a'), cell('b')], { a: { phase: 'connected' }, b: { phase: 'connecting' } }, hosts)).toEqual([]);
  });
  it('takes at most the 20 cells of a grid', () => {
    const cells = Array.from({ length: 25 }, (_, i) => cell(`c${i}`));
    expect(reconnectAllTargets(cells, {}, hosts)).toHaveLength(20);
  });
});

describe('the app start claim of main', () => {
  it('answers true once (a foreign sender never reaches it: the channel is sender-guarded)', () => {
    const c = createAppStartClaim();
    expect(c.claim()).toBe(true);
    expect(c.claim()).toBe(false); // a reload
  });
  it('is spent by a Pty Host restart before the renderer claims it', () => {
    const c = createAppStartClaim();
    c.cancel();
    expect(c.claim()).toBe(false);
  });
});

describe('what a start of an SSH cell leaves behind', () => {
  it('spends the app-start mark only when the cell view mounts', () => {
    expect(sshStartEffects(true, 'connect')).toEqual({ spendMark: true, keepStarted: true });
    expect(sshStartEffects(true, 'idle')).toEqual({ spendMark: true, keepStarted: true });
  });
  it('lets a later mount decide again after an idle start from elsewhere (task restore, automation, path drop)', () => {
    expect(sshStartEffects(false, 'idle')).toEqual({ spendMark: false, keepStarted: false });
    expect(sshStartEffects(false, 'connect')).toEqual({ spendMark: false, keepStarted: true }); // a cell the user just created
    expect(sshStartEffects(false, 'attach')).toEqual({ spendMark: false, keepStarted: true });
  });
  it('a background start keeps the mark, so the mount still connects at app start', () => {
    const background = sshCellStart({ alive: false, connectOnMount: false, appStart: true, reconnectOnStart: true, mounted: false });
    expect(background).toBe('idle');
    expect(sshStartEffects(false, background).spendMark).toBe(false);
    expect(sshCellStart({ alive: false, connectOnMount: false, appStart: true, reconnectOnStart: true, mounted: true, phase: 'idle' })).toBe('connect');
  });
});
