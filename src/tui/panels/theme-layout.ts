import stringWidth from 'string-width';
import type {ThemeRow} from '../../runtime/command-surface.js';
import {legibilityReport, type LegibilityPair} from '../../config/theme-legibility.js';
import {palette} from '../appearance/theme.js';
import {faintColor, mixHex} from '../appearance/colors.js';
import {clipLine} from '../terminal/text.js';
import type {Region} from '../terminal/mouse.js';
import {panePadding, panelRows} from '../components/panel-frame.js';
import {fitRow, sampleRows, type SampleRow, type SampleSeg} from './theme-sample.js';

/**
 * The /theme page is drawn and hit-tested from this one plan: `themeLayout` returns the styled body rows, the regions they were built
 * from and the footer. Wide terminals show the list beside the sample, narrower ones stack them, and a very narrow or short one shows the
 * list alone (the highlighted theme still previews on the page itself).
 */
export type Seg = SampleSeg;
export type ThemeMode = 'wide' | 'stacked' | 'list';
export type ThemeCommand =
  | {readonly kind: 'move'; readonly delta: number}
  | {readonly kind: 'page'; readonly delta: number}
  | {readonly kind: 'edge'; readonly to: 'first' | 'last'}
  /** Highlight (preview) a row; `index: -1` is the highlighted one. */
  | {readonly kind: 'select'; readonly index: number}
  /** Save a row and close; `index: -1` is the highlighted one. */
  | {readonly kind: 'choose'; readonly index: number}
  | {readonly kind: 'cancel'};
export interface ThemeHit {readonly region: Region; readonly command: ThemeCommand}
/** A rectangle of screen cells: columns [x0, x1), rows [y0, y1). */
export interface Area {readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number}
export interface ThemeView {readonly selected: number; readonly scroll: number; readonly sampleScroll: number}
export interface ThemeLayout {
  readonly mode: ThemeMode;
  readonly header: readonly Seg[];
  readonly rows: readonly SampleRow[];
  readonly hits: readonly ThemeHit[];
  readonly footer: {readonly text: string; readonly actions: readonly {readonly label: string; readonly command: ThemeCommand}[]};
  /** Normalised highlight, list scroll and sample scroll (the page stores them). */
  readonly selected: number; readonly scroll: number; readonly sampleScroll: number;
  readonly listRows: number;
  readonly listArea: Area;
  readonly sampleArea: Area | undefined;
}

/** Terminal widths and heights at which the layout changes. */
export const themeTiers = {wideColumns: 96, stackedColumns: 50, wideRows: 12, stackedRows: 18} as const;

/** The next theme that can be chosen, `delta` rows away (wrapping); unavailable rows are skipped. -1 when none can be chosen. */
export function stepSelectable(themes: readonly ThemeRow[], from: number, delta: number): number {
  const usable = themes.map((theme, index) => theme.unavailable ? -1 : index).filter(index => index >= 0);
  if (!usable.length) return -1;
  const at = usable.indexOf(from);
  if (at < 0) return delta < 0 ? usable.at(-1)! : usable[0]!;
  return usable[(at + delta % usable.length + usable.length) % usable.length]!;
}
/** A highlight that is a usable row: the one given, else the saved theme, else the first usable. */
export function normalizeSelection(themes: readonly ThemeRow[], selected: number, current: string): number {
  if (themes[selected] && !themes[selected]!.unavailable) return selected;
  const saved = themes.findIndex(theme => theme.name === current && !theme.unavailable);
  return saved >= 0 ? saved : themes.findIndex(theme => !theme.unavailable);
}

/** Contrast ratios cut (not rounded) to two decimals, so a shown number is at or above its threshold exactly when the pair passes. */
export const ratioText = (ratio: number): string => (Math.floor(ratio * 100 + 1e-9) / 100).toFixed(2);

