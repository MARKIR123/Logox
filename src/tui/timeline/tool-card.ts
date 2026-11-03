import stringWidth from 'string-width';
import type {Message} from '../../runtime/contracts.js';
import type {ToolFrame, ToolRenderContext} from '../../tools/ui-types.js';
import {palette} from '../appearance/theme.js';
import {faintColor} from '../appearance/colors.js';
import {clipLine} from '../terminal/text.js';
import type {ToolCall} from '../../runtime/messages.js';
import {baseCardTitle} from '../../tools/ui-format.js';
import type {createBuilder, SceneAction, SceneSegment} from './scene.js';

/**
 * Shared anatomy of every tool card body. A tool UI builds a `ToolView` (summary after the title plus a rendered user view of
 * the result) and calls `renderToolCard`; layout, the 12-line cap, the single `… N more lines` expander, empty states and
 * failures are owned here so all tools look and behave the same.
 */
export const TOOL_BODY_LINES = 12;

/** One rendered body row. `segments` rows are clipped to the card width, `prose` rows wrap and stay selectable. */
export interface ToolLine {
  readonly segments?: readonly SceneSegment[];
  /** Plain text row (wrapped, selectable); drawn in `color`. */
  readonly prose?: string;
  readonly color?: string;
  /** Full-row background (diff additions and removals). */
  readonly bg?: string;
  /** A `⋯` row between hunks; the expander counts hunks when it cuts at one. */
  readonly separator?: boolean;
}
export interface ToolBody {
  /** Always-visible rows above the lines (Shell: `$ command`). Not counted against the cap. */
  readonly head?: readonly ToolLine[];
  /** The rendered view; a function receives the usable width (Markdown needs it). */
  readonly lines: readonly ToolLine[] | ((width: number) => readonly ToolLine[]);
  /** Italic faint line shown instead of the lines when there are none (`No output`, `No matches`). */
  readonly empty?: string;
  /** Show the last lines instead of the first; the expander then sits above them (Shell). */
  readonly tail?: boolean;
  readonly limit?: number;
}
export interface ToolView {
  /** Pieces after the title; only what the title does not already say. A ` · ` inside a segment becomes a muted separator. */
  readonly summary?: readonly SceneSegment[];
  readonly body?: ToolBody;
  /** A single non-expandable row (an image): no fold, no hover. */
  readonly fixed?: boolean;
  /** Drop the red `Error` fault label (the summary already says it, for example `exit 1`). */
  readonly quietFault?: boolean;
}
export interface ToolCardOptions {
  readonly title: string;
  /** Builds the user view from the result text (without the tool-name line) once the tool has completed. */
  view?(result: string): ToolView | undefined;
  /** Also run `view` when the tool failed (Shell: a non-zero exit is a normal result). */
  readonly handlesFailure?: boolean;
}

/** The result text of a tool message: everything after the tool-name line. */
export function resultText(message: Message): string {
  const [, ...rest] = message.text.split('\n');
  return rest.join('\n');
}

/** The card title: built from the structured call, or the recorded step title for legacy messages without one. */
export function cardTitle(context: ToolRenderContext, call: ToolCall): string {
  const step = context.message.step;
  return step?.call ? baseCardTitle(call, step.title) : step?.title ?? baseCardTitle(call);
}

export const expanderId = (messageId: string): string => messageId + '-more';

/** A muted summary piece; `tone` colors exit codes and counts. */
export function summaryPiece(text: string, tone: 'muted' | 'error' | 'success' | 'added' | 'removed' = 'muted'): SceneSegment {
  const color = tone === 'error' ? palette.error : tone === 'success' ? palette.success : tone === 'added' ? palette.diffAdded : tone === 'removed' ? palette.diffRemoved : palette.muted;
  return {text, color};
}

const LINK = /https?:\/\/[^\s<>"'`)\]]+|www\.[^\s<>"'`)\]]+|localhost:\d+(?:\/[^\s<>"'`)\]]*)?|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|app|co|edu|gov|cn|info|xyz)\b(?:\/[^\s<>"'`)\]]*)?/gi;
/** Splits text into segments with every link, URL and domain underlined in the link color. */
export function linkSegments(text: string, base: Omit<SceneSegment, 'text'> = {}): SceneSegment[] {
  const parts: SceneSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LINK)) {
    const value = match[0].replace(/[.,;:!?]+$/, '');
    if (match.index > cursor) parts.push({...base, text: text.slice(cursor, match.index)});
    parts.push({...base, text: value, color: palette.link, underline: true});
    cursor = match.index + value.length;
  }
  if (cursor < text.length) parts.push({...base, text: text.slice(cursor)});
  return parts.length ? parts : [{...base, text}];
}

/** Clips segments to `width` cells, closing with `…` when something was cut. */
export function clipSegments(segments: readonly SceneSegment[], width: number): SceneSegment[] {
  const total = segments.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
  if (total <= width) return [...segments];
  const result: SceneSegment[] = [];
  let remaining = Math.max(0, width - 1);
  for (const segment of segments) {
    const size = stringWidth(segment.text);
    if (size <= remaining) {result.push(segment); remaining -= size; continue;}
    const text = clipLine(segment.text, remaining);
    if (text) result.push({...segment, text});
    break;
  }
  result.push({text: '…', color: faintColor()});
  return result;
}

