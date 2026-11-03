// test/usage-credentials.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudePlanLabel, profileSource, readClaudeCredentials, readClaudeIdentity, readCodexCredentials, withFailureCache, type CredentialSource } from '../src/main/usage/credentials';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: unknown) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ajza-cred-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const put = (rel: string, body: string) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), body); };
const source = (over: Partial<CredentialSource> = {}): CredentialSource => ({
  env: {}, home, platform: 'win32', keychain: async () => null,
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
  ...over,
});

describe('Claude credentials', () => {
  it('reads the token, expiry and plan from the credentials file', async () => {
    put('.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: 1781010642000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }));
    expect(await readClaudeCredentials(source())).toEqual({ accessToken: 'tok-1', expiresAt: 1781010642000, plan: 'Max 5x', hasRefresh: false });
  });

  it('labels plans with and without a multiplier', () => {
    expect(claudePlanLabel('pro', 'default_claude_pro')).toBe('Pro');
    expect(claudePlanLabel('MAX', 'x_20x')).toBe('Max 20x');
    expect(claudePlanLabel(undefined)).toBeUndefined();
    expect(claudePlanLabel(5)).toBeUndefined();
  });

  it('prefers the environment token and honours CLAUDE_CONFIG_DIR', async () => {
    expect(await readClaudeCredentials(source({ env: { CLAUDE_CODE_OAUTH_TOKEN: ' env-token ' } }))).toEqual({ accessToken: 'env-token' });
    put('other/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-2' } }));
    expect(await readClaudeCredentials(source({ env: { CLAUDE_CONFIG_DIR: join(home, 'other') } }))).toMatchObject({ accessToken: 'tok-2' });
  });

  it('treats missing, corrupt or incomplete files as signed out', async () => {
    expect(await readClaudeCredentials(source())).toBeNull();
    put('.claude/.credentials.json', '{not json');
    expect(await readClaudeCredentials(source())).toBeNull();
    put('.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: '' } }));
    expect(await readClaudeCredentials(source())).toBeNull();
    put('.claude/.credentials.json', JSON.stringify({ somethingElse: true }));
    expect(await readClaudeCredentials(source())).toBeNull();
    put('.claude/.credentials.json', '[]');
    expect(await readClaudeCredentials(source())).toBeNull();
  });

  it('falls back to the macOS Keychain only on macOS and only without a file', async () => {
    const keychain = vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok-kc' } }));
    expect(await readClaudeCredentials(source({ platform: 'win32', keychain }))).toBeNull();
    expect(keychain).not.toHaveBeenCalled();
    expect(await readClaudeCredentials(source({ platform: 'darwin', keychain }))).toEqual({ accessToken: 'tok-kc', expiresAt: undefined, plan: undefined, hasRefresh: false });
    put('.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-file' } }));
    keychain.mockClear();
    expect(await readClaudeCredentials(source({ platform: 'darwin', keychain }))).toMatchObject({ accessToken: 'tok-file' });
    expect(keychain).not.toHaveBeenCalled();
  });
});

describe('Codex credentials', () => {
  const chatgpt = (access: string, id: string) => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: id, access_token: access, refresh_token: 'r', account_id: 'acc-1' } });

  it('reads the token, account, expiry, plan and e-mail', async () => {
    const access = jwt({ exp: 1781010642 });
    const id = jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } });
    put('.codex/auth.json', chatgpt(access, id));
    expect(await readCodexCredentials(source())).toEqual({
      mode: 'chatgpt', accessToken: access, accountId: 'acc-1', expiresAt: 1781010642000, plan: 'plus', email: 'me@example.com', hasRefresh: true,
    });
  });

  it('works when the tokens carry no readable claims', async () => {
    put('.codex/auth.json', chatgpt('opaque', 'opaque'));
    expect(await readCodexCredentials(source())).toEqual({ mode: 'chatgpt', accessToken: 'opaque', accountId: 'acc-1', expiresAt: undefined, plan: undefined, email: undefined, hasRefresh: true });
  });

  it('recognises API key logins, which have no limits', async () => {
    put('.codex/auth.json', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null }));
    expect(await readCodexCredentials(source())).toEqual({ mode: 'apiKey' });
  });

  it('honours CODEX_HOME and treats missing or corrupt files as signed out', async () => {
    expect(await readCodexCredentials(source())).toBeNull();
    put('.codex/auth.json', '{broken');
    expect(await readCodexCredentials(source())).toBeNull();
    put('.codex/auth.json', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: '' } }));
    expect(await readCodexCredentials(source())).toBeNull();
    put('elsewhere/auth.json', chatgpt('opaque', 'opaque'));
    expect(await readCodexCredentials(source({ env: { CODEX_HOME: join(home, 'elsewhere') } }))).toMatchObject({ mode: 'chatgpt' });
  });
});

