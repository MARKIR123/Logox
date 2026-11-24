// Two controls that float over the timeline rectangle without moving a single content row: the "jump to latest" pill (a one-row
// chip above the composer, shown while the reading position is above the end) and the sticky user message (one row at the
// top that pins the message that started the exchange being read, shown while that message is above the viewport).
// Both are built from the viewport after the fact: the overlay rows replace rows of the visible slice, carry `hits` and a `hover` id
// for the mouse router, and a `glow` the terminal plane eases on hover. Selection, copy and scrolling keep reading the real rows.
import stringWidth from 'string-width';
import type {MutableRefObject} from 'react';
import {mixHex} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import {railCell, rowSegments} from './row-presentation.js';
import type {SceneAction, SceneRow, SceneSegment} from './scene.js';
import {viewport, type Anchor, type Row} from './viewport.js';

/** Hover ids of the two controls; the plane's hover fade and the mouse router both key on them. */
export const JUMP_ID = '__jump_bottom__';
export const STICKY_ID = '__sticky_message__';
/** The hover fade lasts this long; the plane steps it on its own clock (about four frames). */
export const FADE_MS = 150;

const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});

export interface TimelineView {readonly rows: readonly Row[]; readonly start: number; readonly following: boolean}
export interface OverlayInfo {
  /** Index in the full row list of the pinned user message's header, when the sticky header is shown. */
  readonly sticky?: number;
  /** Where the pill sits (screen columns and rows inside the timeline rectangle), when shown. */
  readonly pill?: {readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly label: string};
}
export interface OverlaidView extends TimelineView {readonly overlay: OverlayInfo}

/** True while the reading position is above the end of the timeline. */
export function scrolledUp(rows: readonly Row[], height: number, anchor: Anchor | null): boolean {
  return viewport(rows, height, anchor).start < Math.max(0, rows.length - height);
}

/** Rows that appeared since the person left the bottom, counted as distinct messages (a message's cards share its id). */
export function unseenCount(rows: readonly Row[], baseline: number): number {
  const seen = new Set<string>();
  for (let i = Math.max(0, Math.min(baseline, rows.length)); i < rows.length; i++) {
    const row = rows[i]!;
    if (row.tone === 'spacer') continue;
    seen.add(row.messageId.replace(/(?:-(?:who|stage|body|more)|:header)$/, ''));
  }
  return seen.size;
}

// ---------- segments ------------------------------------------------------------------------------------------------------------------

function merge(parts: readonly SceneSegment[]): SceneSegment[] {
  const out: SceneSegment[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const last = out.at(-1);
    if (last && last.color === part.color && last.bg === part.bg && last.bold === part.bold && last.italic === part.italic && last.underline === part.underline) out[out.length - 1] = {...last, text: last.text + part.text};
    else out.push(part);
  }
  return out;
}
/** What the plane draws for a row: the rail cell and the body, with the row's own background baked into every segment. */
function flatten(raw: Row): SceneSegment[] {
  const row = raw as SceneRow;
  return [...(row.gutterCols > 0 ? [railCell(row)] : []), ...rowSegments(row)].map(segment => row.bg && !segment.bg ? {...segment, bg: row.bg} : segment);
}
/** Display columns `[from, to)` of a segment list; a wide glyph cut by an edge becomes a space. */
export function sliceSegments(segments: readonly SceneSegment[], from: number, to: number): SceneSegment[] {
  const out: SceneSegment[] = [];
  let column = 0;
  for (const segment of segments) for (const {segment: glyph} of graphemes.segment(segment.text)) {
    const width = Math.max(1, stringWidth(glyph));
    const end = column + width;
    if (column >= to) return merge(out);
    if (column >= from && end <= to) out.push({...segment, text: glyph});
    else if (end > from && column < to) out.push({...segment, text: ' '.repeat(Math.min(end, to) - Math.max(column, from))});
    column = end;
  }
  return merge(out);
}
const widthOf = (segments: readonly SceneSegment[]): number => segments.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
const pad = (segments: readonly SceneSegment[], width: number, bg?: string): SceneSegment[] =>
  merge([...segments, {text: ' '.repeat(Math.max(0, width - widthOf(segments))), ...(bg ? {bg} : {})}]);

// ---------- the pill ------------------------------------------------------------------------------------------------------------------

