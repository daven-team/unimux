import { describe, expect, it } from 'vitest';
import { claudeExtendedHooks, claudeHookSettings, HookServer, notificationEvent, toolHookEvent, toolHookFacts, type HookTarget } from '../src/main/hooks';
import { integratedLaunch } from '../src/ptyhost/manager';
import { BASH_INIT, cmdPrompt, encodePowerShell, parseShellMark, POWERSHELL_SCRIPT, withShellIntegration } from '../src/shared/shellIntegration';
import { failedExit, statusText } from '../src/shared/statusDetail';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Notification types', () => {
  it('maps each documented type to what it means for the status', () => {
    const n = (type: string) => notificationEvent(JSON.stringify({ hook_event_name: 'Notification', notification_type: type, message: 'secret text' }));
    expect(n('permission_prompt')).toEqual({ event: 'notify', info: { need: 'permission' } });
    expect(n('elicitation_dialog')).toEqual({ event: 'notify', info: { need: 'elicitation' } });
    expect(n('elicitation_url_dialog')).toEqual({ event: 'notify', info: { need: 'elicitation' } });
    expect(n('agent_needs_input')).toEqual({ event: 'notify', info: { need: 'input' } });
    expect(n('quota_auto_resume_stale')).toEqual({ event: 'notify', info: { need: 'input' } });
    expect(n('idle_prompt')).toEqual({ event: 'idle' });
    expect(n('quota_auto_resume_fired')).toEqual({ event: 'prompt' });
    for (const quiet of ['auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'plugin_notification', 'quota_auto_resume_disabled']) expect(n(quiet)).toBeNull();
    // Unknown (a type added later) and unparsable payloads still tell the user.
    expect(n('something_new')).toEqual({ event: 'notify', info: {} });
    expect(notificationEvent('not json')).toEqual({ event: 'notify' });
  });
});

