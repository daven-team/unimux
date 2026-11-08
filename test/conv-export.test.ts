import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  capText, exportBaseName, formatStamp, inlineCode, renderConvMarkdown, type ConvExportData, type MarkdownLabels,
} from '../src/shared/convExport';

const FIXTURES = join(__dirname, 'fixtures', 'convexport');
/**
 * What reading the transcript fixtures (claude.jsonl, the Codex rollout) gives: 1.1.4's exporter wrote these files at R1; the
 * Rust reader (unimux-agents conv::export) is checked against the same transcripts in unimux-agents/tests/conv_index.rs.
 */
const exported = (cli: 'claude' | 'codex'): ConvExportData => JSON.parse(readFileSync(join(FIXTURES, `${cli}.export.json`), 'utf8'));

const LABELS: MarkdownLabels = {
  you: 'Ty', date: 'Data', folder: 'Folder projektu', agent: 'Agent', session: 'Sesja', tool: 'Narzędzie', untitled: 'Rozmowa bez tytułu',
  cutMessage: 'wiadomość skrócona', capped: 'Rozmowa jest bardzo długa: wyeksportowano tylko jej początek.',
};

describe('Markdown of a conversation', () => {
  it('renders the Claude fixture with a header, sections and no tool calls by default', () => {
    const data = exported('claude');
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

  it('adds one quoted line per tool call when asked', () => {
    const md = renderConvMarkdown(exported('claude'), { tools: true }, LABELS);
    expect(md).toContain('Uruchomię najpierw testy.\n\n> Narzędzie: Bash `npm test`\n>\n> Narzędzie: Edit `src/a.ts`\n\nPoprawione:');
    expect(md).not.toContain('secret');
  });

  it('renders the Codex fixture under "## Codex"', () => {
    const md = renderConvMarkdown(exported('codex'), { tools: true }, LABELS);
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
