/**
 * The plan flowchart as a pure layout: `buildFlow()` turns a derived plan (`src/runtime/plan.ts:derivePlan`) into rows of styled cells, the hit boxes of its
 * nodes and their reading order. It knows nothing about colours (cells carry a tone), the pointer or the clock; `plan-sidebar.ts` paints and drives it.
 *
 * Algorithm (deterministic, no crossing minimisation):
 *  1. Top-level nodes are phases, stacked in id order: a rule row with status glyph, id and title, a line with owner, status and progress, then their notes.
 *     An open phase lays its children out as a group; an accepted or abandoned phase starts collapsed (`expanded` overrides either way).
 *  2. A group is a set of siblings. A node's layer is 0 without prerequisites among its siblings, else 1 + the largest layer of those prerequisites.
 *     Layers are drawn top to bottom, nodes of a layer in id order.
 *  3. Nodes of one layer sit side by side (two per row when the sidebar is at least 48 columns wide and the group has 44 cells, else stacked). A node that is
 *     open and has children stands alone in its row and its children follow as a group indented by two cells. Chunks of one layer are separated by a
 *     `∥ parallel` row.
 *  4. Between the last chunk of layer k-1 and the first chunk of layer k, prerequisites that sit in the previous chunk are drawn as a two-row connector
 *     (a bus with `┌ ┬ ┐ ├ ┼ ┤ └ ┴ ┘ ─` and `▼` over each target). Every other prerequisite (skipping a layer, in another chunk, another phase) is a
 *     `↳ after 1.1` note under the node, so no line ever crosses a node.
 *  5. A node is a 3-row box (`╭ id title ─╮`, `│ owner  status clock │`, `╰─╯`) followed by notes: `▸ N steps` (`▾` when open), `◦ N workers · M done`, `↳ after …`.
 */
import stringWidth from 'string-width';
import {PLAN_GLYPHS} from '../../commands/plan-page.js';
import type {DerivedNode, DerivedPlan, NodeStatus} from '../../runtime/plan.js';
import {CLOCK_WIDTH, safeText} from '../terminal/text.js';

export type FlowTone = 'fg' | 'strong' | 'muted' | 'faint' | 'accent' | 'success' | 'warning' | 'error' | 'owner' | 'line';
export interface FlowCell {
  readonly text: string;
  readonly tone: FlowTone;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** The actor whose colour an `owner` cell wears. */
  readonly owner?: string;
  /** A border or rule cell of this node's box (it takes the hover and selection colour). */
  readonly node?: string;
  /** A connector cell between these nodes (it takes the hover colour of either). */
  readonly links?: readonly string[];
  /** The text is a fixed-width placeholder for the elapsed time since this epoch time (ms); the painter fills it. */
  readonly clock?: number;
}
export type FlowRow = readonly FlowCell[];
export interface FlowBox {
  readonly id: string;
  /** Rows `y0..y1` (inclusive, notes included) and columns `x0..x1` (exclusive) of the node; a phase spans the whole width. */
  readonly y0: number; readonly y1: number; readonly x0: number; readonly x1: number;
  /** The owner's name on the second row, a click target of its own. */
  readonly owner: {readonly y: number; readonly x0: number; readonly x1: number};
  readonly hasChildren: boolean;
  readonly open: boolean;
  readonly parent?: string;
}
export interface FlowLayout {
  readonly rows: readonly FlowRow[];
  readonly boxes: readonly FlowBox[];
  /** Node ids in reading order (only the nodes that are drawn). */
  readonly order: readonly string[];
  readonly width: number;
}
export interface FlowOptions {
  /** The inner width of the sidebar in cells. */
  readonly width: number;
  /** Whether the sidebar is wide enough for two nodes per row (its total width is at least 48). */
  readonly twoUp: boolean;
  /** Explicit open (true) or closed (false) states of parents; the rest follow the default. */
  readonly expanded: ReadonlyMap<string, boolean>;
  /** The symbol and name an owner is shown with. */
  readonly owners: (id: string) => {readonly symbol: string; readonly name: string};
}
/** Counts layouts built; tests assert an unrelated store change builds none. */
export const flowStats = {builds: 0};

