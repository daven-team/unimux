import { codexHookOverrides } from './codexHooks';
import { withResetTail } from './termReset';
import type { Profile, ShellKind } from './types';

export const DEFAULT_PROFILES: Profile[] = [
  { id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' },
  { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
  { id: 'shell', name: 'PowerShell', cli: 'shell', args: '', color: '#7a7a7a' },
];

/** Ids of the built-in shell profile (ssh-shell: its copy restored for SSH cells, see ensureShellProfile). */
const BUILT_IN_SHELL_IDS = new Set(['shell', 'ssh-shell']);
/** Names the built-in shell profile was shipped with (PowerShell on Windows, Terminal on macOS and Linux). */
const BUILT_IN_SHELL_NAMES = new Set(['PowerShell', 'Terminal']);
const SHELL_NAMES: Record<ShellKind, string> = { pwsh: 'PowerShell', powershell: 'Windows PowerShell', cmd: 'Wiersz polecenia', zsh: 'zsh', bash: 'bash' };

/**
 * The name a profile is shown with. The built-in shell profile, while it keeps its shipped name, is named after the shell chosen
 * in Settings (a cell set to cmd does not say "PowerShell"); a renamed or custom profile keeps its own name.
 */
export function shownProfileName(profile: Pick<Profile, 'id' | 'name' | 'cli'>, shell: ShellKind, tr: (key: 'Wiersz polecenia') => string = (key) => key): string {
  if (profile.cli !== 'shell' || !BUILT_IN_SHELL_IDS.has(profile.id) || !BUILT_IN_SHELL_NAMES.has(profile.name.trim())) return profile.name;
  return shell === 'cmd' ? tr('Wiersz polecenia') : SHELL_NAMES[shell] ?? profile.name;
}

/** Profiles shipped by earlier versions, folded into their base profile. */
export const RETIRED_PROFILES: Record<string, string> = { 'claude-opus': 'claude', 'codex-high': 'codex' };
/** How long Codex waits for one unimux MCP tool call (its default is 60 s). */
export const MCP_TOOL_TIMEOUT_SEC = 180;

/** PowerShell single-quoted literal. */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** POSIX shell single-quoted literal (bash/zsh). */
export const posixQuote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";

/** Quotes a path for the cell's shell (cmd has no single-quote strings). */
export const shellQuote = (s: string, shell: ShellKind = 'pwsh') =>
  shell === 'cmd' ? `"${s}"` : shell === 'zsh' || shell === 'bash' ? posixQuote(s) : psQuote(s);

export interface LaunchOptions {
  model?: string;
  mode: 'new' | 'resume';
  sessionId?: string;
  /** Per-cell Claude settings file carrying our status hooks. */
  claudeSettingsPath?: string;
  shell?: ShellKind;
  /** Per-process hook URL of a Codex cell (see codexHooks.ts); without it Codex only gets plain terminal notifications. */
  codexNotifyUrl?: string;
  /**
   * App-owned, per-cell MCP configuration; never changes the user's global config. Claude reads the server and its token from
   * `claudeConfigPath` (a literal header, see main/mcpCellConfig.ts); Codex reads the token from the `tokenEnv` variable.
   */
  mcp?: { url: string; tokenEnv?: string; claudeConfigPath?: string };
  /**
   * First prompt for a new conversation. PowerShell and POSIX shells read it from `file`
   * (keeping newlines and quotes intact); cmd gets the text inline on one line.
   */
  initialPrompt?: { file: string; text: string };
}

function promptArg(p: { file: string; text: string }, shell: ShellKind = 'pwsh'): string {
  if (shell === 'zsh' || shell === 'bash') return `"$(cat ${posixQuote(p.file)})"`;
  if (shell === 'cmd') return `"${p.text.replace(/\s+/g, ' ').replace(/"/g, "'").trim()}"`;
  return `(Get-Content -Raw -Encoding utf8 -LiteralPath ${psQuote(p.file)})`;
}

/** The agent's own command line (what the CLI is started with); null for plain shell profiles. */
export function buildCliCommand(profile: Profile, opts: LaunchOptions): string | null {
  // A cell override replaces a profile's model flag instead of giving the CLI duplicates.
  const args = (opts.model ? profile.args.replace(/(?:^|\s)(?:--model(?:=|\s+)|-m\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g, ' ') : profile.args).trim();
  const parts: string[] = [];
  if (profile.cli === 'claude') {
    parts.push('claude');
    if (opts.sessionId) parts.push(opts.mode === 'resume' ? '--resume' : '--session-id', opts.sessionId);
    if (opts.claudeSettingsPath) parts.push('--settings', shellQuote(opts.claudeSettingsPath, opts.shell));
    if (opts.mcp?.claudeConfigPath) parts.push('--mcp-config', shellQuote(opts.mcp.claudeConfigPath, opts.shell));
  } else if (profile.cli === 'codex') {
    parts.push('codex');
    if (opts.mode === 'resume' && opts.sessionId) parts.push('resume', opts.sessionId);
    if (opts.codexNotifyUrl) {
      // Single-quoted TOML inside; cmd has no single-quote strings, so it gets double quotes around the whole override.
      for (const override of codexHookOverrides(opts.codexNotifyUrl)) parts.push('-c', opts.shell === 'cmd' ? `"${override}"` : shellQuote(override, opts.shell));
    } else parts.push('-c', 'tui.notifications=true');
    if (opts.mcp?.tokenEnv) {
      for (const [key, value] of [['url', opts.mcp.url], ['bearer_token_env_var', opts.mcp.tokenEnv]]) {
        const setting = `mcp_servers.unimux.${key}=${JSON.stringify(value)}`;
        // cmd does not interpret TOML single quotes; these generated values contain no spaces/apostrophes.
        parts.push('-c', opts.shell === 'cmd' ? `mcp_servers.unimux.${key}='${value}'` : shellQuote(setting, opts.shell));
      }
      // Codex gives a tool 60 s by default; create_grid with worktrees and close_grid can take longer (a number: no quoting).
      parts.push('-c', `mcp_servers.unimux.tool_timeout_sec=${MCP_TOOL_TIMEOUT_SEC}`);
    }
  } else {
    return null;
  }
  if (args) parts.push(args);
  if (opts.model) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(opts.model)) throw new Error('Invalid model name.');
    parts.push('--model', shellQuote(opts.model, opts.shell));
  }
  if (opts.mode === 'new' && opts.initialPrompt?.text.trim()) parts.push(promptArg(opts.initialPrompt, opts.shell));
  return parts.join(' ');
}

/**
 * Line typed into the cell's shell to start the agent: the command, then a tail that runs when the CLI returned (also after a
 * crash or kill) and switches off the mouse / focus / paste modes a dead CLI leaves on (see termReset.ts). Null for shell profiles.
 */
export function buildLaunchCommand(profile: Profile, opts: LaunchOptions): string | null {
  const command = buildCliCommand(profile, opts);
  return command === null ? null : withResetTail(command, opts.shell);
}
