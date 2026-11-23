/**
 * The Team tab of the sidebar (the team event stream of `src/runtime/team-events.ts`: every dispatch and reply of the team, in time order) as pure functions:
 * `buildTeamLayout()` (events + width + member filter -> rows of cells and the hit boxes of the posts), `paintTeam()` (layout + view -> one line of styled
 * segments per screen row, each exactly the sidebar's width) and the two reducers that run keyboard (`stepTeamKey`) and mouse (`stepTeamMouse`).
 * `use-plan-sidebar.ts` holds the state and applies the effects. Nothing here reads a clock or a store, and no cell ever carries a background.
 *
 * A post is two rows: the header (the sender's glyph and name in its actor colour, ` → @a @b` the recipients, ` · assign` / ` · done` a muted kind or a status
 * word in its status colour, the time `HH:MM` right-aligned) and one faint body line clipped with `…`. A `waiting` post is the header alone and a `workers` post
 * lists its jobs in the body (`◦` worker, `⑂` fork). The layout does not depend on the pointer, the selection or the scroll position, so it is rebuilt only when the
 * events, the width or the member filter change; selection, hover and focus are applied while painting.
 *
 * Selection is the id of an event. Live follows the newest post (the selection is the last visible post and the view sits at the bottom); any manual
 * navigation (click, arrows, page keys, wheel, `◀ ▶`) leaves Live until `● Live` is clicked or End is pressed. The wheel moves the selection by one post and the
 * view follows it, so the scroll position is always derived from the selection (`effectiveScroll`) and a width or filter change never loses it. The selected
 * index (`positionOf`) counts the visible posts; the unfiltered stream and its index are what a later graph with replay reads.
 *
 * Geometry: column 0 is the border (as in `plan-sidebar.ts`), the content starts at column 2. Rows: header (tabs and Live, then a rule), the body, footer (a rule,
 * then `◀ ▶ · selected / total · elapsed · member filter`). A screen too short for both drops the rules.
 */
import stringWidth from 'string-width';
import {involves, teamMembers, type TeamEvent, type TeamStatus} from '../../runtime/team-events.js';
import {faintColor} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import type {SideSegment} from '../terminal/terminal-plane.js';
import {fit, formatTook, type FlowTone} from './plan-flow.js';
import {CONTENT_X, DOUBLE_CLICK_MS, TASKS_LABEL, TEAM_LABEL, sideLine, toneColor} from './plan-sidebar.js';

// ---------------------------------------------------------------------------------------------------------------------------------- layout
export interface TeamCell {
  readonly text: string;
  readonly tone: FlowTone;
  /** The actor whose colour an `owner` cell wears (`user` and `automa` included). */
  readonly owner?: string;
  readonly bold?: boolean;
  /** The post this cell belongs to (the painter recolours it by hover and selection). */
  readonly post?: string;
  readonly part?: 'glyph' | 'sender' | 'recip' | 'word' | 'time' | 'body';
  /** The member a click on this cell filters by. */
  readonly member?: string;
}
export type TeamRow = readonly TeamCell[];
export interface TeamHit {readonly x0: number; readonly x1: number; readonly member: string}
export interface TeamBox {readonly id: string; readonly y0: number; readonly y1: number; readonly names: readonly TeamHit[]}
export interface TeamLayout {
  readonly rows: readonly TeamRow[];
  readonly boxes: readonly TeamBox[];
  /** Visible event ids in order. */
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, number>;
  /** The visible events and the whole stream (the filter is applied to it). */
  readonly events: readonly TeamEvent[];
  readonly all: readonly TeamEvent[];
  /** When the stream began (the elapsed time counts from it). */
  readonly firstAt: number;
  /** The members of the whole stream, for the filter picker. */
  readonly members: readonly string[];
  readonly filter?: string | undefined;
  readonly width: number;
}
export type Labeler = (id: string) => {readonly symbol: string; readonly name: string};
export interface TeamOptions {readonly width: number; readonly filter?: string | undefined; readonly label: Labeler}
/** Counts layouts built; tests assert an unrelated store change builds none. */
export const teamStats = {builds: 0};

