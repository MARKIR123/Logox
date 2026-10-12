import stringWidth from 'string-width';

export interface Draft {readonly text: string; readonly cursor: number; readonly preferredColumn?: number}
export interface InputLine {readonly text: string; readonly start: number; readonly end: number}
export interface InputLayout {readonly lines: readonly InputLine[]; readonly cursorRow: number; readonly cursorColumn: number}
const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});
export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map(part => part.segment);
}
export const emptyDraft: Draft = {text: '', cursor: 0};
export function insert(draft: Draft, text: string): Draft {
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  const parts = graphemes(draft.text);
  const prefix = parts.slice(0, draft.cursor).join('') + text;
  parts.splice(draft.cursor, 0, text);
  return {text: parts.join(''), cursor: graphemes(prefix).length};
}
export function move(draft: Draft, amount: number): Draft {
  return {text: draft.text, cursor: Math.max(0, Math.min(graphemes(draft.text).length, draft.cursor + amount))};
}
export function erase(draft: Draft, backward: boolean): Draft {
  const parts = graphemes(draft.text);
  const index = backward ? draft.cursor - 1 : draft.cursor;
  if (index < 0 || index >= parts.length) return draft;
  parts.splice(index, 1);
  return {text: parts.join(''), cursor: backward ? draft.cursor - 1 : draft.cursor};
}

// Display rows retain source grapheme indices. Soft wraps never change the draft.
export function layoutInput(draft: Draft, columns: number): InputLayout {
  const width = Math.max(1, columns);
  const parts = graphemes(draft.text);
  const lines: InputLine[] = [];
  let start = 0;
  let text = '';
  let used = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === '\n') {
      lines.push({text, start, end: index});
      start = index + 1; text = ''; used = 0;
      continue;
    }
    const size = stringWidth(part);
    if (used > 0 && used + size > width) {
      lines.push({text, start, end: index});
      start = index; text = ''; used = 0;
    }
    text += part; used += size;
  }
  lines.push({text, start, end: parts.length});
  const cursor = Math.max(0, Math.min(parts.length, draft.cursor));
  let cursorRow = 0;
  for (let row = 0; row < lines.length; row++) {
    if (cursor >= lines[row]!.start) cursorRow = row;
  }
  const line = lines[cursorRow]!;
  const cursorColumn = stringWidth(parts.slice(line.start, cursor).join(''));
  return {lines, cursorRow, cursorColumn};
}

export function inputViewport(layout: InputLayout, height: number, previousStart = 0): {start: number; lines: readonly InputLine[]} {
  height = Math.max(1, height);
  let start = Math.max(0, Math.min(previousStart, layout.lines.length - height));
  if (layout.cursorRow < start) start = layout.cursorRow;
  if (layout.cursorRow >= start + height) start = layout.cursorRow - height + 1;
  return {start, lines: layout.lines.slice(start, start + height)};
}

export function cursorAt(layout: InputLayout, row: number, column: number): number {
  const line = layout.lines[Math.max(0, Math.min(layout.lines.length - 1, row))]!;
  let used = 0;
  let index = line.start;
  for (const part of graphemes(line.text)) {
    if (used + stringWidth(part) > column) break;
    used += stringWidth(part); index++;
  }
  // The end of a soft-wrapped row belongs to the next row.
  const next = layout.lines[row + 1];
  return next?.start === line.end ? Math.min(index, Math.max(line.start, line.end - 1)) : index;
}

export function moveVertical(draft: Draft, direction: -1 | 1, columns: number): Draft {
  const layout = layoutInput(draft, columns);
  const target = Math.max(0, Math.min(layout.lines.length - 1, layout.cursorRow + direction));
  if (target === layout.cursorRow) return draft;
  const preferredColumn = draft.preferredColumn ?? layout.cursorColumn;
  return {text: draft.text, cursor: cursorAt(layout, target, preferredColumn), preferredColumn};
}

export function moveToLineEdge(draft: Draft, end: boolean, columns: number): Draft {
  const layout = layoutInput(draft, columns);
  const row = layout.lines[layout.cursorRow]!;
  return {text: draft.text, cursor: end ? cursorAt(layout, layout.cursorRow, Infinity) : row.start};
}

