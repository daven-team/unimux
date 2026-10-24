import { describe, expect, it } from 'vitest';
import {
  captureSourceLine, codeLineFlags, exportFileName, foldText, hitRanges, isImportableNoteFile, isNoteImageName, noteExcerpt, noteFromFile, noteFromTemplate,
  noteImageMarkdown, noteImageName, noteImageNames, noteMatches, noteTags, noteTasks, noteWordCount, normalizeNoteSort, parseNoteQuery, plainLine,
  sortNotes, splitTags, tagCounts, taskProgress, toggleTask, toggleTaskLine, type NoteTemplateWords,
} from '../src/shared/noteTools';
import { normalizeNotes } from '../src/shared/notes';
import type { Note } from '../src/shared/types';

const note = (id: string, extra: Partial<Note> = {}): Note => ({ id, name: id, text: '', updatedAt: 1, ...extra });

describe('note tags', () => {
  it('reads #tags outside code, lowercased and once each', () => {
    const text = '# Heading\nPlan for #Work and #ideas/later, see #42.\n`#notatag` (#work) #ŻÓŁW\n```\n#code\n```\nurl http://x.io/#anchor #a-b- #x';
    expect(noteTags(text)).toEqual(['work', 'ideas/later', 'żółw', 'a-b', 'x']);
    expect(noteTags('#'.repeat(3) + ' title')).toEqual([]);
    expect(noteTags(`#${'a'.repeat(41)} #ok`)).toEqual(['ok']);
  });

  it('cuts a line at its tags for the preview', () => {
    expect(splitTags('Fix #Login-bug now, not #42 (#ops)')).toEqual(['Fix ', { tag: 'login-bug', raw: '#Login-bug' }, ' now, not #42 (', { tag: 'ops', raw: '#ops' }, ')']);
    expect(splitTags('no tags here')).toEqual(['no tags here']);
  });

  it('counts tags over notes, the most used first', () => {
    expect(tagCounts([{ name: 'x', text: '#b #a' }, { name: 'y #a', text: '' }, { name: 'z', text: '#c #b #a' }])).toEqual([
      { tag: 'a', count: 3 }, { tag: 'b', count: 2 }, { tag: 'c', count: 1 },
    ]);
  });

  it('marks fenced code lines, an unclosed fence running to the end', () => {
    expect(codeLineFlags(['a', '```ts', 'x', '```', 'b', '  ~~~', 'y'])).toEqual([false, true, true, true, false, true, true]);
    expect(codeLineFlags(['````', '```', 'still code', '````', 'out'])).toEqual([true, true, true, true, false]);
  });
});

describe('note checklists', () => {
  const text = '# List\r\n- [ ] one\n- [x] two\n  * [X] nested\n1. [ ] numbered\n> - [ ] quoted\n- [ ]\n- [ ] \n```\n- [ ] code\n```\n- [] no';

  it('finds the tasks the preview shows as checkboxes', () => {
    const tasks = noteTasks(text);
    expect(tasks.map((t) => [t.line, t.checked, t.text])).toEqual([
      [1, false, 'one'], [2, true, 'two'], [3, true, 'nested'], [4, false, 'numbered'], [5, false, 'quoted'], [6, false, ''], [7, false, ''],
    ]);
    for (const t of tasks) expect(text[t.at - 1] + text[t.at + 1]).toBe('[]');
    expect(taskProgress(text)).toEqual({ done: 2, total: 5 });
    expect(taskProgress('no tasks')).toEqual({ done: 0, total: 0 });
  });

  it('ticks and unticks one task by its index', () => {
    const once = toggleTask(text, 0);
    expect(once).toContain('- [x] one');
    expect(toggleTask(once, 0)).toBe(text);
    expect(toggleTask(text, 2)).toContain('  * [ ] nested');
    expect(toggleTask(text, 1, true)).toBe(text);
    expect(toggleTask(text, 99)).toBe(text);
    // \r\n line ends keep the offsets right.
    expect(toggleTask('a\r\n- [ ] b\r\n- [ ] c', 1)).toBe('a\r\n- [ ] b\r\n- [x] c');
  });

  it('turns a line into a task or flips it (Ctrl+Enter in the editor)', () => {
    expect(toggleTaskLine('- [ ] buy milk')).toBe('- [x] buy milk');
    expect(toggleTaskLine('  1. [x] done')).toBe('  1. [ ] done');
    expect(toggleTaskLine('- [ ]')).toBe('- [x]');
    expect(toggleTaskLine('* item')).toBe('* [ ] item');
    expect(toggleTaskLine('> - quoted')).toBe('> - [ ] quoted');
    expect(toggleTaskLine('   plain text')).toBe('   - [ ] plain text');
    expect(toggleTaskLine('')).toBe('- [ ] ');
  });
});

