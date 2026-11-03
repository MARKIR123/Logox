import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ToolUI} from '../ui-types.js';
import {messageToolCall, createToolUI} from '../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, summaryPiece, type ToolView} from '../../tui/timeline/tool-card.js';
import {codeLines, markdownLines} from '../../tui/timeline/tool-code.js';
import {callArgs, formatByteSize, isImageFile} from '../ui-format.js';
import {imageSize} from './image-size.js';

const totals = new Map<string, {mtimeMs: number; size: number; total: number}>();
/** Number of lines in a file on disk (cached by mtime and size); undefined when it cannot be read. */
function fileLines(path: string): number | undefined {
  try {
    const full = resolve(process.cwd(), path), info = statSync(full), known = totals.get(full);
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return known.total;
    if (info.size > 32 * 1024 * 1024) return undefined;
    const total = readFileSync(full, 'utf8').split(/\r?\n/).length;
    if (totals.size >= 64) totals.clear();
    totals.set(full, {mtimeMs: info.mtimeMs, size: info.size, total});
    return total;
  } catch {return undefined;}
}

/** Read card view: numbered, lightly colored excerpt (Markdown rendered), `lines A–B of N`, or one image row. */
export function readView(path: string, offset: number, result: string): ToolView | undefined {
  if (isImageFile(path, result)) {
    const size = /size:\s*(\d+)\s*bytes/i.exec(result);
    const dimensions = imageSize(resolve(process.cwd(), path));
    return {fixed: true, summary: [summaryPiece(['image', ...(dimensions ? [`${dimensions.width} × ${dimensions.height}`] : []), ...(size ? [formatByteSize(Number(size[1]))] : [])].join(' · '))]};
  }
  const rows = result.split('\n');
  const truncated = rows.at(-1) === '(Remaining lines omitted)';
  if (truncated) rows.pop();
  const numbered = rows.map(row => /^(\d+): ?(.*)$/s.exec(row));
  const lines = numbered.map((match, index) => match ? match[2]! : rows[index]!);
  const first = Number(numbered[0]?.[1] ?? offset), last = first + lines.length - 1;
  const total = truncated || first > 1 ? fileLines(path) : last;
  const whole = first === 1 && !truncated;
  const summary = !lines.length ? undefined : whole ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : `lines ${first}–${last}${total ? ` of ${total}` : ''}`;
  const empty = !result.trim() || (lines.length === 1 && lines[0] === '' && whole);
  const markdown = /\.(md|markdown)$/i.test(path);
  return {
    ...(summary && !empty ? {summary: [summaryPiece(summary)]} : {}),
    body: {lines: empty ? [] : markdown ? width => markdownLines(lines.join('\n'), width) : codeLines(lines, first, path), empty: 'Empty file'},
  };
}

export const UI: ToolUI = {
  ...createToolUI(['file_path', 'path']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const args = callArgs(call);
    const path = String(args.file_path ?? args.path ?? '');
    renderToolCard(context, {title: cardTitle(context, call), view: result => readView(path, typeof args.offset === 'number' ? args.offset : 1, result)});
  },
};
