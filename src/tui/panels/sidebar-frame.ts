/**
 * The frame of the sidebar (the team stage of `team-sidebar.ts`) as pure functions and constants: how wide it docks, where its content starts, the border
 * column with the collapse button and resize handle (`sideLine()`), and the palette colour of a cell tone (`toneColor()`). Nothing here reads a clock or a store.
 *
 * Geometry: column 0 is the border (`│`, accent while the sidebar has the keyboard; on the first row the `›` collapse button), column 1 a space, the content
 * starts at column 2.
 */
import stringWidth from 'string-width';
import {faintColor} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import type {SideSegment} from '../terminal/terminal-plane.js';
import {fit, type FlowTone} from './panel-text.js';

/** The sidebar docks beside the timeline only at this many columns or more; narrower terminals open it as an overlay. */
export const DOCK_MIN_COLUMNS = 110;
export const SIDEBAR_MIN = 36, SIDEBAR_MAX = 56;
/** Dragging the border never leaves the timeline fewer columns than this, and never gives the sidebar more than this share of the usable width. */
export const TIMELINE_MIN = 60;
export const SIDEBAR_SHARE_MAX = 0.6;
/** The first column of the content inside the sidebar (border and one space). */
export const CONTENT_X = 2;
export const DOUBLE_CLICK_MS = 350;

/** The default sidebar width: 34% of the usable width, clamped to 36..56 columns. */
export const defaultSidebarWidth = (width: number): number => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(width * 0.34)));
/** The widest a dragged sidebar may be: 60% of the usable width, and never so wide that the timeline (and its one-column gap) drops under `TIMELINE_MIN`; never below `SIDEBAR_MIN`. */
export const maxSidebarWidth = (width: number): number => Math.max(SIDEBAR_MIN, Math.min(Math.floor(width * SIDEBAR_SHARE_MAX), width - 1 - TIMELINE_MIN));
/** A requested width clamped into `SIDEBAR_MIN..maxSidebarWidth(width)`. */
export const clampSidebarWidth = (requested: number, width: number): number => Math.max(SIDEBAR_MIN, Math.min(maxSidebarWidth(width), Math.round(requested)));
/** The docked width: the person's remembered width re-clamped into the current range, else the default. */
export const sidebarWidth = (width: number, preferred?: number): number => preferred === undefined ? defaultSidebarWidth(width) : clampSidebarWidth(preferred, width);
/** The sidebar width while its border is dragged to terminal column `x` (the sidebar spans the right-hand `width - x` columns). */
export const dragWidth = (width: number, x: number): number => clampSidebarWidth(width - x, width);

/** The collapse button in the border column of the header row (one cell wide). */
export const COLLAPSE = '›';

export function toneColor(tone: FlowTone): string {
  switch (tone) {
    case 'strong': return palette.strong;
    case 'muted': return palette.muted;
    case 'faint': return faintColor();
    case 'accent': return palette.accent;
    case 'success': return palette.success;
    case 'warning': return palette.warning;
    case 'error': return palette.error;
    case 'line': return palette.line;
    default: return palette.fg;
  }
}
function merge(segments: readonly SideSegment[]): SideSegment[] {
  const result: SideSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = result.at(-1);
    if (last && last.clock === undefined && segment.clock === undefined && last.color === segment.color && last.bg === segment.bg && last.bold === segment.bold && last.italic === segment.italic && last.underline === segment.underline) result[result.length - 1] = {...last, text: last.text + segment.text};
    else result.push(segment);
  }
  return result;
}
/** What a sidebar line needs of its frame: the panel width, the pointer over its border and whether the border wears the accent (keyboard focus or a drag). */
export interface SideFrame {readonly width: number; readonly hoveredEdge?: 'collapse' | 'handle' | undefined; readonly accent: boolean}
/** The border (the `›` collapse button on the first row, else the resize handle), then the cells of `row` clipped to the content width and padded: one line exactly `width` cells wide. */
export function sideLine(frame: SideFrame, row: readonly SideSegment[], first = false): SideSegment[] {
  const room = frame.width - CONTENT_X;
  const out: SideSegment[] = [];
  let used = 0;
  for (const segment of row) {
    if (used >= room) break;
    const size = stringWidth(segment.text);
    if (used + size <= room) {out.push(segment); used += size; continue;}
    out.push({...segment, text: fit(segment.text, room - used).replace(/…$/, ' ')}); used = room; break;
  }
  const {hoveredEdge} = frame;
  const edgeColor = frame.accent || hoveredEdge === 'handle' ? palette.accent : palette.line;
  const border: SideSegment[] = first ? [{text: COLLAPSE, color: hoveredEdge === 'collapse' ? palette.accent : palette.muted, bold: true}, {text: ' ', color: palette.fg}] : [{text: '│ ', color: edgeColor}];
  return merge([...border, ...out, {text: ' '.repeat(Math.max(0, room - used)), color: palette.fg}]);
}
