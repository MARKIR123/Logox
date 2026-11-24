import {performance} from 'node:perf_hooks';
import stringWidth from 'string-width';
import type {SceneRow, SceneSegment} from '../timeline/scene.js';
import {palette} from '../appearance/theme.js';
import {themeRevision} from '../../config/theme-palette.js';
import {decorateRow, presentedSegments, railCell} from '../timeline/row-presentation.js';
import {rowSelectionBounds, type Row, type SelectionRange} from '../timeline/viewport.js';
import {formatClock} from './text.js';
import {imageGraphics, type EncodeSpec} from './image-graphics.js';

/** A picture drawn as Sixel pixels over cells: `x`, `y` are screen cells, `id` names the picture, `spec` what to encode. */
export interface Placed {readonly id: string; readonly x: number; readonly y: number; readonly cols: number; readonly rows: number; readonly spec: EncodeSpec}
const sameSpot = (a: Placed, b: Placed): boolean => a.id === b.id && a.x === b.x && a.y === b.y && a.cols === b.cols && a.rows === b.rows;

/** A segment of a side line; `clock` marks a fixed-width placeholder the plane fills with the time elapsed since that epoch time (ms) each second. */
export interface SideSegment extends SceneSegment {readonly clock?: number}
/** A column drawn beside the history: `lines` (one per row, each exactly `width` cells) at column `x`. The plane repaints only the lines that changed. */
export interface PlaneSide {
  readonly x: number; readonly width: number; readonly lines: readonly (readonly SideSegment[])[];
  /** A short animation (the team stage's pulse): the lines for the plane's clock `now`, and whether it still runs; the plane asks again on its animation frame until `busy` is false. `motion` is the reduced-motion setting. */
  readonly animate?: (now: number, motion: boolean) => {readonly lines: readonly (readonly SideSegment[])[]; readonly busy: boolean};
}
export interface PlaneFrame {readonly rows: readonly Row[]; readonly start: number; readonly width: number; readonly height: number; readonly selection: SelectionRange | null; readonly motion?: boolean; readonly hoveredFoldId?: string | null; readonly side?: PlaneSide | undefined}
export interface PlaneMetrics {readonly renderTime: number; readonly scrolled: number; readonly paintedRows: number}
const reset = '\x1b[0m';
function rgb(color: string | undefined, background = false): string {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return '';
  const value = Number.parseInt(color.slice(1), 16);
  return `\x1b[${background ? 48 : 38};2;${value >> 16};${(value >> 8) & 255};${value & 255}m`;
}
function styled(segment: SceneSegment, color?: string, bg?: string): string {
  if (!segment.text) return '';
  return reset + rgb(segment.color ?? color) + rgb(segment.bg ?? bg, true) +
    (segment.bold ? '\x1b[1m' : '') + (segment.italic ? '\x1b[3m' : '') + (segment.underline ? '\x1b[4m' : '') + segment.text + reset;
}
const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});
const widths = new Map<string, number>();
function glyphWidth(text: string): number {
  if (text.length === 1 && text.charCodeAt(0) < 128) return 1;
  const known = widths.get(text); if (known !== undefined) return known;
  const width = stringWidth(text);
  if (widths.size >= 2048) widths.clear();
  widths.set(text, width); return width;
}
function clipEncoded(text: string, width: number): string {
  if (!Number.isFinite(width)) return text;
  let result = '', used = 0;
  for (const token of text.matchAll(/\x1b\[[\d;]*m|[^\x1b]+/g)) {
    if (token[0].startsWith('\x1b')) {result += token[0]; continue;}
    for (const {segment} of graphemes.segment(token[0])) {
      const size = glyphWidth(segment);
      if (used + size > width) return result + reset;
      result += segment; used += size;
    }
  }
  return result;
}
/** One side line as terminal text; clock placeholders show the time elapsed at `now`. */
export function encodeSide(segments: readonly SideSegment[] | undefined, now: number): string {
  if (!segments) return '';
  return segments.map(segment => styled(segment.clock === undefined ? segment : {...segment, text: formatClock(now - segment.clock).padEnd(segment.text.length)}, palette.fg)).join('') + reset;
}
const encoded = new WeakMap<Row, {revision: number; width: number; text: string}>();
export function encodeRow(raw: Row, index: number, selection: SelectionRange | null, width = Infinity, isHovered = false): string {
  const bounds = rowSelectionBounds(raw, index, selection);
  if (!bounds && !isHovered) {const known = encoded.get(raw); if (known?.width === width && known.revision === themeRevision()) return known.text;}
  const row = raw as SceneRow;
  const rail = row.gutterCols > 0 ? styled(railCell(row)) : '';
  const body = presentedSegments(row, index, selection, isHovered).map(segment => styled(segment, palette.fg, row.bg)).join('');
  const result = clipEncoded(rail + body + reset, width);
  if (!bounds && !isHovered) encoded.set(raw, {revision: themeRevision(), width, text: result});
  return result;
}

/** Owns only the history rectangle. Ink's surrounding UI never participates in a scroll frame. */
export class TerminalPlane {
  private frame: PlaneFrame | undefined;
  private previous: PlaneFrame | undefined;
  private previousLines: readonly string[] = [];
  private previousSide: readonly string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queued = false;
  private animationTimer: ReturnType<typeof setTimeout> | undefined;
  private displayedRows: readonly Row[] = [];
  private clock = Date.now();
  private lastPaint = -Infinity;
  private lastInputAt = -Infinity;
  private active = false;
  private closed = false;
  private outputHeld = false;
  private sideBusy = false;
  /** Pictures believed to be on screen as Sixel pixels (timeline thumbnails), and the lightbox picture wanted and shown. */
  private shown: Placed[] = [];
  private overlayWanted: Placed | null = null;
  private overlayShown: Placed | null = null;
  private readonly stopImages: () => void;
  constructor(private readonly write: (text: string) => void, private readonly onFrame?: (metrics: PlaneMetrics) => void) {
    this.stopImages = imageGraphics.subscribe(() => {if (this.closed) return; this.drawOverlay(); if (this.frame) this.flush();});
  }

  get rows(): readonly Row[] {return this.displayedRows;}
  get time(): number {return this.clock;}
  get height(): number {return this.frame?.height ?? 0;}
  noteInput(): void {this.lastInputAt = performance.now();}
  present(frame: PlaneFrame): void {
    if (this.frame && (this.frame.width !== frame.width || this.frame.height !== frame.height || this.frame.side?.x !== frame.side?.x || this.frame.side?.width !== frame.side?.width)) this.erase();
    const hoverChanged = this.frame?.hoveredFoldId !== frame.hoveredFoldId;
    // The first content after an empty history (a new approval, the first message) must not wait for frame pacing.
    const firstContent = this.displayedRows.length === 0 && frame.rows.length > 0;
    this.frame = frame;
    if ((hoverChanged || firstContent) && this.active && !this.closed && !this.outputHeld) {
      this.flush();
      return;
    }
    if (this.timer || this.queued || !this.active || this.closed || this.outputHeld) return;
    const wait = 16 - (performance.now() - this.lastPaint);
    if (wait <= 0) {
      this.queued = true;
      queueMicrotask(() => {if (this.queued) this.flush();});
    } else this.timer = setTimeout(() => {this.timer = undefined; this.flush();}, wait);
  }
  /** Ink may erase any history cells during layout/resize. Restore them after its write. */
  afterInkWrite(text: string): void {
    if (text.includes('\x1b[?1049l')) {this.active = false; this.cancel(); return;}
    if (text.includes('\x1b[?1049h')) {this.active = true; this.invalidate();}
    if (!this.active || this.closed) return;
    if (text.includes('\x1b[2J') || text.includes('\x1b[1;1H\x1b[J') || text.includes('\x1b[H\x1b[J')) this.invalidate();
    this.flush();
    if (this.overlayWanted) this.drawOverlay();
  }
  /** A cleared or repainted screen no longer shows any picture: the next frame draws them again. */
  invalidate(): void {this.previous = undefined; this.previousLines = []; this.previousSide = []; this.shown = []; this.overlayShown = null;}
  /**
   * The lightbox's picture: `null` removes it (its cells are blanked). The picture is drawn after the next Ink write, or when its encoding
   * lands; Ink keeps painting the half-block cells beneath, which are the fallback and never change while the placement holds.
   */
  setOverlay(placed: Placed | null): void {
    const before = this.overlayWanted;
    this.overlayWanted = placed;
    if (!placed) {this.eraseOverlay(); return;}
    if (before && !sameSpot(before, placed)) this.eraseOverlay();
    if (!this.outputHeld && imageGraphics.encoded(placed.spec) !== undefined) this.drawOverlay();
  }
  private eraseOverlay(): void {
    const shown = this.overlayShown;
    this.overlayShown = null;
    if (!shown || !this.active || this.closed) return;
    const rows = Array.from({length: shown.rows}, (_, i) => `\x1b[${shown.y + i + 1};${shown.x + 1}H${rgb(shown.spec.bg, true)}\x1b[${shown.cols}X`).join('');
    this.write('\x1b[?2026h\x1b7' + rows + reset + '\x1b8\x1b[?2026l');
  }
  private drawOverlay(): void {
    const wanted = this.overlayWanted;
    if (!wanted || !this.active || this.closed || (this.overlayShown && sameSpot(this.overlayShown, wanted))) return;
    const data = imageGraphics.encoded(wanted.spec);
    if (data === undefined) return;
    this.write('\x1b[?2026h\x1b7' + `\x1b[${wanted.y + 1};${wanted.x + 1}H` + data + reset + '\x1b8\x1b[?2026l');
    this.overlayShown = wanted;
  }
  beginOutput(): void {this.outputHeld = true; this.cancel();}
  endOutput(): void {this.outputHeld = false; this.flush();}
  private erase(): void {
    if (this.active && !this.closed && !this.outputHeld && this.frame?.height) {
      const rows = Array.from({length: this.frame.height}, (_, i) => `\x1b[${i + 1};1H\x1b[2K`).join('');
      this.write('\x1b[?2026h\x1b7' + reset + rows + '\x1b8\x1b[?2026l');
    }
    this.invalidate();
  }
  hide(): void {this.erase(); this.frame = undefined; this.displayedRows = []; this.cancel();}
  private cancelAnimation(): void {if (this.animationTimer) clearTimeout(this.animationTimer); this.animationTimer = undefined;}
  private armAnimation(): void {
    this.cancelAnimation();
    if (!this.active || this.closed) return;
    const hasRunning = this.frame?.rows.some(raw => {
      const a = (raw as SceneRow).animation;
      return a?.step?.state === 'running' || a?.active;
    });
    if (!hasRunning) {
      // A side animation (the team pulse) asks for the animation frame rhythm until it is done.
      if (this.sideBusy) {
        this.animationTimer = setTimeout(() => {this.animationTimer = undefined; this.flush();}, this.frame?.motion === false ? 100 : 80);
        this.animationTimer.unref?.();
        return;
      }
      // A side column with an elapsed clock only needs the next whole second.
      if (this.frame?.side?.lines.some(line => line.some(segment => segment.clock !== undefined))) {
        this.animationTimer = setTimeout(() => {this.animationTimer = undefined; this.flush();}, 1010 - (Date.now() % 1000));
        this.animationTimer.unref?.();
      }
      return;
    }
    const sinceInput = performance.now() - this.lastInputAt;
    const baseWait = this.frame?.motion === false ? 100 : 80;
    const wait = sinceInput < 120 ? Math.max(baseWait, 150 - Math.round(sinceInput)) : baseWait;
    this.animationTimer = setTimeout(() => {this.animationTimer = undefined; this.flush();}, wait);
    this.animationTimer.unref?.();
  }
  /** Pictures whose rows are all on screen inside the history rectangle; a partly visible one stays as half blocks. */
  private placements(frame: PlaneFrame): Placed[] {
    const found: Placed[] = [], rows = this.displayedRows as readonly SceneRow[];
    for (let i = 0; i < frame.height; i++) {
      const image = rows[i]?.image;
      if (!image || image.slot !== 0 || i + image.slots > frame.height) continue;
      let whole = true;
      for (let k = 1; k < image.slots && whole; k++) {const next = rows[i + k]?.image; whole = Boolean(next && next.id === image.id && next.slot === k);}
      const x = rows[i]!.gutterCols + image.indent;
      if (whole && x + image.cols <= frame.width) found.push({id: image.id, x, y: i, cols: image.cols, rows: image.slots, spec: image.spec});
    }
    return found;
  }
  private cancel(): void {this.cancelAnimation(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.queued = false;}
  dispose(): void {this.closed = true; this.cancel(); this.frame = undefined; this.stopImages();}
  flush(): void {
    this.cancel();
    const frame = this.frame;
    if (!frame || !this.active || this.closed || this.outputHeld) return;
    const began = performance.now();
    this.clock = Date.now();
    this.displayedRows = frame.rows.map(row => decorateRow(row, this.clock, frame.motion !== false));
    const hoveredFoldId = frame.hoveredFoldId;
    const lines = Array.from({length: frame.height}, (_, index) => {
      const row = this.displayedRows[index];
      if (!row) return '';
      const isHovered = Boolean(hoveredFoldId && (row as SceneRow).hover?.foldId === hoveredFoldId);
      return encodeRow(row, index, frame.selection, frame.width, isHovered);
    });
    const side = frame.side;
    const live = side?.animate?.(this.clock, frame.motion !== false);
    this.sideBusy = Boolean(live?.busy);
    const sideSource = live?.lines ?? side?.lines ?? [];
    const sideLines = side ? Array.from({length: frame.height}, (_, index) => encodeSide(sideSource[index], this.clock)) : [];
    const previous = this.previous;
    const same = Boolean(previous && previous.width === frame.width && previous.height === frame.height && previous.side?.x === side?.x && previous.side?.width === side?.width);
    let shifted = [...this.previousLines], scrolled = 0;
    const delta = previous ? frame.start - previous.start : 0;
    if (same && delta && Math.abs(delta) < frame.height) {
      const count = frame.height - Math.abs(delta);
      let matches = 0;
      for (let i = 0; i < count; i++) if (lines[i + Math.max(0, -delta)] === shifted[i + Math.max(0, delta)]) matches++;
      if (matches === count) {
        scrolled = delta;
        shifted = delta > 0 ? [...shifted.slice(delta), ...Array<string>(delta).fill('')] : [...Array<string>(-delta).fill(''), ...shifted.slice(0, delta)];
      }
    }
    // Sixel pictures: any that moved, scrolled or lost a repainted row are blanked by repainting their rows (cell text overwrites pixels), then drawn again.
    const wanted = imageGraphics.active ? this.placements(frame) : [];
    const stale = scrolled !== 0 || !same ? this.shown : this.shown.filter(spot => !wanted.some(want => sameSpot(want, spot)));
    const forced = new Set<number>();
    for (const spot of stale) for (let r = spot.y; r < spot.y + spot.rows; r++) forced.add(r);
    const repainted = new Set<number>();
    const chunks: string[] = [];
    if (scrolled) chunks.push(reset + `\x1b[1;${frame.height}r\x1b[${Math.abs(scrolled)}${scrolled > 0 ? 'S' : 'T'}\x1b[r`);
    let paintedRows = 0;
    for (let i = 0; i < lines.length; i++) {
      // A newly exposed blank row has already been cleared by SU/SD.
      const historyDirty = !(same && lines[i] === shifted[i]) || forced.has(i);
      if (historyDirty) repainted.add(i);
      // The scroll moves the side column with the rows, so every side line is painted again after one; otherwise only a changed side line is.
      const sideDirty = side !== undefined && (scrolled !== 0 || !same || sideLines[i] !== this.previousSide[i]);
      // Beside a side column a row is padded to its width instead of erased to the end of the line, which would wipe the side line.
      if (historyDirty) chunks.push(side ? `\x1b[${i + 1};1H${reset}${lines[i]}${' '.repeat(Math.max(0, frame.width - stringWidth(lines[i]!.replace(/\x1b\[[\d;]*m/g, ''))))}`
        : `\x1b[${i + 1};1H${reset}\x1b[2K${lines[i]}`);
      if (sideDirty && side) chunks.push(`\x1b[${i + 1};${side.x + 1}H${reset}${sideLines[i]}`);
      if (historyDirty || sideDirty) paintedRows++;
    }
    this.previous = frame; this.previousLines = lines; this.previousSide = sideLines;
    const kept = this.shown.filter(spot => !stale.includes(spot) && ![...repainted].some(row => row >= spot.y && row < spot.y + spot.rows));
    for (const want of wanted) {
      if (kept.some(spot => sameSpot(spot, want))) continue;
      const data = imageGraphics.encoded(want.spec);
      if (data === undefined) continue; // the half blocks stay until the worker has it
      chunks.push(`\x1b[${want.y + 1};${want.x + 1}H${reset}${data}`);
      kept.push(want);
    }
    this.shown = kept;
    if (chunks.length) {
      // DEC save/restore preserves Ink's composer cursor (including pending wrap); margins are always reset.
      this.write('\x1b[?2026h\x1b7' + chunks.join('') + reset + '\x1b8\x1b[?2026l');
      this.lastPaint = performance.now();
      this.onFrame?.({renderTime: performance.now() - began, scrolled, paintedRows});
    }
    this.armAnimation();
  }
}