const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});
/** `text` cut to at most `width` cells; a cut ends with `…` and never splits a wide character. */
export function fit(text: string, width: number): string {
  const clean = safeText(text).replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (stringWidth(clean) <= width) return clean;
  let out = '';
  for (const {segment} of segmenter.segment(clean)) {
    if (stringWidth(out + segment) > width - 1) break;
    out += segment;
  }
  return out + '…';
}
export const rowWidth = (row: FlowRow): number => row.reduce((sum, cell) => sum + stringWidth(cell.text), 0);

export const STATUS_TONE: Readonly<Record<NodeStatus, FlowTone>> = {pending: 'muted', ready: 'fg', running: 'accent', waiting: 'warning', done: 'success', accepted: 'success', failed: 'error', abandoned: 'muted'};
/** Whether a parent's children are drawn when the person has not chosen: everything except finished-and-accepted or abandoned subtrees. */
export const defaultOpen = (node: Pick<DerivedNode, 'status'>): boolean => node.status !== 'accepted' && node.status !== 'abandoned';

const cell = (text: string, tone: FlowTone, extra: Partial<FlowCell> = {}): FlowCell => ({text, tone, ...extra});
const spaces = (count: number): FlowCell => cell(' '.repeat(Math.max(0, count)), 'fg');

interface Slot {readonly node: DerivedNode; readonly x: number; readonly block: Block}
interface Block {readonly rows: readonly FlowRow[]; readonly ownerX0: number; readonly ownerX1: number}
interface Chunk {readonly slots: readonly Slot[]; readonly slotWidth: number}
interface Context {
  readonly options: FlowOptions;
  readonly rows: FlowRow[];
  readonly boxes: FlowBox[];
  readonly byParent: Map<string | undefined, DerivedNode[]>;
}

/** The second line of a node: owner, status, progress, clock; whole parts are dropped from the right until it fits. */
function statusLine(node: DerivedNode, options: FlowOptions, width: number): {cells: FlowCell[]; ownerX0: number; ownerX1: number} {
  const owner = options.owners(node.owner);
  const ownerText = owner.symbol + ' ' + owner.name;
  const glyph = PLAN_GLYPHS[node.status], tone = STATUS_TONE[node.status];
  const progress = node.progress ? `${node.progress.accepted}/${node.progress.total}` : '';
  const since = node.status === 'running' ? node.runningSince : undefined;
  const variants = [
    {label: true, progress: true, clock: true}, {label: true, progress: false, clock: true}, {label: true, progress: true, clock: false}, {label: true, progress: false, clock: false},
    {label: false, progress: false, clock: true}, {label: false, progress: false, clock: false},
  ];
  for (const variant of variants) {
    if (variant.clock && since === undefined) continue;
    if (variant.progress && !progress) continue;
    const parts: FlowCell[] = [cell(ownerText, 'owner', {owner: node.owner}), spaces(2), cell(glyph + (variant.label ? ' ' + node.status : ''), tone)];
    if (variant.progress) parts.push(spaces(1), cell(progress, 'muted'));
    if (variant.clock) parts.push(spaces(1), cell(' '.repeat(CLOCK_WIDTH), 'muted', {clock: since!}));
    if (rowWidth(parts) <= width) return {cells: parts, ownerX0: 0, ownerX1: stringWidth(ownerText)};
  }
  // Last resort: a clipped owner name and the glyph.
  const room = Math.max(1, width - 3);
  const shown = fit(ownerText, room);
  return {cells: [cell(shown, 'owner', {owner: node.owner}), spaces(1), cell(glyph, tone)], ownerX0: 0, ownerX1: stringWidth(shown)};
}

