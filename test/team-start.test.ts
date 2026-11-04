// 1.1.4: AI team starts - the inbox-built startup prompt, the resume note, the coordinator's delegation rules and their
// command lines per shell, the CLI-end post of the launch line, the delegation setting and its limit.
import { describe, expect, it } from 'vitest';
import type { AgentTask } from '../src/shared/automation';
import { taskPrompt } from '../src/shared/automation';
import {
  coordinatorRoleNote, coordinatorSystemRules, DEFAULT_DELEGATION, delegationOf, delegationRefusal, normalizeDelegation, shellSafeText, teamLimit,
} from '../src/shared/delegation';
import { buildCliCommand, buildLaunchCommand, DEFAULT_PROFILES } from '../src/shared/profiles';
import { automationStatusFor } from '../src/shared/runtimeStatus';
import { defaultState, normalizeState } from '../src/shared/state';
import { resumeTaskPrompt, startupTaskPrompt } from '../src/shared/teamPrompts';
import { withResetTail } from '../src/shared/termReset';
import { mcpInstructions } from '../src/main/mcpTools';

const P = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.id, p]));
const task = (id: string, cellId: string, status: AgentTask['status'], extra: Partial<AgentTask> = {}): AgentTask => ({
  id, projectId: 'p', cellId, title: `Title ${id}`, prompt: `Do ${id}`, status, delivery: 'startup', createdAt: 1, updatedAt: 1, ...extra,
});

describe('startupTaskPrompt (a new conversation of a role cell)', () => {
  it('sends the one queued task as its own task prompt, whatever the stored startupPrompt says', () => {
    const t = task('t1', 'w', 'queued');
    expect(startupTaskPrompt([t], 'w', 'worker', taskPrompt(t))).toBe(taskPrompt(t));
    expect(startupTaskPrompt([t], 'w', 'worker')).toBe(taskPrompt(t));
  });

  it('keeps the task after the first start: a cleared startupPrompt still gets the queued task (the lost-task bug)', () => {
    expect(startupTaskPrompt([task('t1', 'w', 'queued')], 'w', 'worker', undefined)).toContain('[Unimux task t1]');
  });

  it('lists several tasks once each and points to read_inbox; claimed ones only as "continue"', () => {
    const text = startupTaskPrompt([task('a', 'w', 'queued'), task('b', 'w', 'queued'), task('c', 'w', 'in_progress'), task('d', 'w', 'completed'), task('e', 'x', 'queued')], 'w', 'worker')!;
    expect(text).toContain('- a: Title a');
    expect(text).toContain('- b: Title b');
    expect(text.split('- c: Title c').length).toBe(2);
    expect(text.indexOf('- c:')).toBeGreaterThan(text.indexOf('already started'));
    expect(text).not.toContain('Title d');
    expect(text).not.toContain('Title e');
    expect(text).toContain('read_inbox');
    expect(text).toContain('Do not create agents');
    expect(startupTaskPrompt([task('a', 'w', 'queued'), task('b', 'w', 'queued')], 'w', 'coordinator')).toContain('Follow your delegation rules');
  });

  it('keeps a plain stored prompt (a grid template) first and falls back to it without tasks', () => {
    expect(startupTaskPrompt([], 'w', 'worker', 'Review the PR')).toBe('Review the PR');
    expect(startupTaskPrompt([task('t1', 'w', 'queued')], 'w', 'worker', 'Review the PR')).toMatch(/^Review the PR\n\n\[Unimux task t1\]/);
    expect(startupTaskPrompt([task('t1', 'w', 'completed')], 'w', 'worker', '[Unimux task t1] old')).toBe('[Unimux task t1] old');
    expect(startupTaskPrompt([], 'w', 'worker')).toBeUndefined();
  });
});

describe('resumeTaskPrompt (the user restarted an agent)', () => {
  it('names the open tasks of a worker and nothing without them', () => {
    const text = resumeTaskPrompt([task('a', 'w', 'in_progress'), task('b', 'w', 'queued'), task('c', 'w', 'completed')], 'w', 'worker')!;
    expect(text).toContain('a Title a (in_progress)');
    expect(text).toContain('b Title b (queued)');
    expect(text).not.toContain('Title c');
    expect(text).toContain('read_inbox');
    expect(resumeTaskPrompt([task('c', 'w', 'completed')], 'w', 'worker')).toBeUndefined();
  });

  it('tells a coordinator which tasks it was waiting for', () => {
    const text = resumeTaskPrompt([task('x', 'w1', 'in_progress', { fromCellId: 'lead' }), task('y', 'w2', 'blocked', { fromCellId: 'lead' }), task('z', 'w3', 'completed', { fromCellId: 'lead' })], 'lead', 'coordinator')!;
    expect(text).toContain('waiting for tasks x, y: call wait_for');
    expect(resumeTaskPrompt([task('x', 'w1', 'in_progress', { fromCellId: 'lead' })], 'lead', 'worker')).toBeUndefined();
  });
});