/** The pill's label: `↓ 3 new  End`, `↓ Latest  End`, shorter forms when the timeline is narrow; empty when nothing fits. */
export function pillLabel(newCount: number, width: number): string {
  const head = newCount > 0 ? `↓ ${newCount > 99 ? '99+' : newCount} new` : '↓ Latest';
  for (const label of [`${head}  End`, head, '↓']) if (stringWidth(label) + 4 <= width) return label;
  return '';
}
/** Where the pill sits: one row, centred, one row above the composer's rule when the timeline is tall enough. */
export function pillBox(width: number, height: number, newCount: number): NonNullable<OverlayInfo['pill']> | undefined {
  if (height < 4) return undefined;
  const label = pillLabel(newCount, width);
  if (!label) return undefined;
  const boxWidth = stringWidth(label) + 4;
  return {x: Math.floor((width - boxWidth) / 2), y: height >= 6 ? height - 2 : height - 1, width: boxWidth, height: 1, label};
}
/** The chip at a hover level 0..1: `▐ ↓ Latest  End ▌`, a soft accent fill that deepens toward a stronger accent, half-block caps in the fill colour on the terminal's own background. */
export function pillChip(label: string, level: number): SceneSegment[] {
  const fill = mixHex(palette.accent, palette.bg, 0.2 + 0.28 * level);
  const text = mixHex(palette.fg, fill, 0.8 + 0.2 * level);
  const [arrow, ...rest] = [...label];
  const tail = rest.join('');
  const at = tail.lastIndexOf('End');
  const arrowColor = mixHex(palette.accent, palette.fg, 0.75 + 0.25 * level);
  return [
    {text: '▐', color: fill},
    {text: ' ', bg: fill},
    {text: arrow ?? '', color: arrowColor, bg: fill, bold: true},
    ...(at < 0 ? [{text: tail, color: text, bg: fill}] : [{text: tail.slice(0, at), color: text, bg: fill}, {text: 'End', color: palette.muted, bg: fill}]),
    {text: ' ', bg: fill},
    {text: '▌', color: fill},
  ];
}

function pillRows(box: NonNullable<OverlayInfo['pill']>, view: TimelineView): Row[] {
  const under = view.rows[box.y];
  const flat = under ? flatten(under) : [];
  const left = pad(sliceSegments(flat, 0, box.x), box.x);
  const right = sliceSegments(flat, box.x + box.width, Infinity);
  const paint = (level: number): readonly SceneSegment[] => merge([...left, ...pillChip(box.label, level), ...right]);
  const action: SceneAction = {kind: 'jump_bottom'};
  return [{
    messageId: JUMP_ID, line: 0, text: '', railColor: '', gutterCols: 0, softWrap: false, noSelect: true, tone: 'body',
    segments: paint(0), hover: {foldId: JUMP_ID, startCol: box.x, endCol: box.x + box.width},
    hits: [{startCol: box.x, endCol: box.x + box.width, action}], glow: {id: JUMP_ID, paint},
  } as SceneRow];
}

// ---------- the sticky user message ---------------------------------------------------------------------------------------------------

/** Index of the header of the user turn that began the exchange at row `start`, when that message is entirely above it; else -1. */
export function stickyIndex(rows: readonly Row[], start: number): number {
  if (start <= 0) return -1;
  let head = -1;
  for (let i = Math.min(start, rows.length - 1); i >= 0; i--) if ((rows[i] as SceneRow).turnStart) {head = i; break;}
  if (head < 0 || head >= start) return -1;
  // The message is visible while any of its rows is: its body rows follow the header and share the message id.
  const body = rows[head]!.messageId.replace(/-who$/, '');
  let end = head;
  while (end + 1 < rows.length && rows[end + 1]!.messageId === body) end++;
  return end >= start ? -1 : head;
}
/** The pinned message as one line of text: the body rows joined, whitespace collapsed. */
function messageText(rows: readonly Row[], head: number): string {
  const body = rows[head]!.messageId.replace(/-who$/, '');
  const parts: string[] = [];
  for (let i = head + 1; i < rows.length && rows[i]!.messageId === body && parts.length < 8; i++) parts.push(rows[i]!.text);
  return safeText(parts.join(' ')).replace(/\s+/g, ' ').trim();
}
function stickyRow(rows: readonly Row[], head: number, width: number): Row {
  const header = rows[head] as SceneRow;
  const tint = header.railColor || palette.user;
  const name = merge(rowSegments(header).map(segment => ({...segment, text: segment.text.replace(/\s+$/, '')})).filter(segment => segment.text));
  const hint = width >= 48 ? '↑ Jump' : '';
  const paint = (level: number): readonly SceneSegment[] => {
    const bg = mixHex(tint, palette.bg, 0.1 + 0.12 * level);
    const lead = [railCell(header), ...name].map(segment => ({...segment, bg}));
    const room = width - widthOf(lead) - 2 - (hint ? stringWidth(hint) + 2 : 0);
    let text = messageText(rows, head);
    if (room < 4) text = '';
    else if (stringWidth(text) > room) {
      let clipped = '';
      for (const {segment} of graphemes.segment(text)) {if (stringWidth(clipped + segment) > room - 1) break; clipped += segment;}
      text = clipped.replace(/\s+$/, '') + '…';
    }
    const body: SceneSegment[] = text ? [{text: '  ', bg}, {text, color: mixHex(palette.fg, bg, 0.7 + 0.3 * level), bg}] : [];
    const used = widthOf(lead) + widthOf(body);
    const tail: SceneSegment[] = hint && used + stringWidth(hint) + 2 <= width
      ? [{text: ' '.repeat(width - used - stringWidth(hint) - 1), bg}, {text: hint, color: mixHex(tint, bg, 0.55 + 0.45 * level), bg, underline: level > 0.5}, {text: ' ', bg}]
      : [{text: ' '.repeat(Math.max(0, width - used)), bg}];
    return merge([...lead, ...body, ...tail]);
  };
  return {
    messageId: STICKY_ID, line: 0, text: '', railColor: '', gutterCols: 0, softWrap: false, noSelect: true, tone: 'body',
    segments: paint(0), hover: {foldId: STICKY_ID, startCol: 0, endCol: width},
    hits: [{startCol: 0, endCol: width, action: {kind: 'jump_message', value: header.messageId}}], glow: {id: STICKY_ID, paint},
  } as SceneRow;
}