/** `… N more lines` (or `hunks`): italic faint; brighter and underlined while hovered. Click and keyboard toggle the fold `<id>-more`. */
export function pushExpander(builder: ReturnType<typeof createBuilder>, id: string, accent: string, frame: ToolFrame, count: number, unit: 'lines' | 'hunks'): void {
  const foldId = expanderId(id);
  const hovered = builder.hoveredFoldId === foldId;
  const word = unit === 'hunks' ? (count === 1 ? 'hunk' : 'hunks') : (count === 1 ? 'line' : 'lines');
  const action: SceneAction = {kind: 'toggle_fold', foldId};
  const first = builder.rows.length;
  builder.pushFramedLine(foldId, accent, [{text: `… ${count} more ${word}`, color: hovered ? palette.fg : faintColor(), italic: true, ...(hovered ? {underline: true} : {})}], frame, action);
  for (let index = first; index < builder.rows.length; index++) {
    const row = builder.rows[index]!;
    const startCol = row.gutterCols, endCol = row.gutterCols + stringWidth(row.text.trimEnd());
    builder.rows[index] = {...row, hover: {foldId, startCol, endCol}, hits: [{startCol, endCol, action}]};
  }
}

function pushLine(builder: ReturnType<typeof createBuilder>, id: string, accent: string, frame: ToolFrame, line: ToolLine): void {
  if (line.prose !== undefined) {builder.pushProse(id, line.prose, accent, 'body', frame, undefined, line.color); return;}
  builder.pushFramedLine(id, accent, clipSegments(line.segments ?? [], frame.innerWidth), frame, undefined, line.bg);
}

/** Body rows for a view: head, the capped lines with their expander, or the empty-state line. */
export function pushToolBody(builder: ReturnType<typeof createBuilder>, id: string, accent: string, frame: ToolFrame, body: ToolBody, expanded: boolean): void {
  body.head?.forEach((line, index) => pushLine(builder, `${id}-head-${index}`, accent, frame, line));
  const lines = typeof body.lines === 'function' ? body.lines(frame.innerWidth) : body.lines;
  if (!lines.length) {
    if (body.empty) builder.pushFramedLine(`${id}-empty`, accent, [{text: body.empty, color: faintColor(), italic: true}], frame);
    return;
  }
  const limit = body.limit ?? TOOL_BODY_LINES;
  let shown = lines, hidden = 0, unit: 'lines' | 'hunks' = 'lines';
  if (!expanded && lines.length > limit) {
    if (body.tail) {shown = lines.slice(lines.length - limit); hidden = lines.length - limit;}
    else {
      // Cut at the last hunk boundary inside the cap when there is one: the remainder is then counted in hunks.
      let cut = -1;
      for (let index = Math.min(limit, lines.length - 1); index > 0; index--) if (lines[index]!.separator) {cut = index; break;}
      if (cut > 0) {
        shown = lines.slice(0, cut);
        hidden = lines.slice(cut).filter(line => line.separator).length;
        unit = 'hunks';
      } else {shown = lines.slice(0, limit); hidden = lines.length - limit;}
    }
  }
  if (hidden > 0 && body.tail) pushExpander(builder, id, accent, frame, hidden, unit);
  const offset = body.tail ? lines.length - shown.length : 0;
  shown.forEach((line, index) => pushLine(builder, `${id}-b-${index + offset}`, accent, frame, line));
  if (hidden > 0 && !body.tail) pushExpander(builder, id, accent, frame, hidden, unit);
}

/** Summary and body for a failed, denied or cancelled call: the first line in the summary, the full text below when it says more. */
export function failureView(text: string, cancelled: boolean): ToolView {
  const lines = text.replace(/\s+$/, '').split('\n');
  const first = (lines[0] ?? '').trim();
  const color = cancelled ? palette.muted : palette.error;
  const summary = clipLine(first, 80);
  return {
    ...(summary ? {summary: [{text: summary + (summary.length < first.length ? '…' : ''), color}]} : {}),
    ...(lines.length > 1 || first.length > 80 ? {body: {lines: lines.map(line => ({prose: line, color}))}} : {}),
  };
}

/**
 * The one entry point for tool cards: header (`▮`/`▾`, title, summary, right-aligned time), then the body for the completed
 * result. Running calls draw the header only; failures show the reason; empty results never render nothing.
 */
export function renderToolCard(context: ToolRenderContext, options: ToolCardOptions): void {
  const {builder, message, frame, open, accent} = context;
  const step = message.step;
  const state = step?.state;
  const failed = state === 'failed' || state === 'cancelled' || Boolean(step?.disposition);
  const done = state === undefined || state === 'completed';
  const result = resultText(message);
  let view: ToolView | undefined;
  // Legacy records carry no structured call: their text is all there is, shown as plain output.
  if (!step?.call) view = result.trim() ? {body: {lines: result.replace(/\s+$/, '').split('\n').map(prose => ({prose, color: palette.muted}))}} : undefined;
  else if (failed && !options.handlesFailure) view = failureView(result, state === 'cancelled');
  else if (done || (failed && options.handlesFailure)) view = options.view?.(result);
  const expanded = context.isOpen?.(expanderId(message.id)) ?? false;
  builder.pushOrdinaryCard({
    id: message.id, ownerId: message.ownerId, kind: 'Tool', title: options.title, bodyLines: [], open: view?.fixed ? false : open, railColor: accent,
    statusRight: true,
    ...(view?.summary?.length ? {summarySegments: view.summary} : {}),
    ...(view?.quietFault ? {faultLabel: ''} : {}),
    ...(view?.fixed ? {fixed: true} : {}),
    ...(step ? {step} : {}),
    ...(frame ? {parentFrame: frame} : {}),
    renderBody: inner => {if (view?.body) pushToolBody(builder, message.id, accent, inner, view.body, expanded);},
  });
}
