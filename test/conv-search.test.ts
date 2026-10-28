import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fold, folderOwner, matchDoc, messageAt, MESSAGE_SEP, normalizeFolder, parseTerms, searchDocs, type ConvDoc,
} from '../src/shared/convSearch';
import { claudeWanted, codexWanted, feedLine, newMeta, readLines } from '../src/convsearch/parse';
import { ConvIndexer } from '../src/convsearch/indexer';
import { sanitizeQuery } from '../src/main/convSearchClient';

const FIXTURES = join(__dirname, 'fixtures', 'convsearch');
const ALPHA = '11111111-aaaa-4bbb-8ccc-000000000001';
const THEME = '22222222-aaaa-4bbb-8ccc-000000000002';
const CODEX = '0199aaaa-bbbb-7ccc-8ddd-000000000010';

function docOf(messages: Array<[string, string]>, extra: Partial<ConvDoc> = {}): ConvDoc {
  const starts: number[] = [];
  let len = 0;
  for (const [, text] of messages) { starts.push(starts.length ? len + 1 : 0); len = starts[starts.length - 1] + text.length; }
  const text = messages.map((m) => m[1]).join(MESSAGE_SEP);
  return {
    cli: 'claude', id: 'x', cwd: 'D:\\p', title: 'T', startedAt: 1, updatedAt: 2, file: 'f', text, folded: fold(text), starts,
    roles: messages.map((m) => m[0]).join(''), times: messages.map(() => 0), capped: false, ...extra,
  };
}

describe('folding and terms', () => {
  it('folds case and Polish diacritics without changing the length', () => {
    const s = 'Zażółć GĘŚLĄ Jaźń İx ß';
    expect(fold(s)).toBe('zazolc gesla jazn ix s');
    expect(fold(s).length).toBe(s.length);
    expect(fold('한국어')).toBe('한국어');
    expect(fold('emoji 😀 ok').length).toBe('emoji 😀 ok'.length);
  });

  it('splits words and quoted phrases and drops terms another one contains', () => {
    expect(parseTerms('Atomic  "write file"  atom')).toEqual(['atomic', 'write file']);
    expect(parseTerms('"unterminated phrase')).toEqual(['unterminated phrase']);
    expect(parseTerms('   ')).toEqual([]);
    expect(parseTerms('a b c d e f g h i j').length).toBe(8);
  });

  it('finds the message of an offset', () => {
    expect(messageAt([0, 5, 9], 0)).toBe(0);
    expect(messageAt([0, 5, 9], 5)).toBe(1);
    expect(messageAt([0, 5, 9], 8)).toBe(1);
    expect(messageAt([0, 5, 9], 100)).toBe(2);
  });
});