/** Notes under a node: its steps, its workers, and the prerequisites no connector shows. */
function notesOf(node: DerivedNode, ctx: Context, open: boolean, undrawn: readonly string[], width: number): FlowRow[] {
  const notes: FlowRow[] = [];
  const children = ctx.byParent.get(node.id) ?? [];
  if (children.length) notes.push([spaces(2), cell(fit(`${open ? '▾' : '▸'} ${children.length} ${children.length === 1 ? 'step' : 'steps'}`, width - 2), 'muted')]);
  const automa = new Set(node.links.flatMap(link => link.automaJob ? [link.automaJob] : []));
  const workers = node.work.filter(item => automa.has(item.id));
  if (workers.length) {
    const done = workers.filter(item => item.phase === 'completed').length;
    notes.push([spaces(2), cell(fit(`◦ ${workers.length} ${workers.length === 1 ? 'worker' : 'workers'} · ${done} done`, width - 2), 'muted')]);
  }
  if (undrawn.length) notes.push([spaces(2), cell(fit('↳ after ' + undrawn.join(', '), width - 2), 'faint')]);
  return notes;
}

function boxBlock(node: DerivedNode, ctx: Context, width: number, open: boolean, undrawn: readonly string[]): Block {
  const inner = width - 4;
  const label = fit(node.id + ' ' + node.title, width - 5);
  const fill = Math.max(1, width - 4 - stringWidth(label));
  const border = (text: string) => cell(text, 'line', {node: node.id});
  const top: FlowRow = [border('╭ '), cell(node.id, 'muted'), cell(label.slice(node.id.length), node.status === 'running' ? 'strong' : 'fg', {bold: node.status === 'running'}),
    border(' ' + '─'.repeat(fill) + '╮')];
  const line = statusLine(node, ctx.options, inner);
  const used = rowWidth(line.cells);
  const middle: FlowRow = [border('│ '), ...line.cells, spaces(inner - used), border(' │')];
  const bottom: FlowRow = [border('╰' + '─'.repeat(width - 2) + '╯')];
  // The id is part of the label: it was cut apart only to give it its own tone; when the label was clipped inside the id the whole label is one cell.
  const labelRow: FlowRow = label.startsWith(node.id) ? top : [border('╭ '), cell(label, 'fg'), border(' ' + '─'.repeat(fill) + '╮')];
  return {rows: [labelRow, middle, bottom, ...notesOf(node, ctx, open, undrawn, width)], ownerX0: 2 + line.ownerX0, ownerX1: 2 + line.ownerX1};
}

/** A phase: a rule row with glyph, id and title, then the owner line, then notes. */
function phaseBlock(node: DerivedNode, ctx: Context, width: number, open: boolean, undrawn: readonly string[]): Block {
  const rule = (text: string) => cell(text, 'line', {node: node.id});
  const lead = [rule('━ '), cell(PLAN_GLYPHS[node.status], STATUS_TONE[node.status])];
  const head = stringWidth(lead.map(item => item.text).join('')) + 1;
  const idText = node.id + ' ';
  const title = fit(node.title, Math.max(1, width - head - stringWidth(idText) - 2));
  const used = head + stringWidth(idText) + stringWidth(title) + 1;
  const first: FlowRow = [...lead, spaces(1), cell(idText, 'muted'), cell(title, 'strong', {bold: true}), spaces(1), rule('━'.repeat(Math.max(1, width - used)))];
  const line = statusLine(node, ctx.options, width - 2);
  return {rows: [first, [spaces(2), ...line.cells], ...notesOf(node, ctx, open, undrawn, width)], ownerX0: 2 + line.ownerX0, ownerX1: 2 + line.ownerX1};
}

const open = (node: DerivedNode, ctx: Context): boolean => ctx.options.expanded.get(node.id) ?? defaultOpen(node);

function layersOf(nodes: readonly DerivedNode[]): Map<string, number> {
  const byId = new Map(nodes.map(node => [node.id, node] as const));
  const memo = new Map<string, number>(), visiting = new Set<string>();
  const layer = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let result = 0;
    for (const ref of byId.get(id)!.after) if (byId.has(ref)) result = Math.max(result, layer(ref) + 1);
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const node of nodes) layer(node.id);
  return memo;
}

/** One row of marks (`x` -> glyph and the nodes it joins) as cells. */
function marksRow(width: number, marks: ReadonlyMap<number, {readonly ch: string; readonly links: readonly string[]}>): FlowRow {
  const cells: FlowCell[] = [];
  let at = 0;
  for (const x of [...marks.keys()].sort((a, b) => a - b)) {
    if (x >= width) break;
    if (x > at) cells.push(spaces(x - at));
    const mark = marks.get(x)!;
    cells.push(cell(mark.ch, 'line', {links: mark.links}));
    at = x + 1;
  }
  return cells;
}