describe('launch lines of team agents', () => {
  const rules = coordinatorSystemRules(DEFAULT_DELEGATION)!;
  const initialPrompt = { file: 'C:/p/t.txt', text: 'task one' };

  it('gives a Claude coordinator --append-system-prompt after the prompt, as one quoted argument per shell', () => {
    const ps = buildCliCommand(P.claude, { mode: 'new', sessionId: 's', initialPrompt, systemPrompt: rules, mcp: { url: 'u', claudeConfigPath: 'C:/m/lead.json' } })!;
    expect(ps.startsWith("claude (Get-Content -Raw -Encoding utf8 -LiteralPath 'C:/p/t.txt') --session-id s")).toBe(true);
    expect(ps).toContain(`--mcp-config 'C:/m/lead.json' --append-system-prompt '${rules}'`);
    const cmd = buildCliCommand(P.claude, { mode: 'new', shell: 'cmd', initialPrompt, systemPrompt: rules })!;
    expect(cmd).toBe(`claude "task one" --append-system-prompt "${rules}"`);
    const zsh = buildCliCommand(P.claude, { mode: 'new', shell: 'zsh', systemPrompt: rules })!;
    expect(zsh).toBe(`claude --append-system-prompt '${rules}'`);
  });

  it('cleans what a shell would read in the rules (quotes, %, &, newlines)', () => {
    const system = `it's "100%" & more\nx`;
    expect(buildCliCommand(P.claude, { mode: 'new', shell: 'pwsh', systemPrompt: system })).toBe("claude --append-system-prompt 'it s 100 more x'");
    expect(buildCliCommand(P.claude, { mode: 'new', shell: 'cmd', systemPrompt: system })).toBe('claude --append-system-prompt "it s 100 more x"');
    expect(buildCliCommand(P.claude, { mode: 'new', shell: 'bash', systemPrompt: system })).toBe("claude --append-system-prompt 'it s 100 more x'");
    expect(shellSafeText(`a "b" 'c' %d% ^e !f! | <g> $h \\i\n`)).toBe('a b c d e f g h i');
  });

  it('gives a Codex coordinator developer_instructions as a TOML literal string per shell', () => {
    expect(buildCliCommand(P.codex, { mode: 'new', systemPrompt: 'be brief' })).toBe("codex -c tui.notifications=true -c 'developer_instructions=''be brief'''");
    expect(buildCliCommand(P.codex, { mode: 'new', shell: 'cmd', systemPrompt: 'be brief' })).toBe(`codex -c tui.notifications=true -c "developer_instructions='be brief'"`);
    expect(buildCliCommand(P.codex, { mode: 'new', shell: 'bash', systemPrompt: 'be brief' })).toBe(`codex -c tui.notifications=true -c 'developer_instructions='"'"'be brief'"'"''`);
  });

  it('passes a resume note: Claude prompt first then --resume, Codex resume <id> ... <prompt>', () => {
    const resumePrompt = { file: 'C:/p/r.txt', text: 'continue' };
    expect(buildCliCommand(P.claude, { mode: 'resume', sessionId: 'u1', resumePrompt, shell: 'cmd' })).toBe('claude "continue" --resume u1');
    expect(buildCliCommand(P.codex, { mode: 'resume', sessionId: 's9', resumePrompt, shell: 'cmd' })).toBe('codex resume s9 -c tui.notifications=true "continue"');
    // A new conversation never takes the resume note, a resume never takes the startup prompt.
    expect(buildCliCommand(P.claude, { mode: 'new', resumePrompt, shell: 'cmd' })).toBe('claude');
    expect(buildCliCommand(P.claude, { mode: 'resume', sessionId: 'u1', initialPrompt, shell: 'cmd' })).toBe('claude --resume u1');
  });

  it('posts the end of the CLI with its exit code from the reset tail of every shell', () => {
    const url = 'http://127.0.0.1:5555/x/cell-1/0123456789abcdef';
    const ps = buildLaunchCommand(P.claude, { mode: 'new', exitUrl: url })!;
    expect(ps).toMatch(/^Clear-Host; try \{ claude \} finally \{ \$__mcExit = \$LASTEXITCODE; curl\.exe -s --noproxy '\*' -m 2 -X POST "http:\/\/127\.0\.0\.1:5555\/x\/cell-1\/0123456789abcdef\/\$__mcExit" \*> \$null; \[Console\]::Write\(.*\); \$global:LASTEXITCODE = \$__mcExit; \$global:__unimuxExit = \$__mcExit \}$/);
    expect(withResetTail('claude', 'cmd', url)).toMatch(/^claude & call curl\.exe -s --noproxy \* -m 2 -X POST http:\/\/127\.0\.0\.1:5555\/x\/cell-1\/0123456789abcdef\/%\^errorlevel% >nul 2>&1 & powershell /);
    expect(withResetTail('claude', 'bash', url)).toContain(`claude; __mc_exit=$?; curl -s --noproxy '*' -m 2 -X POST '${url}/'$__mc_exit >/dev/null 2>&1; printf`);
    // Anything but the hook server's exit route is ignored (nothing foreign is typed into a shell).
    expect(withResetTail('claude', 'pwsh', 'http://evil" & calc')).toBe(withResetTail('claude', 'pwsh'));
    expect(withResetTail('claude', 'cmd')).not.toContain('curl');
  });
});

