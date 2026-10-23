// Where a terminal can come from. The SSH panel lists the local shells of the configured profiles and the saved SSH hosts
// (AppState.sshHosts). A host launches as { type: 'ssh', hostId }: an SSH cell whose session runs in the Pty Host (src/ptyhost/ssh.ts).
import { shellsForPlatform, type AppPlatform } from './platform';
import { shownProfileName } from './profiles';
import { userAtEndpoint, type SshHost } from './ssh';
import type { Profile, ShellKind } from './types';

export type TerminalSourceKind = 'local' | 'ssh';

export type TerminalLaunch =
  /** A configured shell profile: what a cell starts today (the cell runs the user's shell). */
  | { type: 'profile'; profileId: string }
  /** A ready command line (program and arguments, never one shell string): for sources that need one, such as ssh. */
  | { type: 'command'; program: string; args: string[] }
  /** A saved SSH host: the cell runs an SSH session to it. */
  | { type: 'ssh'; hostId: string };

export interface TerminalSource {
  /** Stable and unique across providers. */
  id: string;
  /** What the user sees (a profile name, a host alias). */
  label: string;
  kind: TerminalSourceKind;
  /** A short technical line under the label (the shell, "user@host:22"). Not translated. */
  detail: string;
  launch: TerminalLaunch;
}

export interface TerminalSourceContext {
  profiles: readonly Profile[];
  platform: AppPlatform;
  /** The shell chosen in Settings. */
  shell: ShellKind;
  sshHosts?: readonly SshHost[];
  /** Translates the shown name of the built-in shell profile (see shownProfileName). */
  tr?: (key: 'Wiersz polecenia') => string;
}

export interface TerminalSourceProvider {
  id: string;
  list(ctx: TerminalSourceContext): TerminalSource[];
}

/** The shells of the shell profiles (on Windows PowerShell, cmd ...; on macOS and Linux zsh or bash). */
export const localShellProvider: TerminalSourceProvider = {
  id: 'local-shell',
  list(ctx) {
    const shellName = shellsForPlatform(ctx.platform).find((s) => s.code === ctx.shell)?.name ?? ctx.shell;
    return ctx.profiles
      .filter((profile) => profile.cli === 'shell')
      .map((profile) => ({
        id: `local:${profile.id}`,
        label: shownProfileName(profile, ctx.shell, ctx.tr),
        kind: 'local' as const,
        detail: [shellName, profile.args.trim()].filter(Boolean).join(' '),
        launch: { type: 'profile' as const, profileId: profile.id },
      }));
  },
};

/** The saved SSH hosts, in the order they are stored. */
export const sshHostProvider: TerminalSourceProvider = {
  id: 'ssh-host',
  list(ctx) {
    return (ctx.sshHosts ?? []).map((host) => ({
      id: `ssh:${host.id}`,
      label: host.label,
      kind: 'ssh' as const,
      detail: userAtEndpoint(host),
      launch: { type: 'ssh' as const, hostId: host.id },
    }));
  },
};

/** Providers in display order. */
export const TERMINAL_SOURCE_PROVIDERS: readonly TerminalSourceProvider[] = [localShellProvider, sshHostProvider];

/** Every source of every provider; a source without an id or label, or with an id already seen, is dropped. */
export function listTerminalSources(ctx: TerminalSourceContext, providers: readonly TerminalSourceProvider[] = TERMINAL_SOURCE_PROVIDERS): TerminalSource[] {
  const seen = new Set<string>();
  const out: TerminalSource[] = [];
  for (const provider of providers) {
    let list: TerminalSource[] = [];
    try { list = provider.list(ctx); } catch { /* one broken provider must not empty the panel */ }
    for (const source of list) {
      if (!source.id || !source.label || seen.has(source.id)) continue;
      seen.add(source.id);
      out.push(source);
    }
  }
  return out;
}

export function groupTerminalSources(sources: readonly TerminalSource[]): { local: TerminalSource[]; connections: TerminalSource[] } {
  return { local: sources.filter((s) => s.kind === 'local'), connections: sources.filter((s) => s.kind !== 'local') };
}

/** Can the app start this source now? Profiles and saved SSH hosts. */
export const canLaunchSource = (source: TerminalSource): boolean => source.launch.type === 'profile' || source.launch.type === 'ssh';

/** The launch as a short line for tooltips and logs: the profile id, the SSH host id, or the program and its arguments. */
export function describeLaunch(launch: TerminalLaunch): string {
  if (launch.type === 'profile') return `profile ${launch.profileId}`;
  if (launch.type === 'ssh') return `ssh ${launch.hostId}`;
  return [launch.program, ...launch.args].join(' ');
}