/** The connector between the last chunk of a layer and the first of the next; returns the prerequisite pairs it drew (`from>to`). */
function connect(ctx: Context, from: Chunk, to: Chunk, width: number): Set<string> {
  const edges: {from: string; to: string; sx: number; tx: number}[] = [];
  for (const target of to.slots) for (const ref of target.node.after) {
    const source = from.slots.find(slot => slot.node.id === ref);
    if (source) edges.push({from: ref, to: target.node.id, sx: source.x + 2, tx: target.x + 2});
  }
  const drawn = new Set(edges.map(edge => edge.from + '>' + edge.to));
  if (!edges.length) return drawn;
  const sources = new Set(edges.map(edge => edge.sx)), targets = new Set(edges.map(edge => edge.tx));
  const stems = [...new Set([...sources, ...targets])].sort((a, b) => a - b);
  const min = stems[0]!, max = stems.at(-1)!;
  const linksAt = (x: number) => [...new Set(edges.filter(edge => x >= Math.min(edge.sx, edge.tx) && x <= Math.max(edge.sx, edge.tx)).flatMap(edge => [edge.from, edge.to]))];
  const bus = new Map<number, {ch: string; links: readonly string[]}>();
  for (let x = min; x <= max; x++) {
    const source = sources.has(x), target = targets.has(x);
    let ch = '─';
    if (min === max) ch = '│';
    else if (source || target) {
      const edge = x === min ? 'left' : x === max ? 'right' : 'middle';
      ch = edge === 'left' ? (source && target ? '├' : source ? '└' : '┌') : edge === 'right' ? (source && target ? '┤' : source ? '┘' : '┐') : (source && target ? '┼' : source ? '┴' : '┬');
    }
    bus.set(x, {ch, links: linksAt(x)});
  }
  ctx.rows.push(marksRow(width, bus));
  const arrows = new Map<number, {ch: string; links: readonly string[]}>();
  for (const x of targets) arrows.set(x, {ch: '▼', links: edges.filter(edge => edge.tx === x).flatMap(edge => [edge.from, edge.to])});
  ctx.rows.push(marksRow(width, arrows));
  return drawn;
}

