import stringWidth from 'string-width';
import type {Row, SelectionRange} from './viewport.js';

export interface ContentCell {readonly column: number; readonly width: number; readonly key: string; readonly offset: number}
export interface ContentPoint {
  readonly key: string;
  readonly offset: number;
  readonly messageId: string;
  readonly line: number;
  readonly x: number;
  readonly rowIndex?: number;
}
export interface ContentSelection {readonly anchor: ContentPoint; readonly focus: ContentPoint}
const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});
const cellsCache = new WeakMap<Row, readonly ContentCell[]>();

export function railColumns(row: Row): number {return row.gutterCols > 0 ? 2 : 0;}
export function visibleText(row: Row): string {return row.displayText ?? row.text;}

export function cells(row: Row): readonly ContentCell[] {
  if (row.selectionCells?.length) return row.selectionCells;
  const cached = cellsCache.get(row);
  if (cached) return cached;
  const prefix = row.gutterCols - railColumns(row);
  if (row.sourceCells?.length) {
    const mapped = row.sourceCells.map(cell => ({column: prefix + cell.column, width: cell.width, key: row.messageId, offset: cell.start}));
    cellsCache.set(row, mapped);
    return mapped;
  }
  const result: ContentCell[] = [];
  let column = prefix, offset = row.sourceStart ?? 0;
  const key = row.sourceCells ? row.messageId + ':decoration:' + row.sourceStart : row.sourceStart !== undefined ? row.messageId : row.messageId + ':' + row.line;
  for (const {segment} of graphemes.segment(row.text)) {
    const width = segment.length === 1 && segment.charCodeAt(0) < 128 ? 1 : Math.max(1, stringWidth(segment));
    result.push({column, width, key, offset}); column += width; offset += segment.length;
  }
  cellsCache.set(row, result);
  return result;
}

export function contentPoint(rows: readonly Row[], index: number, x: number): ContentPoint {
  const clampedIndex = Math.max(0, Math.min(rows.length - 1, index));
  const row = rows[clampedIndex];
  if (!row) return {key: '', offset: 0, messageId: '', line: 0, x, rowIndex: clampedIndex};
  const column = Math.max(0, x - railColumns(row)), mapped = cells(row);
  const cell = mapped.find(cell => column >= cell.column && column < cell.column + cell.width) ??
    [...mapped].reverse().find(cell => cell.column <= column) ?? mapped[0];
  return {key: cell?.key ?? row.messageId + ':empty:' + row.line, offset: cell?.offset ?? 0, messageId: row.messageId, line: row.line, x, rowIndex: clampedIndex};
}

function locate(rows: readonly Row[], point: ContentPoint): {x: number; y: number} {
  if (!rows.length || !point.key) return {x: point.x, y: 0};

  // Empty / spacer line fast path: no cell will ever match :empty:
  if (point.key.includes(':empty:')) {
    if (point.rowIndex !== undefined && point.rowIndex >= 0 && point.rowIndex < rows.length && rows[point.rowIndex]?.messageId === point.messageId) {
      return {x: point.x, y: point.rowIndex};
    }
    const y = rows.findIndex(row => row.messageId === point.messageId && row.line >= point.line);
    return {x: point.x, y: Math.max(0, y)};
  }

  // Fast path 1: index hint matches the point's message and cell exactly
  if (point.rowIndex !== undefined && point.rowIndex >= 0 && point.rowIndex < rows.length) {
    const hintRow = rows[point.rowIndex];
    if (hintRow && hintRow.messageId === point.messageId) {
      for (const cell of cells(hintRow)) {
        if (cell.key === point.key && cell.offset === point.offset) {
          return {x: cell.column + railColumns(hintRow), y: point.rowIndex};
        }
      }
    }
  }

  // Fast path 2: narrow search to rows matching point.messageId
  let best: {x: number; y: number; distance: number} | undefined;
  if (point.messageId) {
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y]!;
      if (row.messageId === point.messageId) {
        for (const cell of cells(row)) {
          if (cell.key === point.key) {
            const distance = Math.abs(cell.offset - point.offset);
            if (!best || distance < best.distance) best = {x: cell.column + railColumns(row), y, distance};
            if (!distance) return {x: cell.column + railColumns(row), y};
          }
        }
      }
    }
    if (best) return {x: best.x, y: best.y};
  }

  // Fallback: full linear search across all rows (guarantees 100% compatibility for any cross-message keys)
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
