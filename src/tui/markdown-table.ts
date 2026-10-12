import stringWidth from 'string-width';
import type {MarkdownLine, MarkdownStyle, SourceCell} from './markdown.js';

export interface TableInputLine {readonly raw: string; readonly offset: number}
interface Cell {readonly text: string; readonly start: number}
type RenderCell = (text: string, start: number, width: number, bold?: boolean) => readonly MarkdownLine[];

// Pipes inside escaped text and backtick code spans are cell content, not separators.
function cells(line: TableInputLine): Cell[] | undefined {
  const raw = line.raw.replace(/\r$/, '');
  const cuts: number[] = [];
  let code = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {i++; continue;}
    if (raw[i] === '`') {
      let count = 1; while (raw[i + count] === '`') count++;
      if (!code) code = count; else if (code === count) code = 0;
      i += count - 1;
    } else if (raw[i] === '|' && !code) cuts.push(i);
  }
  if (!cuts.length) return undefined;
  let begin = 0;
  const result: Cell[] = [];
  for (const end of [...cuts, raw.length]) {
    const value = raw.slice(begin, end), text = value.trim();
    result.push({text, start: line.offset + begin + value.length - value.trimStart().length});
    begin = end + 1;
  }
  if (raw.slice(0, cuts[0]).trim() === '') result.shift();
  if (raw.slice(cuts.at(-1)! + 1).trim() === '') result.pop();
  return result;
}

export function layoutTable(input: readonly TableInputLine[], index: number, width: number, render: RenderCell):
  {readonly rows: readonly MarkdownLine[]; readonly consumed: number} | undefined {
  const headerLine = input[index], separator = input[index + 1];
  if (!headerLine || !separator) return undefined;
  const header = cells(headerLine), rules = cells(separator);
  if (!header?.length || header.length !== rules?.length || !rules.every(cell => /^:?-{3,}:?$/.test(cell.text))) return undefined;
  const records: {line: TableInputLine; values: readonly Cell[]; header: boolean}[] = [{line: headerLine, values: header, header: true}];
  let consumed = 2;
  for (let i = index + 2; i < input.length; i++) {
    const line = input[i]!, values = cells(line);
    if (!values || values.length > header.length || !line.raw.trim()) break;
    records.push({line, values: Array.from({length: header.length}, (_, column) => values[column] ?? {text: '', start: line.offset + line.raw.length}), header: false});
    consumed++;
  }
  const rows: MarkdownLine[] = [];
  const columnCount = header.length;
  const available = width - 4 - 3 * (columnCount - 1);
  const vertical = available < columnCount * 3;
  const widths = Array<number>(columnCount).fill(3);
  const desired = header.map((_, column) => Math.max(3, ...records.flatMap(record => render(record.values[column]!.text,
    record.values[column]!.start, 100000).map(line => stringWidth(line.text)))));
  if (!vertical) {
    let remaining = available - columnCount * 3;
    while (remaining > 0) {
      let grew = false;
      for (let col = 0; col < columnCount && remaining; col++) if (widths[col]! < desired[col]!) {widths[col]!++; remaining--; grew = true;}
      if (!grew) break;
    }
  }
  function block(line: TableInputLine): {start: number; end: number} {return {start: line.offset, end: line.offset + line.raw.length};}
  function addRule(): void {
    const text = '├─' + widths.map(value => '─'.repeat(value)).join('─┼─') + '─┤';
    rows.push({text, pieces: [{text, muted: true}], cells: [{column: 0, width: stringWidth(text), ...block(separator!)}],
      ...block(separator!), softWrap: false, sourceBlock: block(separator!)});
  }
  for (const record of records) {
    const sourceBlock = block(record.line);
    if (vertical) {
      for (const [column, value] of record.values.entries()) {
        const content = render(value.text, value.start, width, record.header);
        if (!record.header) {
          // Labels occupy their own wrapped lines; they are presentation, not copied content.
          for (const label of render(header[column]!.text + '：', header[column]!.start, width, true))
            rows.push({...label, cells: [], start: sourceBlock.start, end: sourceBlock.start, noSelect: true});
        }
        for (const line of content) rows.push({...line, sourceBlock, softWrap: false});
      }
    } else {
      const wrapped = record.values.map((value, column) => render(value.text, value.start, widths[column]!, record.header));
      const height = Math.max(1, ...wrapped.map(lines => lines.length));
      for (let y = 0; y < height; y++) {
        const pieces: (MarkdownStyle & {text: string})[] = [{text: '│ ', muted: true}];
        const mapped: SourceCell[] = [];
        let used = 2;
        for (let col = 0; col < columnCount; col++) {
          const line = wrapped[col]![y];
          const length = stringWidth(line?.text ?? ''), pad = Math.max(0, widths[col]! - length);
          const rule = rules[col]!.text;
          const before = rule.endsWith(':') ? rule.startsWith(':') ? Math.floor(pad / 2) : pad : 0;
          pieces.push({text: ' '.repeat(before)});
          if (line) {pieces.push(...line.pieces); mapped.push(...line.cells.map(cell => ({...cell, column: cell.column + used + before})));}
          pieces.push({text: ' '.repeat(pad - before)}, {text: col === columnCount - 1 ? ' │' : ' │ ', muted: true});
          used += widths[col]! + 3;
        }
        const actual = mapped.filter(cell => cell.end > cell.start);
        rows.push({text: pieces.map(piece => piece.text).join(''), pieces, cells: mapped,
          start: actual.length ? Math.min(...actual.map(cell => cell.start)) : sourceBlock.start,
          end: actual.length ? Math.max(...actual.map(cell => cell.end)) : sourceBlock.end,
          softWrap: false, sourceBlock});
      }
    }
    if (record.header) {
      if (vertical) {
        // Retain the separator's original source even when there is no horizontal grid.
        rows.push({text: '─'.repeat(width), pieces: [{text: '─'.repeat(width), muted: true}], cells: [], ...block(separator), softWrap: false, sourceBlock: block(separator)});
      } else addRule();
    }
  }
  return {rows, consumed};
}
