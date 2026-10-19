import {performance} from 'node:perf_hooks';
import stringWidth from 'string-width';
import type {SceneRow, SceneSegment} from './scene.js';
import {palette} from './cards.js';
import {decorateRow, presentedSegments} from './row-presentation.js';
import {rowSelectionBounds, type Row, type SelectionRange} from './viewport.js';

export interface PlaneFrame {readonly rows: readonly Row[]; readonly start: number; readonly width: number; readonly height: number; readonly selection: SelectionRange | null; readonly motion?: boolean}
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
    (segment.bold ? '\x1b[1m' : '') + (segment.italic ? '\x1b[3m' : '') + segment.text + reset;
}
const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});
const widths = new Map<string, number>();
function glyphWidth(text: string): number {
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
const encoded = new WeakMap<Row, {width: number; text: string}>();
export function encodeRow(raw: Row, index: number, selection: SelectionRange | null, width = Infinity): string {
  const bounds = rowSelectionBounds(raw, index, selection);
  if (!bounds) {const known = encoded.get(raw); if (known?.width === width) return known.text;}
  const row = raw as SceneRow;
  const rail = row.gutterCols > 0 ? styled({text: '▎ ', color: row.railColor}) : '';
  const body = presentedSegments(row, index, selection).map(segment => styled(segment, palette.fg, row.bg)).join('');
  const result = clipEncoded(rail + body + reset, width);
  if (!bounds) encoded.set(raw, {width, text: result});
  return result;
}

/** Owns only the history rectangle. Ink's surrounding UI never participates in a scroll frame. */
export class TerminalPlane {
  private frame: PlaneFrame | undefined;
  private previous: PlaneFrame | undefined;
  private previousLines: readonly string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queued = false;
  private animationTimer: ReturnType<typeof setTimeout> | undefined;
  private displayedRows: readonly Row[] = [];
  private clock = Date.now();
  private lastPaint = -Infinity;
  private active = false;
  private closed = false;
  private outputHeld = false;
  constructor(private readonly write: (text: string) => void, private readonly onFrame?: (metrics: PlaneMetrics) => void) {}

  get rows(): readonly Row[] {return this.displayedRows;}
  get time(): number {return this.clock;}
  present(frame: PlaneFrame): void {
    if (this.frame && (this.frame.width !== frame.width || this.frame.height !== frame.height)) this.erase();
    this.frame = frame;
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
    // Escape-only cursor/mouse mode changes do not damage the canvas.
    const visible = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, '');
    if (/[^\x00-\x1f\x7f-\x9f]/.test(visible) || /\x1b\[[\d;]*[JKHf]/.test(text)) this.invalidate();
    this.flush();
  }
  invalidate(): void {this.previous = undefined; this.previousLines = [];}
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
    if (!hasRunning) return;
    this.animationTimer = setTimeout(() => {this.animationTimer = undefined; this.flush();}, this.frame?.motion === false ? 100 : 80);
    this.animationTimer.unref?.();
  }
  private cancel(): void {this.cancelAnimation(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.queued = false;}
  dispose(): void {this.closed = true; this.cancel(); this.frame = undefined;}
  flush(): void {
    this.cancel();
    const frame = this.frame;
    if (!frame || !this.active || this.closed || this.outputHeld) return;
    const began = performance.now();
    this.clock = Date.now();
    this.displayedRows = frame.rows.map(row => decorateRow(row, this.clock, frame.motion !== false));
    const lines = Array.from({length: frame.height}, (_, index) => this.displayedRows[index] ? encodeRow(this.displayedRows[index]!, index, frame.selection, frame.width) : '');
    const previous = this.previous;
    let shifted = [...this.previousLines], scrolled = 0;
    const delta = previous ? frame.start - previous.start : 0;
    if (previous && previous.width === frame.width && previous.height === frame.height && delta && Math.abs(delta) < frame.height) {
      const count = frame.height - Math.abs(delta);
      let matches = 0;
      for (let i = 0; i < count; i++) if (lines[i + Math.max(0, -delta)] === shifted[i + Math.max(0, delta)]) matches++;
      if (matches === count) {
        scrolled = delta;
        shifted = delta > 0 ? [...shifted.slice(delta), ...Array<string>(delta).fill('')] : [...Array<string>(-delta).fill(''), ...shifted.slice(0, delta)];
      }
    }
    const chunks: string[] = [];
    if (scrolled) chunks.push(reset + `\x1b[1;${frame.height}r\x1b[${Math.abs(scrolled)}${scrolled > 0 ? 'S' : 'T'}\x1b[r`);
    let paintedRows = 0;
    for (let i = 0; i < lines.length; i++) {
      // A newly exposed blank row has already been cleared by SU/SD.
      if (previous && previous.width === frame.width && previous.height === frame.height && lines[i] === shifted[i]) continue;
      chunks.push(`\x1b[${i + 1};1H${reset}\x1b[2K${lines[i]}`); paintedRows++;
    }
    this.previous = frame; this.previousLines = lines;
    if (chunks.length) {
      // DEC save/restore preserves Ink's composer cursor (including pending wrap); margins are always reset.
      this.write('\x1b[?2026h\x1b7' + chunks.join('') + reset + '\x1b8\x1b[?2026l');
      this.lastPaint = performance.now();
      this.onFrame?.({renderTime: performance.now() - began, scrolled, paintedRows});
    }
    this.armAnimation();
  }
}
