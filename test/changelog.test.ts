import { describe, expect, it } from 'vitest';
import { parseInline, parseNotes } from '../src/shared/changelog';

describe('release notes', () => {
  it('turns markdown into blocks without ever producing HTML', () => {
    const blocks = parseNotes('## Added\n\n- **Status bar** with `v0.5.5`\n- Resize cells\n  across rows\n\nSome <b>text</b>.');
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, inlines: [{ type: 'text', text: 'Added' }] });
    expect(blocks[1]).toEqual({ type: 'list', items: [
      [{ type: 'bold', text: 'Status bar' }, { type: 'text', text: ' with ' }, { type: 'code', text: 'v0.5.5' }],
      [{ type: 'text', text: 'Resize cells' }, { type: 'text', text: ' across rows' }],
    ] });
    expect(blocks[2]).toEqual({ type: 'paragraph', inlines: [{ type: 'text', text: 'Some <b>text</b>.' }] });
    expect(parseInline('plain')).toEqual([{ type: 'text', text: 'plain' }]);
  });
});

