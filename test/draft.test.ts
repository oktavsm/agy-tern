import { describe, expect, test } from 'bun:test';
import type { Key } from '@stencil-hq/tern';
import { draftKey, editDraft, isCursorOnFirstRow, isCursorOnLastRow } from '../src/draft';

const key = (name: string, overrides: Partial<Key> = {}): Key => ({
  name, ctrl: false, alt: false, shift: false, meta: false, ...overrides,
});

describe('keyboard draft', () => {
  test('deletes and navigates whole graphemes using UTF-16 offsets', () => {
    const clusters = ['😀', 'e\u0301', '👩‍👩‍👧‍👦', '🇮🇩'];
    for (const cluster of clusters) {
      const text = `a${cluster}b`;
      const end = 1 + cluster.length;
      expect(draftKey({ text, cursor: end }, key('backspace')).draft).toEqual({ text: 'ab', cursor: 1 });
      expect(draftKey({ text, cursor: 1 }, key('delete')).draft).toEqual({ text: 'ab', cursor: 1 });
      expect(draftKey({ text, cursor: 1 }, key('right')).draft.cursor).toBe(end);
      expect(draftKey({ text, cursor: end }, key('left')).draft.cursor).toBe(1);
    }
  });

  test('pastes a multiline block without sending, then requires a separate Enter', () => {
    const pasted = draftKey({ text: 'ab', cursor: 1 }, key('paste', { text: '😀\r\nnext\rlast\n' }));
    expect(pasted.send).toBe(false);
    expect(pasted.draft).toEqual({ text: 'a😀\nnext\nlast\nb', cursor: 14 });
    const newline = draftKey(pasted.draft, key('enter', { shift: true }));
    expect(newline.send).toBe(false);
    expect(newline.draft.text).toBe('a😀\nnext\nlast\n\nb');
    expect(draftKey(newline.draft, key('enter')).send).toBe(true);
    expect(draftKey(newline.draft, key('enter', { ctrl: true })).send).toBe(false);
  });

  test('replaces a keyboard selection and handles a leading empty line', () => {
    const selected = draftKey({ text: 'a😀b', cursor: 3 }, key('left', { shift: true })).draft;
    expect(selected).toEqual({ text: 'a😀b', cursor: 1, anchor: 3 });
    expect(draftKey(selected, key('paste', { text: 'é' })).draft).toEqual({ text: 'aéb', cursor: 2 });
    expect(draftKey({ text: '\n😀x', cursor: 0 }, key('home')).draft.cursor).toBe(0);
    expect(draftKey({ text: '\n😀x', cursor: 1 }, key('up')).draft.cursor).toBe(0);
  });

  test('applies native edits only against the expected text length', () => {
    const draft = { text: 'a😀b', cursor: 3 };
    expect(editDraft(draft, { from: 1, to: 3, text: 'é', cursor: 2, len: 4 })).toEqual({ text: 'aéb', cursor: 2 });
    expect(editDraft(draft, { from: 1, to: 3, text: '', cursor: 1, len: 2 })).toBe(draft);
  });

  test('supports shell/OMP navigation (Ctrl+A/E, word jumps, kill lines, Ctrl+W, Meta+A)', () => {
    const ml = { text: 'first line\nsecond word here', cursor: 22 }; // right before "here"
    expect(draftKey(ml, key('a', { ctrl: true })).draft.cursor).toBe(11);
    expect(draftKey(ml, key('e', { ctrl: true })).draft.cursor).toBe(27);
    expect(draftKey(ml, key('home', { ctrl: true })).draft.cursor).toBe(0);
    expect(draftKey(ml, key('end', { ctrl: true })).draft.cursor).toBe(27);
    expect(draftKey(ml, key('left', { ctrl: true })).draft.cursor).toBe(18);
    expect(draftKey({ text: 'alpha beta', cursor: 0 }, key('right', { ctrl: true })).draft.cursor).toBe(5);
    expect(draftKey({ text: 'alpha beta', cursor: 0 }, key('f', { alt: true })).draft.cursor).toBe(5);
    expect(draftKey({ text: 'alpha beta', cursor: 10 }, key('b', { alt: true })).draft.cursor).toBe(6);

    expect(draftKey({ text: 'first line\nsecond word', cursor: 18 }, key('u', { ctrl: true })).draft).toEqual({
      text: 'first line\nword',
      cursor: 11,
    });
    expect(draftKey({ text: 'first line\nsecond word', cursor: 17 }, key('k', { ctrl: true })).draft).toEqual({
      text: 'first line\nsecond',
      cursor: 17,
    });
    expect(draftKey({ text: 'hello world', cursor: 11 }, key('w', { ctrl: true })).draft).toEqual({
      text: 'hello ',
      cursor: 6,
    });
    expect(draftKey({ text: 'hello world', cursor: 0 }, key('d', { alt: true })).draft).toEqual({
      text: ' world',
      cursor: 0,
    });
    expect(draftKey({ text: 'select all', cursor: 3 }, key('a', { meta: true })).draft).toEqual({
      text: 'select all',
      cursor: 10,
      anchor: 0,
    });
  });

  test('navigates up and down across both newlines and soft-wrapped long lines', () => {
    const wrapped = { text: 'abcdefghij0123456789xyz', cursor: 13 };
    const up = draftKey(wrapped, key('up'), { wrapWidth: 10 });
    expect(up.draft.cursor).toBe(3);
    const down = draftKey(up.draft, key('down'), { wrapWidth: 10 });
    expect(down.draft.cursor).toBe(13);

    const pUp = draftKey({ text: 'line one\nline two', cursor: 13 }, key('p', { ctrl: true }));
    expect(pUp.draft.cursor).toBe(4);
    const nDown = draftKey(pUp.draft, key('n', { ctrl: true }));
    expect(nDown.draft.cursor).toBe(13);

    expect(isCursorOnFirstRow('line one\nline two', 4)).toBe(true);
    expect(isCursorOnLastRow('line one\nline two', 4)).toBe(false);
    expect(isCursorOnFirstRow('line one\nline two', 13)).toBe(false);
    expect(isCursorOnLastRow('line one\nline two', 13)).toBe(true);
    expect(isCursorOnFirstRow('abcdefghij0123456789', 15, 10)).toBe(false);
    expect(isCursorOnLastRow('abcdefghij0123456789', 15, 10)).toBe(true);
  });
});