/** Rows of the legibility block for the current palette: the summary first, then `label ratio` cells, then the confusable colour pairs. */
export function legibilityRows(width: number): SampleRow[] {
  const report = legibilityReport(palette), rows: SampleRow[] = [];
  rows.push([{text: report.summary, color: report.failing === 0 ? palette.success : palette.warning, bold: true}]);
  const cell = (pair: LegibilityPair, room: number): Seg[] => {
    const text = pair.label.padEnd(Math.max(...report.pairs.map(item => item.label.length)) + 1) + ratioText(pair.ratio);
    return [{text: clipLine(text, room), color: pair.ok ? palette.success : palette.warning}];
  };
  const labelWidth = Math.max(...report.pairs.map(item => item.label.length)) + 1 + 5;
  if (width >= labelWidth * 2 + 3) {
    const half = Math.ceil(report.pairs.length / 2);
    for (let index = 0; index < half; index++) {
      const left = cell(report.pairs[index]!, labelWidth), right = report.pairs[index + half];
      rows.push(right ? [...left, {text: ' '.repeat(Math.max(1, labelWidth + 3 - stringWidth(left.map(seg => seg.text).join('')))), color: palette.fg}, ...cell(right, labelWidth)] : left);
    }
  } else for (const pair of report.pairs) rows.push(cell(pair, width));
  for (const pair of report.confusable) rows.push([{text: pair.a + ' ≈ ' + pair.b, color: palette.warning}]);
  return rows;
}

