/**
 * The list pages of the sidebar (the Changes and Usage tabs) as pure functions: a model of fixed head lines and two-line items (`changesModel()`, `usageModel()`),
 * `paintList()` (model + view -> one line of segments per row, `content` cells wide, no border), and the reducers `stepListKey()` and `stepListMouse()`. The view is the
 * scroll offset, the selected item and the hovered one; an item is activated by a click (hover shows it) or Enter. `use-team-sidebar.ts` hosts the pages next to Team.
 */
import stringWidth from 'string-width';
import {faintColor} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import type {SideSegment} from '../terminal/terminal-plane.js';
import {fit} from './panel-text.js';
import type {FileChange} from './changes-model.js';

export type Line = readonly SideSegment[];
/** One list item: its two lines (name and figures, then a faint detail line) and what activating it does. */
export interface ListItem {readonly id: string; readonly lines: readonly [Line, Line]}
export interface ListModel {
  /** Fixed lines above the scrolling list (a summary and a rule). */
  readonly head: readonly Line[];
  readonly items: readonly ListItem[];
  /** Shown instead of the items when there are none. */
  readonly empty: readonly string[];
}
export const ITEM_ROWS = 2;
/** Cells the marker column takes in front of an item line: models are built this much narrower than the page. */
export const MARKER = 2;
export interface ListView {readonly scroll: number; readonly selected?: number | undefined; readonly hovered?: number | undefined}
export const emptyListView: ListView = {scroll: 0};

const seg = (text: string, color: string, extra: Partial<SideSegment> = {}): SideSegment => ({text, color, ...extra});
/** `1.2k`, `34k`, `1.2M`: whole tokens compactly. */
export function compact(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1e6) return (count < 1e4 ? (count / 1e3).toFixed(1) : String(Math.round(count / 1e3))).replace(/\.0$/, '') + 'k';
  return (count < 1e7 ? (count / 1e6).toFixed(1) : String(Math.round(count / 1e6))).replace(/\.0$/, '') + 'M';
}
/** `left` on the left and `right` right-aligned in `content` cells; the left text gives way first. */
function split(content: number, left: readonly SideSegment[], right: readonly SideSegment[], gap = 2): SideSegment[] {
  const rightWidth = right.reduce((sum, item) => sum + stringWidth(item.text), 0);
  const room = Math.max(1, content - rightWidth - gap);
  const out: SideSegment[] = [];
  let used = 0;
  for (const item of left) {
    const size = stringWidth(item.text);
    if (used + size <= room) {out.push(item); used += size; continue;}
    if (room - used > 1) out.push({...item, text: fit(item.text, room - used)});
    used = room; break;
  }
  return [...out, seg(' '.repeat(Math.max(1, content - used - rightWidth)), palette.fg), ...right];
}
const rule = (content: number): Line => [seg('─'.repeat(Math.max(0, content)), palette.line)];

// ---------------------------------------------------------------------------------------------------------------------------------- Changes
export interface ChangesNames {readonly name: (ownerId: string) => string}
/** `3 files · +42 −7` over the changed files, newest first: `● name.ts   +12 −3` over `src/dir · 2 edits · Techne`. */
export function changesModel(changes: readonly FileChange[], content: number, names: ChangesNames): ListModel {
  const added = changes.reduce((sum, change) => sum + change.added, 0), removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const summary: Line = changes.length ? [seg(`${changes.length} ${changes.length === 1 ? 'file' : 'files'}`, palette.strong, {bold: true}), seg(' · ', palette.muted), seg(`+${added}`, palette.success), seg(' ', palette.fg), seg(`−${removed}`, palette.error)]
    : [seg('No files changed yet', palette.muted)];
  const items = changes.map((change): ListItem => {
    const at = Math.max(change.path.lastIndexOf('/'), change.path.lastIndexOf('\\')), base = change.path.slice(at + 1), dir = at > 0 ? change.path.slice(0, at) : '';
    const figures = [seg(`+${change.added}`, palette.success), seg(' ', palette.fg), seg(`−${change.removed}`, palette.error)];
    const who = change.owners.map(names.name).join(', ');
    const detail = [dir ? fit(tail(dir, Math.max(8, content - 4 - stringWidth(who) - 14)), content) : '', change.edits.length === 1 ? '1 edit' : change.edits.length + ' edits', who].filter(Boolean).join(' · ');
    return {id: change.path, lines: [split(content, [seg('● ', palette.accent), seg(base, palette.strong, {bold: true})], figures), [seg('  ' + fit(detail, Math.max(1, content - 2)), faintColor())]]};
  });
  return {head: [summary, rule(content + MARKER)], items, empty: ['Edits and writes of this session appear here', 'Click a file to see its diff']};
}
/** The end of a path that fits `width` cells: `…/last/folders`. */
function tail(path: string, width: number): string {
  if (stringWidth(path) <= width) return path;
  const parts = path.split(/[\\/]/);
  let out = parts.pop() ?? '';
  while (parts.length && stringWidth(parts.at(-1) + '/' + out) + 2 <= width) out = parts.pop() + '/' + out;
  return '…/' + out;
}

