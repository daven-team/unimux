import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { buildCliCommand, buildLaunchCommand, DEFAULT_PROFILES, cellShell, posixQuote, psQuote, shownProfileName } from '../src/shared/profiles';
import { addProject, addTab, defaultState, normalizeState } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';
import { INPUT_MODES_OFF } from '../src/shared/termReset';

const P = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.id, p]));

describe('buildCliCommand', () => {
  it('quotes macOS settings and prompts safely for bash and zsh', () => {
    const path = "/Users/ala/Project's files/prompt.txt";
    const initialPrompt = { file: path, text: 'Napraw "błąd"\n$HOME; `whoami`' };
    for (const shell of ['zsh', 'bash'] as const) {
      const command = buildCliCommand(P.claude, { mode: 'new', shell, claudeSettingsPath: path, initialPrompt })!;
      expect(command).toContain("--settings '/Users/ala/Project'\"'\"'s files/prompt.txt'");
      expect(command).toContain('"$(cat ' + posixQuote(path) + ')"');
      expect(command).not.toContain('Get-Content');
      expect(command).not.toContain(initialPrompt.text);
    }
  });
  it('starts a new claude conversation with a fixed session id and our settings', () => {
    expect(buildCliCommand({ ...P.claude, args: '--model opus' }, { mode: 'new', sessionId: 'u1', claudeSettingsPath: 'C:\\a b\\x.json' }))
      .toBe("claude --session-id u1 --settings 'C:\\a b\\x.json' --model opus");
  });

  it('passes a startup prompt from a file in PowerShell and inline in cmd', () => {
    const initialPrompt = { file: 'C:/p/c1.txt', text: 'napraw "bug"\nteraz' };
    expect(buildCliCommand(P.codex, { mode: 'new', initialPrompt }))
      .toBe("codex -c tui.notifications=true (Get-Content -Raw -Encoding utf8 -LiteralPath 'C:/p/c1.txt')");
    expect(buildCliCommand(P.claude, { mode: 'new', initialPrompt, shell: 'cmd' })).toBe(`claude "napraw 'bug' teraz"`);
    expect(buildCliCommand(P.claude, { mode: 'resume', sessionId: 'x', initialPrompt })).toBe('claude --resume x');
  });

  it('double-quotes the settings path for cmd', () => {
    expect(buildCliCommand(P.claude, { mode: 'new', sessionId: 'u1', claudeSettingsPath: 'C:/a b/x.json', shell: 'cmd' }))
      .toBe('claude --session-id u1 --settings "C:/a b/x.json"');
  });

  it('resumes claude', () => {
    expect(buildCliCommand(P.claude, { mode: 'resume', sessionId: 'u1' })).toBe('claude --resume u1');
  });

  it('starts and resumes codex with terminal notifications', () => {
    expect(buildCliCommand(P.codex, { mode: 'new' })).toBe('codex -c tui.notifications=true');
    expect(buildCliCommand({ ...P.codex, args: '-c model_reasoning_effort=high' }, { mode: 'resume', sessionId: 's9' }))
      .toBe('codex resume s9 -c tui.notifications=true -c model_reasoning_effort=high');
  });

  it('returns null for shell profiles', () => {
    expect(buildCliCommand(P.shell, { mode: 'new' })).toBeNull();
  });
  it('adds app-owned MCP settings without removing user CLI arguments', () => {
    const mcp = { url: 'http://127.0.0.1:12345/mcp', tokenEnv: 'UNIMUX_MCP_TOKEN', claudeConfigPath: "C:/User's files/mcp.json" };
    const claude = buildCliCommand({ ...P.claude, args: '--model opus' }, { mode: 'new', mcp })!;
    expect(claude).toContain("--mcp-config 'C:/User''s files/mcp.json'");
    expect(claude).toContain('--model opus');
    const codex = buildCliCommand(P.codex, { mode: 'resume', sessionId: 'known', mcp })!;
    expect(codex).toContain('codex resume known');
    expect(codex).toContain("'mcp_servers.unimux.url=\"http://127.0.0.1:12345/mcp\"'");
    expect(codex).toContain("'mcp_servers.unimux.bearer_token_env_var=\"UNIMUX_MCP_TOKEN\"'");
    expect(buildCliCommand(P.codex, { mode: 'new', shell: 'cmd', mcp })).toContain("mcp_servers.unimux.url='http://127.0.0.1:12345/mcp'");
    // A long create_grid (worktrees) or close_grid must not hit Codex's default 60 s tool timeout.
    for (const shell of ['pwsh', 'cmd', 'bash'] as const) expect(buildCliCommand(P.codex, { mode: 'new', shell, mcp })).toContain('-c mcp_servers.unimux.tool_timeout_sec=180');
    expect(buildCliCommand(P.codex, { mode: 'new' })).not.toContain('tool_timeout_sec');
    expect(buildCliCommand(P.claude, { mode: 'new', shell: 'bash', mcp })).toContain("'C:/User'\"'\"'s files/mcp.json'");
  });
  it('configures MCP only through the part each CLI reads: the config file for Claude, the token variable for Codex', () => {
    expect(buildCliCommand(P.claude, { mode: 'new', mcp: { url: 'http://127.0.0.1:1/mcp', tokenEnv: 'UNIMUX_MCP_TOKEN' } })).not.toContain('--mcp-config');
    expect(buildCliCommand(P.codex, { mode: 'new', mcp: { url: 'http://127.0.0.1:1/mcp', claudeConfigPath: 'C:/m.json' } })).not.toContain('mcp_servers');
  });

  it('psQuote escapes single quotes and keeps Polish characters', () => {
    expect(psQuote("D:\\Moje Projekty\\źródło's")).toBe("'D:\\Moje Projekty\\źródło''s'");
  });
});