describe('matching and snippets', () => {
  const doc = docOf([
    ['u', 'Napraw zapis stanu: plik state.json gubi zakładki'],
    ['a', 'Sprawdzę funkcję atomicWrite.'],
    ['u', 'Teraz dodaj test regresji dla zapisu.'],
  ]);

  it('needs every term somewhere in the conversation', () => {
    expect(matchDoc(doc, ['zakladki', 'atomicwrite'])).not.toBeNull();
    expect(matchDoc(doc, ['zakladki', 'nieistniejace'])).toBeNull();
  });

  it('marks the terms in snippets with offsets of the snippet text', () => {
    const m = matchDoc(doc, ['zapis'])!;
    expect(m.hits).toBe(2);
    const first = m.snippets[0];
    expect(first.index).toBe(0);
    expect(first.role).toBe('user');
    const [a, b] = first.marks[0];
    expect(first.text.slice(a, b)).toBe('zapis');
    // "zapisu" in the third message is marked by its prefix.
    const third = m.snippets.find((s) => s.index === 2)!;
    expect(third.text.slice(third.marks[0][0], third.marks[0][1])).toBe('zapis');
  });

  it('marks folded matches on the original text', () => {
    const m = matchDoc(doc, ['zakladki'])!;
    const s = m.snippets[0];
    expect(s.text.slice(s.marks[0][0], s.marks[0][1])).toBe('zakładki');
  });

  it('filters by role', () => {
    expect(matchDoc(doc, ['atomicwrite'], 'user')).toBeNull();
    expect(matchDoc(doc, ['atomicwrite'], 'assistant')!.snippets[0].index).toBe(1);
  });

  it('cuts long messages around the hit and collapses whitespace', () => {
    const long = docOf([['a', `${'lorem ipsum '.repeat(40)}\n\n  NEEDLE   here ${'dolor sit '.repeat(60)}`]]);
    const s = matchDoc(long, ['needle'])!.snippets[0];
    expect(s.before).toBe(true);
    expect(s.after).toBe(true);
    expect(s.text.length).toBeLessThan(260);
    expect(s.text).toContain('NEEDLE here');
    expect(s.text.slice(s.marks[0][0], s.marks[0][1])).toBe('NEEDLE');
  });

  it('matches a title term and lists newest first with filters', () => {
    const a = docOf([['u', 'one']], { id: 'a', title: 'Redis pool', updatedAt: 10, cwd: 'D:\\A' });
    const b = docOf([['u', 'redis two']], { id: 'b', updatedAt: 20, cli: 'codex', cwd: 'd:/a/' });
    const c = docOf([['u', 'nothing']], { id: 'c', updatedAt: 30, cwd: 'D:\\C' });
    const all = searchDocs([a, b, c], { text: 'redis' });
    expect(all.hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(all.hits[1].titleMarks).toEqual([[0, 5]]);
    expect(all.conversations).toBe(3);
    expect(all.projects.find((p) => p.key === normalizeFolder('D:\\A'))!.count).toBe(2);
    expect(searchDocs([a, b, c], { text: 'redis', cli: 'claude' }).hits.map((h) => h.id)).toEqual(['a']);
    expect(searchDocs([a, b, c], { text: '', project: normalizeFolder('D:\\C') }).hits.map((h) => h.id)).toEqual(['c']);
    expect(searchDocs([a, b, c], { text: '', from: 15 }).hits.map((h) => h.id)).toEqual(['c', 'b']);
    expect(searchDocs([a, b, c], { text: '', limit: 1 })).toMatchObject({ total: 3, hits: [{ id: 'c' }] });
  });
});

describe('parsing transcripts', () => {
  const feed = (cli: 'claude' | 'codex', lines: string[]) => {
    const meta = newMeta();
    const out: Array<[string, string]> = [];
    for (const line of lines) { const buf = Buffer.from(line); feedLine(cli, meta, buf, 0, buf.length, (role, text) => out.push([role, text])); }
    return { meta, out };
  };

  it('skips tool output, thinking, injected and sidechain lines on Claude', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' }, sessionId: 's', cwd: 'C:\\x', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] }, sessionId: 's' }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'thinking', thinking: 'hidden' }] }, sessionId: 's' }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } }),
      '{"type":"user", broken',
    ];
    const { meta, out } = feed('claude', lines);
    expect(out).toEqual([['user', 'hello there'], ['assistant', 'answer']]);
    expect(meta).toMatchObject({ id: 's', cwd: 'C:\\x', model: 'claude-x', prompt: 'hello there' });
    expect(meta.firstTs).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('prefilters lines on their bytes', () => {
    const b = (s: string) => Buffer.from(s);
    const check = (fn: typeof claudeWanted, s: string) => fn(b(s), 0, b(s).length);
    expect(check(claudeWanted, '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}')).toBe(false);
    expect(check(claudeWanted, '{"type":"user","message":{"content":[{"type":"tool_result"}]}}')).toBe(false);
    expect(check(claudeWanted, '{"type":"ai-title","aiTitle":"x","sessionId":"s"}')).toBe(true);
    expect(check(claudeWanted, '{"type":"api-request-blob","message":{"role":"user"}}')).toBe(false);
    expect(check(codexWanted, '{"type":"response_item","payload":{"type":"function_call_output","output":"x"}}')).toBe(false);
    expect(check(codexWanted, '{"type":"response_item","payload":{"type":"message","role":"developer"}}')).toBe(false);
    expect(check(codexWanted, '{"type":"turn_context","payload":{"model":"m"}}')).toBe(true);
  });

  it('reads lines across chunk borders, skips huge lines and keeps the offset of the last whole line', async () => {
    const lines = ['{"a":1}', 'x'.repeat(50), '{"b":2}', '{"c":3'];
    const data = Buffer.from(lines.join('\n'));
    const file = { read: async (buf: Buffer, off: number, len: number, pos: number) => {
      // 7-byte reads force lines across chunks.
      const n = Math.max(0, Math.min(len, 7, data.length - pos));
      data.copy(buf, off, pos, pos + n);
      return { bytesRead: n };
    } };
    const seen: string[] = [];
    const end = await readLines(file, 0, (buf, s, e) => { const t = buf.toString('utf8', s, e); seen.push(t); try { JSON.parse(t); return true; } catch { return false; } }, 20);
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3']);
    // The incomplete last line is not consumed.
    expect(end).toBe(data.length - '{"c":3'.length);
  });
});

describe('ConvIndexer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conv-index-'));
    cpSync(FIXTURES, dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (cacheFile?: string) => new ConvIndexer({ claudeRoots: [join(dir, 'claude')], codexRoots: [join(dir, 'codex')], cacheFile, freshMs: 0 });

  it('indexes both formats and searches across projects', async () => {
    const ix = make();
    await ix.refresh(true);
    const all = ix.search({ text: '' });
    // The session without any prompt is not listed.
    expect(all.hits.map((h) => h.id).sort()).toEqual([CODEX, ALPHA, THEME].sort());
    const alpha = all.hits.find((h) => h.id === ALPHA)!;
    expect(alpha).toMatchObject({ cli: 'claude', cwd: 'D:\\work\\alpha', title: 'Fix state.json losing tabs', model: 'claude-opus-5-5', messages: 4 });
    expect(all.hits.find((h) => h.id === THEME)!.title).toBe('Theme toggle');
    const codex = all.hits.find((h) => h.id === CODEX)!;
    expect(codex).toMatchObject({ cli: 'codex', cwd: 'D:\\work\\beta', title: 'Migrate the Redis client to the new pool API', model: 'gpt-6.1-sol', messages: 2 });

    // Tool output, instructions, thinking and sidechains are not indexed.
    expect(ix.search({ text: 'zebracorn' }).total).toBe(0);
    expect(ix.search({ text: 'flamingo' }).total).toBe(0);
    expect(ix.search({ text: 'secret reasoning' }).total).toBe(0);

    const hit = ix.search({ text: 'zazolc rename' });
    expect(hit.hits.map((h) => h.id)).toEqual([ALPHA]);
    expect(hit.hits[0].snippets.map((s) => s.index)).toEqual([0, 2]);
    expect(ix.search({ text: 'pool', cli: 'codex' }).hits.map((h) => h.id)).toEqual([CODEX]);
    expect(ix.search({ text: 'pool', cli: 'claude' }).total).toBe(0);
    expect(ix.search({ text: '', project: normalizeFolder('D:/work/beta') }).hits.map((h) => h.id)).toEqual([CODEX]);
    expect(all.projects.map((p) => p.key).sort()).toEqual(['d:/work/alpha', 'd:/work/beta']);
  });

  it('reads only what a grown transcript gained, and a replaced one again', async () => {
    const ix = make();
    await ix.refresh(true);
    expect(ix.stats.fullReads).toBe(4);
    const file = join(dir, 'claude', 'projects', 'D--work-alpha', `${THEME}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'and a purple accent colour' }, sessionId: THEME, timestamp: '2026-10-19T00:00:00Z' })}\n`);
    await ix.refresh(true);
    expect(ix.stats).toMatchObject({ fullReads: 4, appendReads: 1 });
    const r = ix.search({ text: 'purple' });
    expect(r.hits.map((h) => h.id)).toEqual([THEME]);
    expect(r.hits[0].messages).toBe(3);
    // Unchanged files are not read at all.
    await ix.refresh(true);
    expect(ix.stats).toMatchObject({ fullReads: 4, appendReads: 1 });
    // A shorter file (replaced) is read from the start.
    writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'brand new' }, sessionId: THEME })}\n`);
    await ix.refresh(true);
    expect(ix.stats.fullReads).toBe(5);
    expect(ix.search({ text: 'purple' }).total).toBe(0);
    expect(ix.search({ text: 'brand new' }).total).toBe(1);
  });

  it('drops removed files, survives missing folders and keeps the index in its cache file', async () => {
    const cache = join(dir, 'data', 'conversation-index.bin');
    const ix = make(cache);
    await ix.refresh(true);
    await ix.save();
    const again = make(cache);
    await again.refresh(true);
    expect(again.stats.fullReads).toBe(0);
    expect(again.search({ text: 'rename' }).hits.map((h) => h.id)).toEqual([ALPHA]);

    rmSync(join(dir, 'codex'), { recursive: true, force: true });
    await again.refresh(true);
    expect(again.search({ text: '' }).hits.map((h) => h.cli)).toEqual(['claude', 'claude']);

    const missing = new ConvIndexer({ claudeRoots: [join(dir, 'nope')], codexRoots: [join(dir, 'nope2')], freshMs: 0 });
    await missing.refresh(true);
    expect(missing.search({ text: 'x' })).toMatchObject({ total: 0, conversations: 0 });

    writeFileSync(cache, 'garbage');
    const broken = make(cache);
    await broken.refresh(true);
    expect(broken.search({ text: 'rename' }).total).toBe(1);
  });

  it('reads the transcript preview of indexed files only, with message indexes that match the snippets', async () => {
    const ix = make();
    await ix.refresh(true);
    const file = ix.search({ text: 'regresji' }).hits[0];
    const t = await ix.transcript(file.file);
    expect(t.ok).toBe(true);
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
    expect(t.messages[file.snippets[0].index].text).toContain('regresji');
    expect((await ix.transcript(join(dir, 'elsewhere.jsonl'))).ok).toBe(false);
  });

  it('caps the text of a huge conversation', async () => {
    const big = join(dir, 'claude', 'projects', 'D--big');
    mkdirSync(big, { recursive: true });
    const line = (i: number) => JSON.stringify({ type: 'user', message: { role: 'user', content: `${i} ${'word '.repeat(2000)}` }, sessionId: 'big', cwd: 'D:\\big' });
    writeFileSync(join(big, 'big.jsonl'), Array.from({ length: 400 }, (_, i) => line(i)).join('\n') + '\n');
    const ix = make();
    await ix.refresh(true);
    const hit = ix.search({ text: '', project: normalizeFolder('D:\\big') }).hits[0];
    expect(hit.messages).toBeLessThan(400);
    expect(hit.messages).toBeGreaterThan(100);
  });
});

describe('query sanitizing and resume target', () => {
  it('keeps only known query fields', () => {
    expect(sanitizeQuery({ text: 'x'.repeat(1000), cli: 'bash', role: 'user', from: 'yesterday', to: 5, limit: 99999, evil: 1 }))
      .toEqual({ text: 'x'.repeat(400), role: 'user', to: 5, limit: 500 });
    expect(sanitizeQuery(null)).toEqual({ text: '' });
  });

  it('finds the project or worktree of a conversation folder', () => {
    const projects = [
      { id: 'p1', path: 'D:\\work\\alpha', worktrees: [{ path: 'D:\\trees\\feature', branch: 'feature/x' }] },
      { id: 'p2', path: '/Users/me/beta', worktrees: [] },
    ];
    expect(folderOwner(projects, 'd:/work/alpha/')).toEqual({ projectId: 'p1' });
    expect(folderOwner(projects, 'D:\\trees\\feature')).toEqual({ projectId: 'p1', worktree: { path: 'D:\\trees\\feature', label: 'feature/x', branch: 'feature/x' } });
    expect(folderOwner(projects, 'D:\\work\\alpha-wt-fix')).toEqual({ projectId: 'p1', worktree: { path: 'D:\\work\\alpha-wt-fix', label: 'alpha-wt-fix' } });
    expect(folderOwner(projects, '/Users/me/beta')).toEqual({ projectId: 'p2' });
    expect(folderOwner(projects, '/Users/me/gamma')).toBeNull();
    expect(folderOwner(projects, '')).toBeNull();
  });
});
