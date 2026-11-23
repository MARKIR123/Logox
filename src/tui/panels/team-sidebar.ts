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
import {stageAt, type StageSnapshot} from '../../runtime/team-stage.js';
import {faintColor, frameColor} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import type {SideSegment} from '../terminal/terminal-plane.js';
import {fit, formatTook, type FlowTone} from './plan-flow.js';
import {CONTENT_X, DOUBLE_CLICK_MS, TASKS_LABEL, TEAM_LABEL, sideLine, toneColor} from './plan-sidebar.js';
import {FEED_MIN, STAGE_FULL_MIN, STRIP_MIN, buildStage, controlsRow, nextSpeed, pulseAt, scrubPosition, stageHeight, stripRow, type ControlsRow, type StageBox, type StageCell, type StageLabeler,
  type StagePlan, type StageRow} from './team-stage.js';

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

/** The left part of a post header (sender, recipients, word) fitted to `budget` cells: progressively fewer recipients and words until it fits, the sender alone clipped as the last resort. */
function leftCells(event: TeamEvent, budget: number, label: Labeler): TeamCell[] {
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
  const whole = candidates.find(row => cellWidth(row) <= budget);
  if (whole) return whole;
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
  return out;
}
/** The header of one post fitted to `width` cells, the time right-aligned. */
function header(event: TeamEvent, width: number, label: Labeler): {readonly row: TeamRow; readonly names: readonly TeamHit[]} {
  const left = leftCells(event, width - TIME_WIDTH - 1, label);
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
  /** Playback runs: one event per `PLAY_STEP_MS / speed`, then Live at the end. */
  readonly playing?: boolean;
  /** 1, 2 or 4 (default 1). */
  readonly speed?: number;
  /** The pulse of the current event: it started `at` (epoch ms) on the stage; set only by playback and by a new event while Live, never by manual stepping. */
  readonly pulse?: {readonly id: string; readonly at: number} | undefined;
  /** The scrubber bar is held: a drag moves the selection. */
  readonly scrubbing?: boolean;
  /** The stage card chosen by a click (an actor id): Enter opens its detail page. */
  readonly card?: string | undefined;
  /** What the pointer is over on the stage: `card:<id>`, `prev`, `next`, `play`, `scrub`, `speed` or `event`. */
  readonly hoveredStage?: string | undefined;
}
export const emptyTeamView: TeamView = {live: true, scroll: 0};
/** Playback shows one event per this many milliseconds at 1x. */
export const PLAY_STEP_MS = 900;

export type StageMode = 'off' | 'strip' | 'full';
export interface TeamGeometry {
  readonly height: number; readonly header: number; readonly footer: number; readonly body: number;
  /** The rows of the stage between the header and the feed (0 when off) and what it shows. */
  readonly stage: number;
  readonly stageMode: StageMode;
}
/** The panel's rows: header, `stage` rows (none by default), the feed body and the footer. */
export function teamGeometry(height: number, stage: {readonly rows: number; readonly mode: StageMode} = {rows: 0, mode: 'off'}): TeamGeometry {
  const [header, footer] = height >= 6 ? [2, 2] : height >= 3 ? [1, 1] : [Math.min(1, height), 0];
  const rows = header + footer + stage.rows <= height ? stage.rows : 0;
  return {height, header, footer, stage: rows, stageMode: rows ? stage.mode : 'off', body: Math.max(0, height - header - footer - rows)};
}
const stubLabel: StageLabeler = id => ({symbol: '◇', name: id});
const finals = new WeakMap<readonly TeamEvent[], StageSnapshot>();
/** The stage at the end of the stream (memoised per array: it reserves the stage's height). */
function finalOf(all: readonly TeamEvent[]): StageSnapshot {
  let known = finals.get(all);
  if (!known) {known = stageAt(all, all.length - 1); finals.set(all, known);}
  return known;
}
/** How many rows the stage takes in a panel `height` rows tall: the full stage (controls, graph, current post) on a tall sidebar, the controls and a one-line status on a short one, nothing under `STRIP_MIN`. */
export function stageRowsFor(layout: TeamLayout, height: number): {readonly rows: number; readonly mode: StageMode} {
  if (!layout.all.length || height < STRIP_MIN) return {rows: 0, mode: 'off'};
  const graph = stageHeight(finalOf(layout.all), layout.width, stubLabel), full = 1 + graph + 3;
  if (graph > 0 && height >= STAGE_FULL_MIN && height - 4 - full >= FEED_MIN) return {rows: full, mode: 'full'};
  return {rows: 2, mode: 'strip'};
}
/** The geometry with the stage this layout and height call for. */
export const teamGeometryFor = (layout: TeamLayout, height: number): TeamGeometry => teamGeometry(height, stageRowsFor(layout, height));
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
/** A manual move: playback stops, there is no pulse and no card is chosen any more (stepping jumps, it never animates). */
const manual = (view: TeamView): TeamView => view.playing || view.pulse || view.card !== undefined ?{...view, playing: false, pulse: undefined, card: undefined} : view;
/** Selects the post at `index` (clamped) and leaves Live; the view follows it. */
function selectAt(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, index: number): TeamView {
  if (!layout.ids.length) return view;
  const id = layout.ids[Math.max(0, Math.min(layout.ids.length - 1, index))]!;
  const base: TeamView = {...manual(view), live: false, selected: id, scroll: effectiveScroll(layout, view, geometry)};
  return {...base, scroll: effectiveScroll(layout, base, geometry)};
}
const goLive = (layout: TeamLayout, view: TeamView, geometry: TeamGeometry): TeamView =>
  ({...manual(view), live: true, selected: layout.ids[layout.ids.length - 1], scroll: maxScroll(layout, geometry)});