describe('buildLaunchCommand (typed line with the terminal reset)', () => {
  const PS_TAIL = / finally \{ \[Console\]::Write\(\[char\]27\+'\[\?1000;1002;1003;1005;1006;1015;2004l'\+\[char\]27\+'\[<u'\) \}$/;
  it('carries the exact CLI command inside, on one line, for every shell', () => {
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) {
      for (const profile of [P.claude, P.codex]) {
        const opts = { mode: 'resume' as const, sessionId: 's1', shell, claudeSettingsPath: 'C:/a b/x.json' };
        const cli = buildCliCommand(profile, opts)!;
        const line = buildLaunchCommand(profile, opts)!;
        expect(line).toContain(cli);
        expect(line).toContain('1000;1002;1003;1005;1006;1015;');
        expect(line).not.toMatch(/[\r\n]/);
      }
    }
  });
  it('wraps PowerShell in try/finally (also runs after Ctrl+C), cmd with & and POSIX shells with ;', () => {
    for (const shell of ['pwsh', 'powershell'] as const) {
      const line = buildLaunchCommand(P.claude, { mode: 'new', shell })!;
      expect(line.startsWith('try { claude } finally { ')).toBe(true);
      expect(line).toMatch(PS_TAIL);
    }
    expect(buildLaunchCommand(P.claude, { mode: 'new' })).toMatch(PS_TAIL);
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'cmd' })).toMatch(/^claude & powershell -NoProfile -NonInteractive -Command "\[Console\]::Write\(.*\)" 2>nul$/);
    for (const shell of ['zsh', 'bash'] as const) expect(buildLaunchCommand(P.codex, { mode: 'new', shell })).toMatch(/^trap : INT; codex -c tui\.notifications=true; printf '\\033\[\?1000;.*1004;2004l.*; trap - INT$/);
  });
  it('writes the escape character through the shell, never typed into the line', () => {
    for (const shell of ['pwsh', 'cmd', 'zsh'] as const) expect(buildLaunchCommand(P.claude, { mode: 'new', shell })).not.toContain('\x1b');
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'cmd' })).toContain("[char]27+'[?");
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'bash' })).toContain('\\033[?');
  });
  it('leaves the initial prompt and its quoting alone', () => {
    const initialPrompt = { file: 'C:/p/c1.txt', text: 'napraw "bug"' };
    expect(buildLaunchCommand(P.claude, { mode: 'new', initialPrompt })!).toContain("try { claude (Get-Content -Raw -Encoding utf8 -LiteralPath 'C:/p/c1.txt') } finally {");
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'cmd', initialPrompt })!.startsWith(`claude "napraw 'bug'" & `)).toBe(true);
  });
  it('never clears win32-input-mode (ConPTY owns it) nor, on Windows shells, focus reports', () => {
    expect(INPUT_MODES_OFF).not.toContain('9001');
    for (const shell of ['pwsh', 'powershell', 'cmd'] as const) {
      const line = buildLaunchCommand(P.claude, { mode: 'new', shell })!;
      expect(line).not.toContain('9001');
      expect(line).not.toContain('1004');
    }
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'zsh' })).toContain('1004');
  });
  it('adds nothing for plain shell profiles', () => {
    expect(buildLaunchCommand(P.shell, { mode: 'new', shell: 'cmd' })).toBeNull();
  });
});

