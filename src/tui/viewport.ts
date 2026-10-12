import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type {Message} from '../runtime/contracts.js';
import {ownerColor, ownerHeader, palette, safeText} from './cards.js';
import type {SourceCell} from './markdown.js';

export interface Row {
  readonly messageId: string;
  readonly line: number;
  readonly text: string;
  readonly railColor: string;
  readonly gutterCols: number;
  readonly softWrap: boolean;
  readonly noSelect: boolean;
  readonly tone: 'header' | 'direction' | 'body' | 'spacer';
  readonly sourceText?: string;
  readonly sourceStart?: number;
  readonly sourceEnd?: number;
  readonly sourceCells?: readonly SourceCell[];
}
export interface Anchor {readonly messageId: string; readonly line: number; readonly sourceOffset?: number; readonly screenOffset?: number}
export interface SelectionPoint {readonly x: number; readonly y: number}
export interface SelectionRange {readonly anchor: SelectionPoint; readonly focus: SelectionPoint}
export interface SgrMouseEvent {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly action: 'press' | 'move' | 'drag' | 'release' | 'wheel_up' | 'wheel_down';
}

const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});
const cache = new WeakMap<Message, Map<number, readonly Row[]>>();

export function timelineRows(messages: readonly Message[], width: number): readonly Row[] {
  width = Math.max(1, width);
  return messages.flatMap(message => {
    let widths = cache.get(message);
    if (!widths) { widths = new Map(); cache.set(message, widths); }
    const known = widths.get(width);
    if (known) return [...known];
    const gutterCols = width >= 6 ? 2 : 0;
    const contentWidth = Math.max(1, width - gutterCols);
    const railColor = message.role === 'user' ? palette.user : ownerColor(message.ownerId);
    const roleLabel = message.role === 'user' ? '收到任务' : message.role === 'assistant' ? '台词' : '记录';
    const headerText = safeText(`${ownerHeader(message.ownerId)} · ${roleLabel}`);
    const headerLines = wrapAnsi(headerText, contentWidth, {hard: true, trim: false}).split('\n');
    const built: Row[] = [];
    for (let i = 0; i < headerLines.length; ++i) {
      built.push({
        messageId: message.id,
        line: built.length,
        text: headerLines[i]!,
        railColor,
        gutterCols,
        softWrap: i < headerLines.length - 1,
        noSelect: true,
        tone: 'header',
      });
    }
    const logicalLines = safeText(message.text).split('\n');
    for (const logical of logicalLines) {
      const trimmed = logical.trim();
      const tone: Row['tone'] = /^（[\s\S]*）$/.test(trimmed) ? 'direction' : 'body';
      const segments = wrapAnsi(logical, contentWidth, {hard: true, trim: false}).split('\n');
      for (let i = 0; i < segments.length; ++i) {
        built.push({
          messageId: message.id,
          line: built.length,
          text: segments[i]!,
          railColor,
          gutterCols,
          softWrap: i < segments.length - 1,
          noSelect: false,
          tone,
        });
      }
    }
    built.push({
      messageId: message.id,
      line: built.length,
      text: '',
      railColor: '',
      gutterCols: 0,
      softWrap: false,
      noSelect: true,
      tone: 'spacer',
    });
    widths.set(width, built);
    return built;
  });
}

export function viewport(rows: readonly Row[], height: number, anchor: Anchor | null): {rows: readonly Row[]; start: number; following: boolean} {
  height = Math.max(0, height);
  const maxStart = Math.max(0, rows.length - height);
  let start = maxStart;
  if (anchor) {
    if (anchor.messageId === '__top__') {
      start = Math.min(maxStart, Math.max(0, anchor.line));
    } else {
      const index = rows.findIndex(row => row.messageId === anchor.messageId && (anchor.sourceOffset !== undefined && row.sourceEnd !== undefined
        ? row.sourceEnd > anchor.sourceOffset || row.sourceStart === anchor.sourceOffset
        : row.line >= anchor.line));
      const last = rows.findLastIndex(row => row.messageId === anchor.messageId);
      if (index >= 0 || last >= 0) start = Math.max(0, Math.min(maxStart, (index >= 0 ? index : last) - (anchor.screenOffset ?? 0)));
    }
  }
  return {rows: rows.slice(start, start + height), start, following: anchor === null};
}