/** The labels of `user` and Automa workers on top of the actors' own. */
export const teamLabeler = (base: Labeler): Labeler => id => id === 'user' ? {symbol: '✓', name: 'you'} : id === 'automa' ? {symbol: '◦', name: 'worker'} : base(id);
/** The inner width a post may use in a panel `panelWidth` cells wide. */
export const teamWidth = (panelWidth: number): number => panelWidth - CONTENT_X - 1;

const TIME_WIDTH = 5;
const clock = (at: number): string => {const date = new Date(at); return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');};
const cellWidth = (row: TeamRow): number => row.reduce((sum, cell) => sum + stringWidth(cell.text), 0);
const STATUS_TONE: Readonly<Record<TeamStatus, FlowTone>> = {done: 'success', blocked: 'warning', failed: 'error', interrupted: 'muted'};

/** The header of one post fitted to `width` cells: progressively fewer recipients and words until it fits, the sender alone clipped as the last resort. */
function header(event: TeamEvent, width: number, label: Labeler): {readonly row: TeamRow; readonly names: readonly TeamHit[]} {
  const sender = label(event.from);
  const senderMember = event.from === 'automa' ? event.dispatcher : event.from;
  const lead: TeamCell[] = [{text: ' ', tone: 'fg'},
    {text: sender.symbol, tone: 'owner', owner: event.from, post: event.id, part: 'glyph', ...(senderMember ? {member: senderMember} : {})}, {text: ' ', tone: 'fg'},
    {text: sender.name, tone: 'owner', owner: event.from, post: event.id, part: 'sender', ...(senderMember ? {member: senderMember} : {})}];
  const word = event.kind === 'assign' ? 'assign' : event.status;
  const tail = (): TeamCell[] => word ? [{text: ' · ', tone: 'muted'}, {text: word, tone: event.status ? STATUS_TONE[event.status] : 'muted', post: event.id, part: 'word'}] : [];
  const recipients = (count: number): TeamCell[] => {
    const shown = event.to.slice(0, count), rest = event.to.length - shown.length;
    return [...shown.flatMap((id): TeamCell[] => [{text: ' ', tone: 'fg'}, {text: '@' + label(id).name, tone: 'owner', owner: id, post: event.id, part: 'recip', member: id}]),
      ...(rest > 0 ? [{text: ' +' + rest, tone: 'muted' as const}] : [])];
  };
  /** The connector: ` → ` before text, ` →` before recipients (each of which opens with its own space). */
  const arrow = (glyph: string, text = true): TeamCell[] => [{text: ' ' + glyph + (text ? ' ' : ''), tone: 'muted'}];
  const candidates: TeamCell[][] = event.kind === 'workers' ? [[...lead, ...arrow('⇢'), {text: event.text, tone: 'fg'}], [...lead, ...arrow('⇢'), {text: event.text.replace(/ (workers?|forks?)$/, ''), tone: 'fg'}]]
    : event.kind === 'waiting' ? [[...lead, ...arrow('┄'), {text: event.text, tone: 'warning'}]]
    : [[...lead, ...arrow('→', false), ...recipients(event.to.length), ...tail()], [...lead, ...arrow('→', false), ...recipients(event.to.length)],
      [...lead, ...arrow('→', false), ...recipients(1), ...tail()], [...lead, ...arrow('→', false), ...recipients(1)], [...lead, ...arrow('→', false)]];
  const budget = width - TIME_WIDTH - 1;
  let left = candidates.find(row => cellWidth(row) <= budget);
  if (!left) {
    // Nothing fits whole: the shortest candidate cut at the budget, its last visible cell clipped with `…`.
    const out: TeamCell[] = [];
    let used = 0;
    for (const cell of candidates[candidates.length - 1]!) {
      const size = stringWidth(cell.text);
      if (used + size <= budget) {out.push(cell); used += size; continue;}
      const room = budget - used;
      if (room > 0) out.push({...cell, text: fit(cell.text, room)});
      break;
    }
    left = out;
  }
  const names: TeamHit[] = [];
  let x = 0;
  for (const cell of left) {
    const size = stringWidth(cell.text);
    if (cell.member !== undefined) names.push({x0: x, x1: x + size, member: cell.member});
    x += size;
  }
  const row: TeamCell[] = [...left, {text: ' '.repeat(Math.max(1, width - x - TIME_WIDTH)), tone: 'fg'}, {text: clock(event.at), tone: 'muted', post: event.id, part: 'time'}];
  return {row, names};
}

/** The body of a post: what was said, or the jobs of a dispatch (`◦` worker, `⑂` fork); none for a wait. */
function body(event: TeamEvent, width: number): TeamRow | undefined {
  if (event.kind === 'waiting') return undefined;
  const text = event.kind === 'workers' && event.items ? event.items.map(item => (item.fork ? '⑂ ' : '◦ ') + fit(item.title, width)).join('   ') : fit(event.text, width);
  return [{text: '   ', tone: 'fg'}, {text: clip(text, Math.max(1, width - 3)), tone: 'faint', post: event.id, part: 'body'}];
}
const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});
/** `text` cut to at most `width` cells with a closing `…`, spaces kept as they are (unlike `fit`, which collapses them); a wide character is never split. */
function clip(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = '';
  for (const {segment} of graphemes.segment(text)) {
    if (stringWidth(out + segment) > width - 1) break;
    out += segment;
  }
  return out.trimEnd() + '…';
}

