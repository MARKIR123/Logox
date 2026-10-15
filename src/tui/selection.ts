import stringWidth from 'string-width';
import type {Row, SelectionRange} from './viewport.js';

export interface ContentCell {readonly column: number; readonly width: number; readonly key: string; readonly offset: number}
export interface ContentPoint {readonly key: string; readonly offset: number; readonly messageId: string; readonly line: number; readonly x: number}
export interface ContentSelection {readonly anchor: ContentPoint; readonly focus: ContentPoint}
const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});

export function railColumns(row: Row): number {return row.gutterCols > 0 ? 2 : 0;}
export function visibleText(row: Row): string {return row.displayText ?? row.text;}
function cells(row: Row): readonly ContentCell[] {
  if (row.selectionCells?.length) return row.selectionCells;
  const prefix = row.gutterCols - railColumns(row);
  if (row.sourceCells?.length) return row.sourceCells.map(cell => ({column: prefix + cell.column, width: cell.width, key: row.messageId, offset: cell.start}));
  const result: ContentCell[] = [];
  let column = prefix, offset = row.sourceStart ?? 0;
  const key = row.sourceCells ? row.messageId + ':decoration:' + row.sourceStart : row.sourceStart !== undefined ? row.messageId : row.messageId + ':' + row.line;
  for (const {segment} of graphemes.segment(row.text)) {
    const width = Math.max(1, stringWidth(segment));
    result.push({column, width, key, offset}); column += width; offset += segment.length;
  }
  return result;
}
export function contentPoint(rows: readonly Row[], index: number, x: number): ContentPoint {
  const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
  if (!row) return {key: '', offset: 0, messageId: '', line: 0, x};
  const column = Math.max(0, x - railColumns(row)), mapped = cells(row);
  const cell = mapped.find(cell => column >= cell.column && column < cell.column + cell.width) ??
    [...mapped].reverse().find(cell => cell.column <= column) ?? mapped[0];
  return {key: cell?.key ?? row.messageId + ':empty:' + row.line, offset: cell?.offset ?? 0, messageId: row.messageId, line: row.line, x};
}
function locate(rows: readonly Row[], point: ContentPoint): {x: number; y: number} {
  let best: {x: number; y: number; distance: number} | undefined;
  for (const [y, row] of rows.entries()) for (const cell of cells(row)) if (cell.key === point.key) {
    const distance = Math.abs(cell.offset - point.offset);
    if (!best || distance < best.distance) best = {x: cell.column + railColumns(row), y, distance};
    if (!distance) return {x: cell.column + railColumns(row), y};
  }
  if (best) return {x: best.x, y: best.y};
  const y = rows.findIndex(row => row.messageId === point.messageId && row.line >= point.line);
  return {x: point.x, y: Math.max(0, y)};
}
export function selectionRange(rows: readonly Row[], selection: ContentSelection | null): SelectionRange | null {
  return selection ? {anchor: locate(rows, selection.anchor), focus: locate(rows, selection.focus)} : null;
}
export function selectionInViewport(selection: SelectionRange | null, start: number): SelectionRange | null {
  return selection ? {anchor: {...selection.anchor, y: selection.anchor.y - start}, focus: {...selection.focus, y: selection.focus.y - start}} : null;
}