describe('delegation setting', () => {
  it('defaults to "auto" with 4 agents, also for a state.json of 1.1.3', () => {
    expect(defaultState().settings.delegation).toEqual({ mode: 'auto', maxAgents: 4 });
    const old = JSON.parse(JSON.stringify(defaultState())) as { settings: Record<string, unknown> };
    delete old.settings.delegation;
    expect(normalizeState(old)!.settings.delegation).toEqual({ mode: 'auto', maxAgents: 4 });
    expect(normalizeState({ ...old, settings: { ...old.settings, delegation: { mode: 'ask', maxAgents: 7 } } })!.settings.delegation).toEqual({ mode: 'ask', maxAgents: 7 });
  });

  it('clamps and repairs bad values', () => {
    expect(normalizeDelegation({ mode: 'sometimes', maxAgents: 99 })).toEqual({ mode: 'auto', maxAgents: 20 });
    expect(normalizeDelegation({ mode: 'ask', maxAgents: 0 })).toEqual({ mode: 'ask', maxAgents: 1 });
    expect(normalizeDelegation({ maxAgents: 'x' })).toEqual({ mode: 'auto', maxAgents: 4 });
    expect(normalizeDelegation(null)).toEqual(DEFAULT_DELEGATION);
    expect(delegationOf({ settings: {} })).toEqual(DEFAULT_DELEGATION);
  });

  it('has system rules only in "auto" mode, and the MCP instructions follow the mode', () => {
    expect(coordinatorSystemRules({ mode: 'ask', maxAgents: 4 })).toBeNull();
    const rules = coordinatorSystemRules({ mode: 'auto', maxAgents: 6 })!;
    expect(rules).toContain('create_grid');
    expect(rules).toContain('at most 6 agents');
    expect(rules).toBe(shellSafeText(rules));
    expect(coordinatorRoleNote({ mode: 'ask', maxAgents: 4 })).toContain('only when the user asked to delegate');
    expect(mcpInstructions('coordinator', { cellId: 'c' }, { mode: 'ask', maxAgents: 4 })).toContain('only when the user asked to delegate');
    expect(mcpInstructions('coordinator', { cellId: 'c' })).toContain('Delegate on your own');
    expect(mcpInstructions('worker', { cellId: 'c' })).not.toContain('Delegate');
  });

  it('teamLimit and delegationRefusal count the agents with open tasks from the coordinator', () => {
    const state = { settings: { delegation: { mode: 'auto' as const, maxAgents: 2 } }, automation: { tasks: [
      task('a', 'w1', 'in_progress', { fromCellId: 'lead' }), task('b', 'w1', 'queued', { fromCellId: 'lead' }), task('c', 'w9', 'completed', { fromCellId: 'lead' }),
      task('d', 'w5', 'queued', { fromCellId: 'other' }),
    ] } };
    expect(teamLimit(state)).toBe(2);
    expect(delegationRefusal(state, 'lead', { taskCellId: 'w1' })).toBeNull();
    expect(delegationRefusal(state, 'lead', { taskCellId: 'w2' })).toBeNull();
    expect(delegationRefusal(state, 'lead', { newAgents: 1 })).toBeNull();
    expect(delegationRefusal(state, 'lead', { newAgents: 2 })).toMatch(/at most 2 agents/);
    expect(delegationRefusal({ ...state, automation: { tasks: [...state.automation.tasks, task('e', 'w2', 'queued', { fromCellId: 'lead' })] } }, 'lead', { taskCellId: 'w3' })).toMatch(/Team limit/);
  });
});

describe('runtime status after the CLI ended', () => {
  it('stays exited while the shell idles, until the agent works again', () => {
    expect(automationStatusFor('idle', undefined, false, 'exited')).toBeNull();
    expect(automationStatusFor('waiting', 'done', false, 'exited')).toBeNull();
    expect(automationStatusFor('working', undefined, true, 'exited')).toBe('working');
  });
});

describe('the hook server exit route', () => {
  it('hears the end of the current spawn only (its nonce), with the exit code', async () => {
    const { HookServer } = await import('../src/main/hooks');
    const hooks = new HookServer();
    await hooks.start();
    const heard: Array<[string, number | undefined]> = [];
    hooks.on('cliexit', (cellId: string, code?: number) => heard.push([cellId, code]));
    try {
      const old = hooks.exitUrl('c1');
      hooks.prepareCodex('c1'); // a new spawn: a fresh nonce
      const url = hooks.exitUrl('c1');
      expect(url).not.toBe(old);
      expect(withResetTail('codex', 'pwsh', url)).toContain(url);
      for (const target of [`${old}/1`, `${url}/x`, `${url}/2`]) await fetch(target, { method: 'POST' });
      expect((await fetch(`${url}/3`)).status).toBe(403);
      await new Promise((r) => setTimeout(r, 50));
      expect(heard).toEqual([['c1', undefined], ['c1', 2]]);
    } finally { hooks.stop(); }
  });
});
