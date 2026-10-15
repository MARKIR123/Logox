import stringWidth from 'string-width';
import type {Step} from '../runtime/contracts.js';
import {stepElapsed} from '../runtime/steps.js';
import {mixHex, palette} from './cards.js';
import type {SceneRow, SceneSegment} from './scene.js';
import {rowSelectionBounds, sliceRowText, type Row, type SelectionRange} from './viewport.js';

const dots = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const glyphs = new Intl.Segmenter('zh', {granularity: 'grapheme'});
const breathingRows = new WeakMap<Row, {color: string | undefined; row: SceneRow}>();
export function thinkingDuration(step: Step, now: number): string {
  const seconds = stepElapsed(step, now) / 1000;
  const terminal = ['completed', 'failed', 'cancelled'].includes(step.state);
  return terminal ? Math.round(seconds) + 's' : (seconds.toFixed(1) + 's').padEnd(7).slice(0, 7);
}
export function stepIcon(step: Step, now: number, motion: boolean): string {
  return step.state === 'running' && motion ? dots[Math.floor(now / 80) % dots.length]! : step.state === 'running' ? '·' : step.state === 'waiting' ? '○' : step.state === 'queued' ? '◦' : '▮';
}
export function stepStatus(step: Step, now: number): string {
  const seconds = stepElapsed(step, now) / 1000;
  const duration = (seconds < 60 ? seconds.toFixed(1) + 's' : Math.floor(seconds / 60) + 'm' + String(Math.floor(seconds % 60)).padStart(2, '0') + 's').padStart(7).slice(-7);
  const state = step.state === 'waiting' ? step.waiting ?? '等待中' : step.state === 'queued' ? '排队中' : step.state === 'cancelled' ? '已取消' : '';
  return duration + (state ? ' ' + state : '');
}
export function rowSegments(row: SceneRow): readonly SceneSegment[] {
  if (row.segments?.length) return row.segments;
  const color = row.color ?? (row.tone === 'header' ? row.railColor : row.tone === 'direction' ? palette.muted : palette.fg);
  return [...row.prefixSegments ?? [], {text: row.text, color, ...(row.bg ? {bg: row.bg} : {}), bold: row.tone === 'header', italic: row.tone === 'direction'}, ...row.suffixSegments ?? []];
}
function transform(segments: readonly SceneSegment[], fn: (glyph: SceneSegment, column: number) => SceneSegment): SceneSegment[] {
  const result: SceneSegment[] = [];
  let column = 0;
  for (const segment of segments) for (const {segment: text} of glyphs.segment(segment.text)) {
    const value = fn({...segment, text}, column), previous = result.at(-1);
    if (previous && previous.color === value.color && previous.bg === value.bg && previous.bold === value.bold && previous.italic === value.italic && previous.selectionKey === value.selectionKey) result[result.length - 1] = {...previous, text: previous.text + value.text};
    else result.push(value);
    column += Math.max(1, stringWidth(text));
  }
  return result;
}
/** Color and fixed-size slots only: no layout or runtime publication on a clock tick. */
export function decorateRow(raw: Row, now: number, motion = true): SceneRow {
  const row = raw as SceneRow, animation = row.animation;
  if (!animation) return row;
  const running = animation.step?.state === 'running';
  if (!running && !(motion && animation.active)) return row;
  const status = animation.step && running ? animation.thinking ? thinkingDuration(animation.step, now) : stepStatus(animation.step, now).slice(0, 7) : '';
  const breath = motion && animation.active && animation.actorBg
    ? mixHex(animation.actorColor ?? animation.actorBg, animation.actorBg, 0.02 + (Math.sin(now * 2 * Math.PI / 2500) + 1) * 0.08) : undefined;
  if (!running) {
    const known = breathingRows.get(row);
    if (known && known.color === breath) return known.row;
  }
  // Background colors apply to style runs, not individual graphemes.
  const original = rowSegments(row);
  const base = original.map(segment => breath && (segment.bg === animation.actorBg || segment.color === animation.actorBg) ? {...segment,
    ...(segment.bg === animation.actorBg ? {bg: breath} : {}),
    ...(segment.color === animation.actorBg ? {color: breath} : {})} : segment);
  if (!running) {
    const bg = breath && row.bg === animation.actorBg ? breath : row.bg;
    const decorated = bg === row.bg && base.every((segment, index) => segment === original[index]) ? row : {...row, ...(bg ? {bg} : {}), segments: base,
      displayText: row.displayText ?? base.map(segment => segment.text).join('')};
    breathingRows.set(row, {color: breath, row: decorated});
    return decorated;
  }
  const mappedCells = new Map(row.selectionCells?.map(cell => [cell.column, cell]));
  const segments = transform(base, (segment, column) => {
    const cell = mappedCells.get(column);
    if (running && cell?.key.endsWith(':status') && cell.offset < status.length)
      segment = {...segment, text: status[cell.offset] ?? segment.text};
    if (running && animation.thinking && cell?.key.endsWith(':icon') && cell.offset === 0)
      segment = {...segment, text: stepIcon(animation.step!, now, motion), color: animation.actorColor ?? palette.accent};
    if (running && motion && animation.thinking && !animation.highlighted && cell?.key.endsWith(':title')) {
      const wave = (Math.sin(column * 0.7 - now / 150) + 1) / 2;
      segment = {...segment, color: mixHex(animation.actorColor ?? palette.accent, palette.muted, 0.35 + wave * 0.65)};
    }
    return segment;
  });
  return {...row, ...(breath && row.bg === animation.actorBg ? {bg: breath} : {}), segments, displayText: segments.map(segment => segment.text).join('')};
}
export function presentedSegments(row: SceneRow, index: number, selection: SelectionRange | null): readonly SceneSegment[] {
  const bounds = rowSelectionBounds(row, index, selection);
  const segments = rowSegments(row);
  if (!bounds) return segments;
  let column = 0;
  return segments.flatMap(segment => {
    const parts = sliceRowText(segment.text, Math.max(0, bounds[0] - column), Math.max(0, bounds[1] - column));
    column += stringWidth(segment.text);
    return [{...segment, text: parts.before}, {...segment, text: parts.selected, color: palette.fg, bg: palette.selectionBg}, {...segment, text: parts.after}].filter(part => part.text);
  });
}
