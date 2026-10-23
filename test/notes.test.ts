import { describe, expect, it } from 'vitest';
import { NOTE_LIMITS, normalizeNotes, notePreview, parseRightPanelOrder, rightPanelOrder } from '../src/shared/notes';
import { defaultState, editNote, moveNote, normalizeState, removeNote, upsertNote } from '../src/shared/state';
import type { Note } from '../src/shared/types';

const note = (id: string, extra: Partial<Note> = {}): Note => ({ id, name: id, text: `text ${id}`, updatedAt: 1, ...extra });

describe('notes in the saved state', () => {
  it('starts with no notes and the panel closed, also for files from before notes', () => {
    expect(defaultState().notes).toEqual([]);
    expect(defaultState().notesOpen).toBe(false);
    const { notes: _notes, notesOpen: _open, ...old } = defaultState();
    const loaded = normalizeState(JSON.parse(JSON.stringify(old)))!;
    expect(loaded.notes).toEqual([]);
    expect(loaded.notesOpen).toBe(false);
    expect(normalizeState({ ...defaultState(), notesOpen: true })!.notesOpen).toBe(true);
    expect(normalizeState({ ...defaultState(), notesOpen: 'yes' })!.notesOpen).toBe(false);
  });

  it('keeps good notes and drops or repairs damaged ones', () => {
    const raw = [
      note('a', { projectId: 'p1', color: '#3b82f6' }),
      null, 'text', [], { name: 'no id' }, { id: '', text: 'x' }, { id: 'n', updatedAt: 5 },
      { id: 'a', name: 'repeated id', text: '' },
      { id: 'b', text: 'only text', color: 'red', projectId: 7, updatedAt: -3, extra: true },
      { id: 'c', name: 'only name', updatedAt: Number.NaN },
      { id: 'x'.repeat(NOTE_LIMITS.id + 1), text: 'long id' },
    ];
    expect(normalizeNotes(raw)).toEqual([
      note('a', { projectId: 'p1', color: '#3b82f6' }),
      { id: 'b', name: '', text: 'only text', updatedAt: 0 },
      { id: 'c', name: 'only name', text: '', updatedAt: 0 },
    ]);
    expect(normalizeNotes('nope')).toEqual([]);
    expect(normalizeState({ ...defaultState(), notes: raw })!.notes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('caps the name, the text and the number of notes', () => {
    const [big] = normalizeNotes([{ id: 'big', name: 'n'.repeat(500), text: 't'.repeat(NOTE_LIMITS.text + 10), updatedAt: 2 }]);
    expect(big.name).toHaveLength(NOTE_LIMITS.name);
    expect(big.text).toHaveLength(NOTE_LIMITS.text);
    const many = Array.from({ length: NOTE_LIMITS.count + 20 }, (_, i) => note(`n${i}`));
    expect(normalizeNotes(many)).toHaveLength(NOTE_LIMITS.count);
  });
});

describe('note helpers', () => {
  const base = { ...defaultState(), notes: [note('a'), note('b'), note('c')] };

  it('adds, replaces in place, moves and removes notes', () => {
    const added = upsertNote(base, note('d'));
    expect(added.notes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(upsertNote(added, note('b', { name: 'B' })).notes.map((n) => n.name)).toEqual(['a', 'B', 'c', 'd']);
    expect(moveNote(base, 'c', 'a', 'before').notes.map((n) => n.id)).toEqual(['c', 'a', 'b']);
    expect(moveNote(base, 'a', null).notes.map((n) => n.id)).toEqual(['b', 'c', 'a']);
    expect(moveNote(base, 'a', 'a')).toBe(base);
    expect(removeNote(base, 'b').notes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(base.notes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('edits the name and text with a new time, and writes nothing when nothing changed', () => {
    const edited = editNote(base, 'b', { text: 'new text' }, 99);
    expect(edited.notes[1]).toEqual({ ...note('b'), text: 'new text', updatedAt: 99 });
    expect(editNote(edited, 'b', { name: 'b', text: 'new text' }, 100)).toBe(edited);
    expect(editNote(base, 'missing', { text: 'x' })).toBe(base);
    expect(editNote(base, 'a', { name: 'x'.repeat(300) }, 5).notes[0].name).toHaveLength(NOTE_LIMITS.name);
  });

  it('previews the first non-empty lines', () => {
    expect(notePreview('\n  first  \n\nsecond\nthird')).toBe('first\nsecond');
    expect(notePreview('one\r\ntwo', 1)).toBe('one');
    expect(notePreview('   \n')).toBe('');
  });
});

describe('the right column order', () => {
  const open = (snippets: boolean, notes: boolean) => ({ snippets, notes });

  it('puts a newly opened panel below the one already open', () => {
    let order = rightPanelOrder([], open(false, true));
    expect(order).toEqual(['notes']);
    order = rightPanelOrder(order, open(true, true));
    expect(order).toEqual(['notes', 'snippets']);
    // Closing the top one lets the other fill the column; opening it again puts it at the bottom.
    order = rightPanelOrder(order, open(false, true));
    expect(order).toEqual(['notes']);
    order = rightPanelOrder(order, open(true, true));
    expect(order).toEqual(['notes', 'snippets']);
    order = rightPanelOrder(order, open(true, false));
    expect(order).toEqual(['snippets']);
    order = rightPanelOrder(order, open(true, true));
    expect(order).toEqual(['snippets', 'notes']);
    expect(rightPanelOrder(order, open(false, false))).toEqual([]);
  });

  it('starts with the snippets on top when both are open and keeps the same array when nothing changed', () => {
    expect(rightPanelOrder([], open(true, true))).toEqual(['snippets', 'notes']);
    const order = rightPanelOrder([], open(true, false));
    expect(rightPanelOrder(order, open(true, false))).toBe(order);
    expect(rightPanelOrder(['notes', 'notes'], open(true, true))).toEqual(['notes', 'snippets']);
  });
});

describe('parseRightPanelOrder', () => {
  it('reads a saved order and keeps it while both panels stay open', () => {
    const saved = parseRightPanelOrder('["notes","snippets"]');
    expect(saved).toEqual(['notes', 'snippets']);
    expect(rightPanelOrder(saved, { snippets: true, notes: true })).toBe(saved);
  });

  it('drops unknown or repeated entries and broken values', () => {
    expect(parseRightPanelOrder('["notes","x","notes",3]')).toEqual(['notes']);
    expect(parseRightPanelOrder('{"a":1}')).toEqual([]);
    expect(parseRightPanelOrder('not json')).toEqual([]);
    expect(parseRightPanelOrder(null)).toEqual([]);
  });
});