export function buildTeamLayout(all: readonly TeamEvent[], options: TeamOptions): TeamLayout {
  teamStats.builds++;
  const {width, filter, label} = options;
  const events = filter === undefined ? all : all.filter(event => involves(event, filter));
  const rows: TeamRow[] = [], boxes: TeamBox[] = [], byId = new Map<string, number>();
  for (const event of events) {
    const head = header(event, width, label), lines = body(event, width);
    byId.set(event.id, boxes.length);
    boxes.push({id: event.id, y0: rows.length, y1: rows.length + (lines ? 1 : 0), names: head.names});
    rows.push(head.row);
    if (lines) rows.push(lines);
  }
  return {rows, boxes, ids: events.map(event => event.id), byId, events, all, firstAt: all[0]?.at ?? 0, members: teamMembers(all), filter, width};
}

// ---------------------------------------------------------------------------------------------------------------------------------- view
export type TeamControl = 'tasks' | 'live' | 'prev' | 'next' | 'filter';
export interface TeamView {
  /** Follows the newest post. */
  readonly live: boolean;
  /** The selected event (when not live; a hidden or missing one reads as the newest visible post). */
  readonly selected?: string | undefined;
  /** The first row shown (derived from the selection; see `effectiveScroll`). */
  readonly scroll: number;
  /** Only posts involving this member. */
  readonly filter?: string | undefined;
  /** The highlighted row of the open member picker (0 is all members); undefined: closed. */
  readonly picker?: number | undefined;
  readonly hovered?: string | undefined;
  /** `<event id>\0<member>`: the pointer is over a name that a click filters by. */
  readonly hoveredName?: string | undefined;
  readonly hoveredControl?: TeamControl | undefined;
  readonly hoveredEdge?: 'collapse' | 'handle' | undefined;
  readonly lastClick?: {readonly id: string; readonly time: number} | undefined;
}
export const emptyTeamView: TeamView = {live: true, scroll: 0};

