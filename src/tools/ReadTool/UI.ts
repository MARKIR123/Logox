import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ToolUI} from '../ui-types.js';
import {messageToolCall, createToolUI} from '../../tui/timeline/tool-ui.js';
import {cardTitle, keyValueLines, renderToolCard, summaryPiece, type ToolLine, type ToolView} from '../../tui/timeline/tool-card.js';
import {codeLines, markdownLines} from '../../tui/timeline/tool-code.js';
import {callArgs, formatByteSize, isImageFile, stageText} from '../ui-format.js';
import {imageSize} from './image-size.js';
import {imageThumbnailLines} from '../../tui/timeline/image-thumb.js';

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

/** What is cheaply known about an image read: the path as resolved, the format, pixel size (from the file header) and byte size. */
export interface ImageFacts {readonly path: string; readonly format: string; readonly width?: number; readonly height?: number; readonly bytes?: number}
export function imageFacts(path: string, result: string): ImageFacts {
  const full = resolve(process.cwd(), path);
  const dimensions = imageSize(full);
  const size = /size:\s*(\d+)\s*bytes/i.exec(result);
  let bytes = size ? Number(size[1]) : undefined;
  if (bytes === undefined) try {bytes = statSync(full).size;} catch {}
  const format = /format:\s*image\/([\w.+-]+)/i.exec(result)?.[1] ?? (/\.(\w+)$/.exec(path)?.[1] ?? 'image');
  return {path: full, format: format.toUpperCase().replace('JPG', 'JPEG'), ...(dimensions ?? {}), ...(bytes !== undefined ? {bytes} : {})};
}

/**
 * An image Read: a summary after the title and an expandable detail: a bounded half-block thumbnail on top (a click opens the lightbox;
 * `src/tui/timeline/image-thumb.ts`, always visible and outside the body cap), then path, format, size in pixels and bytes.
 * `messageId` names the preview's hover and click target.
 */
export function imageView(path: string, result: string, messageId = path): ToolView {
  const facts = imageFacts(path, result);
  return {
    summary: [summaryPiece(['image', ...(facts.width && facts.height ? [`${facts.width} × ${facts.height}`] : []), ...(facts.bytes !== undefined ? [formatByteSize(facts.bytes)] : [])].join(' · '))],
    body: {head: width => imageThumbnailLines(facts.path, messageId, width), lines: imageDetailLines(facts)},
  };
}
/** The detail rows of an image Read, one fact per row. */
export function imageDetailLines(facts: ImageFacts): ToolLine[] {
  return keyValueLines([
    ['Path', facts.path],
    ['Format', facts.format],
    ...(facts.width && facts.height ? [['Dimensions', `${facts.width} × ${facts.height} pixels`] as const] : []),
    ...(facts.bytes !== undefined ? [['Size', `${formatByteSize(facts.bytes)} (${facts.bytes.toLocaleString('en-US')} bytes)`] as const] : []),
  ]);
}

/** Read card view: numbered, lightly colored excerpt (Markdown rendered), `lines A–B of N`, or one image row. */
export function readView(path: string, offset: number, result: string, messageId?: string): ToolView | undefined {
  if (isImageFile(path, result)) return imageView(path, result, messageId);
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
  stageLabel: call => stageText('Reading', callArgs(call).file_path ?? callArgs(call).path),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const args = callArgs(call);
    const path = String(args.file_path ?? args.path ?? '');
    renderToolCard(context, {title: cardTitle(context, call), view: result => readView(path, typeof args.offset === 'number' ? args.offset : 1, result, context.message.id)});
  },
};