export function clipLine(text: string, width: number): string {
  let result = '';
  for (const part of segmenter.segment(safeText(text))) {
    if (stringWidth(result + part.segment) > width) break;
    result += part.segment;
  }
  return result;
}

export function normalizeSelection(selection: SelectionRange): {start: SelectionPoint; end: SelectionPoint} {
  const {anchor, focus} = selection;
  if (anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)) {
    return {start: anchor, end: focus};
  }
  return {start: focus, end: anchor};
}

export function sliceRowText(text: string, startCol: number, endCol: number): {before: string; selected: string; after: string} {
  let col = 0;
  let before = '';
  let selected = '';
  let after = '';
  for (const {segment} of segmenter.segment(safeText(text))) {
    const w = Math.max(1, stringWidth(segment));
    if (col + w <= startCol) before += segment;
    else if (col >= endCol) after += segment;
    else selected += segment;
    col += w;
  }
  return {before, selected, after};
}

export function rowSelectionBounds(row: Row, rowIndex: number, selection: SelectionRange | null): [number, number] | null {
  if (!selection || row.noSelect) return null;
  const {start, end} = normalizeSelection(selection);
  if (start.x === end.x && start.y === end.y) return null;
  if (rowIndex < start.y || rowIndex > end.y) return null;
  const rawStart = rowIndex === start.y ? start.x : 0;
  const rawEnd = rowIndex === end.y ? end.x + 1 : Infinity;
  const startCol = Math.max(0, rawStart - row.gutterCols);
  const endCol = Math.max(0, rawEnd - row.gutterCols);
  return endCol > startCol ? [startCol, endCol] : null;
}

export function extractSelection(rows: readonly Row[], selection: SelectionRange | null): string {
  if (!selection) return '';
  const {start, end} = normalizeSelection(selection);
  if (start.x === end.x && start.y === end.y) return '';
  let result = '';
  let hasPiece = false;
  let prevRowIndex = -2;
  let prevSoftWrap = false;
  const firstY = Math.max(0, start.y);
  const lastY = Math.min(rows.length - 1, end.y);
  for (let y = firstY; y <= lastY; ++y) {
    const row = rows[y];
    if (!row) continue;
    const bounds = rowSelectionBounds(row, y, selection);
    if (!bounds) continue;
    const cells = row.sourceCells?.filter(cell => cell.column < bounds[1] && cell.column + cell.width > bounds[0]);
    const selected = row.sourceText !== undefined && cells?.length
      ? row.sourceText.slice(cells[0]!.start, cells.at(-1)!.end)
      : row.sourceText !== undefined && !row.text ? row.sourceText.slice(row.sourceStart, row.sourceEnd)
      : sliceRowText(row.text, bounds[0], bounds[1]).selected;
    if (!hasPiece) {
      result = selected;
      hasPiece = true;
    } else if (prevSoftWrap && prevRowIndex === y - 1) {
      result += selected;
    } else {
      result += '\n' + selected;
    }
    prevRowIndex = y;
    prevSoftWrap = row.softWrap;
  }
  return result;
}

const sgrMouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
export function parseSgrMouse(chunk: string): readonly SgrMouseEvent[] {
  const events: SgrMouseEvent[] = [];
  for (const match of chunk.matchAll(sgrMouseRe)) {
    const button = Number.parseInt(match[1]!, 10);
    const x = Math.max(0, Number.parseInt(match[2]!, 10) - 1);
    const y = Math.max(0, Number.parseInt(match[3]!, 10) - 1);
    const final = match[4]!;
    const action: SgrMouseEvent['action'] =
      button === 64 ? 'wheel_up'
      : button === 65 ? 'wheel_down'
      : final === 'm' ? 'release'
      : (button & 32) !== 0 ? ((button & 3) === 3 ? 'move' : 'drag')
      : 'press';
    events.push({button: button & 3, x, y, action});
  }
  return events;
}

export function osc52Clipboard(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}