export interface TeamGeometry {readonly height: number; readonly header: number; readonly footer: number; readonly body: number}
export function teamGeometry(height: number): TeamGeometry {
  if (height >= 6) return {height, header: 2, footer: 2, body: height - 4};
  if (height >= 3) return {height, header: 1, footer: 1, body: height - 2};
  return {height, header: Math.min(1, height), footer: 0, body: Math.max(0, height - 1)};
}
const maxScroll = (layout: TeamLayout, geometry: TeamGeometry) => Math.max(0, layout.rows.length - geometry.body);
/** The selected post: the newest visible one while live (or when the chosen one is hidden), else the chosen one. */
export function selectedId(layout: TeamLayout, view: TeamView): string | undefined {
  if (!layout.ids.length) return undefined;
  if (view.live || view.selected === undefined || !layout.byId.has(view.selected)) return layout.ids[layout.ids.length - 1];
  return view.selected;
}
/** 1-based position of the selected post among the visible posts (0 with none). */
export const positionOf = (layout: TeamLayout, view: TeamView): number => {const id = selectedId(layout, view); return id === undefined ? 0 : layout.byId.get(id)! + 1;};
/** The first row shown: the bottom while live, else the scroll position moved just enough to show the selected post. */
export function effectiveScroll(layout: TeamLayout, view: TeamView, geometry: TeamGeometry): number {
  const max = maxScroll(layout, geometry);
  if (view.live) return max;
  let scroll = Math.max(0, Math.min(max, view.scroll));
  const id = selectedId(layout, view), box = id === undefined ? undefined : layout.boxes[layout.byId.get(id)!];
  if (box) {
    if (box.y0 < scroll) scroll = box.y0;
    else if (box.y1 >= scroll + geometry.body) scroll = Math.min(box.y0, box.y1 - geometry.body + 1);
  }
  return Math.max(0, Math.min(max, scroll));
}
/** Selects the post at `index` (clamped) and leaves Live; the view follows it. */
function selectAt(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, index: number): TeamView {
  if (!layout.ids.length) return view;
  const id = layout.ids[Math.max(0, Math.min(layout.ids.length - 1, index))]!;
  const base: TeamView = {...view, live: false, selected: id, scroll: effectiveScroll(layout, view, geometry)};
  return {...base, scroll: effectiveScroll(layout, base, geometry)};
}
const goLive = (layout: TeamLayout, view: TeamView, geometry: TeamGeometry): TeamView =>
  ({...view, live: true, selected: layout.ids[layout.ids.length - 1], scroll: maxScroll(layout, geometry)});
const filtered = (view: TeamView, member: string | undefined): TeamView => ({...view, filter: member, picker: undefined, hovered: undefined, hoveredName: undefined});

