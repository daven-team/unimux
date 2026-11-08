import { describe, expect, it } from 'vitest';
import {
  CodexThreads,
} from '../src/shared/codexHooks';
import { FailureScanner, normalizeOutput } from '../src/shared/outputFailure';

const A = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
const B = '0198aa11-2222-7333-8444-555566667777';
const C = '0198aa11-9999-7333-8444-555566667777';

describe('thread bookkeeping of Codex cells', () => {
  it('binds the first committed thread unconfirmed and confirms it when the same thread commits again', () => {
    const t = new CodexThreads();
    t.begin();
    expect(t.commit(A)).toEqual({ id: A, confirmed: false });
    expect(t.commit(A)).toEqual({ id: A, confirmed: true });
    expect(t.commit(A)).toBeNull();
  });

  it('keeps two cells of one folder apart', () => {
    const one = new CodexThreads();
    const two = new CodexThreads();
    one.begin();
    two.begin();
    expect(two.commit(B)).toEqual({ id: B, confirmed: false });
    expect(one.commit(A)).toEqual({ id: A, confirmed: false });
    expect(one.commit(A)?.confirmed).toBe(true);
    expect(two.commit(B)?.confirmed).toBe(true);
  });

  it('starts from the stored session and never rebinds it for the same thread', () => {
    const t = new CodexThreads();
    t.begin({ id: B, confirmed: true });
    expect(t.commit(B)).toBeNull();
    const unconfirmed = new CodexThreads();
    unconfirmed.begin({ id: B });
    expect(unconfirmed.commit(B)).toBeNull();
    expect(unconfirmed.commit(B)).toEqual({ id: B, confirmed: true });
  });

  it('never binds a thread seen as a sub-agent, and never marks the own thread of the cell as one', () => {
    const t = new CodexThreads();
    t.begin({ id: A, confirmed: true });
    expect(t.markSecondary(C)).toBe(true);
    expect(t.isSecondary(C)).toBe(true);
    expect(t.commit(C)).toBeNull();
    expect(t.commit(C)).toBeNull();
    expect(t.markSecondary(A)).toBe(false);
    expect(t.isSecondary(A)).toBe(false);
    const fresh = new CodexThreads();
    fresh.begin();
    fresh.markSecondary(C);
    expect(fresh.commit(C)).toBeNull();
    expect(fresh.commit(A)).toEqual({ id: A, confirmed: false });
  });

  it('follows a conversation switch (/new, /resume) only after the new thread committed twice without the old one in between', () => {
    const t = new CodexThreads();
    t.begin({ id: A, confirmed: true });
    expect(t.commit(C)).toBeNull();
    expect(t.commit(A)).toBeNull(); // the old thread reports again: the candidate starts over
    expect(t.commit(C)).toBeNull();
    expect(t.commit(C)).toEqual({ id: C, confirmed: true });
    expect(t.commit(C)).toBeNull();
  });

  it('ignores payloads without a thread', () => {
    const t = new CodexThreads();
    t.begin();
    expect(t.commit(undefined)).toBeNull();
  });

  it('uses the stored id only when it is a thread id', () => {
    const t = new CodexThreads();
    t.begin({ id: 'not-a-uuid', confirmed: true });
    expect(t.commit(A)).toEqual({ id: A, confirmed: false });
  });
});

describe('failure line of Codex output', () => {
  const line = (text: string) => `\x1b[31m■ ${text}\x1b[0m\r\n`;

  it('recognizes the usage limit however the terminal draws it', () => {
    expect(new FailureScanner().feed(line('You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.'))).toBe('usage-limit');
    expect(new FailureScanner().feed(line("You've hit your usage limit. Try again later."))).toBe('usage-limit');
    expect(new FailureScanner().feed(line('You’ve hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now.'))).toBe('usage-limit');
    expect(new FailureScanner().feed(line('Quota exceeded. Check your plan and billing details.'))).toBe('usage-limit');
    expect(new FailureScanner().feed('\x1b[5;1H\x1b[31m■\x1b[1CYou’ve\x1b[1Chit\x1b[1Cyour\x1b[1Cusage\x1b[1Climit.')).toBe('usage-limit');
    expect(new FailureScanner().feed('   \x1b[31m■ You’ve hit your usage limit.\r\n')).toBe('usage-limit'); // leading blanks are fine
  });

  it('finds a message split over several chunks and wrapped over lines, and reports it once', () => {
    const s = new FailureScanner();
    expect(s.feed('\x1b[31m■ You’ve hit your us')).toBeNull();
    expect(s.feed('age li')).toBeNull();
    expect(s.feed('mit.\r\n')).toBe('usage-limit');
    expect(s.feed('prompt >')).toBeNull();
    const wrapped = new FailureScanner();
    expect(wrapped.feed('■ You’ve hit your\r\n  usage\r\n  limit. Try again later.')).toBe('usage-limit');
    const once = new FailureScanner();
    expect(once.feed('■ You’ve hit your usage limit.')).toBe('usage-limit');
    expect(once.feed(' Try again later.\r\n')).toBeNull();
  });

  it('does not fire for a line that merely contains the text (grep results, diffs, listings, source, an answer quoting it)', () => {
    const s = new FailureScanner();
    // the reviewer's repro: an rg result line of a test file, with the literal escape text and with a real escape
    expect(s.feed("test/codex-status.test.ts:16:const LIMIT_LINE = '\\x1b[31m■ You’ve hit your usage limit. Try again later.\\x1b[0m\\r\\n';\r\n")).toBeNull();
    expect(s.feed("\x1b[35mtest/codex-status.test.ts\x1b[0m:16:const LIMIT_LINE = '\x1b[31m■ You’ve hit your usage limit.\x1b[0m';\r\n")).toBeNull();
    expect(s.feed('+  const message = "■ You’ve hit your usage limit";\r\n')).toBeNull();
    expect(s.feed('  16 │ ■ You’ve hit your usage limit.\r\n')).toBeNull();
    expect(s.feed('• The CLI prints “■ You’ve hit your usage limit” when the plan is exhausted.\r\n')).toBeNull();
    expect(s.feed('• Fixed: the line "You’ve hit your usage limit" is shown in red\r\n')).toBeNull();
    expect(s.feed("  - 'You’ve hit your usage limit' is shown in red\r\n")).toBeNull();
    expect(s.feed('■ stream disconnected before completion: Idle timeout\r\n')).toBeNull();
    expect(s.feed('')).toBeNull();
  });

  it('a bullet line that wraps into an unrelated text is not a hit', () => {
    const s = new FailureScanner();
    expect(s.feed('■ Selected model is at capacity.\r\nYou’ve hit your usage limit in another place\r\n')).toBeNull();
  });

  it('is cheap on hostile input', () => {
    const started = Date.now();
    const s = new FailureScanner();
    expect(s.feed('\x1b['.repeat(100_000) + 'x'.repeat(5_000_000))).toBeNull();
    expect(s.feed('\r\n'.repeat(200_000))).toBeNull();
    expect(normalizeOutput('a\x1b]0;title\x07 b\x1b[?25l')).toBe('ab');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
