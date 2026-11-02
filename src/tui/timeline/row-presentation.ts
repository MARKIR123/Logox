import stringWidth from 'string-width';
import type {Step} from '../../runtime/contracts.js';
import {stepElapsed} from '../../runtime/steps.js';
import {stepIcon, thinkingDuration, stepStatus, swarmElapsed} from '../appearance/animation.js';
import {mixHex} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import type {SceneRow, SceneSegment} from './scene.js';
import {rowSelectionBounds, sliceRowText, type Row, type SelectionRange} from './viewport.js';

const glyphs = new Intl.Segmenter('zh', {granularity: 'grapheme'});

export function rowSegments(row: SceneRow, isHovered = false): readonly SceneSegment[] {
  let segments = row.segments;
  if (!segments || !segments.length) {
    const color = row.color ?? (row.tone === 'header' ? row.railColor : row.tone === 'direction' ? palette.muted : palette.fg);
    segments = [...row.prefixSegments ?? [], {text: row.text, color, ...(row.bg ? {bg: row.bg} : {}), bold: row.tone === 'header', italic: row.tone === 'direction'}, ...row.suffixSegments ?? []];
  }
  const highlight = row.hoverColor ?? row.railColor;
  if (isHovered && highlight) {
    return segments.map(s => (!s.color || s.color === palette.muted ? {...s, color: highlight} : s));
  }
  return segments;
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
const decoratedCache = new WeakMap<Row, {animNow: number; motion: boolean; decorated: SceneRow}>();

function extractToolWordLength(text: string): number {
  const clean = text.trim();
  if (clean.startsWith('Thinking')) return clean.startsWith('Thinking...') ? 11 : 8;
  const match = /^([a-zA-Z0-9_]+)/.exec(clean);
  return match ? match[1]!.length : clean.length;
}

function dshShimmerLuster(offset: number, wordLength: number, now: number, stepMs = 60): number {
  const windowSize = 8;
  const cycle = Math.max(wordLength + 14, 20);
  const glimmerStart = (Math.floor(now / stepMs) % cycle) - 7;
  const inBeam = offset >= glimmerStart && offset < glimmerStart + windowSize;
  if (!inBeam) return 0;
  const center = glimmerStart + windowSize / 2;
  const dist = Math.abs(offset - center) / (windowSize / 2);
  return Math.max(0, 1 - dist * dist);
}

/** Color and fixed-size slots only: no layout or runtime publication on a clock tick. */
export function decorateRow(raw: Row, now: number, motion = true): SceneRow {
  const row = raw as SceneRow, animation = row.animation;
  if (!animation) return row;
  const running = animation.step?.state === 'running';
  const activeActor = Boolean(animation.active);
  if (!running && !activeActor) return row;
  if (!motion && !running) return row;

  const animNow = Math.floor(now / 100) * 100;
  const cached = decoratedCache.get(raw);
  if (cached && cached.animNow === animNow && cached.motion === motion) {
    return cached.decorated;
  }

  const status = animation.step && running ? animation.thinking ? thinkingDuration(animation.step, now) : stepStatus(animation.step, now).trim().slice(0, 7) : '';
  const base = rowSegments(row);
  const mappedCells = new Map(row.selectionCells?.map(cell => [cell.column, cell]));
  const actorColor = animation.actorColor ?? palette.accent;
  const isWorking = (running && animation.thinking) || activeActor;
  const isRunningTool = running && !animation.thinking;

  const titleSegment = base.find(s => s.selectionKey?.endsWith(':title'));
  const titleText = titleSegment?.text ?? '';
  const toolWordLen = isRunningTool || (running && animation.thinking) ? extractToolWordLength(titleText) : 0;
  const frame = Math.floor(now / 200);
  const highlightColor = mixHex(palette.fg, actorColor, 0.85);


  const segments = transform(base, (segment, column) => {
    const cell = mappedCells.get(column);
    if (running && cell?.key.endsWith(':status') && cell.offset < status.length)
      segment = {...segment, text: status[cell.offset] ?? segment.text};
    if (running && animation.step && cell?.key.endsWith(':swarm_icon') && cell.offset === 0) segment = {...segment, text: stepIcon(animation.step, now, motion, animation.frames), color: actorColor};
    if (running && animation.step && cell?.key.endsWith(':swarm_time')) segment = {...segment, text: swarmElapsed(stepElapsed(animation.step, now))[cell.offset] ?? ' '};
    if (isWorking && cell?.key.endsWith(':icon') && cell.offset === 0) {
      if (!activeActor || !animation.open) {
        segment = {...segment, text: stepIcon(animation.step ?? ({state: 'running'} as Step), now, motion, animation.frames), color: actorColor};
      }
    } else if (isRunningTool && cell?.key.endsWith(':icon') && cell.offset === 0) {
      // Breath: the running ▮ rises and falls between muted and the role color on a 2 s cycle of 200 ms frames.
      segment = {...segment, text: '▮', color: motion ? mixHex(palette.muted, actorColor, (Math.sin(frame * Math.PI / 5) + 1) / 2) : mixHex(palette.muted, actorColor, 0.5)};
    }
    if (running && (isRunningTool || animation.thinking) && cell?.key.endsWith(':title')) {
      if (animation.highlighted) {
        // Keep hover highlight color
      } else if (motion && cell.offset < toolWordLen) {
        const luster = dshShimmerLuster(cell.offset, toolWordLen, now);
        segment = {...segment, color: mixHex(actorColor, palette.fg, luster), bold: luster > 0.35};
      } else {
        segment = {...segment, color: palette.fg};
      }
    }
    return segment;
  });
  const decorated = {...row, segments, displayText: segments.map(segment => segment.text).join('')};
  decoratedCache.set(raw, {animNow, motion, decorated});
  return decorated;
}
export function presentedSegments(row: SceneRow, index: number, selection: SelectionRange | null, isHovered = false): readonly SceneSegment[] {
  const bounds = rowSelectionBounds(row, index, selection);
  const segments = rowSegments(row, isHovered);
  if (!bounds) return segments;
  let column = 0;
  return segments.flatMap(segment => {
    const parts = sliceRowText(segment.text, Math.max(0, bounds[0] - column), Math.max(0, bounds[1] - column));
    column += stringWidth(segment.text);
    return [{...segment, text: parts.before}, {...segment, text: parts.selected, color: palette.selectionFg, bg: palette.selectionBg}, {...segment, text: parts.after}].filter(part => part.text);
  });
}
