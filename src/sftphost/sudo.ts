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
 * The prompt sudo prints when it reads the password (`-p`): a fixed marker, so the password is written only once sudo asked
 * for it (never into sftp-server's input) and a second marker means a wrong password, whatever language sudo speaks.
 */
export const SUDO_MARKER = '[unimux-sudo-password]';

/** The environment of the exec channel: sudo's messages in English where the server accepts it (AcceptEnv LANG LC_*). */
export const SUDO_ENV = { LC_ALL: 'C', LANG: 'C' } as const;

/**
 * `sudo -n <rest>` -> `sudo -S -p '<marker>' <rest>`: sudo then reads the password as the first line of stdin and the SFTP
 * stream follows on the same stdin. null for a command of another form (it cannot be given a password).
 */
export function passwordCommand(command: string): string | null {
  const m = /^sudo\s+-n\s+(\S.*)$/.exec(command.trim());
  return m ? `sudo -S -p '${SUDO_MARKER}' ${m[1]}` : null;
}

/** A password that can be written as one stdin line. */
export const validSudoPassword = (pw: string): boolean => pw.length > 0 && pw.length <= 1024 && !/[\r\n\0]/.test(pw);

/** How many password prompts (markers) sudo has printed so far. */
export const markerCount = (stderr: string): number => stderr.split(SUDO_MARKER).length - 1;

export type SudoOutcome = 'password' | 'wrongPassword' | 'tty' | 'denied' | 'notFound' | 'noSudo' | 'other';

/**
 * What sudo's stderr (and the exit code, when it ended) says; null while nothing conclusive came yet. English (the exec
 * channel asks for LC_ALL=C) and Polish texts are known; `nonInteractive` (a `sudo -n` run): an unknown message with exit
 * status 1 is read as "a password is required", the usual reason sudo -n fails that way.
 */
export function classifySudo(stderr: string, exitCode?: number | null, nonInteractive = false): SudoOutcome | null {
  const t = stderr.split(SUDO_MARKER).join(' ').toLowerCase();
  if (/(^|\n|: )sudo: (command )?not found|sudo: nie znaleziono polecenia|nie znaleziono polecenia: sudo/.test(t)) return 'noSudo';
  if (/not allowed to execute|not in the sudoers|may not run sudo|is not allowed to run sudo|nie ma uprawnień|nie występuje w pliku sudoers|nie może uruchamiać/.test(t)) return 'denied';
  if (/must have a tty|requiretty|musisz mieć terminal|wymaga terminala/.test(t)) return 'tty';
  if (/incorrect password|try again|authentication failure|spróbuj ponownie|nieprawidłow/.test(t)) return 'wrongPassword';
  if (/password is required|no tty present|terminal is required|askpass|wymagane jest hasło|hasło jest wymagane/.test(t)) return 'password';
  if (/command not found|no such file or directory|not found|nie znaleziono|nie ma takiego pliku/.test(t) || exitCode === 127) return 'notFound';
  if (exitCode === undefined || exitCode === null) return null;
  return nonInteractive && exitCode === 1 ? 'password' : 'other';
}

/** The session error a failed sudo start ends with. */
export function sudoError(outcome: SudoOutcome | 'timeout'): SshErrorCode {
  switch (outcome) {
    case 'wrongPassword': return 'sudoPassword';
    case 'tty': return 'sudoTty';
    case 'denied': return 'sudoDenied';
    case 'notFound': return 'sudoNoServer';
    case 'noSudo': return 'sudoMissing';
    default: return 'sudoFailed';
  }
}