const speedOf = (view: TeamView): number => view.speed ?? 1;
/** Play or pause. Playing from the newest post starts over from the first one (with its pulse); otherwise it carries on from the selection. */
export function togglePlay(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, now: number): TeamView {
  if (!layout.ids.length) return view;
  if (view.playing) return {...view, playing: false};
  if (positionOf(layout, view) >= layout.ids.length) {
    const first = selectAt(layout, view, geometry, 0);
    return {...first, playing: true, pulse: {id: layout.ids[0]!, at: now}};
  }
  return {...view, playing: true};
}
/**
 * One playback tick: the next post is selected and pulses; the last post switches to Live and stops. Not a manual move: the pulse starts here.
 * The host calls it every `PLAY_STEP_MS / speed` while `view.playing`.
 */
export function stepPlay(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, now: number): TeamView {
  if (!view.playing || !layout.ids.length) return view;
  const position = positionOf(layout, view);
  if (position >= layout.ids.length) return goLive(layout, view, geometry);
  const next = layout.ids[position]!;
  const moved = selectAt(layout, view, geometry, position);
  if (position + 1 >= layout.ids.length) return {...goLive(layout, moved, geometry), pulse: {id: next, at: now}};
  return {...moved, playing: true, pulse: {id: next, at: now}};
}
/** A new post arrived while Live: it pulses (a view that is not Live is left alone). */
export function arrived(view: TeamView, id: string, now: number): TeamView {
  return view.live && view.pulse?.id !== id ? {...view, pulse: {id, at: now}} : view;
}
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
/** `◀ ▶   13 / 26 · +9m47s            all members ▾`: the stepping buttons, where the selection is and the member filter; the elapsed time and then words go first when narrow. With a stage (`staged`) only the member filter remains, right-aligned. */
function footerChrome(layout: TeamLayout, view: TeamView, content: number, label: Labeler, staged = false): Chrome {
  if (staged) {
    // The stage's controls row already carries the stepping buttons, the counter and the elapsed time: the footer keeps the member filter only, right-aligned.
    const name = (view.filter === undefined ? 'all members' : label(view.filter).name) + ' ▾', text = stringWidth(name) <= content ? name : view.filter === undefined ? 'all ▾' : '▾';
    const x = Math.max(0, content - stringWidth(text));
    return {cells: [{text: ' '.repeat(x), tone: 'fg'}, {text, tone: view.hoveredControl === 'filter' || view.picker !== undefined ? 'accent' : view.filter === undefined ? 'muted' : 'fg', bold: view.filter !== undefined}],
      regions: [{x0: x, x1: content, control: 'filter'}]};
  }
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

// ---------------------------------------------------------------------------------------------------------------------------------- stage
interface StripBox {readonly id: string; readonly x0: number; readonly x1: number}
/** What the stage shows for the selected post: the controls row, then the graph and the current post (full) or the one-line status (strip). */
interface StageModel {
  readonly mode: 'strip' | 'full';
  readonly controls: ControlsRow;
  readonly plan?: StagePlan;
  readonly card?: readonly TeamRow[];
  readonly strip?: StageRow;
  readonly stripBoxes: readonly StripBox[];
  readonly snapshot: StageSnapshot;
}
const indexes = new WeakMap<readonly TeamEvent[], Map<string, number>>();
function indexInAll(all: readonly TeamEvent[], id: string): number {
  let map = indexes.get(all);
  if (!map) {map = new Map(all.map((event, at) => [event.id, at] as const)); indexes.set(all, map);}
  return map.get(id) ?? -1;
}
let snapshotCache: {all: readonly TeamEvent[]; index: number; snapshot: StageSnapshot} | undefined;
const snapshotAt = (all: readonly TeamEvent[], index: number): StageSnapshot => {
  if (snapshotCache?.all === all && snapshotCache.index === index) return snapshotCache.snapshot;
  const snapshot = stageAt(all, index);
  snapshotCache = {all, index, snapshot};
  return snapshot;
};
let planCache: {all: readonly TeamEvent[]; index: number; width: number; label: Labeler; plan: StagePlan} | undefined;
const planAt = (all: readonly TeamEvent[], index: number, width: number, label: Labeler): StagePlan => {
  if (planCache?.all === all && planCache.index === index && planCache.width === width && planCache.label === label) return planCache.plan;
  const plan = buildStage(snapshotAt(all, index), finalOf(all), width, label);
  planCache = {all, index, width, label, plan};
  return plan;
};
/** `── #13  ⊞ techne → @logox · done ─────────── 08:32`, one body line and a closing rule: the current post under the stage. */
function eventCard(event: TeamEvent, ordinal: number, width: number, label: Labeler): readonly TeamRow[] {
  const lead: TeamCell[] = [{text: '── ', tone: 'line'}, {text: '#' + ordinal, tone: 'muted'}];
  const left = leftCells(event, width - TIME_WIDTH - cellWidth(lead) - 3, label);
  const fill = Math.max(2, width - cellWidth(lead) - cellWidth(left) - TIME_WIDTH);
  const first: TeamRow = [...lead, ...left, {text: ' ' + '─'.repeat(fill - 2) + ' ', tone: 'line'}, {text: clock(event.at), tone: 'muted'}];
  const second: TeamRow = body(event, width) ?? [{text: '   ', tone: 'fg'}, {text: clip(event.text, Math.max(1, width - 3)), tone: 'faint'}];
  return [first, second, [{text: '─'.repeat(Math.max(0, width)), tone: 'line'}]];
}
function stageModel(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, label: Labeler): StageModel | undefined {
  if (geometry.stageMode === 'off') return undefined;
  const selected = selectedId(layout, view);
  if (selected === undefined) return undefined;
  const event = layout.events[layout.byId.get(selected)!]!, index = indexInAll(layout.all, selected);
  const snapshot = snapshotAt(layout.all, index);
  const controls = controlsRow({width: layout.width, playing: view.playing ?? false, speed: speedOf(view), position: positionOf(layout, view), total: layout.ids.length,
    elapsed: event.at - layout.firstAt, hovered: view.hoveredStage});
  if (geometry.stageMode === 'full') return {mode: 'full', controls, plan: planAt(layout.all, index, layout.width, label), card: eventCard(event, index + 1, layout.width, label), stripBoxes: [], snapshot};
  const strip = stripRow(snapshot.actors, layout.width, label), boxes: StripBox[] = [];
  let x = 0;
  for (const cell of strip) {const size = stringWidth(cell.text); if (cell.actor !== undefined) boxes.push({id: cell.actor, x0: x, x1: x + size}); x += size;}
  return {mode: 'strip', controls, strip, stripBoxes: boxes, snapshot};
}
type StageHit = {readonly kind: 'control'; readonly control: string} | {readonly kind: 'card'; readonly id: string} | {readonly kind: 'event'};
/** What is at (`x`, `y`) of the stage (content coordinates, row 0 the controls). */
function stageHit(model: StageModel, x: number, y: number): StageHit | undefined {
  if (y === 0) {const region = model.controls.regions.find(item => x >= item.x0 && x < item.x1); return region ? {kind: 'control', control: region.control} : undefined;}
  if (model.plan) {
    const gy = y - 1;
    if (gy < model.plan.height) {const box = model.plan.boxes.find((item: StageBox) => x >= item.x0 && x < item.x1 && gy >= item.y0 && gy <= item.y1); return box ? {kind: 'card', id: box.id} : undefined;}
    return {kind: 'event'};
  }
  const box = y === 1 ? model.stripBoxes.find(item => x >= item.x0 && x < item.x1) : undefined;
  return box ? {kind: 'card', id: box.id} : undefined;
}
/** `row` with the cell at column `x` replaced by the pulse. */
function withPulse(row: StageRow, x: number): StageRow {
  const out: StageCell[] = [];
  let at = 0;
  for (const cell of row) {
    const size = stringWidth(cell.text);
    if (x < at || x >= at + size) {out.push(cell); at += size; continue;}
    let pre = '', post = '', used = at, hit = false;
    for (const {segment} of graphemes.segment(cell.text)) {
      const width = stringWidth(segment);
      if (!hit && x >= used && x < used + width) {hit = true; used += width; continue;}
      if (hit) post += segment; else pre += segment;
      used += width;
    }
    if (pre) out.push({...cell, text: pre});
    out.push({text: '●', tone: 'accent', bold: true});
    if (post) out.push({...cell, text: post});
    at += size;
  }
  return out;
}
const BORDER = /^[─-╿]+$/;
function stageSegment(cell: StageCell, view: TeamView, ownerColor: (id: string) => string): SideSegment {
  let color: string, bold = cell.bold ?? false;
  if (cell.tone === 'owner') {
    const base = ownerColor(cell.owner ?? '');
    color = cell.frame ? frameColor(base) : base;
    // A card's border: bright under the pointer, accent while it is the chosen member.
    if (cell.actor !== undefined && cell.actor === cell.owner && BORDER.test(cell.text)) {
      if (view.hoveredStage === 'card:' + cell.actor) {color = base; bold = true;}
      if (view.card === cell.actor || view.filter === cell.actor) color = palette.accent;
    }
  } else color = toneColor(cell.tone);
  return {text: cell.text, color, ...(bold ? {bold: true} : {})};
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
  /** Draws the stage (timeline controls, the team graph, the current post) above the feed. Off by default: the feed alone. */
  readonly stage?: boolean;
  /** Milliseconds since the pulse of the current post began (the host's clock); absent: no pulse is drawn. */
  readonly pulseMs?: number;
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
  const geometry = input.stage ? teamGeometryFor(layout, height) : teamGeometry(height), content = width - CONTENT_X;
  const frame = {width, hoveredEdge: view.hoveredEdge, accent: Boolean(input.dragging || input.focused)};
  const selected = selectedId(layout, view);
  const paintRow = (row: TeamRow) => row.map(cell => segmentOf(cell, input, selected));
  const lines: SideSegment[][] = [];
  const rule = (): SideSegment[] => sideLine(frame, [{text: '─'.repeat(Math.max(0, content)), color: palette.line}]);
  if (geometry.header >= 1) lines.push(sideLine(frame, paintRow(headerChrome(content, view).cells), true));
  if (geometry.header >= 2) lines.push(rule());
  if (geometry.stage > 0) {
    const model = stageModel(layout, view, geometry, label);
    const paintStage = (row: StageRow) => sideLine(frame, row.map(cell => stageSegment(cell, view, input.ownerColor)));
    if (model) {
      lines.push(paintStage(model.controls.cells));
      if (model.plan) {
        let rows = model.plan.rows;
        if (input.pulseMs !== undefined) for (const path of model.plan.paths) {
          const point = pulseAt(path, input.pulseMs);
          if (point) rows = rows.map((row, y) => y === point.y ? withPulse(row, point.x) : row);
        }
        lines.push(...rows.map(paintStage), ...(model.card ?? []).map(row => sideLine(frame, paintRow(row))));
      } else if (model.strip) lines.push(paintStage(model.strip));
    }
    while (lines.length < geometry.header + geometry.stage) lines.push(sideLine(frame, []));
  }
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
  if (geometry.footer >= 1) lines.push(sideLine(frame, paintRow(footerChrome(layout, view, content, label, geometry.stage > 0).cells)));
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
  | {readonly kind: 'tab'; readonly tab: 'tasks' | 'team'}
  /** Open the detail page of a stage card's actor. */
  | {readonly kind: 'actor'; readonly id: string};
export interface TeamStep {readonly view: TeamView; readonly effects: readonly TeamEffect[]; readonly consumed: boolean}
export interface TeamKey {readonly up?: boolean; readonly down?: boolean; readonly left?: boolean; readonly right?: boolean; readonly enter?: boolean; readonly escape?: boolean;
  readonly pageUp?: boolean; readonly pageDown?: boolean; readonly home?: boolean; readonly end?: boolean;
  /** `t`: back to the Tasks tab. */
  readonly tab?: boolean;
  /** `f`: the member filter. */
  readonly filter?: boolean;
  /** Space: play or pause the replay. */
  readonly space?: boolean;
  /** `+` and `-`: the replay speed. */
  readonly faster?: boolean;
  readonly slower?: boolean}

/**
 * Keyboard while the sidebar has focus on the Team tab: arrows step through the posts, Enter opens one (or the chosen stage card's actor), End returns to Live, Space plays or pauses the
 * replay, `+` and `-` change its speed, `f` opens the member filter, `t` the Tasks tab. `now` is the host's clock (a replay started by Space pulses from it).
 */
export function stepTeamKey(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, key: TeamKey, now = 0): TeamStep {
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
  if (key.space) return done(togglePlay(layout, view, geometry, now));
  if (key.faster || key.slower) return done({...view, speed: nextSpeed(speedOf(view), key.faster ? 1 : -1, false)});
  if (key.filter) return done({...view, picker: layout.filter === undefined ? 0 : layout.members.indexOf(layout.filter) + 1});
  if (key.up || key.left) return done(selectAt(layout, view, geometry, index - 1));
  if (key.down || key.right) return done(selectAt(layout, view, geometry, index + 1));
  if (key.pageUp || key.pageDown) return done(selectAt(layout, view, geometry, index + (key.pageUp ? -1 : 1) * Math.max(1, Math.floor(geometry.body / 2))));
  if (key.home) return done(selectAt(layout, view, geometry, 0));
  if (key.end) return done(goLive(layout, view, geometry));
  if (key.enter) {
    if (view.card !== undefined) return done(view, [{kind: 'actor', id: view.card}]);
    const id = selectedId(layout, view);
    return done(view, id === undefined ? [] : [{kind: 'open', id}]);
  }
  return {view, effects: [], consumed: false};
}

export interface TeamPointer {
  /** Coordinates inside the sidebar (0,0 is its top-left cell). */
  readonly x: number; readonly y: number;
  readonly action: 'press' | 'move' | 'wheel_up' | 'wheel_down' | 'drag' | 'release';
  readonly draggable?: boolean;
}
const EDGE_CLICK = '\0edge';
/** A press on the stage: the timeline controls, a card (select and filter; a second click opens the actor) or the current post (opens it). */
function stagePress(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, model: StageModel | undefined, hit: StageHit | undefined, x: number, now: number): [TeamView, readonly TeamEffect[]] {
  const focus: TeamEffect = {kind: 'focus'};
  if (!model || !hit) return [view, [focus]];
  const index = positionOf(layout, view) - 1;
  if (hit.kind === 'event') {
    // The current post under the stage opens like the same post in the feed: a second click within the double-click time.
    const id = selectedId(layout, view), key = 'event:' + id, double = id !== undefined && view.lastClick?.id === key && now - view.lastClick.time <= DOUBLE_CLICK_MS;
    return [{...view, lastClick: double ? undefined : {id: key, time: now}}, double && id !== undefined ? [focus, {kind: 'open', id}] : [focus]];
  }
  if (hit.kind === 'card') {
    const key = 'card:' + hit.id, double = view.lastClick?.id === key && now - view.lastClick.time <= DOUBLE_CLICK_MS;
    // A second click on the same card opens its actor (the filter the first click set stays); a card is a member, the person's marker only filters.
    if (double && hit.id !== 'user') return [{...view, card: hit.id, lastClick: undefined}, [focus, {kind: 'actor', id: hit.id}]];
    const clear = view.filter === hit.id;
    return [{...filtered(view, clear ? undefined : hit.id), card: clear || hit.id === 'user' ? undefined : hit.id, lastClick: {id: key, time: now}}, [focus]];
  }
  switch (hit.control) {
    case 'prev': return [selectAt(layout, view, geometry, index - 1), [focus]];
    case 'next': return [selectAt(layout, view, geometry, index + 1), [focus]];
    case 'play': return [togglePlay(layout, view, geometry, now), [focus]];
    case 'speed': return [{...view, speed: nextSpeed(speedOf(view), 1, true)}, [focus]];
    case 'scrub': return [{...selectAt(layout, view, geometry, scrubPosition(model.controls.bar, x, layout.ids.length) - 1), scrubbing: true}, [focus]];
    default: return [view, [focus]];
  }
}
const regionAt = (chrome: Chrome, x: number): TeamControl | undefined => chrome.regions.find(region => x >= region.x0 && x < region.x1)?.control;
/** Mouse over the Team tab: hover, the wheel and the stepping buttons (selection), click (select), double click (details), names (filter), the Live switch, the tabs and the member picker. */
export function stepTeamMouse(layout: TeamLayout, view: TeamView, geometry: TeamGeometry, pointer: TeamPointer, now: number, width: number, label: Labeler): TeamStep {
  const done = (next: TeamView, effects: readonly TeamEffect[] = []): TeamStep => ({view: next, effects, consumed: true});
  const content = width - CONTENT_X, cx = pointer.x - CONTENT_X;
  // A held scrubber follows the pointer wherever it is (the host feeds drags and the release even outside the panel).
  if (pointer.action === 'drag' || pointer.action === 'release') {
    if (!view.scrubbing) return done(view);
    if (pointer.action === 'release') return done({...view, scrubbing: false});
    const model = stageModel(layout, view, geometry, label);
    return done(model ? selectAt(layout, view, geometry, scrubPosition(model.controls.bar, cx, layout.ids.length) - 1) : {...view, scrubbing: false});
  }
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
  const rest = (patch: Partial<TeamView>): TeamView => ({...current, hoveredControl: undefined, hovered: undefined, hoveredName: undefined, hoveredStage: undefined, ...patch});
  const row = pointer.y - geometry.header - geometry.stage;
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
    if (footerRow && regionAt(footerChrome(layout, current, content, label, geometry.stage > 0), cx) === 'filter') return done({...current, picker: undefined}, [{kind: 'focus'}]);
    current = {...current, picker: undefined};
  }
  const stageRow = pointer.y - geometry.header;
  if (geometry.stage > 0 && stageRow >= 0 && stageRow < geometry.stage && !wheel) {
    const model = stageModel(layout, current, geometry, label), hit = model ? stageHit(model, cx, stageRow) : undefined;
    if (pointer.action === 'move') {
      const value = hit?.kind === 'control' ? hit.control : hit?.kind === 'card' ? 'card:' + hit.id : hit?.kind === 'event' ? 'event' : undefined;
      return move(value === current.hoveredStage && current.hovered === undefined && current.hoveredControl === undefined && current.hoveredName === undefined ? current : rest({hoveredStage: value}));
    }
    return done(...stagePress(layout, current, geometry, model, hit, cx, now));
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
    const control = regionAt(footerChrome(layout, current, content, label, geometry.stage > 0), cx);
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
    return move(box?.id === current.hovered && hoveredName === current.hoveredName && current.hoveredControl === undefined && current.hoveredStage === undefined ? current : rest({hovered: box?.id, hoveredName}));
  }
  if (!box) return done(current, [{kind: 'focus'}]);
  if (name) return done({...filtered(current, current.filter === name.member ? undefined : name.member), lastClick: undefined}, [{kind: 'focus'}]);
  const double = current.lastClick?.id === box.id && now - current.lastClick.time <= DOUBLE_CLICK_MS;
  const selected = selectAt(layout, current, geometry, layout.byId.get(box.id)!);
  return done({...selected, lastClick: double ? undefined : {id: box.id, time: now}}, double ? [{kind: 'focus'}, {kind: 'open', id: box.id}] : [{kind: 'focus'}]);
}
