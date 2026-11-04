import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeCellFiles } from '../src/main/cellFiles';
import { endCellMcp, MCP_TOKEN_ENV, prepareCellMcp, writeClaudeMcpConfig } from '../src/main/mcpCellConfig';
import { cleanEnv } from '../src/shared/env';
import { buildCliCommand, DEFAULT_PROFILES } from '../src/shared/profiles';

const P = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.id, p]));
const URL = 'http://127.0.0.1:43210/mcp';
const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);
const roots: string[] = [];
function fakeData() {
  // A temp folder stands in for the app's data dir; nothing under the real profile is read or written.
  const root = mkdtempSync(join(tmpdir(), 'mc-mcpcell-'));
  roots.push(root);
  return { root, dirs: { hooks: join(root, 'hooks'), prompts: join(root, 'prompts'), mcp: join(root, 'mcp') } };
}
/** The spawn environment the app builds for a cell, from a parent that itself runs inside an older unimux cell. */
const spawnEnv = (): Record<string, string> => ({ ...cleanEnv({ PATH: '/usr/bin', HOME: '/tmp/fake-home', [MCP_TOKEN_ENV]: 'parent-token' }), MC_CELL_ID: 'c1' });
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('per-cell MCP token delivery', () => {
  it('keeps the token out of a Claude cell environment and command line, and puts it in the config as a literal header', () => {
    const { dirs } = fakeData();
    const env = spawnEnv();
    const mcp = prepareCellMcp('claude', { dir: dirs.mcp, cellId: 'c1', url: URL, token: TOKEN, env });
    expect(Object.values(env).join('\n')).not.toContain(TOKEN);
    expect(env[MCP_TOKEN_ENV]).toBeUndefined();
    expect(mcp).toEqual({ url: URL, claudeConfigPath: join(dirs.mcp, 'c1.json') });
    const command = buildCliCommand(P.claude, { mode: 'new', mcp })!;
    expect(command).toContain('--mcp-config');
    expect(command).not.toContain(TOKEN);
    const config = JSON.parse(readFileSync(mcp.claudeConfigPath!, 'utf8'));
    // timeout: above the longest wait_for of a Claude caller (600 s); it also lifts Claude Code's 60 s first-byte timer.
    expect(config).toEqual({ mcpServers: { unimux: { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 660_000 } } });

    expect(readFileSync(mcp.claudeConfigPath!, 'utf8')).not.toContain('${');
    // Atomic write: no temp file is left next to the config.
    expect(readdirSync(dirs.mcp)).toEqual(['c1.json']);
  });

  it('gives a Codex cell the token only in the one variable Codex reads it from (it cannot take a header from a file)', () => {
    const { dirs } = fakeData();
    const env = spawnEnv();
    const mcp = prepareCellMcp('codex', { dir: dirs.mcp, cellId: 'c1', url: URL, token: TOKEN, env });
    expect(mcp).toEqual({ url: URL, tokenEnv: MCP_TOKEN_ENV });
    // Unavoidable for Codex: exactly one variable, named with TOKEN so Codex's default shell_environment_policy filters it.
    expect(Object.entries(env).filter(([, value]) => value.includes(TOKEN))).toEqual([[MCP_TOKEN_ENV, TOKEN]]);
    expect(MCP_TOKEN_ENV).toMatch(/TOKEN/);
    const command = buildCliCommand(P.codex, { mode: 'new', mcp })!;
    expect(command).toContain(`bearer_token_env_var="${MCP_TOKEN_ENV}"`);
    expect(command).not.toContain(TOKEN);
    expect(existsSync(join(dirs.mcp, 'c1.json'))).toBe(false);
  });

  it('a respawn as Codex removes the token file an earlier Claude spawn of the cell wrote', () => {
    const { dirs } = fakeData();
    prepareCellMcp('claude', { dir: dirs.mcp, cellId: 'c1', url: URL, token: TOKEN, env: spawnEnv() });
    expect(existsSync(join(dirs.mcp, 'c1.json'))).toBe(true);
    prepareCellMcp('codex', { dir: dirs.mcp, cellId: 'c1', url: URL, token: 'next', env: spawnEnv() });
    expect(existsSync(join(dirs.mcp, 'c1.json'))).toBe(false);
  });

  it('replaces the config of a respawn with the new token', () => {
    const { dirs } = fakeData();
    writeClaudeMcpConfig(dirs.mcp, 'c1', URL, 'old-token');
    writeClaudeMcpConfig(dirs.mcp, 'c1', URL, TOKEN);
    const text = readFileSync(join(dirs.mcp, 'c1.json'), 'utf8');
    expect(text).toContain(TOKEN);
    expect(text).not.toContain('old-token');
  });

  it.skipIf(process.platform === 'win32')('writes the config 0600 in a 0700 folder on POSIX', () => {
    const { dirs } = fakeData();
    const file = writeClaudeMcpConfig(dirs.mcp, 'c1', URL, TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirs.mcp).mode & 0o777).toBe(0o700);
    // An existing file with wider permissions is tightened by the rewrite.
    writeFileSync(file, '{}', { mode: 0o644 });
    writeClaudeMcpConfig(dirs.mcp, 'c1', URL, TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('removing the cell deletes its MCP config', async () => {
    const { dirs } = fakeData();
    const file = writeClaudeMcpConfig(dirs.mcp, 'c1', URL, TOKEN);
    writeClaudeMcpConfig(dirs.mcp, 'c2', URL, 'other');
    await removeCellFiles(dirs, 'c1');
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dirs.mcp)).toEqual(['c2.json']);
  });

  it('ending the cell MCP access (exit, kill, failed spawn, spawn without MCP) revokes the token and deletes the file', () => {
    const { dirs } = fakeData();
    const file = writeClaudeMcpConfig(dirs.mcp, 'c1', URL, TOKEN);
    writeClaudeMcpConfig(dirs.mcp, 'c2', URL, 'other');
    const revoked: string[] = [];
    endCellMcp({ revokeCell: (id) => revoked.push(id) }, dirs.mcp, 'c1');
    expect(revoked).toEqual(['c1']);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dirs.mcp)).toEqual(['c2.json']);
    // A cell that never had a file (a Codex or shell cell) and a missing folder are fine.
    endCellMcp({ revokeCell: (id) => revoked.push(id) }, join(dirs.mcp, 'missing'), 'c3');
    expect(revoked).toEqual(['c1', 'c3']);
  });
});
