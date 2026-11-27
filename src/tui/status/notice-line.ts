// Row 2 of the footer when a persistent notice is what it shows: one plan for drawing and hit-testing. The top notice's parts, a `×` on a read
// notice and a `+N` badge when more exist are laid out once; the same call returns the styled segments and the clickable regions, so the mouse
// never has its own coordinates. Narrow widths drop whole parts from the right (never a word cut in the middle), keep the `×` and the badge,
// and only the first part is ever shortened, at a word boundary.
import stringWidth from 'string-width';
import {mainAction, type NoticeAction, type PersistentNotice} from '../../runtime/notices.js';
import {palette} from '../appearance/theme.js';
import {mixHex} from '../appearance/colors.js';
import {toneGlyph, type NoteSegment} from './notification-line.js';

/** A clickable cell of the notice row: columns [x0, x1) of row 2. `id` is `part:<index>`, `dismiss` or `badge`. */
export interface NoticeRegion {readonly id: string; readonly x0: number; readonly x1: number}
export interface NoticeRow {
  readonly segments: readonly NoteSegment[];
  readonly regions: readonly NoticeRegion[];
  /** What a click on a region does: an action of the notice, the dismissal of it or the Notices page. */
  readonly effect: (id: string) => {readonly kind: 'action'; readonly action: NoticeAction} | {readonly kind: 'dismiss'} | {readonly kind: 'notices'} | undefined;
}
const SEPARATOR = ' · ', BUTTON_GAP = '  ', TAIL_GAP = 2;

/** `text` shortened to `room` cells at the last word boundary, with `…`; a single word longer than the room is cut. */
export function clipWords(text: string, room: number): string {
  if (room <= 0) return '';
  if (stringWidth(text) <= room) return text;
  const words = text.split(' ');
  let out = '';
  for (const word of words) {
    const next = out ? out + ' ' + word : word;
    if (stringWidth(next) + 1 > room) break;
    out = next;
  }
  if (out) return out + '…';
  let cut = '';
  for (const char of text) {if (stringWidth(cut + char) + 1 > room) break; cut += char;}
  return cut + '…';
}

/**
 * The notice row for `top` (the first of `total` persistent notices) in `width` cells. `hovered` is the region id under the pointer; `hoverColor`
 * is the window colour a hovered control takes (the `×` takes the error colour).
 */
export function noticeRow(input: {top: PersistentNotice; total: number; width: number; hovered?: string | null | undefined; hoverColor: string}): NoticeRow {
  const {top, total, width, hovered, hoverColor} = input;
  const faint = mixHex(palette.muted, palette.bg, 0.6);
  const glyph = toneGlyph[top.tone], glyphWidth = stringWidth(glyph);
  const read = top.kind === 'read', more = total - 1;
  const tailText = (more > 0 ? '+' + more : '') + (more > 0 && read ? ' ' : '') + (read ? '×' : '');
  const tailWidth = stringWidth(tailText);
  const label = (part: PersistentNotice['parts'][number]) => part.button ? '[' + part.text + ']' : part.text;
  const join = (index: number) => index === 0 ? '' : top.parts[index]!.button ? BUTTON_GAP : SEPARATOR;
  const reserve = tailWidth ? TAIL_GAP + tailWidth : 0;
  // The most parts that fit, dropping from the right; the first part is always kept (shortened when it alone does not fit).
  let count = top.parts.length;
  const need = (n: number) => glyphWidth + top.parts.slice(0, n).reduce((sum, part, index) => sum + stringWidth(join(index)) + stringWidth(label(part)), 0);
  while (count > 1 && need(count) + reserve > width) count--;
  const segments: NoteSegment[] = [], regions: NoticeRegion[] = [];
  let x = 0;
  const push = (segment: NoteSegment) => {segments.push(segment); x += stringWidth(segment.text);};
  if (glyph) push({text: glyph, color: palette[top.tone === 'info' ? 'fg' : top.tone], bold: true});
  top.parts.slice(0, count).forEach((part, index) => {
    if (index) push({text: join(index), color: faint});
    const room = width - reserve - x;
    const text = clipWords(label(part), room);
    if (!text) return;
    const id = 'part:' + index, over = hovered === id;
    if (part.action) {
      regions.push({id, x0: x, x1: x + stringWidth(text)});
      push({text, color: over ? hoverColor : palette.accent, bold: over || Boolean(part.button), underline: !part.button});
    } else push({text, color: palette.fg, bold: index === 0});
  });
  if (tailWidth) {
    push({text: ' '.repeat(Math.max(0, width - x - tailWidth)), color: palette.fg});
    if (more > 0) {
      regions.push({id: 'badge', x0: x, x1: x + 1 + String(more).length});
      push({text: '+' + more, color: hovered === 'badge' ? hoverColor : palette.accent, bold: true});
      if (read) push({text: ' ', color: palette.fg});
    }
    if (read) {
      regions.push({id: 'dismiss', x0: x, x1: x + 1});
      push({text: '×', color: hovered === 'dismiss' ? palette.error : palette.muted, bold: hovered === 'dismiss'});
    }
  }
  const effect: NoticeRow['effect'] = id => {
    if (id === 'badge') return {kind: 'notices'};
    if (id === 'dismiss') return {kind: 'dismiss'};
    const part = id.startsWith('part:') ? top.parts[Number(id.slice(5))] : undefined;
    const action = part?.action ?? mainAction(top);
    return action ? {kind: 'action', action} : undefined;
  };
  return {segments, regions, effect};
}
export const regionAt = (regions: readonly NoticeRegion[], x: number): NoticeRegion | undefined => regions.find(region => x >= region.x0 && x < region.x1);