/** Lays out the children of one parent (or the siblings of a group) below the rows already placed. */
function layoutGroup(ctx: Context, nodes: readonly DerivedNode[], indent: number, available: number): void {
  const layers = layersOf(nodes);
  const last = Math.max(0, ...layers.values());
  const perRow = ctx.options.twoUp && available >= 44 ? 2 : 1;
  const slotWidth = perRow === 2 ? Math.floor((available - 1) / 2) : available;
  let previous: Chunk | undefined;
  for (let level = 0; level <= last; level++) {
    const members = nodes.filter(node => layers.get(node.id) === level);
    const chunks: DerivedNode[][] = [];
    for (const node of members) {
      const tail = chunks.at(-1);
      const parent = (ctx.byParent.get(node.id)?.length ?? 0) > 0 && open(node, ctx);
      const tailParent = tail && (ctx.byParent.get(tail.at(-1)!.id)?.length ?? 0) > 0 && open(tail.at(-1)!, ctx);
      if (!tail || parent || tailParent || tail.length >= perRow) chunks.push([node]); else tail.push(node);
    }
    let lastChunk: Chunk | undefined;
    chunks.forEach((chunk, index) => {
      if (index > 0) ctx.rows.push([spaces(indent), cell('∥ parallel', 'faint', {italic: true})]);
      const slots: Slot[] = [];
      const shell: Chunk = {slots, slotWidth};
      const x0s = chunk.map((_, slot) => indent + slot * (slotWidth + 1));
      // Prerequisites a connector draws never repeat as notes; the connector needs the slot positions first.
      const placeholder: Slot[] = chunk.map((node, slot) => ({node, x: x0s[slot]!, block: {rows: [], ownerX0: 0, ownerX1: 0}}));
      const drawn = index === 0 && previous ? connect(ctx, previous, {slots: placeholder, slotWidth}, ctx.options.width) : new Set<string>();
      for (const [slot, node] of chunk.entries()) {
        const undrawn = node.after.filter(ref => !drawn.has(ref + '>' + node.id));
        const isOpen = open(node, ctx);
        const block = boxBlock(node, ctx, slotWidth, isOpen, undrawn);
        slots.push({node, x: x0s[slot]!, block});
      }
      const height = Math.max(...slots.map(slot => slot.block.rows.length));
      const y0 = ctx.rows.length;
      for (let r = 0; r < height; r++) {
        const row: FlowCell[] = [spaces(indent)];
        slots.forEach((slot, slotIndex) => {
          if (slotIndex > 0) row.push(spaces(1));
          const source = slot.block.rows[r];
          row.push(...(source ?? [spaces(slotWidth)]));
          if (source) row.push(spaces(slotWidth - rowWidth(source)));
        });
        ctx.rows.push(row);
      }
      for (const slot of slots) {
        const kids = ctx.byParent.get(slot.node.id) ?? [];
        ctx.boxes.push({id: slot.node.id, y0, y1: y0 + slot.block.rows.length - 1, x0: slot.x, x1: slot.x + slotWidth,
          owner: {y: y0 + 1, x0: slot.x + slot.block.ownerX0, x1: slot.x + slot.block.ownerX1}, hasChildren: kids.length > 0, open: open(slot.node, ctx),
          ...(slot.node.parent ? {parent: slot.node.parent} : {})});
      }
      lastChunk = shell;
      // The children of a lone open node follow it, indented.
      const only = slots[0]!;
      const kids = ctx.byParent.get(only.node.id) ?? [];
      if (slots.length === 1 && kids.length && open(only.node, ctx)) layoutGroup(ctx, kids, indent + 2, available - 2);
    });
    previous = lastChunk;
  }
}

/** The whole plan as rows, boxes and reading order. Pure; the same plan, width and expansion give the same layout. */
export function buildFlow(plan: DerivedPlan, options: FlowOptions): FlowLayout {
  flowStats.builds++;
  const byParent = new Map<string | undefined, DerivedNode[]>();
  for (const node of plan.nodes) byParent.set(node.parent, [...byParent.get(node.parent) ?? [], node]);
  const ctx: Context = {options, rows: [], boxes: [], byParent};
  const top = byParent.get(undefined) ?? [];
  if (!top.length) ctx.rows.push([cell('No steps yet.', 'muted', {italic: true})]);
  top.forEach((node, index) => {
    if (index > 0) ctx.rows.push([]);
    const isOpen = open(node, ctx);
    // Prerequisites between phases are notes: the phases are already in reading order.
    const block = phaseBlock(node, ctx, options.width, isOpen, node.after);
    const y0 = ctx.rows.length;
    ctx.rows.push(...block.rows);
    const kids = byParent.get(node.id) ?? [];
    ctx.boxes.push({id: node.id, y0, y1: y0 + block.rows.length - 1, x0: 0, x1: options.width, owner: {y: y0 + 1, x0: block.ownerX0, x1: block.ownerX1}, hasChildren: kids.length > 0, open: isOpen});
    if (kids.length && isOpen) layoutGroup(ctx, kids, 0, options.width);
  });
  return {rows: ctx.rows, boxes: ctx.boxes, order: ctx.boxes.map(box => box.id), width: options.width};
}

/** The box under a point of the flow (columns from the content edge, rows from the top of the flow), and whether the point is on the owner's name. */
export function flowHit(flow: FlowLayout, x: number, y: number): {readonly box: FlowBox; readonly onOwner: boolean} | undefined {
  // Boxes of one row group never overlap; a node's notes belong to it, children (below an open node) have their own boxes.
  let found: FlowBox | undefined;
  for (const box of flow.boxes) if (y >= box.y0 && y <= box.y1 && x >= box.x0 && x < box.x1 && (!found || box.y0 >= found.y0)) found = box;
  if (!found) return undefined;
  return {box: found, onOwner: y === found.owner.y && x >= found.owner.x0 && x < found.owner.x1};
}