describe('cleanEnv', () => {
  it('drops parent session vars but keeps user config', () => {
    const env = cleanEnv({
      PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'a',
      CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_ENABLE_TELEMETRY: '1', ELECTRON_RUN_AS_NODE: '1', U: undefined,
      UNIMUX_MCP_TOKEN: 'parent-token', MC_CELL_ID: 'parent-cell',
    });
    expect(env).toEqual({ PATH: 'x', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
  });
});

describe('per-cell model overrides', () => {
  it('replaces a profile model while retaining unrelated CLI flags', () => {
    const command = buildCliCommand({ ...P.codex, args: '--model old-model --no-alt-screen' }, { mode: 'new', model: 'new-model' })!;
    expect(command).not.toContain('old-model');
    expect(command.match(/--model/g)).toHaveLength(1);
    expect(command).toContain('--no-alt-screen');
  });
  it('passes a quoted model to both agents for every supported shell', () => {
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) {
      for (const profile of [P.claude, P.codex]) {
        const command = buildCliCommand(profile, { mode: 'new', model: 'provider/model-v2', shell })!;
        expect(command).toContain('--model');
        expect(command).toContain(shell === 'cmd' ? '"provider/model-v2"' : "'provider/model-v2'");
      }
    }
  });
  it('rejects model strings that could execute shell syntax', () => {
    for (const model of ['a;whoami', '%PATH%', 'a`id`', '$(id)', 'a"b', '-bad', 'a b']) {
      expect(() => buildCliCommand(P.codex, { mode: 'new', model })).toThrow('Invalid model');
    }
  });
});

describe('shownProfileName', () => {
  const shell = DEFAULT_PROFILES.find((p) => p.cli === 'shell')!;
  it('names the built-in shell profile after the shell chosen in Settings', () => {
    expect(shownProfileName(shell, 'pwsh')).toBe('PowerShell');
    expect(shownProfileName(shell, 'powershell')).toBe('Windows PowerShell');
    expect(shownProfileName(shell, 'cmd', () => 'Command Prompt')).toBe('Command Prompt');
    expect(shownProfileName({ ...shell, name: 'Terminal' }, 'zsh')).toBe('zsh');
    expect(shownProfileName({ ...shell, id: 'ssh-shell' }, 'bash')).toBe('bash');
  });

  it('keeps renamed, custom and agent profile names', () => {
    expect(shownProfileName({ ...shell, name: 'Moja konsola' }, 'cmd')).toBe('Moja konsola');
    expect(shownProfileName({ id: 'wsl', name: 'PowerShell', cli: 'shell' }, 'cmd')).toBe('PowerShell');
    expect(shownProfileName(DEFAULT_PROFILES[0], 'cmd')).toBe('Claude');
  });

  it('1.0.7: a running cell keeps the name of the shell it was started with when Settings change', () => {
    expect(shownProfileName(shell, cellShell({ shell: 'cmd' }, 'pwsh'), () => 'Wiersz polecenia')).toBe('Wiersz polecenia');
    expect(shownProfileName(shell, cellShell({}, 'pwsh'))).toBe('PowerShell');
    expect(cellShell(undefined, 'bash')).toBe('bash');
  });

  it('1.0.7: the recorded shell of a cell is dropped on load (nothing runs after a restart of the app)', () => {
    const s = createProjectState();
    const loaded = normalizeState(JSON.parse(JSON.stringify(s.withShell)), 'win32')!;
    expect(loaded.projects[0].tabs[0].cells[0].shell).toBeUndefined();
    expect(loaded.projects[0].tabs[0].cells[0].pathMode).toBe('shell');
  });
});

function createProjectState() {
  let st = defaultState('win32');
  st = addProject(st, { name: 'P', path: 'C:\\p' });
  const projectId = st.projects[0].id;
  st = addTab(st, projectId, { name: 'G', layout: layoutForCount(1), cells: [{ profileId: 'shell' }] });
  const tab = st.projects[0].tabs[0];
  const withShell = { ...st, projects: [{ ...st.projects[0], tabs: [{ ...tab, cells: [{ ...tab.cells[0], shell: 'cmd' as const, pathMode: 'shell' as const }] }] }] };
  return { withShell };
}