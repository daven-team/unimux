import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILES } from '../src/shared/profiles';
import {
  canLaunchSource, describeLaunch, groupTerminalSources, listTerminalSources, localShellProvider, sshHostProvider, TERMINAL_SOURCE_PROVIDERS,
  type TerminalSource, type TerminalSourceContext, type TerminalSourceProvider,
} from '../src/shared/terminalSources';
import type { Profile } from '../src/shared/types';

const ctx = (patch: Partial<TerminalSourceContext> = {}): TerminalSourceContext => ({ profiles: DEFAULT_PROFILES, platform: 'win32', shell: 'pwsh', ...patch });

describe('terminal sources', () => {
  it('lists the local shell profiles as sources that launch a profile', () => {
    const sources = listTerminalSources(ctx());
    expect(sources).toEqual([{ id: 'local:shell', label: 'PowerShell', kind: 'local', detail: 'PowerShell 7 (pwsh)', launch: { type: 'profile', profileId: 'shell' } }]);
    expect(sources.every(canLaunchSource)).toBe(true);
    expect(TERMINAL_SOURCE_PROVIDERS).toContain(localShellProvider);
  });

  it('follows the configured shell and platform, and extra profile arguments', () => {
    const custom: Profile[] = [...DEFAULT_PROFILES, { id: 'wsl', name: 'WSL', cli: 'shell', args: '-d Ubuntu', color: '#888' }];
    expect(listTerminalSources(ctx({ profiles: custom, shell: 'cmd' })).map((s) => [s.label, s.detail])).toEqual([['Wiersz polecenia', 'cmd'], ['WSL', 'cmd -d Ubuntu']]);
    expect(listTerminalSources(ctx({ platform: 'darwin', shell: 'zsh' }))[0].detail).toBe('zsh');
    expect(listTerminalSources(ctx({ profiles: DEFAULT_PROFILES.filter((p) => p.cli !== 'shell') }))).toEqual([]);
  });

  it('groups local sources apart from connections (empty until a provider adds some)', () => {
    const sources = listTerminalSources(ctx());
    expect(groupTerminalSources(sources)).toEqual({ local: sources, connections: [] });
  });

  it('takes SSH-like sources from any added provider, without duplicates or broken entries', () => {
    const host: TerminalSource = { id: 'ssh:build', label: 'build', kind: 'ssh', detail: 'me@build.example:22', launch: { type: 'command', program: 'ssh', args: ['-p', '22', 'me@build.example'] } };
    const ssh: TerminalSourceProvider = { id: 'ssh', list: () => [host, { ...host }, { ...host, id: '' }, { ...host, id: 'ssh:x', label: '' }] };
    const broken: TerminalSourceProvider = { id: 'broken', list: () => { throw new Error('boom'); } };
    const sources = listTerminalSources(ctx(), [localShellProvider, broken, ssh]);
    expect(sources.map((s) => s.id)).toEqual(['local:shell', 'ssh:build']);
    const { local, connections } = groupTerminalSources(sources);
    expect(local).toHaveLength(1);
    expect(connections).toEqual([host]);
    expect(canLaunchSource(host)).toBe(false);
    expect(describeLaunch(host.launch)).toBe('ssh -p 22 me@build.example');
    expect(describeLaunch({ type: 'profile', profileId: 'shell' })).toBe('profile shell');
  });

  it('lists saved SSH hosts as connections that can be launched', () => {
    const sshHosts = [{ id: '00000000-0000-4000-8000-000000000001', label: 'web', address: 'web.example', port: 2222, username: 'deploy', createdAt: 0, updatedAt: 0 }];
    const sources = listTerminalSources(ctx({ sshHosts }));
    const { connections } = groupTerminalSources(sources);
    expect(connections).toEqual([{ id: `ssh:${sshHosts[0].id}`, label: 'web', kind: 'ssh', detail: 'deploy@web.example:2222', launch: { type: 'ssh', hostId: sshHosts[0].id } }]);
    expect(canLaunchSource(connections[0])).toBe(true);
    expect(describeLaunch(connections[0].launch)).toBe(`ssh ${sshHosts[0].id}`);
    expect(TERMINAL_SOURCE_PROVIDERS).toContain(sshHostProvider);
  });
});