// ---------------------------------------------------------------------------------------------------------------------------------- chrome
interface Region {readonly x0: number; readonly x1: number; readonly control: TeamControl}
interface Chrome {readonly cells: readonly TeamCell[]; readonly regions: readonly Region[]}
const LIVE_ON = '● Live', LIVE_OFF = '○ Live';
/** The tabs and the Live switch (content coordinates, `content` cells wide). */
function headerChrome(content: number, view: TeamView): Chrome {
  const live = view.live ? LIVE_ON : LIVE_OFF, liveX = Math.max(TASKS_LABEL.length + 2 + TEAM_LABEL.length + 1, content - live.length);
  const cells: TeamCell[] = [{text: TASKS_LABEL, tone: view.hoveredControl === 'tasks' ? 'accent' : 'muted'}, {text: '  ', tone: 'fg'}, {text: TEAM_LABEL, tone: 'strong', bold: true},
    {text: ' '.repeat(Math.max(1, liveX - TASKS_LABEL.length - 2 - TEAM_LABEL.length)), tone: 'fg'},
    {text: live, tone: view.hoveredControl === 'live' ? 'accent' : view.live ? 'success' : 'muted', bold: view.live}];
  return {cells, regions: [{x0: 0, x1: TASKS_LABEL.length, control: 'tasks'}, {x0: liveX, x1: liveX + live.length, control: 'live'}]};
}
/** `◀ ▶   13 / 26 · +9m47s            all members ▾`: the stepping buttons, where the selection is and the member filter; the elapsed time and then words go first when narrow. */
function footerChrome(layout: TeamLayout, view: TeamView, content: number, label: Labeler): Chrome {
  const position = positionOf(layout, view), selected = selectedId(layout, view);
  const at = selected === undefined ? undefined : layout.events[layout.byId.get(selected)!]!.at;
  const counter = `${position} / ${layout.ids.length}`;
  const elapsed = at === undefined ? '' : ' · +' + formatTook(Math.max(0, at - layout.firstAt));
  const name = view.filter === undefined ? 'all members' : label(view.filter).name;
  const filters = [name + ' ▾', view.filter === undefined ? 'all ▾' : '▾'];
  const base = 4 + 2;
  const pick = (): {readonly text: string; readonly filter: string; readonly elapsed: boolean} | undefined => {
    for (const withElapsed of [true, false]) for (const filter of filters) {
      const text = counter + (withElapsed ? elapsed : '');
      if (base + text.length + 2 + stringWidth(filter) <= content) return {text, filter, elapsed: withElapsed};
    }
    return undefined;
  };
  const chosen = pick() ?? {text: counter, filter: filters[1]!, elapsed: false};
  const filterX = Math.max(base + chosen.text.length + 1, content - stringWidth(chosen.filter));
  const step = (text: string, control: TeamControl, enabled: boolean): TeamCell => ({text, tone: view.hoveredControl === control ? 'accent' : enabled ? 'fg' : 'faint'});
  const cells: TeamCell[] = [step('◀', 'prev', position > 1), {text: ' ', tone: 'fg'}, step('▶', 'next', position > 0 && position < layout.ids.length), {text: '   ', tone: 'fg'},
    {text: chosen.text.split(' · ')[0]!, tone: 'fg'}, ...(chosen.elapsed ? [{text: elapsed, tone: 'muted' as const}] : []),
    {text: ' '.repeat(Math.max(1, filterX - base - chosen.text.length)), tone: 'fg'},
    {text: chosen.filter, tone: view.hoveredControl === 'filter' || view.picker !== undefined ? 'accent' : view.filter === undefined ? 'muted' : 'fg', bold: view.filter !== undefined}];
  return {cells, regions: [{x0: 0, x1: 1, control: 'prev'}, {x0: 2, x1: 3, control: 'next'}, {x0: filterX, x1: content, control: 'filter'}]};
}
interface PickerPlan {readonly items: readonly (string | undefined)[]; readonly shown: number; readonly start: number; readonly top: number}
/** The member picker laid over the bottom of the body: a title rule, then `All members` and each member; null when the open picker has no room. */
function pickerPlan(layout: TeamLayout, view: TeamView, geometry: TeamGeometry): PickerPlan | null {
  if (view.picker === undefined || geometry.body < 3) return null;
  const items: (string | undefined)[] = [undefined, ...layout.members];
  const shown = Math.min(items.length, geometry.body - 1);
  const start = Math.max(0, Math.min(items.length - shown, view.picker - shown + 1));
  return {items, shown, start, top: geometry.body - shown - 1};
}

