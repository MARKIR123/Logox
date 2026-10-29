import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type {Message} from '../../runtime/contracts.js';
import {isTimelineMessage} from '../../runtime/system-events.js';
import {ownerColor, ownerHeader} from '../appearance/actor-style.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import type {SourceCell} from './markdown.js';
import {railColumns, visibleText, type ContentCell} from './selection.js';
import {isVisibleToolMessage} from '../../tools/ui-registry.js';
import {themeRevision} from '../../config/theme-palette.js';

export interface Row {
  readonly displayText?: string;
  readonly selectionCells?: readonly ContentCell[];
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
  readonly sourceBlock?: {readonly start: number; readonly end: number};
}
export interface Anchor {readonly messageId: string; readonly line: number; readonly sourceOffset?: number; readonly screenOffset?: number}
export interface SelectionPoint {readonly x: number; readonly y: number}
export interface SelectionRange {readonly anchor: SelectionPoint; readonly focus: SelectionPoint}

const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});
const cache = new WeakMap<Message, {revision: number; widths: Map<number, readonly Row[]>}>();

export function timelineRows(messages: readonly Message[], width: number): readonly Row[] {
  width = Math.max(1, width);
  return messages.filter(message => isTimelineMessage(message) && isVisibleToolMessage(message)).flatMap(message => {
    let cached = cache.get(message);
    if (!cached || cached.revision !== themeRevision()) {
      cached = {revision: themeRevision(), widths: new Map()}; cache.set(message, cached);
    }
    const widths = cached.widths;
    const known = widths.get(width);
    if (known) return [...known];
    const gutterCols = width >= 6 ? 2 : 0;
    const contentWidth = Math.max(1, width - gutterCols);
    const railColor = message.role === 'user' ? palette.user : ownerColor(message.ownerId);
    const roleLabel = message.role === 'user' ? '收到任务' : message.role === 'assistant' ? '台词' : '记录';
    const headerText = safeText(`${ownerHeader(message.ownerId)} · ${roleLabel}`);
    const headerLines = wrapAnsi(headerText, contentWidth, {hard: true, trim: false}).split('\n');
    const built: Row[] = [];
    let headerOffset = 0;
    for (let i = 0; i < headerLines.length; ++i) {
      built.push({
        messageId: message.id + ':header',
        line: built.length,
        text: headerLines[i]!,
        sourceStart: headerOffset, sourceEnd: headerOffset + headerLines[i]!.length,
        railColor,
        gutterCols,
        softWrap: i < headerLines.length - 1,
        noSelect: true,
        tone: 'header',
      });
      headerOffset += headerLines[i]!.length;
    }
    let sourceOffset = 0;
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
          sourceStart: sourceOffset, sourceEnd: sourceOffset + segments[i]!.length,
          railColor,
          gutterCols,
          softWrap: i < segments.length - 1,
          noSelect: false,
          tone,
        });
        sourceOffset += segments[i]!.length;
      }
      sourceOffset++;
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
        ? row.sourceBlock && row.sourceCells?.length
          ? row.sourceCells.some(cell => cell.start <= anchor.sourceOffset! && cell.end > anchor.sourceOffset!)
          : row.sourceEnd > anchor.sourceOffset || row.sourceStart === anchor.sourceOffset
        : row.line >= anchor.line));
      const last = rows.findLastIndex(row => row.messageId === anchor.messageId);
      if (index >= 0 || last >= 0) start = Math.max(0, Math.min(maxStart, (index >= 0 ? index : last) - (anchor.screenOffset ?? 0)));
    }
  }
  return {rows: rows.slice(start, start + height), start, following: anchor === null};
}

export function normalizeSelection(selection: SelectionRange): {start: SelectionPoint; end: SelectionPoint} {
  const {anchor, focus} = selection;
  if (anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)) {
    return {start: anchor, end: focus};
  }
  return {start: focus, end: anchor};
}

export function sliceRowText(text: string, startCol: number, endCol: number): {before: string; selected: string; after: string} {
  if (endCol <= 0) return {before: '', selected: '', after: text};
  let col = 0;
  let before = '';
  let selected = '';
  let after = '';
  for (const {segment} of segmenter.segment(safeText(text))) {
    const w = segment.length === 1 && segment.charCodeAt(0) < 128 ? 1 : Math.max(1, stringWidth(segment));
    if (col + w <= startCol) before += segment;
    else if (col >= endCol) after += segment;
    else selected += segment;
    col += w;
  }
  return {before, selected, after};
}

export function rowSelectionBounds(row: Row, rowIndex: number, selection: SelectionRange | null): [number, number] | null {
  if (!selection) return null;
  const {start, end} = normalizeSelection(selection);
  if (start.x === end.x && start.y === end.y) return null;
  if (rowIndex < start.y || rowIndex > end.y) return null;
  const rawStart = rowIndex === start.y ? start.x : 0;
  const rawEnd = rowIndex === end.y ? end.x + 1 : Infinity;
  const startCol = Math.max(0, rawStart - railColumns(row));
  const endCol = Math.max(0, rawEnd - railColumns(row));
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
    const inset = Math.max(0, row.gutterCols - railColumns(row));
    let selected = sliceRowText(visibleText(row), bounds[0], Math.min(bounds[1], inset + stringWidth(row.text))).selected;
    if (prevSoftWrap && prevRowIndex === y - 1) {
      const inset = Math.max(0, row.gutterCols - railColumns(row));
      if (bounds[0] === 0 && inset) selected = sliceRowText(selected, inset, Infinity).selected;
    }
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