// ---------------------------------------------------------------------------------------------------------------------------------- Usage
export interface UsageEntry {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  /** The actor's colour; the page falls back to the foreground. */
  readonly color?: string | undefined;
  readonly model?: string | undefined;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly cost?: {readonly amount: number; readonly currency: string; readonly partial: boolean} | undefined;
}
export const formatCost = (cost: NonNullable<UsageEntry['cost']>): string => (cost.partial ? '~' : '') + cost.currency + ' ' + cost.amount.toFixed(cost.amount < 1 ? 4 : 2);
/** `1.2M tokens · USD 3.1200` over the actors by total, each `◇ Name   34k tok   USD 0.4100` over `in 20k · out 14k · cached 8k · model`. */
export function usageModel(entries: readonly UsageEntry[], content: number): ListModel {
  const used = entries.filter(entry => entry.input + entry.output > 0).sort((a, b) => b.input + b.output - (a.input + a.output));
  const total = used.reduce((sum, entry) => sum + entry.input + entry.output, 0);
  const currencies = new Set(used.flatMap(entry => entry.cost ? [entry.cost.currency] : []));
  const cost = currencies.size === 1 ? used.reduce((sum, entry) => sum + (entry.cost?.amount ?? 0), 0) : undefined;
  const partial = used.some(entry => !entry.cost || entry.cost.partial);
  const summary: Line = used.length
    ? [seg(compact(total) + ' tokens', palette.strong, {bold: true}), ...cost !== undefined ? [seg(' · ', palette.muted), seg(formatCost({amount: cost, currency: [...currencies][0]!, partial}), palette.fg)] : []]
    : [seg('No usage recorded yet', palette.muted)];
  const items = used.map((entry): ListItem => {
    const right = [seg(compact(entry.input + entry.output) + ' tok', palette.fg), ...entry.cost ? [seg('  ' + formatCost(entry.cost), palette.muted)] : []];
    const detail = [`in ${compact(entry.input)}`, `out ${compact(entry.output)}`, ...entry.cached ? [`cached ${compact(entry.cached)}`] : [], ...entry.model ? [entry.model] : []].join(' · ');
    return {id: entry.id, lines: [split(content, [seg(entry.symbol + ' ', entry.color ?? palette.fg), seg(entry.name, entry.color ?? palette.strong, {bold: true})], right), [seg('  ' + fit(detail, Math.max(1, content - 2)), faintColor())]]};
  });
  return {head: [summary, rule(content + MARKER)], items, empty: ['Tokens and cost per actor appear here', 'Click an actor to open its window']};
}

