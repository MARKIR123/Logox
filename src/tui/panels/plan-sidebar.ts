/**
 * The task sidebar (the flowchart of `src/runtime/task-graph.ts`: the plan and the work done, or an earlier session's plan) as pure functions: its width and geometry, `paintSidebar()` (flow layout + view state -> one line of styled segments per screen row, each
 * exactly as wide as the sidebar) and the two reducers that run keyboard (`stepKey`) and mouse (`stepMouse`) over a layout. `use-plan-sidebar.ts` holds the
 * state and applies the effects; `plan-flow.ts` decides what is drawn. Nothing here reads a clock or a store: the caller passes `now`.
 *
 * Geometry: column 0 is the border (`│`, accent while the sidebar has the keyboard), column 1 a space, the flow starts at column 2. Rows: a header (the graph's
 * title, then status, `accepted/total` of its work items and a thin bar, then a rule; a click on it or `p` opens the plan switcher), the scrolling body, a
 * footer (a rule and the tooltip line). A screen too short for both drops the rules.
 */
import stringWidth from 'string-width';
import type {DerivedPlan, LeafProgress} from '../../runtime/plan.js';
import {faintColor} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import type {SideSegment} from '../terminal/terminal-plane.js';
import {fit, flowHit, perFit, type FlowCell, type FlowLayout, type FlowOptions, type FlowRow, type FlowTone} from './plan-flow.js';

/** The sidebar docks beside the timeline only at this many columns or more; narrower terminals open it as an overlay. */
export const DOCK_MIN_COLUMNS = 110;
export const SIDEBAR_MIN = 36, SIDEBAR_MAX = 56;
/** The first column of the flow inside the sidebar (border and one space). */
export const CONTENT_X = 2;
/** Seconds after a wheel or page scroll during which the sidebar does not follow the running node. */
export const FOLLOW_PAUSE_MS = 10_000;
export const DOUBLE_CLICK_MS = 350;

/** 34% of the usable width, clamped to 36..56 columns. */
export const sidebarWidth = (width: number): number => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(width * 0.34)));
/** The flow width of a panel `width` cells wide and how many nodes a row may hold there: 1 below 48 columns, 2 at 48..67 (the sidebar), more in a full-screen view. */
export const flowOptionsFor = (width: number): Pick<FlowOptions, 'width' | 'perRow'> => ({width: width - CONTENT_X - 1, perRow: perFit(width - CONTENT_X - 1)});

/** What a panel draws: the session's task graph with its plan, the task graph of a session without a plan (`work`), or a plan of an earlier session (read-only). */
export type GraphKind = 'plan' | 'work' | 'earlier';

export interface SidebarGeometry {readonly height: number; readonly header: number; readonly footer: number; readonly body: number}
export function sidebarGeometry(height: number): SidebarGeometry {
  if (height >= 9) return {height, header: 3, footer: 2, body: height - 5};
  if (height >= 4) return {height, header: 2, footer: 1, body: height - 3};
  return {height, header: Math.min(1, height), footer: 0, body: Math.max(0, height - 1)};
}

export interface SidebarView {
  /** Parents the person opened (true) or closed (false); the rest follow `defaultOpen`. */
  readonly expanded: ReadonlyMap<string, boolean>;
  readonly selected?: string | undefined;
  readonly hovered?: string | undefined;
  /** The first flow row shown. */
  readonly scroll: number;
  /** When the person last scrolled (wheel, page keys): the running node is not followed for `FOLLOW_PAUSE_MS` after. */
  readonly scrolledAt: number;
  readonly lastClick?: {readonly id: string; readonly time: number} | undefined;
  /** The pointer is over the header (a click there opens the plan switcher). */
  readonly hoveredHeader?: boolean | undefined;
}
export const emptyView: SidebarView = {expanded: new Map(), scroll: 0, scrolledAt: -Infinity};

/**
 * The outcome of the work items: the live nodes that have no live children (the same leaves a phase counts, `DerivedNode.leaves`, so header and phases agree).
 * `done` counts accepted and done work alike, failed and interrupted ones are counted apart.
 */
export function planProgress(plan: DerivedPlan): LeafProgress {
  const live = (id: string) => plan.nodes.find(child => child.id === id)?.status !== 'abandoned';
  const leaves = plan.nodes.filter(node => node.status !== 'abandoned' && !node.children.some(live));
  const count = (...wanted: string[]) => leaves.filter(node => wanted.includes(node.status)).length;
  return {done: count('done', 'accepted'), failed: count('failed'), interrupted: count('interrupted'), total: leaves.length};
}

