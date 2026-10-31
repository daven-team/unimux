import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capText, exportBaseName, formatStamp, inlineCode, renderConvMarkdown, toolDetail, type ConvExportData, type MarkdownLabels,
} from '../src/shared/convExport';
import { locateSession, readExport } from '../src/convsearch/exporter';
import { sanitizeExportSource } from '../src/main/convSearchClient';

const FIXTURES = join(__dirname, 'fixtures', 'convexport');
const CLAUDE_FILE = join(FIXTURES, 'claude.jsonl');
const CODEX_ID = '0199bbbb-cccc-7ddd-8eee-000000000020';
const CODEX_FILE = join(FIXTURES, `rollout-2026-10-21T10-00-00-${CODEX_ID}.jsonl`);

const LABELS: MarkdownLabels = {
  you: 'Ty', date: 'Data', folder: 'Folder projektu', agent: 'Agent', session: 'Sesja', tool: 'Narzędzie', untitled: 'Rozmowa bez tytułu',
  cutMessage: 'wiadomość skrócona', capped: 'Rozmowa jest bardzo długa: wyeksportowano tylko jej początek.',
};

describe('reading a transcript for the export', () => {
  it('reads a Claude transcript: texts and tool calls, never tool output, thinking, injected or sidechain messages', async () => {
    const data = await readExport(CLAUDE_FILE, 'claude');
    expect(data.ok).toBe(true);
    expect(data.id).toBe('44444444-aaaa-4bbb-8ccc-000000000004');
    expect(data.title).toBe('Fix the failing tests');
    expect(data.cwd).toBe('D:\\work\\alpha');
    expect(data.model).toBe('claude-opus-5-5');
    expect(data.startedAt).toBe(Date.parse('2026-10-20T08:00:00.500Z'));
    expect(data.items).toEqual([
      { kind: 'msg', role: 'user', text: 'Napraw testy w `src/a.ts`, proszę.', ts: Date.parse('2026-10-20T08:00:01.000Z') },
      { kind: 'msg', role: 'assistant', text: 'Uruchomię najpierw testy.', ts: Date.parse('2026-10-20T08:00:03.000Z') },
      { kind: 'tool', name: 'Bash', detail: 'npm test', ts: Date.parse('2026-10-20T08:00:04.000Z') },
      { kind: 'tool', name: 'Edit', detail: 'src/a.ts', ts: Date.parse('2026-10-20T08:00:06.000Z') },
      { kind: 'msg', role: 'assistant', text: 'Poprawione:\n\n- `a` zamienione na `b`\n- testy przechodzą', ts: Date.parse('2026-10-20T08:00:09.000Z') },
      { kind: 'msg', role: 'user', text: 'Dzięki!', ts: Date.parse('2026-10-20T08:01:00.000Z') },
    ]);
    const all = JSON.stringify(data);
    for (const hidden of ['secret reasoning', 'secret tool output', 'sidechain prompt', 'command-name']) expect(all).not.toContain(hidden);
  });

  it('reads a Codex rollout: shell commands without the shell wrapper, apply_patch as its files, no reasoning or output', async () => {
    const data = await readExport(CODEX_FILE, 'codex');
    expect(data.id).toBe(CODEX_ID);
    expect(data.model).toBe('gpt-6.1-sol');
    expect(data.cwd).toBe('D:\\work\\beta');
    expect(data.title).toBe('Migrate the Redis client to the new pool API');
    expect(data.items.map((i) => (i.kind === 'tool' ? `tool:${i.name}:${i.detail}` : `${i.role}:${i.text}`))).toEqual([
      'user:Migrate the Redis client to the new pool API',
      'tool:shell:rg createPool src',
      'tool:apply_patch:src/redis.ts',
      'assistant:The pool now comes from createPool() and every command borrows a connection.',
    ]);
    const all = JSON.stringify(data);
    for (const hidden of ['hidden reasoning', 'secret output', 'developer text', 'AGENTS.md']) expect(all).not.toContain(hidden);
  });

  it('stops at the limits and says so', async () => {
    const data = await readExport(CLAUDE_FILE, 'claude', { docChars: 60, messageChars: 10, items: 100 });
    expect(data.capped).toBe(true);
    const first = data.items[0];
    expect(first.kind === 'msg' && first.cut).toBe(true);
    expect(first.kind === 'msg' && first.text.length).toBe(10);
    expect(data.items.reduce((n, i) => n + (i.kind === 'msg' ? i.text.length : i.name.length + i.detail.length), 0)).toBeLessThanOrEqual(60);
  });
});

