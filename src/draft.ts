import type { Key } from '@stencil-hq/tern';

export interface Draft {
  text: string;
  cursor: number;
  anchor?: number;
}

export interface DraftKeyOptions {
  wrapWidth?: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegment = /[\p{L}\p{N}_]/u;
const spaceSegment = /\s/u;

interface GraphemeInfo {
  index: number;
  segment: string;
  width: number;
}

function segmentInfo(text: string): GraphemeInfo[] {
  const parts: GraphemeInfo[] = [];
  for (const part of graphemes.segment(text)) {
    const code = part.segment.codePointAt(0) ?? 0;
    const wide = code > 0xffff || (code >= 0x1100 && (code <= 0x115f || code >= 0x2e80));
    parts.push({ index: part.index, segment: part.segment, width: wide ? 2 : 1 });
  }
  return parts;
}

function boundaries(text: string): number[] {
  return [...graphemes.segment(text)].map(part => part.index).concat(text.length);
}

function floorOffset(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(text.length, offset));
  let result = 0;
  for (const boundary of boundaries(text)) {
    if (boundary > clamped) break;
    result = boundary;
  }
  return result;
}

function replace(draft: Draft, from: number, to: number, text: string): Draft {
  from = floorOffset(draft.text, from);
  to = floorOffset(draft.text, to);
  return {
    text: draft.text.slice(0, from) + text + draft.text.slice(to),
    cursor: from + text.length,
  };
}

/** Find the offset of the previous word boundary in the draft text. */
export function moveWordLeft(text: string, offset: number): number {
  const parts = segmentInfo(text.slice(0, floorOffset(text, offset)));
  let i = parts.length;
  while (i > 0 && spaceSegment.test(parts[i - 1]!.segment)) i--;
  if (i === 0) return 0;
  const isWord = wordSegment.test(parts[i - 1]!.segment);
  while (i > 0 && !spaceSegment.test(parts[i - 1]!.segment) && wordSegment.test(parts[i - 1]!.segment) === isWord) {
    i--;
  }
  return parts[i]?.index ?? 0;
}

/** Find the offset of the next word boundary in the draft text. */
export function moveWordRight(text: string, offset: number): number {
  const start = floorOffset(text, offset);
  const parts = segmentInfo(text);
  let i = parts.findIndex(part => part.index >= start);
  if (i < 0) return text.length;
  while (i < parts.length && spaceSegment.test(parts[i]!.segment)) i++;
  if (i >= parts.length) return text.length;
  const isWord = wordSegment.test(parts[i]!.segment);
  while (i < parts.length && !spaceSegment.test(parts[i]!.segment) && wordSegment.test(parts[i]!.segment) === isWord) {
    i++;
  }
  return i < parts.length ? parts[i]!.index : text.length;
}

function visualRows(text: string, wrapWidth?: number): Array<{ start: number; end: number }> {
  const rows: Array<{ start: number; end: number }> = [];
  const widthLimit = wrapWidth && wrapWidth >= 8 ? Math.floor(wrapWidth) : undefined;
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl < 0 ? text.length : nl;
    if (!widthLimit || lineEnd === pos) {
      rows.push({ start: pos, end: lineEnd });
    } else {
      const parts = segmentInfo(text.slice(pos, lineEnd));
      let rowStart = pos;
      let colWidth = 0;
      for (const part of parts) {
        if (colWidth > 0 && colWidth + part.width > widthLimit) {
          rows.push({ start: rowStart, end: pos + part.index });
          rowStart = pos + part.index;
          colWidth = 0;
        }
        colWidth += part.width;
      }
      rows.push({ start: rowStart, end: lineEnd });
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  return rows;
}

function rowIndexAt(rows: ReadonlyArray<{ start: number; end: number }>, cursor: number): number {
  let rowIdx = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (cursor >= row.start && cursor <= row.end) rowIdx = i;
  }
  return rowIdx;
}

/** Check whether the cursor sits on the first visual row (accounting for soft wraps). */
export function isCursorOnFirstRow(text: string, cursor: number, wrapWidth?: number): boolean {
  return rowIndexAt(visualRows(text, wrapWidth), cursor) === 0;
}

/** Check whether the cursor sits on the last visual row (accounting for soft wraps). */
export function isCursorOnLastRow(text: string, cursor: number, wrapWidth?: number): boolean {
  const rows = visualRows(text, wrapWidth);
  return rowIndexAt(rows, cursor) >= rows.length - 1;
}

function moveVertical(text: string, cursor: number, dir: -1 | 1, wrapWidth?: number): number {
  const rows = visualRows(text, wrapWidth);
  const rowIdx = rowIndexAt(rows, cursor);
  const targetIdx = rowIdx + dir;
  if (targetIdx < 0) return 0;
  if (targetIdx >= rows.length) return text.length;
  const currentRow = rows[rowIdx]!;
  const targetRow = rows[targetIdx]!;
  let targetCol = 0;
  for (const part of segmentInfo(text.slice(currentRow.start, cursor))) {
    targetCol += part.width;
  }
  let width = 0;
  for (const part of segmentInfo(text.slice(targetRow.start, targetRow.end))) {
    if (width + part.width > targetCol) return targetRow.start + part.index;
    width += part.width;
  }
  return targetRow.end;
}

