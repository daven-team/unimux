// Shell integration (the FinalTerm / VS Code prompt marks): the shell of a local cell writes OSC 133 marks around its prompt,
//   A = the prompt starts, B = the prompt ends (input starts), C = a command starts running, D;<code> = the last command ended,
// so the status of a shell cell comes from the shell itself instead of from output and silence: "command running" vs
// "at the prompt" is exact, and an agent CLI that ends (or crashes) back to the shell of its cell is seen at once.
// VS Code's OSC 633 marks (the same letters) are understood too, so a remote shell set up for VS Code reports as well.
// Everything here is pure: the launch changes per shell (the pty host writes the returned files) and the mark parser.

export type ShellKindLike = 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'zsh';
export type ShellMarkKind = 'A' | 'B' | 'C' | 'D';

export interface ShellMark {
  kind: ShellMarkKind;
  /** D: the exit code of the command, when the shell reported one. */
  code?: number;
}

/** Parses the payload of an OSC 133 / 633 sequence ("A", "D;0", "C;..."); null for anything else (E, P, properties). */
export function parseShellMark(payload: string): ShellMark | null {
  const m = /^([ABCD])(?:;(.*))?$/s.exec(payload);
  if (!m) return null;
  const kind = m[1] as ShellMarkKind;
  if (kind !== 'D') return { kind };
  const code = m[2] !== undefined && /^-?\d{1,10}$/.test(m[2].split(';')[0]) ? Number(m[2].split(';')[0]) : undefined;
  return code === undefined ? { kind } : { kind, code };
}

/** Set to 0 in the environment to start every shell untouched. */
export const SHELL_INTEGRATION_ENV = 'UNIMUX_SHELL_INTEGRATION';

/**
 * PowerShell (5.1 and 7): the profile loads as usual, then this wraps the prompt function (D + A before, B after the user's
 * own prompt, which may be oh-my-posh or starship) and PSReadLine's line reader (C once a line was accepted). $? and
 * $LASTEXITCODE are kept for the user's prompt. Without PSReadLine there is no C; the app then takes Enter at the prompt.
 */
export const POWERSHELL_SCRIPT = [
  'if (-not $global:__unimuxShell) {',
  '  $global:__unimuxShell = $true',
  '  $global:__unimuxPrompt = $function:prompt',
  '  function global:prompt {',
  '    $ok = $global:?',
  '    $code = $global:LASTEXITCODE',
  '    $e = [char]27; $b = [char]7',
  '    $status = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }',
  '    $text = if ($global:__unimuxPrompt) { & $global:__unimuxPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }',
  '    $global:LASTEXITCODE = $code',
  '    "$e]133;D;$status$b$e]133;A$b$text$e]133;B$b"',
  '  }',
  '  try { Import-Module PSReadLine -ErrorAction Stop } catch { }',
  '  if (Test-Path Function:\\PSConsoleHostReadLine) {',
  '    $global:__unimuxReadLine = $function:PSConsoleHostReadLine',
  '    function global:PSConsoleHostReadLine {',
  '      $line = & $global:__unimuxReadLine',
  '      [Console]::Write("$([char]27)]133;C$([char]7)")',
  '      $line',
  '    }',
  '  }',
  '}',
].join('\n');

/** -EncodedCommand takes UTF-16LE base64: no quoting of the script can go wrong on the way through node-pty and ConPTY. */
export function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes[i * 2] = c & 0xff;
    bytes[i * 2 + 1] = c >> 8;
  }
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** cmd.exe: its PROMPT codes ($E = ESC) carry the marks; there is no "command starts" hook, the app takes Enter for it. */
export function cmdPrompt(userPrompt: string | undefined): string {
  return `$E]133;D$E\\$E]133;A$E\\${userPrompt?.trim() ? userPrompt : '$P$G'}$E]133;B$E\\`;
}

/**
 * bash (macOS / Linux cells): started with `--init-file` instead of `-l`, so this file loads the login files the way a login
 * shell would, then puts the marks first in PROMPT_COMMAND ($? is kept for the user's own) and C into PS0 (bash 4.4+).
 */
export const BASH_INIT = [
  '# unimux shell integration: the login files as a login shell reads them, then prompt marks (OSC 133).',
  'if [ -r /etc/profile ]; then . /etc/profile; fi',
  'for __unimux_f in ~/.bash_profile ~/.bash_login ~/.profile; do if [ -r "$__unimux_f" ]; then . "$__unimux_f"; break; fi; done',
  'unset __unimux_f',
  '__unimux_prompt() { local c=$?; printf \'\\033]133;D;%s\\007\\033]133;A\\007\' "$c"; return $c; }',
  'case "$PROMPT_COMMAND" in *__unimux_prompt*) ;; *) PROMPT_COMMAND="__unimux_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac',
  'PS0="${PS0}\\[\\033]133;C\\007\\]"',
  '',
].join('\n');

export interface ShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export interface IntegratedLaunch extends ShellLaunch {
  /** Files the launch needs (absolute path -> content); the caller writes them before spawning. */
  files: Record<string, string>;
}

/**
 * The launch of a local shell with the prompt marks added. `dir` holds the helper files (bash). zsh is left as it is: its
 * startup files can only be wrapped through ZDOTDIR, which is not worth the risk to the user's setup (marks the user's own
 * zsh setup writes, e.g. from iTerm2 or WezTerm integration, are still read).
 */
export function withShellIntegration(kind: ShellKindLike, launch: ShellLaunch, opts: { dir: string; platform: string }): IntegratedLaunch {
  const plain: IntegratedLaunch = { ...launch, env: { ...launch.env }, files: {} };
  if (launch.env[SHELL_INTEGRATION_ENV] === '0') return plain;
  if (opts.platform === 'win32') {
    if (kind === 'cmd') return { ...plain, env: { ...plain.env, PROMPT: cmdPrompt(launch.env.PROMPT) } };
    return { ...plain, args: [...launch.args, '-NoExit', '-EncodedCommand', encodePowerShell(POWERSHELL_SCRIPT)] };
  }
  if (kind === 'bash' && launch.file.endsWith('bash')) {
    const sep = opts.dir.includes('\\') && !opts.dir.includes('/') ? '\\' : '/';
    const file = `${opts.dir.replace(/[\\/]+$/, '')}${sep}bash-init.sh`;
    // -i instead of -il: --init-file is ignored by a login shell, the init file reads the login files itself.
    return { ...plain, args: ['--init-file', file, '-i'], files: { [file]: BASH_INIT } };
  }
  return plain;
}