// ---------- composing -----------------------------------------------------------------------------------------------------------------

export interface OverlayInput {
  readonly rows: readonly Row[];
  readonly height: number;
  readonly width: number;
  readonly anchor: Anchor | null;
  /** Rows of the list at the moment the person left the bottom (see `unseenCount`); ignored at the bottom. */
  readonly baseline?: number;
}
/** The viewport of the timeline with the sticky header and the jump pill laid over its visible rows. */
export function overlayView({rows, height, width, anchor, baseline}: OverlayInput): OverlaidView {
  const view = viewport(rows, height, anchor);
  const away = view.start < Math.max(0, rows.length - height);
  const head = stickyIndex(rows, view.start);
  const box = away ? pillBox(width, height, baseline === undefined ? 0 : unseenCount(rows, baseline)) : undefined;
  if (head < 0 && !box) return {...view, overlay: {}};
  const shown = [...view.rows];
  if (head >= 0 && height >= 3 && shown.length) shown[0] = stickyRow(rows, head, width);
  if (box && shown.length > box.y) shown.splice(box.y, 1, ...pillRows(box, {...view, rows: shown}));
  return {...view, rows: shown, overlay: {...(head >= 0 && height >= 3 ? {sticky: head} : {}), ...(box ? {pill: box} : {})}};
}
/** `overlayView` that also keeps the "new below" baseline per window: set while the reading position is at the end. */
export function timelineView(rows: readonly Row[], height: number, width: number, anchor: Anchor | null, baselines: MutableRefObject<Record<string, number>>, windowId: string): OverlaidView {
  const view = viewport(rows, height, anchor);
  const away = view.start < Math.max(0, rows.length - height);
  const known = baselines.current[windowId];
  if (!away || known === undefined) baselines.current[windowId] = rows.length;
  return overlayView({rows, height, width, anchor, ...(away && known !== undefined ? {baseline: Math.min(known, rows.length)} : {})});
}

// ---------- the hover fade ------------------------------------------------------------------------------------------------------------

export interface GlowState {readonly from: number; readonly to: number; readonly since: number}
/** One step of the eased level 0..1 of a control: it moves to `hovered ? 1 : 0` over `FADE_MS` from where it was; no motion means at once. */
export function glowStep(state: GlowState | undefined, hovered: boolean, now: number, motion: boolean, fadeMs = FADE_MS): {state: GlowState; level: number; busy: boolean} {
  const to = hovered ? 1 : 0;
  if (!motion) return {state: {from: to, to, since: now}, level: to, busy: false};
  if (!state && !hovered) return {state: {from: 0, to: 0, since: -Infinity}, level: 0, busy: false};
  let current = state ?? {from: 0, to, since: now};
  let level = current.from + (current.to - current.from) * ease(Math.min(1, (now - current.since) / fadeMs));
  if (current.to !== to) {current = {from: level, to, since: now}; level = current.from;}
  const done = (now - current.since) >= fadeMs;
  if (done) level = current.to;
  return {state: current, level, busy: !done};
}
const ease = (t: number): number => 1 - (1 - t) * (1 - t);