/** Apply a native Tern EditEvent only when the document length still matches. */
export function editDraft(draft: Draft, edit: {
  from: number; to: number; text: string; cursor: number; len: number;
}): Draft {
  if (edit.len !== draft.text.length) return draft;
  const next = replace(draft, edit.from, edit.to, edit.text);
  return { text: next.text, cursor: floorOffset(next.text, edit.cursor) };
}

/** Apply a decoded keystroke to the draft, supporting readline/OMP cursor navigation and deletion. */
export function draftKey(draft: Draft, key: Key, options?: DraftKeyOptions): { draft: Draft; send: boolean } {
  const unchanged = { draft, send: false };
  const low = Math.min(draft.anchor ?? draft.cursor, draft.cursor);
  const high = Math.max(draft.anchor ?? draft.cursor, draft.cursor);
  const hasSelection = low !== high;
  const insert = (text: string) => ({ draft: replace(draft, low, high, text), send: false });
  const moveTo = (cursor: number, extend = key.shift) => ({
    draft: { ...draft, cursor, anchor: extend ? draft.anchor ?? draft.cursor : undefined },
    send: false,
  });

  // A paste is one insertion, even when its text includes Enter characters.
  if (key.name === 'paste') return insert((key.text ?? '').replace(/\r\n?/g, '\n'));
  if (key.name === 'enter' && !key.ctrl && !key.alt && !key.meta) {
    return key.shift ? insert('\n') : { draft, send: true };
  }

  const points = boundaries(draft.text);
  const previous = points.filter(point => point < draft.cursor).at(-1) ?? 0;
  const next = points.find(point => point > draft.cursor) ?? draft.text.length;
  const start = draft.cursor === 0 ? 0 : draft.text.lastIndexOf('\n', draft.cursor - 1) + 1;
  const endAt = draft.text.indexOf('\n', draft.cursor);
  const end = endAt < 0 ? draft.text.length : endAt;
  const delBack = () => ({ draft: replace(draft, hasSelection ? low : previous, high, ''), send: false });
  const delFwd = () => ({ draft: replace(draft, low, hasSelection ? high : next, ''), send: false });
  const delWordBack = () => ({
    draft: replace(draft, hasSelection ? low : moveWordLeft(draft.text, draft.cursor), high, ''),
    send: false,
  });
  const delWordFwd = () => ({
    draft: replace(draft, low, hasSelection ? high : moveWordRight(draft.text, draft.cursor), ''),
    send: false,
  });

  if (key.ctrl && !key.alt && !key.meta) {
    switch (key.name) {
      case 'a': return moveTo(start);
      case 'e': return moveTo(end);
      case 'b': return moveTo(!key.shift && hasSelection ? low : previous);
      case 'f': return moveTo(!key.shift && hasSelection ? high : next);
      case 'p': return moveTo(moveVertical(draft.text, draft.cursor, -1, options?.wrapWidth));
      case 'n': return moveTo(moveVertical(draft.text, draft.cursor, 1, options?.wrapWidth));
      case 'left': return moveTo(moveWordLeft(draft.text, draft.cursor));
      case 'right': return moveTo(moveWordRight(draft.text, draft.cursor));
      case 'home': return moveTo(0);
      case 'end': return moveTo(draft.text.length);
      case 'h': return delBack();
      case 'd': return delFwd();
      case 'w':
      case 'backspace': return delWordBack();
      case 'delete': return delWordFwd();
      case 'k':
        return {
          draft: replace(draft, hasSelection ? low : draft.cursor, hasSelection ? high : (draft.cursor === end && end < draft.text.length ? end + 1 : end), ''),
          send: false,
        };
      case 'u':
        return { draft: replace(draft, hasSelection ? low : start, high, ''), send: false };
      default: return unchanged;
    }
  }

  if (key.alt && !key.ctrl && !key.meta) {
    switch (key.name) {
      case 'b':
      case 'left': return moveTo(moveWordLeft(draft.text, draft.cursor));
      case 'f':
      case 'right': return moveTo(moveWordRight(draft.text, draft.cursor));
      case 'backspace': return delWordBack();
      case 'd':
      case 'delete': return delWordFwd();
      default: return unchanged;
    }
  }

  if (key.meta && !key.ctrl && !key.alt) {
    switch (key.name) {
      case 'a':
        return draft.text.length ? { draft: { text: draft.text, cursor: draft.text.length, anchor: 0 }, send: false } : unchanged;
      case 'left': return moveTo(start);
      case 'right': return moveTo(end);
      case 'up': return moveTo(0);
      case 'down': return moveTo(draft.text.length);
      case 'backspace': return { draft: replace(draft, hasSelection ? low : start, high, ''), send: false };
      default: return unchanged;
    }
  }

  if (key.ctrl || key.alt || key.meta) return unchanged;
  if (key.name === 'backspace') return delBack();
  if (key.name === 'delete') return delFwd();
  if (key.name === 'left') return moveTo(!key.shift && hasSelection ? low : previous);
  if (key.name === 'right') return moveTo(!key.shift && hasSelection ? high : next);
  if (key.name === 'home') return moveTo(start);
  if (key.name === 'end') return moveTo(end);
  if (key.name === 'up') return moveTo(moveVertical(draft.text, draft.cursor, -1, options?.wrapWidth));
  if (key.name === 'down') return moveTo(moveVertical(draft.text, draft.cursor, 1, options?.wrapWidth));
  if (key.text) return insert(key.text);
  return unchanged;
}