// ---------------------------------------------------------------------------------------------------------------------------------- paint and reducers
/** Rows the scrolling list has (the height less the head). */
export const bodyRows = (model: ListModel, height: number): number => Math.max(0, height - model.head.length);
const maxScroll = (model: ListModel, height: number): number => Math.max(0, model.items.length * ITEM_ROWS - bodyRows(model, height));
export const clampView = (model: ListModel, view: ListView, height: number): ListView => {
  const scroll = Math.max(0, Math.min(maxScroll(model, height), view.scroll));
  const keep = (value: number | undefined) => value === undefined || value >= model.items.length ? undefined : value;
  return scroll === view.scroll && keep(view.selected) === view.selected && keep(view.hovered) === view.hovered ? view : {scroll, selected: keep(view.selected), hovered: keep(view.hovered)};
};
/** The view scrolled just enough to show item `index`. */
function reveal(model: ListModel, view: ListView, height: number, index: number): ListView {
  const body = bodyRows(model, height), top = index * ITEM_ROWS;
  const scroll = top < view.scroll ? top : top + ITEM_ROWS > view.scroll + body ? top + ITEM_ROWS - body : view.scroll;
  return {...view, scroll: Math.max(0, Math.min(maxScroll(model, height), scroll))};
}
/** The item under body row `row` (relative to the first body row) at `scroll`, if any. */
const itemAt = (model: ListModel, view: ListView, row: number): number | undefined => {
  const index = Math.floor((view.scroll + row) / ITEM_ROWS);
  return row >= 0 && index >= 0 && index < model.items.length ? index : undefined;
};
/** `height` lines of the page, each `content` cells at most (the host pads and adds the border); item lines are built two cells narrower, for the marker column. `focused`: the selected item shows its marker. */
export function paintList(model: ListModel, view: ListView, content: number, height: number, focused: boolean): Line[] {
  const lines: Line[] = model.head.slice(0, height).map(line => [...line]);
  const body = bodyRows(model, height);
  if (!model.items.length) {
    for (let i = 0; i < Math.min(body, model.empty.length); i++) lines.push([seg(' ' + fit(model.empty[i]!, Math.max(1, content - 1)), i === 0 ? palette.muted : faintColor(), {italic: true})]);
  } else {
    for (let row = 0; row < body; row++) {
      const index = Math.floor((view.scroll + row) / ITEM_ROWS), item = model.items[index];
      if (!item) break;
      const line = [...item.lines[(view.scroll + row) % ITEM_ROWS]!];
      const chosen = index === view.selected && focused, hot = index === view.hovered;
      // The marker column (two cells): `›` on the first line of the selected item; the hovered item's text turns bold.
      const mark = chosen && (view.scroll + row) % ITEM_ROWS === 0 ? seg('› ', palette.accent, {bold: true}) : seg('  ', palette.fg);
      lines.push([mark, ...hot ? line.map(item => ({...item, underline: false, ...item.color === faintColor() ? {} : {bold: true}})) : line]);
    }
  }
  while (lines.length < height) lines.push([]);
  return lines.slice(0, height);
}
export interface ListKey {readonly up?: boolean; readonly down?: boolean; readonly enter?: boolean; readonly escape?: boolean; readonly pageUp?: boolean; readonly pageDown?: boolean; readonly home?: boolean; readonly end?: boolean}
export type ListEffect = {readonly kind: 'open'; readonly id: string} | {readonly kind: 'blur'} | {readonly kind: 'focus'};
export interface ListStep {readonly view: ListView; readonly effects: readonly ListEffect[]; readonly consumed: boolean}
export function stepListKey(model: ListModel, view: ListView, height: number, key: ListKey): ListStep {
  const done = (next: ListView, ...effects: ListEffect[]): ListStep => ({view: next, effects, consumed: true});
  if (key.escape) return done(view, {kind: 'blur'});
  const last = model.items.length - 1, current = view.selected ?? -1, page = Math.max(1, Math.floor(bodyRows(model, height) / ITEM_ROWS));
  const go = (index: number) => {const to = Math.max(0, Math.min(last, index)); return last < 0 ? view : reveal(model, {...view, selected: to}, height, to);};
  if (key.up) return done(go(current < 0 ? last : current - 1));
  if (key.down) return done(go(current + 1));
  if (key.pageUp || key.pageDown) return done(go((current < 0 ? 0 : current) + (key.pageUp ? -page : page)));
  if (key.home) return done(go(0));
  if (key.end) return done(go(last));
  if (key.enter && view.selected !== undefined && model.items[view.selected]) return done(view, {kind: 'open', id: model.items[view.selected]!.id});
  return {view, effects: [], consumed: false};
}
export interface ListPointer {readonly x: number; readonly y: number; readonly action: 'press' | 'move' | 'wheel_up' | 'wheel_down'}
/** Mouse inside the page (`y` 0 is the first row below the header bar): hover marks an item, a click selects and opens it, the wheel scrolls three rows. */
export function stepListMouse(model: ListModel, view: ListView, height: number, pointer: ListPointer): ListStep {
  const row = pointer.y - model.head.length;
  if (pointer.action === 'wheel_up' || pointer.action === 'wheel_down') {
    const scroll = Math.max(0, Math.min(maxScroll(model, height), view.scroll + (pointer.action === 'wheel_down' ? 3 : -3)));
    return {view: scroll === view.scroll ? view : {...view, scroll, hovered: undefined}, effects: [], consumed: true};
  }
  const index = row >= 0 && row < bodyRows(model, height) ? itemAt(model, view, row) : undefined;
  if (pointer.action === 'move') return {view: index === view.hovered ? view : {...view, hovered: index}, effects: [], consumed: true};
  if (index === undefined) return {view, effects: [{kind: 'focus'}], consumed: true};
  return {view: {...view, selected: index}, effects: [{kind: 'focus'}, {kind: 'open', id: model.items[index]!.id}], consumed: true};
}