const maxScroll = (flow: FlowLayout, geometry: SidebarGeometry) => Math.max(0, flow.rows.length - geometry.body);
export const clampScroll = (view: SidebarView, flow: FlowLayout, geometry: SidebarGeometry): SidebarView => {
  const scroll = Math.max(0, Math.min(maxScroll(flow, geometry), view.scroll));
  return scroll === view.scroll ? view : {...view, scroll};
};
/** The view scrolled just enough to show the node (its top row when it is taller than the body). */
export function revealNode(view: SidebarView, flow: FlowLayout, geometry: SidebarGeometry, id: string): SidebarView {
  const box = flow.boxes.find(item => item.id === id);
  if (!box || geometry.body <= 0) return view;
  let scroll = view.scroll;
  if (box.y0 < scroll) scroll = box.y0;
  else if (box.y1 >= scroll + geometry.body) scroll = Math.min(box.y0, box.y1 - geometry.body + 1);
  return scroll === view.scroll ? view : clampScroll({...view, scroll}, flow, geometry);
}
/** The running node to follow: the first drawn node, in reading order, that runs and has no drawn running child. */
export function followTarget(plan: DerivedPlan, flow: FlowLayout): string | undefined {
  const status = new Map(plan.nodes.map(node => [node.id, node.status] as const));
  const drawn = new Set(flow.order);
  return flow.order.find(id => status.get(id) === 'running' && !(plan.nodes.find(node => node.id === id)?.children ?? []).some(child => drawn.has(child) && status.get(child) === 'running'));
}

const rule = (width: number, tone: FlowTone = 'line'): FlowRow => [{text: '─'.repeat(Math.max(0, width)), tone}];

export interface PaintInput {
  readonly plan: DerivedPlan;
  readonly flow: FlowLayout;
  readonly view: SidebarView;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  /** The colour of an owner's name. */
  readonly ownerColor: (id: string) => string;
  /** What is drawn (default: a plan). */
  readonly kind?: GraphKind;
  /** The nodes synthesized from delegations. */
  readonly synthetic?: ReadonlySet<string>;
}
function toneColor(tone: FlowTone): string {
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
function segmentOf(cell: FlowCell, input: PaintInput): SideSegment {
  const {hovered, selected} = input.view;
  let color: string;
  if (cell.tone === 'owner') color = input.ownerColor(cell.owner ?? '');
  else if (cell.node !== undefined) color = cell.node === hovered ? palette.accent : cell.node === selected ? palette.strong : toneColor(cell.tone);
  else if (cell.links && hovered !== undefined && cell.links.includes(hovered)) color = palette.accent;
  else color = toneColor(cell.tone);
  return {text: cell.text, color, ...(cell.bold || cell.node !== undefined && cell.node === selected ? {bold: true} : {}), ...(cell.italic ? {italic: true} : {}),
    ...(cell.clock !== undefined ? {clock: cell.clock} : {})};
}
function merge(segments: readonly SideSegment[]): SideSegment[] {
  const result: SideSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = result.at(-1);
    if (last && last.clock === undefined && segment.clock === undefined && last.color === segment.color && last.bold === segment.bold && last.italic === segment.italic) result[result.length - 1] = {...last, text: last.text + segment.text};
    else result.push(segment);
  }
  return result;
}
/** `lead` segments, then the cells of `row` clipped to the content width, padded to `width` cells. */
function line(input: PaintInput, row: readonly SideSegment[]): SideSegment[] {
  const room = input.width - CONTENT_X;
  const out: SideSegment[] = [];
  let used = 0;
  for (const segment of row) {
    if (used >= room) break;
    const size = stringWidth(segment.text);
    if (used + size <= room) {out.push(segment); used += size; continue;}
    out.push({...segment, text: fit(segment.text, room - used).replace(/…$/, ' ')}); used = room; break;
  }
  const border: SideSegment = {text: '│ ', color: input.focused ? palette.accent : palette.line};
  return merge([border, ...out, {text: ' '.repeat(Math.max(0, room - used)), color: palette.fg}]);
}
const plain = (cells: readonly FlowCell[], input: PaintInput) => cells.map(cell => segmentOf(cell, input));

/** The tooltip under the body: the hovered (else selected) node's first acceptance check or latest note, else a hint. */
export function tooltipFor(plan: DerivedPlan, view: SidebarView, focused: boolean, kind: GraphKind = 'plan'): string {
  if (view.hoveredHeader) return 'Click or p: switch plan or work view';
  const id = view.hovered ?? view.selected;
  const node = id === undefined ? undefined : plan.nodes.find(item => item.id === id);
  if (!node) {
    if (kind === 'earlier') return 'Read-only · re-activate: /tasks plans';
    if (kind === 'work') return focused ? '↑↓←→ · Enter open · p plans · Esc' : 'No plan · click selects · double-click opens the task';
    return focused ? '↑↓←→ · Enter open · p plans · Esc' : 'Click selects · double-click opens details';
  }
  if (kind === 'work') return node.note ? 'Result: ' + node.note : node.id + ' · ' + node.status;
  if (node.acceptance.length) return 'Check: ' + node.acceptance[0];
  const note = node.note?.split('\n').filter(Boolean).at(-1);
  return note ? 'Note: ' + note : node.id + ' has no check or note yet.';
}