describe('withFailureCache', () => {
  it('holds a null result for the hold time and then asks again', async () => {
    let clock = 1000;
    const read = vi.fn(async () => null);
    const cached = withFailureCache(read, 500, () => clock);
    expect(await cached()).toBeNull();
    clock += 499;
    expect(await cached()).toBeNull();
    expect(read).toHaveBeenCalledOnce();
    clock += 2;
    await cached();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('forgets a remembered failure on reset (a login must see fresh credentials)', async () => {
    const results: (string | null)[] = [null, 'secret'];
    const read = vi.fn(async () => results.shift() ?? null);
    const cached = withFailureCache(read, 30 * 60_000, () => 0);
    expect(await cached()).toBeNull();
    expect(await cached()).toBeNull();
    expect(read).toHaveBeenCalledOnce();
    cached.reset();
    expect(await cached()).toBe('secret');
  });

  it('does not cache a successful read', async () => {
    const read = vi.fn(async () => 'secret');
    const cached = withFailureCache(read, 500, () => 0);
    expect(await cached()).toBe('secret');
    expect(await cached()).toBe('secret');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('profileSource', () => {
  it('points at the profile directory, drops the env token and never reaches the Keychain', async () => {
    const keychain = vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }));
    const base = source({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token', CLAUDE_CONFIG_DIR: join(home, 'main'), KEEP: '1' }, platform: 'darwin', keychain });
    const profile = profileSource(base, join(home, 'profile'));
    expect(profile.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(home, 'profile'), CLAUDE_CODE_OAUTH_TOKEN: '', KEEP: '1' });
    expect(profile.platform).not.toBe('darwin');
    expect(await readClaudeCredentials(profile)).toBeNull();
    expect(keychain).not.toHaveBeenCalled();
    put('profile/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-profile' } }));
    expect(await readClaudeCredentials(profile)).toMatchObject({ accessToken: 'tok-profile' });
  });
});

describe('readClaudeIdentity', () => {
  const account = { oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Acme' } };

  it('reads the email and organization from .claude.json in the home directory', async () => {
    put('.claude.json', JSON.stringify(account));
    expect(await readClaudeIdentity(source())).toEqual({ email: 'me@example.com', org: 'Acme' });
  });

  it('reads .claude.json from CLAUDE_CONFIG_DIR when it is set', async () => {
    put('.claude.json', JSON.stringify(account));
    put('profile/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'other@example.com' } }));
    expect(await readClaudeIdentity(source({ env: { CLAUDE_CONFIG_DIR: join(home, 'profile') } }))).toEqual({ email: 'other@example.com', org: undefined });
  });

  it('returns nothing for a missing, corrupt or non-object file', async () => {
    expect(await readClaudeIdentity(source())).toEqual({});
    put('.claude.json', '{broken');
    expect(await readClaudeIdentity(source())).toEqual({});
    put('.claude.json', '[1,2]');
    expect(await readClaudeIdentity(source())).toEqual({});
    put('.claude.json', JSON.stringify({ oauthAccount: 'x' }));
    expect(await readClaudeIdentity(source())).toEqual({ email: undefined, org: undefined });
  });
});

describe('claude credential extras', () => {
  it('reports a refresh token without exposing it and stamps the file', async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readFile } = await import('node:fs/promises');
    const { claudeCredentialsStamp, readClaudeCredentials } = await import('../src/main/usage/credentials');
    const home = mkdtempSync(join(tmpdir(), 'ajza-cred-'));
    try {
      const source = { env: {}, home, platform: 'win32' as const, keychain: async () => null, readFile: (p: string) => readFile(p, 'utf8').catch(() => null) };
      expect(await claudeCredentialsStamp(source)).toBeNull();
      mkdirSync(join(home, '.claude'));
      writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } }));
      const credentials = await readClaudeCredentials(source);
      expect(credentials).toMatchObject({ accessToken: 'at', hasRefresh: true });
      expect(JSON.stringify(credentials)).not.toContain('"rt"');
      const before = await claudeCredentialsStamp(source);
      writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'at2', refreshToken: 'rt2' } }));
      expect(await claudeCredentialsStamp(source)).not.toBeNull();
      expect(before).not.toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
