import stringWidth from 'string-width';
import {safeText} from './cards.js';
import {layoutTable, type TableInputLine} from './markdown-table.js';

export interface MarkdownStyle {readonly bold?: boolean; readonly italic?: boolean; readonly code?: boolean; readonly muted?: boolean}
interface Piece extends MarkdownStyle {text: string; start: number; end: number}
export interface SourceCell {readonly column: number; readonly width: number; readonly start: number; readonly end: number}
export interface MarkdownLine {
  readonly text: string;
  readonly pieces: readonly (MarkdownStyle & {readonly text: string})[];
  readonly cells: readonly SourceCell[];
  readonly start: number;
  readonly end: number;
  readonly softWrap: boolean;
  readonly sourceBlock?: {readonly start: number; readonly end: number};
  readonly noSelect?: boolean;
}
const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});
const glyphWidths = new Map<string, number>();
function glyphWidth(glyph: string): number {
  const known = glyphWidths.get(glyph);
  if (known !== undefined) return known;
  const width = stringWidth(glyph);
  if (glyphWidths.size >= 2048) glyphWidths.clear();
  glyphWidths.set(glyph, width);
  return width;
}

// Only complete inline delimiters are interpreted. An unfinished streaming tail stays readable.
function inline(text: string, offset: number, style: MarkdownStyle = {}): Piece[] {
  const result: Piece[] = [];
  const pattern = /(`+)([^`]+?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]\n]+)\]\(([^)\n]+)\)|\\([\\`*_|])/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) result.push({...style, text: text.slice(cursor, index), start: offset + cursor, end: offset + index});
    if (match[9]) {result.push({...style, text: match[9], start: offset + index, end: offset + index + match[0].length}); cursor = index + match[0].length; continue;}
    const content = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7]!;
    const leading = match[1]?.length ?? (match[3] || match[4] ? 2 : 1);
    const nested = match[1]
      ? [{...style, code: true, text: content, start: offset + index + leading, end: offset + index + leading + content.length}]
      : inline(content, offset + index + leading, {...style,
        ...(match[3] || match[4] ? {bold: true} : {}), ...(match[5] || match[6] ? {italic: true} : {})});
    if (nested.length) {
      nested[0] = {...nested[0]!, start: offset + index};
      const matchEnd = offset + index + match[0].length;
      nested[nested.length - 1] = {...nested.at(-1)!, end: match[8] ? offset + index + content.length + 2 : matchEnd};
      result.push(...nested);
      if (match[8]) {
        const urlStart = offset + index + content.length + 2;
        result.push({text: ' ', start: urlStart, end: urlStart});
        result.push({text: '(' + match[8] + ')', start: urlStart, end: matchEnd, muted: true});
      }
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) result.push({...style, text: text.slice(cursor), start: offset + cursor, end: offset + text.length});
  return result;
}

function wrapPieces(source: string, pieces: readonly Piece[], width: number, offset: number, sourceEnd: number): MarkdownLine[] {
  const rows: MarkdownLine[] = [];
  let cells: SourceCell[] = [], linePieces: (MarkdownStyle & {text: string})[] = [], used = 0;
  let start = offset, end = offset;
  const flush = (softWrap: boolean) => {
    rows.push({text: linePieces.map(piece => piece.text).join(''), pieces: linePieces, cells, start, end, softWrap});
    cells = []; linePieces = []; used = 0; start = end;
  };
  for (const piece of pieces) {
    const parts = [...graphemes.segment(piece.text)];
    const contentIndex = source.slice(piece.start, piece.end).indexOf(piece.text);
    for (const [index, part] of parts.entries()) {
      const displayed = part.segment === '\t' ? ' '.repeat(Math.min(width, 4)) : part.segment;
      const cellWidth = glyphWidth(displayed);
      if (used && used + cellWidth > width) flush(true);
      // Transformations (list markers, tabs, fence labels) map to the whole original token.
      const cellStart = index === 0 ? piece.start : contentIndex >= 0 ? piece.start + contentIndex + part.index : end;
      const cellEnd = index === parts.length - 1 ? piece.end : contentIndex >= 0 ? piece.start + contentIndex + part.index + part.segment.length : cellStart;
      const last = linePieces.at(-1);
      if (last && last.bold === piece.bold && last.italic === piece.italic && last.code === piece.code && last.muted === piece.muted) last.text += displayed;
      else linePieces.push({...piece, text: displayed});
      cells.push({column: used, width: cellWidth, start: cellStart, end: cellEnd});
      used += cellWidth; end = cellEnd;
    }
  }
  end = sourceEnd;
  if (cells.length) cells[cells.length - 1] = {...cells.at(-1)!, end};
  flush(false);
  return rows;
}

/** A terminal view of common Markdown, with display cells mapped back to the untouched source. */
export function layoutMarkdown(source: string, width: number): readonly MarkdownLine[] {
  width = Math.max(1, width);
  const rows: MarkdownLine[] = [];
  let offset = 0;
  let fence: {marker: string; length: number} | undefined;
  const input: TableInputLine[] = [];
  for (const raw of source.split('\n')) {input.push({raw, offset}); offset += raw.length + 1;}
  for (let lineIndex = 0; lineIndex < input.length; lineIndex++) {
    const {raw, offset} = input[lineIndex]!;
    if (!fence) {
      const table = layoutTable(input, lineIndex, width, (text, start, cellWidth, bold = false) =>
        wrapPieces(source, inline(safeText(text), start, bold ? {bold: true} : {}), cellWidth, start, start + text.length));
      if (table) {rows.push(...table.rows); lineIndex += table.consumed - 1; continue;}
    }
    const text = safeText(raw);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    let pieces: Piece[];
    if (marker && (!fence || (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()))) {
      const closing = Boolean(fence);
      fence = closing ? undefined : {marker: marker[1]![0]!, length: marker[1]!.length};
      pieces = [{text: closing ? '──' : '── ' + (marker[2]!.trim() || '代码'), start: offset, end: offset + raw.length, muted: true}];
    } else if (fence || (/^ {4}|^\t/.test(text) && !/^\s*(?:[-+*]|\d+[.)])\s+/.test(text))) {
      pieces = [];
      let cursor = 0;
      for (const match of text.matchAll(/\t/g)) {
        if (match.index > cursor) pieces.push({text: text.slice(cursor, match.index), start: offset + cursor, end: offset + match.index, code: true});
        pieces.push({text: '    ', start: offset + match.index, end: offset + match.index + 1, code: true});
        cursor = match.index + 1;
      }
      if (cursor < text.length) pieces.push({text: text.slice(cursor), start: offset + cursor, end: offset + raw.length, code: true});
    } else {
      const heading = /^ {0,3}#{1,6}\s+/.exec(text);
      const list = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(text);
      const quote = /^ {0,3}>\s?/.exec(text);
      const prefix = heading?.[0] ?? quote?.[0] ?? list?.[0] ?? '';
      pieces = inline(text.slice(prefix.length), offset + prefix.length, heading ? {bold: true} : quote ? {italic: true, muted: true} : {});
      if (list || quote) pieces.unshift({text: list ? (list[1] ?? '') + (/\d/.test(prefix) ? prefix.trim() + ' ' : '• ') : '│ ', start: offset, end: offset + prefix.length, muted: true});
      else if (prefix && pieces.length) pieces[0] = {...pieces[0]!, start: offset};
      if (!pieces.length && raw.length) pieces = [{text, start: offset, end: offset + raw.length}];
    }
    rows.push(...wrapPieces(source, pieces, width, offset, offset + raw.length));
  }
  return rows;
}