describe('tool hook payloads', () => {
  it('reads the tool name and id of a whole payload, never its input', () => {
    const body = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, tool_use_id: 'toolu_01A' });
    expect(toolHookFacts(body)).toEqual({ tool: 'Bash', toolUseId: 'toolu_01A' });
    expect(toolHookEvent('pre', body)).toEqual({ event: 'busy', info: { tool: 'Bash', toolUseId: 'toolu_01A' } });
    expect(toolHookEvent('post', body)).toEqual({ event: 'busy', info: { tool: 'Bash', toolUseId: 'toolu_01A', toolEnd: true } });
  });

  it('a huge PostToolUse: the id is read from the tail, and an id inside the tool output (escaped) is never taken', () => {
    const output = `${'x'.repeat(40_000)},"tool_use_id":"toolu_FAKE"`;
    const body = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_response: { content: output }, tool_use_id: 'toolu_REAL' });
    const head = body.slice(0, 16 * 1024);
    const tail = body.slice(-2048);
    expect(toolHookFacts(head, tail)).toEqual({ tool: 'Read', toolUseId: 'toolu_REAL' });
  });

  it('AskUserQuestion is a question the moment it starts; PermissionRequest, Elicitation and compaction map to their events', () => {
    const ask = JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: {}, tool_use_id: 'toolu_q' });
    expect(toolHookEvent('pre', ask)).toEqual({ event: 'notify', info: { need: 'question', immediate: true, tool: 'AskUserQuestion', toolUseId: 'toolu_q' } });
    expect(toolHookEvent('permission', JSON.stringify({ tool_name: 'Edit', tool_input: {} }))).toEqual({ event: 'notify', info: { need: 'permission', immediate: true, tool: 'Edit' } });
    expect(toolHookEvent('subagentstart', JSON.stringify({ agent_id: 'a1', agent_type: 'Explore' }))).toEqual({ event: 'busy', info: { subagent: true, subagentStart: true, agentType: 'Explore' } });
    expect(toolHookEvent('compact', JSON.stringify({ trigger: 'manual' }))).toEqual({ event: 'compact', info: { trigger: 'manual' } });
    expect(toolHookEvent('compacted', JSON.stringify({ trigger: 'auto' }))).toEqual({ event: 'compacted', info: { trigger: 'auto' } });
    expect(toolHookEvent('elicit', '{}')).toEqual({ event: 'notify', info: { need: 'elicitation', immediate: true } });
    expect(toolHookEvent('elicited', '{}')).toEqual({ event: 'busy', info: { answered: true } });
    expect(toolHookEvent('nope', '{}')).toBeNull();
  });

  it('the server reads a 1 MB tool payload to the end, answers it and emits the tool facts', async () => {
    const server = new HookServer();
    await server.start();
    try {
      const got = new Promise<unknown[]>((resolve) => server.once('hook', (...args: unknown[]) => resolve(args)));
      const url = server.headerUrl('cell-1', 'post');
      const body = JSON.stringify({ tool_name: 'Write', tool_input: { content: 'y'.repeat(1_000_000) }, tool_response: {}, tool_use_id: 'toolu_W' });
      const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${server.token}` }, body });
      expect(res.status).toBe(204);
      expect(await got).toEqual(['cell-1', 'busy', { tool: 'Write', toolUseId: 'toolu_W', toolEnd: true }]);
    } finally {
      server.stop();
    }
  });
});

describe('Claude hook settings', () => {
  const target: HookTarget = { url: (e) => `http://127.0.0.1:1/h/t/c/${e}/n`, headerUrl: (e) => `http://127.0.0.1:1/k/c/${e}/n`, token: 't' };

  it('2.1.78+ gets the precise hooks; older and unknown versions keep the basic set', () => {
    expect(claudeExtendedHooks('2.1.310 (Claude Code)')).toBe(true);
    expect(claudeExtendedHooks('2.1.78')).toBe(true);
    expect(claudeExtendedHooks('2.1.77')).toBe(false);
    expect(claudeExtendedHooks(undefined)).toBe(false);
    const extended = claudeHookSettings(target, 'http', true).hooks;
    for (const event of ['PermissionRequest', 'PostToolUseFailure', 'PermissionDenied', 'SubagentStart', 'PreCompact', 'PostCompact', 'Elicitation', 'ElicitationResult']) expect(extended[event]).toBeDefined();
    expect(JSON.stringify(extended.PermissionRequest)).toContain('/permission/');
    expect(JSON.stringify(extended.PreToolUse)).toContain('/pre/');
    const basic = claudeHookSettings(target, 'http', false).hooks;
    expect(basic.PermissionRequest).toBeUndefined();
    expect(JSON.stringify(basic.PreToolUse)).toContain('/busy/');
    // The curl form never gets them (they would upload whole payloads through a process per call).
    expect(claudeHookSettings(target, 'shell', true).hooks.PermissionRequest).toBeUndefined();
  });
});

describe('shell prompt marks', () => {
  it('parses A, B, C and D with or without an exit code; ignores other marks', () => {
    expect(parseShellMark('A')).toEqual({ kind: 'A' });
    expect(parseShellMark('B')).toEqual({ kind: 'B' });
    expect(parseShellMark('C')).toEqual({ kind: 'C' });
    expect(parseShellMark('D')).toEqual({ kind: 'D' });
    expect(parseShellMark('D;0')).toEqual({ kind: 'D', code: 0 });
    expect(parseShellMark('D;130')).toEqual({ kind: 'D', code: 130 });
    expect(parseShellMark('D;1;aid=7')).toEqual({ kind: 'D', code: 1 });
    expect(parseShellMark('D;x')).toEqual({ kind: 'D' });
    expect(parseShellMark('E;ls -la')).toBeNull();
    expect(parseShellMark('P;Cwd=/tmp')).toBeNull();
    expect(parseShellMark('')).toBeNull();
  });

  it('PowerShell gets the script as -EncodedCommand (UTF-16LE base64) after -NoExit; cmd its PROMPT', () => {
    const ps = withShellIntegration('pwsh', { file: 'pwsh.exe', args: ['-NoLogo'], env: { A: '1' } }, { dir: 'C:\\t', platform: 'win32' });
    expect(ps.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
    expect(Buffer.from(ps.args[3], 'base64').toString('utf16le')).toBe(POWERSHELL_SCRIPT);
    expect(encodePowerShell('ab')).toBe(Buffer.from('ab', 'utf16le').toString('base64'));
    const cmd = withShellIntegration('cmd', { file: 'cmd.exe', args: [], env: {} }, { dir: 'C:\\t', platform: 'win32' });
    expect(cmd.env.PROMPT).toBe('$E]133;D$E\\$E]133;A$E\\$P$G$E]133;B$E\\');
    expect(cmdPrompt('$N$G')).toContain('$N$G');
  });

  it('bash gets an init file that reads the login files; zsh and the opt-out stay untouched', () => {
    const bash = withShellIntegration('bash', { file: '/bin/bash', args: ['-il'], env: {} }, { dir: '/tmp/u', platform: 'darwin' });
    expect(bash.args).toEqual(['--init-file', '/tmp/u/bash-init.sh', '-i']);
    expect(bash.files['/tmp/u/bash-init.sh']).toBe(BASH_INIT);
    expect(BASH_INIT).toContain('~/.bash_profile');
    const zsh = withShellIntegration('zsh', { file: '/bin/zsh', args: ['-il'], env: {} }, { dir: '/tmp/u', platform: 'darwin' });
    expect(zsh.args).toEqual(['-il']);
    const off = withShellIntegration('pwsh', { file: 'pwsh.exe', args: ['-NoLogo'], env: { UNIMUX_SHELL_INTEGRATION: '0' } }, { dir: 'C:\\t', platform: 'win32' });
    expect(off.args).toEqual(['-NoLogo']);
  });

  it('the pty host writes the helper files before the launch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-si-'));
    try {
      const launch = integratedLaunch('bash', { file: '/bin/bash', args: ['-il'], env: {} }, 'linux', dir);
      expect(launch.args[0]).toBe('--init-file');
      expect(readFileSync(launch.args[1], 'utf8')).toBe(BASH_INIT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('status labels', () => {
  it('says what the status is about', () => {
    expect(statusText('working', undefined, { kind: 'tool', tool: 'Edit' })).toEqual({ key: 'praca: {tool}', params: { tool: 'Edit' } });
    expect(statusText('working', undefined, undefined)).toEqual({ key: 'pracuje' });
    expect(statusText('working', undefined, { kind: 'subagent', tool: 'Explore' })).toEqual({ key: 'subagent: {name}', params: { name: 'Explore' } });
    expect(statusText('working', undefined, { kind: 'command' })).toEqual({ key: 'polecenie działa' });
    expect(statusText('waiting', 'attention', { kind: 'permission', tool: 'Bash' })).toEqual({ key: 'czeka na zgodę: {tool}', params: { tool: 'Bash' } });
    expect(statusText('waiting', 'attention', { kind: 'question' })).toEqual({ key: 'pyta Cię o coś' });
    expect(statusText('waiting', 'error', undefined, 'rate_limit')).toEqual({ key: 'limit osiągnięty' });
    expect(statusText('waiting', 'error', undefined, 'cli-exited')).toEqual({ key: 'CLI zakończył działanie' });
    expect(statusText('waiting', 'done', undefined)).toEqual({ key: 'czeka na Ciebie' });
    expect(statusText('idle', undefined, { kind: 'exit-code', code: 3 })).toEqual({ key: 'kod wyjścia {code}', params: { code: 3 } });
    // 1.0.7: the exit code of the cell's own process is named; a non-zero code of any kind is an error everywhere.
    expect(statusText('exited', undefined, { kind: 'exit-code', code: 3 })).toEqual({ key: 'zakończony (kod {code})', params: { code: 3 } });
    expect(statusText('exited', undefined, undefined)).toEqual({ key: 'zakończony' });
    expect(failedExit({ kind: 'exit-code', code: 5 })).toBe(true);
    expect(failedExit({ kind: 'cli-exited', code: 1 })).toBe(true);
    expect(failedExit({ kind: 'cli-exited' })).toBe(false);
    expect(failedExit({ kind: 'command' })).toBe(false);
    expect(failedExit(undefined)).toBe(false);
    expect(statusText('idle', undefined, { kind: 'cli-exited', code: 1 })).toEqual({ key: 'CLI zakończył działanie (kod {code})', params: { code: 1 } });
    expect(statusText('idle', undefined, undefined)).toBeNull();
    expect(statusText('exited', undefined, undefined)).toEqual({ key: 'zakończony' });
  });
});
