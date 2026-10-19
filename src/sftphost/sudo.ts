// SFTP through sudo (0.9.9): which server commands are tried, how a password is passed and what sudo's messages mean.
// Pure: the SFTP Host runs the commands on exec channels (execSftp.ts). The command is the user's own (the host editor) and
// only ever runs on their own exec channel; nothing typed here reaches a local shell.
import type { SshErrorCode } from '../shared/ssh';

/** Where distributions put OpenSSH's sftp-server (Debian/Ubuntu, RHEL/Fedora/SUSE, Arch). */
export const DEFAULT_SFTP_SERVERS = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server'] as const;

/** The commands tried in order: the host's own command, else `sudo -n <server>` for each default place. */
export function sudoCommands(custom?: string): string[] {
  const own = custom?.trim();
  return own ? [own] : DEFAULT_SFTP_SERVERS.map((p) => `sudo -n ${p}`);
}

/**
 * `sudo -n <rest>` -> `sudo -S -p '' <rest>`: sudo then reads the password as the first line of stdin (no prompt text) and the
 * SFTP stream follows on the same stdin. null for a command of another form (it cannot be given a password).
 */
export function passwordCommand(command: string): string | null {
  const m = /^sudo\s+-n\s+(\S.*)$/.exec(command.trim());
  return m ? `sudo -S -p '' ${m[1]}` : null;
}

/** A password that can be written as one stdin line. */
export const validSudoPassword = (pw: string): boolean => pw.length > 0 && pw.length <= 1024 && !/[\r\n\0]/.test(pw);

export type SudoOutcome = 'password' | 'wrongPassword' | 'tty' | 'denied' | 'notFound' | 'other';

/** What sudo's stderr (and the exit code, when it ended) says; null while nothing conclusive came yet. */
export function classifySudo(stderr: string, exitCode?: number | null): SudoOutcome | null {
  const t = stderr.toLowerCase();
  if (/not allowed to execute|not in the sudoers|may not run sudo|is not allowed to run sudo/.test(t)) return 'denied';
  if (/must have a tty|requiretty/.test(t)) return 'tty';
  if (/incorrect password|try again|authentication failure/.test(t)) return 'wrongPassword';
  if (/password is required|no tty present|terminal is required|askpass/.test(t)) return 'password';
  if (/command not found|no such file or directory|not found/.test(t) || exitCode === 127) return 'notFound';
  return exitCode === undefined || exitCode === null ? null : 'other';
}

/** The session error a failed sudo start ends with. */
export function sudoError(outcome: SudoOutcome | 'timeout'): SshErrorCode {
  switch (outcome) {
    case 'wrongPassword': return 'sudoPassword';
    case 'tty': return 'sudoTty';
    case 'denied': return 'sudoDenied';
    case 'notFound': return 'sudoNoServer';
    default: return 'sudoFailed';
  }
}