describe('note search', () => {
  it('folds case and accents without changing offsets', () => {
    expect(foldText('Zażółć GĘŚLĄ jaźń')).toBe('zazolc gesla jazn');
    expect(foldText('Straße İ')).toHaveLength('Straße İ'.length);
  });

  it('parses words and #tags', () => {
    expect(parseNoteQuery('  Łódź #Work deploy #work # ')).toEqual({ terms: ['lodz', 'deploy'], tags: ['work'] });
  });

  it('matches names and texts by every word and tag', () => {
    const n = { name: 'Wdrożenie', text: 'Kroki dla #prod/eu i #ops' };
    expect(noteMatches(n, parseNoteQuery('wdrozenie kroki'))).toBe(true);
    expect(noteMatches(n, parseNoteQuery('wdrozenie brak'))).toBe(false);
    expect(noteMatches(n, parseNoteQuery('#prod'))).toBe(true);
    expect(noteMatches(n, parseNoteQuery('#ops #prod/eu'))).toBe(true);
    expect(noteMatches(n, parseNoteQuery('#pro'))).toBe(false);
    expect(noteMatches(n, parseNoteQuery(''))).toBe(true);
  });

  it('finds the ranges of hits, merged', () => {
    expect(hitRanges('Ala ma kota, kot ma Alą', ['ala', 'kot', 'ot'])).toEqual([[0, 3], [7, 10], [13, 16], [20, 23]]);
    expect(hitRanges('abc', [])).toEqual([]);
  });
});

describe('note excerpts', () => {
  it('shows Markdown lines as plain text', () => {
    expect(plainLine('## **Bold** title')).toBe('Bold title');
    expect(plainLine('_Build · 09:05_ and *this* but not snake_case_name')).toBe('Build · 09:05 and this but not snake_case_name');
    expect(plainLine('- [x] see [docs](https://x.io) and `code`')).toBe('see docs and code');
    expect(plainLine('> ![shot](note-images/a.png) caption')).toBe('caption');
  });

  it('skips blank lines, fences and headings, and shows the line of a hit further down', () => {
    const text = '# Title\n\n```sh\nnpm test\n```\nsecond\nthird\nfourth has the needle somewhere';
    // Headings are skipped while there is anything else.
    expect(noteExcerpt(text)).toBe('npm test\nsecond');
    expect(noteExcerpt('# Only a heading')).toBe('Only a heading');
    expect(noteExcerpt(text, ['second'])).toBe('npm test\nsecond');
    expect(noteExcerpt(text, ['needle'])).toBe('fourth has the needle somewhere');
    const long = `${'x'.repeat(60)} needle`;
    expect(noteExcerpt(`a\nb\n${long}`, ['needle']).startsWith('…')).toBe(true);
  });
});

describe('note order', () => {
  const notes = [note('b', { name: 'beta', updatedAt: 5 }), note('a', { name: 'Alpha', updatedAt: 9 }), note('u', { name: ' ', updatedAt: 1 }), note('p', { name: 'zeta', pinned: true, updatedAt: 0 }), note('c', { name: 'alpha 10', updatedAt: 9 }), note('d', { name: 'alpha 9', updatedAt: 3 })];
  const ids = (list: Note[]) => list.map((n) => n.id);

  it('keeps pinned notes first in every order', () => {
    expect(ids(sortNotes(notes, 'manual'))).toEqual(['p', 'b', 'a', 'u', 'c', 'd']);
    expect(ids(sortNotes(notes, 'recent'))).toEqual(['p', 'a', 'c', 'b', 'd', 'u']);
    expect(ids(sortNotes(notes, 'name'))).toEqual(['p', 'a', 'd', 'c', 'b', 'u']);
  });

  it('reads a saved order choice', () => {
    expect(normalizeNoteSort('recent')).toBe('recent');
    expect(normalizeNoteSort('x')).toBe('manual');
    expect(normalizeNoteSort(undefined)).toBe('manual');
  });

  it('keeps the pin through a load and drops anything else', () => {
    expect(normalizeNotes([{ id: 'a', name: 'a', pinned: true }, { id: 'b', name: 'b', pinned: 'yes' }]).map((n) => n.pinned)).toEqual([true, undefined]);
  });
});