// ---------------------------------------------------------------------------------------------------------------------------------- painting
export interface TeamPaint {
  readonly layout: TeamLayout;
  readonly view: TeamView;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly dragging?: boolean;
  /** The colour of an actor's name (`user` and `automa` included). */
  readonly ownerColor: (id: string) => string;
  readonly label: Labeler;
}
function segmentOf(cell: TeamCell, input: TeamPaint, selected: string | undefined): SideSegment {
  const {view} = input;
  let color = cell.tone === 'owner' ? input.ownerColor(cell.owner ?? '') : toneColor(cell.tone), bold = cell.bold ?? false, underline = false;
  if (cell.post !== undefined) {
    const chosen = cell.post === selected, hovered = cell.post === view.hovered;
    if (cell.part === 'glyph' && chosen) color = palette.accent;
    if ((cell.part === 'glyph' || cell.part === 'sender' || cell.part === 'recip') && (chosen || hovered)) bold = true;
    if (cell.part === 'body' && (chosen || hovered)) color = palette.muted;
    if (cell.member !== undefined && view.hoveredName === cell.post + '\0' + cell.member) {bold = true; underline = true;}
  }
  return {text: cell.text, color, ...(bold ? {bold: true} : {}), ...(underline ? {underline: true} : {})};
}
/** The panel as `height` lines of segments, each exactly `width` cells wide. */
export function paintTeam(input: TeamPaint): SideSegment[][] {
  const {layout, view, width, height, label} = input;
  const geometry = teamGeometry(height), content = width - CONTENT_X;
  const frame = {width, hoveredEdge: view.hoveredEdge, accent: Boolean(input.dragging || input.focused)};
  const selected = selectedId(layout, view);
  const paintRow = (row: TeamRow) => row.map(cell => segmentOf(cell, input, selected));
  const lines: SideSegment[][] = [];
  const rule = (): SideSegment[] => sideLine(frame, [{text: '─'.repeat(Math.max(0, content)), color: palette.line}]);
  if (geometry.header >= 1) lines.push(sideLine(frame, paintRow(headerChrome(content, view).cells), true));
  if (geometry.header >= 2) lines.push(rule());
  const scroll = effectiveScroll(layout, view, geometry), picker = pickerPlan(layout, view, geometry);
  for (let i = 0; i < geometry.body; i++) {
    if (picker && i >= picker.top) {lines.push(sideLine(frame, paintPicker(layout, view, picker, i - picker.top, content, input, label)));continue;}
    const row = layout.rows[scroll + i];
    if (row) {lines.push(sideLine(frame, paintRow(row))); continue;}
    if (!layout.ids.length && i <= 1) {
      const text = i === 0 ? view.filter !== undefined ? 'No posts involving ' + label(view.filter).name : 'No team activity yet' : view.filter !== undefined ? 'Click the filter to see everyone' : 'Dispatches and replies appear here';
      lines.push(sideLine(frame, [{text: ' ' + fit(text, content - 1), color: i === 0 ? palette.muted : faintColor(), italic: true}]));
      continue;
    }
    lines.push(sideLine(frame, []));
  }
  if (geometry.footer >= 2) lines.push(rule());
  if (geometry.footer >= 1) lines.push(sideLine(frame, paintRow(footerChrome(layout, view, content, label).cells)));
  return lines.slice(0, height);
}
function paintPicker(layout: TeamLayout, view: TeamView, plan: PickerPlan, row: number, content: number, input: TeamPaint, label: Labeler): SideSegment[] {
  if (row === 0) return [{text: '─ Members ' + '─'.repeat(Math.max(0, content - 10)), color: palette.line}];
  const index = plan.start + row - 1, member = plan.items[index];
  const highlighted = index === view.picker, current = member === view.filter;
  const tag = member === undefined ? {symbol: '◇', name: 'All members'} : label(member);
  const color = member === undefined ? palette.fg : input.ownerColor(member);
  return [{text: highlighted ? '› ' : '  ', color: palette.accent, bold: true}, {text: tag.symbol + ' ', color, ...(highlighted ? {bold: true} : {})},
    {text: fit(tag.name, Math.max(1, content - 6)), color: member === undefined ? highlighted ? palette.strong : palette.fg : color, ...(highlighted ? {bold: true} : {})},
    ...(current ? [{text: ' ✓', color: palette.success}] : [])];
}

// ---------------------------------------------------------------------------------------------------------------------------------- interaction
export type TeamEffect =
  | {readonly kind: 'open'; readonly id: string}
  | {readonly kind: 'focus'}
  | {readonly kind: 'blur'}
  | {readonly kind: 'close'}
  | {readonly kind: 'drag'}
  | {readonly kind: 'reset-width'}
  | {readonly kind: 'tab'; readonly tab: 'tasks' | 'team'};
export interface TeamStep {readonly view: TeamView; readonly effects: readonly TeamEffect[]; readonly consumed: boolean}
export interface TeamKey {readonly up?: boolean; readonly down?: boolean; readonly left?: boolean; readonly right?: boolean; readonly enter?: boolean; readonly escape?: boolean;
  readonly pageUp?: boolean; readonly pageDown?: boolean; readonly home?: boolean; readonly end?: boolean;
  /** `t`: back to the Tasks tab. */
  readonly tab?: boolean;
  /** `f`: the member filter. */
  readonly filter?: boolean}