/** The sidebar as `height` lines of segments, each exactly `width` cells wide. */
export function paintSidebar(input: PaintInput): SideSegment[][] {
  const {plan, flow, view, width, height} = input;
  const geometry = sidebarGeometry(height);
  const content = width - CONTENT_X;
  const lines: SideSegment[][] = [];
  const kind = input.kind ?? 'plan';
  const progress = planProgress(plan);
  if (geometry.header >= 1) {
    const title: FlowCell[] = kind === 'work'
      ? [{text: 'Tasks', tone: 'strong', bold: true}, {text: ' · no plan', tone: 'muted'}]
      : [{text: kind === 'earlier' ? 'Earlier tasks ' : 'Tasks ', tone: 'muted'}, {text: fit(plan.title, Math.max(1, content - (kind === 'earlier' ? 14 : 6))), tone: 'strong', bold: true}];
    lines.push(line(input, plain(title, input)));
  }
  if (geometry.header >= 2) {
    const tone: FlowTone = plan.status === 'active' ? 'accent' : plan.status === 'done' ? 'success' : 'muted';
    const statusText = kind === 'earlier' ? 'read-only · ' + plan.status : kind === 'work' ? (plan.status === 'active' ? 'working' : 'settled') : plan.status;
    const head = `${progress.done}/${progress.total} ` + (kind === 'work' ? 'done ' : '') + (progress.failed ? `· ${progress.failed} failed ` : '');
    const room = Math.min(16, content - statusText.length - 3 - head.length);
    const cells: FlowCell[] = [{text: statusText, tone}, {text: ' · ', tone: 'muted'}, {text: head, tone: 'fg'}];
    if (room >= 4) {
      const filled = progress.total ? Math.round(room * progress.done / progress.total) : 0;
      cells.push({text: '━'.repeat(filled), tone: 'success'}, {text: '─'.repeat(room - filled), tone: 'line'});
    }
    lines.push(line(input, plain(cells, input)));
  }
  const more = view.scroll > 0, below = view.scroll < maxScroll(flow, geometry);
  const marked = (text: string, show: boolean): FlowRow => show ? [{text: text.slice(0, -1), tone: 'line'}, {text: '▲', tone: 'muted'}] : rule(content);
  if (geometry.header >= 3) lines.push(line(input, plain(marked('─'.repeat(content), more), input)));
  for (let i = 0; i < geometry.body; i++) lines.push(line(input, plain(flow.rows[view.scroll + i] ?? [], input)));
  if (geometry.footer >= 2) {
    const text = '─'.repeat(content);
    lines.push(line(input, plain(below ? [{text: text.slice(0, -1), tone: 'line'}, {text: '▼', tone: 'muted'}] : rule(content), input)));
  }
  if (geometry.footer >= 1) lines.push(line(input, plain([{text: fit(tooltipFor(plan, view, input.focused, kind), content), tone: 'muted', italic: true}], input)));
  return lines.slice(0, height);
}

// ---------------------------------------------------------------------------------------------------------------------------------- interaction
export type SidebarEffect =
  | {readonly kind: 'open'; readonly id: string}
  | {readonly kind: 'owner'; readonly id: string}
  | {readonly kind: 'focus'}
  | {readonly kind: 'blur'}
  | {readonly kind: 'plans'}
  | {readonly kind: 'close'};
export interface SidebarStep {readonly view: SidebarView; readonly effects: readonly SidebarEffect[]; readonly consumed: boolean}
const toggled = (view: SidebarView, id: string, open: boolean): SidebarView => ({...view, expanded: new Map(view.expanded).set(id, open)});
const withScroll = (view: SidebarView, flow: FlowLayout, geometry: SidebarGeometry, scroll: number, now: number): SidebarView => {
  const next = clampScroll({...view, scroll, scrolledAt: now}, flow, geometry);
  return next.scroll === view.scroll ? view : next;
};

export interface SidebarKey {readonly up?: boolean; readonly down?: boolean; readonly left?: boolean; readonly right?: boolean; readonly enter?: boolean; readonly escape?: boolean;
  readonly pageUp?: boolean; readonly pageDown?: boolean; readonly home?: boolean; readonly end?: boolean;
  /** `p`: open the plan switcher. */
  readonly plans?: boolean}