describe('finding the transcript of a cell', () => {
  let root: string | null = null;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

  it('finds Claude and Codex sessions by id and refuses ids that could be paths', async () => {
    root = mkdtempSync(join(tmpdir(), 'unimux-convexport-'));
    const claudeDir = join(root, 'claude', 'projects', 'D--work-alpha');
    const codexDir = join(root, 'codex', 'sessions', '2026', '10', '21');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(claudeDir, 'abc-1.jsonl'), '{}\n');
    writeFileSync(join(codexDir, `rollout-2026-10-21T10-00-00-${CODEX_ID}.jsonl`), '{}\n');
    const roots = { claudeRoots: [join(root, 'claude')], codexRoots: [join(root, 'codex')] };
    expect(await locateSession('claude', 'abc-1', roots)).toBe(join(claudeDir, 'abc-1.jsonl'));
    expect(await locateSession('codex', CODEX_ID, roots)).toBe(join(codexDir, `rollout-2026-10-21T10-00-00-${CODEX_ID}.jsonl`));
    expect(await locateSession('claude', 'missing', roots)).toBeNull();
    expect(await locateSession('claude', '../abc-1', roots)).toBeNull();
    expect(sanitizeExportSource({ cli: 'claude', id: '..\\x' })).toBeNull();
    expect(sanitizeExportSource({ cli: 'shell', id: 'x' })).toBeNull();
    expect(sanitizeExportSource({ cli: 'codex', id: CODEX_ID })).toEqual({ cli: 'codex', id: CODEX_ID });
    expect(sanitizeExportSource({ file: 'D:\\a.jsonl', extra: 1 })).toEqual({ file: 'D:\\a.jsonl' });
  });
});

describe('Markdown of a conversation', () => {
  it('renders the Claude fixture with a header, sections and no tool calls by default', async () => {
    const data = await readExport(CLAUDE_FILE, 'claude');
    const md = renderConvMarkdown(data, { tools: false }, LABELS);
    expect(md).toBe([
      '# Fix the failing tests',
      '',
      `- Data: ${formatStamp(data.startedAt)} - ${formatStamp(data.updatedAt)}`,
      '- Folder projektu: `D:\\work\\alpha`',
      '- Agent: Claude Code (claude-opus-5-5)',
      '- Sesja: `44444444-aaaa-4bbb-8ccc-000000000004`',
      '',
      '---',
      '',
      '## Ty',
      '',
      'Napraw testy w `src/a.ts`, proszę.',
      '',
      '## Claude',
      '',
      'Uruchomię najpierw testy.',
      '',
      'Poprawione:',
      '',
      '- `a` zamienione na `b`',
      '- testy przechodzą',
      '',
      '## Ty',
      '',
      'Dzięki!',
      '',
    ].join('\n'));
  });

  it('adds one quoted line per tool call when asked', async () => {
    const md = renderConvMarkdown(await readExport(CLAUDE_FILE, 'claude'), { tools: true }, LABELS);
    expect(md).toContain('Uruchomię najpierw testy.\n\n> Narzędzie: Bash `npm test`\n>\n> Narzędzie: Edit `src/a.ts`\n\nPoprawione:');
    expect(md).not.toContain('secret');
  });

  it('renders the Codex fixture under "## Codex"', async () => {
    const md = renderConvMarkdown(await readExport(CODEX_FILE, 'codex'), { tools: true }, LABELS);
    expect(md).toContain('- Agent: Codex (gpt-6.1-sol)');
    expect(md).toContain('## Ty\n\nMigrate the Redis client to the new pool API\n\n## Codex\n\n> Narzędzie: shell `rg createPool src`\n>\n> Narzędzie: apply_patch `src/redis.ts`\n\nThe pool now comes from');
  });

  it('marks cut messages and a cut conversation, and names an untitled one', () => {
    const data: ConvExportData = {
      ok: true, cli: 'codex', id: '', title: '', cwd: '', startedAt: 0, updatedAt: 0, capped: true,
      items: [{ kind: 'msg', role: 'user', text: 'abc', ts: 0, cut: true }],
    };
    const md = renderConvMarkdown(data, { tools: false }, LABELS);
    expect(md.startsWith('# Rozmowa bez tytułu\n\n- Agent: Codex\n')).toBe(true);
    expect(md).toContain('abc … _(wiadomość skrócona)_');
    expect(md.trimEnd().endsWith('_Rozmowa jest bardzo długa: wyeksportowano tylko jej początek._')).toBe(true);
  });
});

describe('export helpers', () => {
  it('summarises tool inputs in one line', () => {
    expect(toolDetail('Bash', { command: 'npm test\n  --run', description: 'x' })).toBe('npm test --run');
    expect(toolDetail('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(toolDetail('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO');
    expect(toolDetail('WebFetch', { url: 'https://x.dev', prompt: 'p' })).toBe('https://x.dev');
    expect(toolDetail('TodoWrite', { todos: [] })).toBe('');
    expect(toolDetail('shell', '{"command":["pwsh","-Command","Get-ChildItem"]}')).toBe('Get-ChildItem');
    expect(toolDetail('shell', { command: ['rg', '-n', 'x'] })).toBe('rg -n x');
    expect(toolDetail('web_search', { type: 'search', query: 'vitest docs' })).toBe('vitest docs');
    expect(toolDetail('Bash', { command: 'x'.repeat(500) }).length).toBe(160);
  });

  it('keeps backticks inside inline code', () => {
    expect(inlineCode('npm test')).toBe('`npm test`');
    expect(inlineCode('echo `date`')).toBe('`` echo `date` ``');
  });

  it('builds a file name from the title and the day', () => {
    const at = new Date(2026, 9, 24, 9, 0).getTime();
    expect(exportBaseName('Fix: a/b "c"', at, 'x')).toBe('Fix- a-b -c- 2026-10-24');
    expect(exportBaseName('', 0, 'Rozmowa')).toBe('Rozmowa');
  });

  it('cuts a long text for a note at a line end with a note', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const r = capText(text, 200, 'cut here');
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.text.endsWith('_cut here_\n')).toBe(true);
    expect(capText('short', 200, 'x')).toEqual({ text: 'short', cut: false });
  });
});