/** Keyboard while the sidebar has focus on the Team tab: arrows step through the posts, Enter opens one, End returns to Live, `f` opens the member filter, `t` the Tasks tab. */
export function stepTeamKey(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, key: TeamKey): TeamStep {
  const done = (next: TeamView, effects: readonly TeamEffect[] = []): TeamStep => ({view: next, effects, consumed: true});
  const index = positionOf(layout, view) - 1;
  if (view.picker !== undefined) {
    const last = layout.members.length;
    if (key.escape || key.filter) return done({...view, picker: undefined});
    if (key.up || key.down) return done({...view, picker: Math.max(0, Math.min(last, view.picker + (key.down ? 1 : -1)))});
    if (key.home || key.end) return done({...view, picker: key.home ? 0 : last});
    if (key.enter) return done(filtered(view, view.picker === 0 ? undefined : layout.members[view.picker - 1]));
    return done(view);
  }
  if (key.escape) return done(view, [{kind: 'blur'}]);
  if (key.tab) return done(view, [{kind: 'tab', tab: 'tasks'}]);
  if (key.filter) return done({...view, picker: layout.filter === undefined ? 0 : layout.members.indexOf(layout.filter) + 1});
  if (key.up || key.left) return done(selectAt(layout, view, geometry, index - 1));
  if (key.down || key.right) return done(selectAt(layout, view, geometry, index + 1));
  if (key.pageUp || key.pageDown) return done(selectAt(layout, view, geometry, index + (key.pageUp ? -1 : 1) * Math.max(1, Math.floor(geometry.body / 2))));
  if (key.home) return done(selectAt(layout, view, geometry, 0));
  if (key.end) return done(goLive(layout, view, geometry));
  if (key.enter) {const id = selectedId(layout, view); return done(view, id === undefined ? [] : [{kind: 'open', id}]);}
  return {view, effects: [], consumed: false};
}