describe('note templates', () => {
  const words: NoteTemplateWords = { daily: 'Daily', goals: 'Goals', notes: 'Notes', meeting: 'Meeting', date: 'Date', attendees: 'Attendees', agenda: 'Agenda', actions: 'Action items', checklist: 'Checklist' };
  const date = new Date(2026, 9, 24, 9, 5);

  it('writes a daily note with the date and a first task', () => {
    const daily = noteFromTemplate('daily', words, date, 'en-US');
    expect(daily.name).toBe('Daily 2026-10-24');
    expect(daily.text).toContain('Saturday, October 24, 2026');
    expect(daily.text).toContain('## Goals\n- [ ] ');
    expect(daily.text.slice(0, daily.cursor).endsWith('## Goals\n- [ ] ')).toBe(true);
  });

  it('writes a meeting note and a checklist', () => {
    const meeting = noteFromTemplate('meeting', words, date);
    expect(meeting.name).toBe('Meeting 2026-10-24');
    expect(meeting.text).toContain('**Date:** 2026-10-24 09:05');
    expect(meeting.text).toContain('## Action items\n- [ ] ');
    expect(meeting.text.slice(0, meeting.cursor).endsWith('**Attendees:** ')).toBe(true);
    expect(noteFromTemplate('checklist', words, date)).toEqual({ name: 'Checklist', text: '# Checklist\n\n- [ ] ', cursor: 19 });
  });
});

describe('note import and export', () => {
  it('takes Markdown and text files', () => {
    expect(isImportableNoteFile('a.MD')).toBe(true);
    expect(isImportableNoteFile('notes.txt')).toBe(true);
    expect(isImportableNoteFile('photo.png')).toBe(false);
    expect(noteFromFile('C:\\docs\\Plan Q4.md', '\uFEFF# Plan\r\nline')).toEqual({ name: 'Plan Q4', text: '# Plan\nline' });
    expect(noteFromFile('todo.txt', 'x')).toEqual({ name: 'todo', text: 'x', language: 'text' });
    expect(noteFromFile('.md', '')).toEqual({ name: '.md', text: '' });
  });

  it('names an exported file safely with the extension of its language', () => {
    expect(exportFileName('Plan: Q4/Q1?', undefined)).toBe('Plan- Q4-Q1-.md');
    expect(exportFileName('  ..  ', 'markdown')).toBe('note.md');
    expect(exportFileName('deploy', 'shell')).toBe('deploy.sh');
    expect(exportFileName('CON', 'text')).toBe('CON-note.txt');
  });
});

describe('note images', () => {
  const name = '0f8fad5b-d9cb-469f-a165-70867728950e.png';

  it('accepts only image names the app gives', () => {
    expect(isNoteImageName(name)).toBe(true);
    expect(isNoteImageName('../evil.png')).toBe(false);
    expect(isNoteImageName(name.replace('.png', '.svg'))).toBe(false);
    expect(noteImageName(`note-images/${name}`)).toBe(name);
    expect(noteImageName(`note-images/../${name}`)).toBeNull();
    expect(noteImageName('https://x.io/a.png')).toBeNull();
  });

  it('links an image and lists the linked ones', () => {
    expect(noteImageMarkdown(name, 'a [b]')).toBe(`![a b](note-images/${name})`);
    expect(noteImageNames(`${noteImageMarkdown(name)} and again note-images/${name}`)).toEqual([name]);
  });
});

describe('note word count', () => {
  it('does not count task boxes, so ticking a task keeps the count', () => {
    const open = '# Lista zadań\n\n- [ ] Kupić mleko #zakupy\n- [ ] Zrobić review #praca\n- [ ] Trzecie zadanie';
    expect(noteWordCount(open)).toBe(10);
    expect(noteWordCount(open.replace('- [ ] Trzecie', '- [x] Trzecie'))).toBe(10);
    expect(noteWordCount('1. [X] done\n> - [x] quoted')).toBe(2);
  });

  it('counts what a reader sees: link texts, not targets, images or fences', () => {
    expect(noteWordCount('See [the docs](https://example.com/a-b) and ![image](note-images/x.png).')).toBe(4);
    expect(noteWordCount('[ref]: https://example.com/page\nText [here][ref]')).toBe(2);
    expect(noteWordCount('```bash\nnpm run build\n```')).toBe(3);
    expect(noteWordCount('**bold** _it_ `code`')).toBe(3);
  });

  it('counts every word of a code note', () => {
    expect(noteWordCount('- [x] a', false)).toBe(2);
  });
});

describe('capture source line', () => {
  const at = new Date(2026, 9, 24, 3, 36);
  it('names the cell and its grid', () => {
    expect(captureSourceLine({ cell: 'Budowanie', grid: 'Siatka 2x2' }, at)).toBe('_Budowanie · Siatka 2x2 · 2026-10-24 03:36_');
  });
  it('keeps the italics whole and skips missing parts', () => {
    expect(captureSourceLine({ cell: 'my_cell*', grid: '' }, at)).toBe('_my cell · 2026-10-24 03:36_');
    expect(captureSourceLine(null, at)).toBe('_2026-10-24 03:36_');
  });
});
