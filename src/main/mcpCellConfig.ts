// How a cell's MCP token reaches its agent. Claude Code reads it from the per-cell `--mcp-config` file as a literal
// Authorization header, so the token is not in the agent's environment and every process the agent starts (shell tools,
// scripts, dev servers, npm packages) no longer inherits it. Codex can take the bearer token of a streamable HTTP server only
// from its config (`http_headers`, which would put the token on the command line typed into the cell's shell and its
// history) or from an environment variable (`bearer_token_env_var`), so Codex keeps the variable; its name contains TOKEN,
// which Codex's default `shell_environment_policy` excludes from the commands it runs.
import { chmodSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './atomicWrite';
import type { LaunchOptions } from '../shared/profiles';

/** The environment variable a Codex cell reads its MCP token from (Claude cells no longer get it). */
export const MCP_TOKEN_ENV = 'UNIMUX_MCP_TOKEN';

const isPosix = () => process.platform !== 'win32';

/** The per-cell Claude MCP config file (the cleanup in cellFiles.ts knows the same name). */
export const claudeMcpConfigPath = (dir: string, cellId: string): string => join(dir, `${cellId}.json`);

/**
 * Claude Code's per-server tool timeout (ms) for unimux: above the longest wait_for of a Claude caller (600 s, shared/automation.ts).
 * It also raises Claude Code's per-request first-byte timer, which is otherwise 60 s for HTTP servers (1.1.4).
 */
export const CLAUDE_MCP_TIMEOUT_MS = 660_000;
/** The Claude Code MCP config of a cell: the local http server with the cell's token as a literal header. */
export function claudeMcpConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { unimux: { type: 'http', url, headers: { Authorization: `Bearer ${token}` }, timeout: CLAUDE_MCP_TIMEOUT_MS } } });
}


/**
 * Writes the cell's Claude MCP config atomically and private to the user: 0600 in a 0700 folder on POSIX; on Windows the
 * folder is in the app's data dir under the user profile, whose ACL already keeps other users out. Returns the path.
 */
export function writeClaudeMcpConfig(dir: string, cellId: string, url: string, token: string, posix = isPosix()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posix) { try { chmodSync(dir, 0o700); } catch { /* best effort: the file itself is 0600 */ } }
  const file = claudeMcpConfigPath(dir, cellId);
  atomicWriteFileSync(file, claudeMcpConfig(url, token), { mode: 0o600 });
  if (posix) chmodSync(file, 0o600);
  return file;
}

/** Removes the cell's Claude MCP config (a spawn without MCP, or a Codex spawn, must not leave an old token file behind). */
export function removeClaudeMcpConfig(dir: string, cellId: string): void {
  try { rmSync(claudeMcpConfigPath(dir, cellId), { force: true }); } catch { /* locked: the next start prunes it */ }
}

/**
 * Prepares the MCP part of one agent spawn: writes or removes the per-cell file, sets or clears the token variable in `env`
 * (the cell's spawn environment) and returns the launch options for buildCliCommand.
 */
export function prepareCellMcp(cli: 'claude' | 'codex', opts: { dir: string; cellId: string; url: string; token: string; env: Record<string, string>; posix?: boolean }): NonNullable<LaunchOptions['mcp']> {
  delete opts.env[MCP_TOKEN_ENV];
  if (cli === 'claude') return { url: opts.url, claudeConfigPath: writeClaudeMcpConfig(opts.dir, opts.cellId, opts.url, opts.token, opts.posix) };
  removeClaudeMcpConfig(opts.dir, opts.cellId);
  opts.env[MCP_TOKEN_ENV] = opts.token;
  return { url: opts.url, tokenEnv: MCP_TOKEN_ENV };
}

/**
 * The cell's MCP access ends (its process exited or was killed, a spawn failed or runs without MCP): the token is revoked and
 * the Claude config carrying it is removed, so no token file outlives the process that read it.
 */
export function endCellMcp(server: { revokeCell(cellId: string): void }, dir: string, cellId: string): void {
  server.revokeCell(cellId);
  removeClaudeMcpConfig(dir, cellId);
}