export interface TeamPointer {
  /** Coordinates inside the sidebar (0,0 is its top-left cell). */
  readonly x: number; readonly y: number;
  readonly action: 'press' | 'move' | 'wheel_up' | 'wheel_down';
  readonly draggable?: boolean;
}
const EDGE_CLICK = '\0edge';
const regionAt = (chrome: Chrome, x: number): TeamControl | undefined => chrome.regions.find(region => x >= region.x0 && x < region.x1)?.control;
/** Mouse over the Team tab: hover, the wheel and the stepping buttons (selection), click (select), double click (details), names (filter), the Live switch, the tabs and the member picker. */
export function stepTeamMouse(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, pointer: TeamPointer, now: number, width: number, label: Labeler): TeamStep {
  const done = (next: TeamView, effects: readonly TeamEffect[] = []): TeamStep => ({view: next, effects, consumed: true});
  const content = width - CONTENT_X, cx = pointer.x - CONTENT_X;
  // Column 0 is the border: the collapse button on the first row, below it the resize handle.
  if (pointer.x === 0 && (pointer.action === 'move' || pointer.action === 'press') && (pointer.y === 0 || pointer.draggable)) {
    const part = pointer.y === 0 ? 'collapse' : 'handle';
    if (pointer.action === 'move') return done(view.hoveredEdge === part && view.hoveredControl === undefined && view.hovered === undefined ? view : {...view, hoveredEdge: part, hoveredControl: undefined, hovered: undefined, hoveredName: undefined});
    if (part === 'collapse') return done(view, [{kind: 'close'}]);
    const double = view.lastClick?.id === EDGE_CLICK && now - view.lastClick.time <= DOUBLE_CLICK_MS;
    return done({...view, lastClick: double ? undefined : {id: EDGE_CLICK, time: now}}, [double ? {kind: 'reset-width'} : {kind: 'drag'}]);
  }
  let current = pointer.action === 'move' && view.hoveredEdge ? {...view, hoveredEdge: undefined} : view;
  const move = (next: TeamView) => next === view ? done(view) : done(next);
  const rest = (patch: Partial<TeamView>): TeamView => ({...current, hoveredControl: undefined, hovered: undefined, hoveredName: undefined, ...patch});
  const row = pointer.y - geometry.header;
  const inBody = row >= 0 && row < geometry.body;
  const footerRow = geometry.footer >= 1 && pointer.y === geometry.height - 1;
  const picker = pickerPlan(layout, current, geometry);
  const wheel = pointer.action === 'wheel_up' || pointer.action === 'wheel_down';
  // The open member picker takes the pointer: a row chooses, anywhere else closes it.
  if (picker) {
    if (wheel) return done({...current, picker: Math.max(0, Math.min(picker.items.length - 1, (current.picker ?? 0) + (pointer.action === 'wheel_down' ? 1 : -1)))});
    const at = inBody && row > picker.top ? picker.start + row - picker.top - 1 : undefined;
    if (pointer.action === 'move') return move(at === undefined ? {...current, hoveredControl: undefined} : {...current, picker: at, hoveredControl: undefined});
    if (at !== undefined) return done(filtered(current, picker.items[at]), [{kind: 'focus'}]);
    if (footerRow && regionAt(footerChrome(layout, current, content, label), cx) === 'filter') return done({...current, picker: undefined}, [{kind: 'focus'}]);
    current = {...current, picker: undefined};
  }
  if (pointer.y < geometry.header && pointer.y === 0) {
    const control = regionAt(headerChrome(content, current), cx);
    if (pointer.action === 'move') return move(control === current.hoveredControl && current.hovered === undefined ? current : rest({hoveredControl: control}));
    if (pointer.action === 'press') {
      if (control === 'tasks') return done(current, [{kind: 'focus'}, {kind: 'tab', tab: 'tasks'}]);
      if (control === 'live') return done(goLive(layout, current, geometry), [{kind: 'focus'}]);
      return done(current, [{kind: 'focus'}]);
    }
    return done(current);
  }
  if (footerRow) {
    const control = regionAt(footerChrome(layout, current, content, label), cx);
    if (pointer.action === 'move') return move(control === current.hoveredControl && current.hovered === undefined ? current : rest({hoveredControl: control}));
    if (wheel) return done(selectAt(layout, current, geometry, positionOf(layout, current) - 1 + (pointer.action === 'wheel_down' ? 1 : -1)));
    if (pointer.action !== 'press') return done(current);
    const index = positionOf(layout, current) - 1;
    if (control === 'prev') return done(selectAt(layout, current, geometry, index - 1), [{kind: 'focus'}]);
    if (control === 'next') return done(selectAt(layout, current, geometry, index + 1), [{kind: 'focus'}]);
    if (control === 'filter') return done({...current, picker: current.filter === undefined ? 0 : layout.members.indexOf(current.filter) + 1}, [{kind: 'focus'}]);
    return done(current, [{kind: 'focus'}]);
  }
  if (wheel) return done(selectAt(layout, current, geometry, positionOf(layout, current) - 1 + (pointer.action === 'wheel_down' ? 1 : -1)));
  const scroll = effectiveScroll(layout, current, geometry);
  const box = inBody ? layout.boxes.find(item => scroll + row >= item.y0 && scroll + row <= item.y1) : undefined;
  const name = box && scroll + row === box.y0 ? box.names.find(hit => cx >= hit.x0 && cx < hit.x1) : undefined;
  if (pointer.action === 'move') {
    const hoveredName = name ? box!.id + '\0' + name.member : undefined;
    return move(box?.id === current.hovered && hoveredName === current.hoveredName && current.hoveredControl === undefined ? current : rest({hovered: box?.id, hoveredName}));
  }
  if (!box) return done(current, [{kind: 'focus'}]);
  if (name) return done({...filtered(current, current.filter === name.member ? undefined : name.member), lastClick: undefined}, [{kind: 'focus'}]);
  const double = current.lastClick?.id === box.id && now - current.lastClick.time <= DOUBLE_CLICK_MS;
  const selected = selectAt(layout, current, geometry, layout.byId.get(box.id)!);
  return done({...selected, lastClick: double ? undefined : {id: box.id, time: now}}, double ? [{kind: 'focus'}, {kind: 'open', id: box.id}] : [{kind: 'focus'}]);
}