/** Keyboard while the sidebar has focus: arrows move between nodes and fold, Enter opens, Esc gives focus back. */
export function stepKey(flow: FlowLayout, view: SidebarView, geometry: SidebarGeometry, key: SidebarKey, now: number): SidebarStep {
  const order = flow.order;
  const at = view.selected === undefined ? -1 : order.indexOf(view.selected);
  const select = (id: string): SidebarStep => ({view: revealNode({...view, selected: id}, flow, geometry, id), effects: [], consumed: true});
  if (key.escape) return {view, effects: [{kind: 'blur'}], consumed: true};
  if (key.plans) return {view, effects: [{kind: 'plans'}], consumed: true};
  if (key.up || key.down) {
    if (!order.length) return {view, effects: [], consumed: true};
    const next = at < 0 ? (key.down ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + (key.down ? 1 : -1)));
    return select(order[next]!);
  }
  if (key.home || key.end) return order.length ? select(order[key.home ? 0 : order.length - 1]!) : {view, effects: [], consumed: true};
  if (key.pageUp || key.pageDown) return {view: withScroll(view, flow, geometry, view.scroll + (key.pageUp ? -1 : 1) * Math.max(1, geometry.body - 1), now), effects: [], consumed: true};
  const box = at < 0 ? undefined : flow.boxes.find(item => item.id === order[at]);
  if (key.left) {
    if (box?.hasChildren && box.open) return {view: toggled(view, box.id, false), effects: [], consumed: true};
    if (box?.parent) return select(box.parent);
    return {view, effects: [], consumed: true};
  }
  if (key.right) {
    if (box?.hasChildren && !box.open) return {view: toggled(view, box.id, true), effects: [], consumed: true};
    const child = box ? flow.boxes.find(item => item.parent === box.id) : undefined;
    if (child) return select(child.id);
    return {view, effects: [], consumed: true};
  }
  if (key.enter) {
    const id = view.selected !== undefined && order.includes(view.selected) ? view.selected : order[0];
    return {view: id !== undefined && view.selected === undefined ? {...view, selected: id} : view, effects: id === undefined ? [] : [{kind: 'open', id}], consumed: true};
  }
  return {view, effects: [], consumed: false};
}

export interface SidebarPointer {
  /** Coordinates inside the sidebar (0,0 is its top-left cell). */
  readonly x: number; readonly y: number;
  readonly action: 'press' | 'move' | 'wheel_up' | 'wheel_down';
}
/** Mouse over the sidebar: hover, wheel, click (select; the fold glyph folds), double click (details) and the owner name (jump to its card). */
export function stepMouse(flow: FlowLayout, view: SidebarView, geometry: SidebarGeometry, pointer: SidebarPointer, now: number): SidebarStep {
  const onHeader = pointer.y < geometry.header;
  if (onHeader && (pointer.action === 'move' || pointer.action === 'press')) {
    return pointer.action === 'press' ? {view, effects: [{kind: 'focus'}, {kind: 'plans'}], consumed: true}
      : {view: view.hoveredHeader && view.hovered === undefined ? view : {...view, hoveredHeader: true, hovered: undefined}, effects: [], consumed: true};
  }
  if (pointer.action === 'move' && view.hoveredHeader) view = {...view, hoveredHeader: false};
  if (pointer.action === 'wheel_up' || pointer.action === 'wheel_down') return {view: withScroll(view, flow, geometry, view.scroll + (pointer.action === 'wheel_up' ? -3 : 3), now), effects: [], consumed: true};
  const inBody = pointer.y >= geometry.header && pointer.y < geometry.header + geometry.body;
  const hit = inBody ? flowHit(flow, pointer.x - CONTENT_X, pointer.y - geometry.header + view.scroll) : undefined;
  if (pointer.action === 'move') return {view: view.hovered === hit?.box.id ? view : {...view, hovered: hit?.box.id}, effects: [], consumed: true};
  if (!hit) return {view, effects: [{kind: 'focus'}], consumed: true};
  const effects: SidebarEffect[] = [{kind: 'focus'}];
  if (hit.onOwner) return {view: {...view, selected: hit.box.id, lastClick: undefined}, effects: [...effects, {kind: 'owner', id: hit.box.id}], consumed: true};
  const double = view.lastClick?.id === hit.box.id && now - view.lastClick.time <= DOUBLE_CLICK_MS;
  let next: SidebarView = {...view, selected: hit.box.id, lastClick: double ? undefined : {id: hit.box.id, time: now}};
  // Only the fold glyph folds: a click anywhere else selects, so the second click of a double click never lands on a layout that moved.
  if (hit.onFold && hit.box.hasChildren) next = toggled({...next, lastClick: undefined}, hit.box.id, !hit.box.open);
  return {view: next, effects: double ? [...effects, {kind: 'open', id: hit.box.id}] : effects, consumed: true};
}