/** The plan: styled body rows, header, footer and every click region, in screen cells for a page whose top rule is at row `y`. */
export function themeLayout(input: {
  themes: readonly ThemeRow[]; current: string; view: ThemeView; width: number; height: number; y: number;
  saving: boolean; error: string;
}): ThemeLayout {
  const {themes, current, view, width, height, y, saving, error} = input;
  const padding = panePadding(width), columns = Math.max(1, width - 2 * padding), frame = panelRows(height), body = frame.bodyHeight;
  const bodyY = y + frame.bodyY;
  const mode: ThemeMode = columns >= themeTiers.wideColumns && body >= themeTiers.wideRows ? 'wide'
    : columns >= themeTiers.stackedColumns && body >= themeTiers.stackedRows ? 'stacked' : 'list';
  const selected = normalizeSelection(themes, view.selected, current), faint = faintColor(), selectedBg = mixHex(palette.accent, palette.bg, 0.12);

  // Geometry of the list column(s).
  const longest = Math.max(8, ...themes.map(theme => stringWidth(theme.name) + (theme.source === 'user' ? 7 : 0)));
  const listWidth = mode === 'wide' ? Math.min(36, Math.max(26, longest + 6)) : columns;
  const stackedList = mode === 'stacked' ? Math.min(themes.length, Math.max(3, Math.floor(body * 0.34))) : 0;
  const listRows = mode === 'list' ? Math.max(1, body) : mode === 'wide' ? Math.max(1, body) : Math.max(1, stackedList);
  let scroll = Math.max(0, Math.min(view.scroll, Math.max(0, themes.length - listRows)));
  if (selected >= 0) {
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + listRows) scroll = selected - listRows + 1;
  }
  scroll = Math.max(0, Math.min(scroll, Math.max(0, themes.length - listRows)));

  const hits: ThemeHit[] = [];
  const listX = padding;
  const listRow = (offset: number): SampleRow => {
    const index = scroll + offset, theme = themes[index];
    if (!theme) return fitRow([], listWidth);
    const here = index === selected, saved = theme.name === current && !theme.unavailable, bg = here ? selectedBg : undefined;
    const tint = (seg: Seg): Seg => bg ? {...seg, bg} : seg;
    const segs: Seg[] = [tint({text: here ? '❯ ' : '  ', color: palette.accent, bold: true})];
    if (theme.unavailable) {
      segs.push(tint({text: theme.name, color: palette.muted, italic: true}), tint({text: ' ✗ ', color: palette.error}), tint({text: theme.unavailable, color: palette.error}));
      return fitRow(segs, listWidth, bg);
    }
    segs.push(tint({text: theme.name, color: here ? palette.fg : palette.muted, bold: here}));
    if (theme.source === 'user') segs.push(tint({text: ' · user', color: faint}));
    const used = segs.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
    if (saved) segs.push(tint({text: ' '.repeat(Math.max(1, listWidth - used - 1)), color: palette.fg}), tint({text: '✓', color: palette.success, bold: true}));
    return fitRow(segs, listWidth, bg);
  };
  const listRegion = (offset: number, x0: number, x1: number, rowY: number) => {
    const index = scroll + offset, theme = themes[index];
    if (theme && !theme.unavailable) hits.push({region: {y: rowY, x0, x1}, command: {kind: 'choose', index}});
  };

  const rows: SampleRow[] = [];
  let sampleArea: Area | undefined, sampleScroll = 0;
  const rule = (span: number): SampleRow => [{text: '─'.repeat(span), color: palette.line}];
  const pad = (row: SampleRow, span: number): SampleRow => fitRow(row, span);
  const gutter: SampleRow = [{text: ' '.repeat(padding), color: palette.fg}];
  const full = (row: SampleRow): SampleRow => [...gutter, ...row, ...gutter];

  if (mode === 'list') {
    for (let offset = 0; offset < body; offset++) {
      rows.push(full(offset < listRows ? listRow(offset) : pad([], listWidth)));
      listRegion(offset, 0, width, bodyY + offset);
    }
  } else {
    const rightWidth = mode === 'wide' ? Math.max(1, columns - listWidth - 3) : columns;
    const legibility = legibilityRows(rightWidth);
    if (mode === 'wide') {
      const legHeight = Math.min(legibility.length, Math.max(3, body - 8));
      const sampleHeight = Math.max(0, body - legHeight - 1);
      const all = sampleRows(rightWidth);
      sampleScroll = Math.max(0, Math.min(view.sampleScroll, Math.max(0, all.length - sampleHeight)));
      const shown = all.slice(sampleScroll, sampleScroll + sampleHeight);
      const right: SampleRow[] = [...shown, ...Array.from({length: Math.max(0, sampleHeight - shown.length)}, () => pad([], rightWidth)), rule(rightWidth), ...legibility.slice(0, legHeight)];
      const x0 = padding + listWidth + 3;
      sampleArea = {x0, x1: x0 + rightWidth, y0: bodyY, y1: bodyY + sampleHeight};
      for (let offset = 0; offset < body; offset++) {
        const left = offset < listRows ? listRow(offset) : pad([], listWidth);
        rows.push([...gutter, ...left, {text: ' │ ', color: palette.line}, ...pad(right[offset] ?? [], rightWidth), ...gutter]);
        listRegion(offset, 0, padding + listWidth + 2, bodyY + offset);
      }
    } else {
      const legHeight = Math.min(legibility.length, Math.max(2, Math.floor((body - listRows - 1) / 2)));
      const sampleHeight = Math.max(0, body - listRows - 1 - legHeight - (legHeight ? 1 : 0));
      const all = sampleRows(rightWidth);
      sampleScroll = Math.max(0, Math.min(view.sampleScroll, Math.max(0, all.length - sampleHeight)));
      const shown = all.slice(sampleScroll, sampleScroll + sampleHeight);
      for (let offset = 0; offset < listRows; offset++) {rows.push(full(listRow(offset))); listRegion(offset, 0, width, bodyY + offset);}
      rows.push(full(rule(columns)));
      sampleArea = {x0: padding, x1: padding + columns, y0: bodyY + listRows + 1, y1: bodyY + listRows + 1 + sampleHeight};
      for (const row of shown) rows.push(full(row));
      for (let offset = shown.length; offset < sampleHeight; offset++) rows.push(full(pad([], columns)));
      if (legHeight) {rows.push(full(rule(columns))); for (const row of legibility.slice(0, legHeight)) rows.push(full(row));}
    }
  }
  while (rows.length < body) rows.push(pad([], width));
  rows.length = Math.max(0, body);

  const hints = [{label: '↑↓ preview', command: {kind: 'move', delta: 1} as ThemeCommand}, {label: 'Enter use', command: {kind: 'choose', index: -1} as ThemeCommand}, {label: 'Esc cancel', command: {kind: 'cancel'} as ThemeCommand}];
  const footerText = saving ? 'Saving…' : error || hints.map(hint => hint.label).join(' · ');
  const name = themes[selected]?.name;
  const header: Seg[] = [{text: 'Theme', color: palette.fg, bold: true}];
  if (name) header.push({text: ' · ', color: faint}, {text: name === current ? 'current' : 'previewing ' + name, color: name === current ? palette.muted : palette.accent});
  const area = (x0: number, x1: number, y0: number, y1: number): Area => ({x0, x1, y0, y1});
  return {mode, header, rows, hits, footer: {text: footerText, actions: hints}, selected, scroll, sampleScroll, listRows,
    listArea: mode === 'wide' ? area(0, padding + listWidth + 2, bodyY, bodyY + body) : area(0, width, bodyY, bodyY + listRows), sampleArea};
}
