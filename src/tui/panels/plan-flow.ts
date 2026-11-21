/**
 * The plan flowchart as a pure layout: `buildFlow()` turns a derived plan (`src/runtime/plan.ts:derivePlan`) into rows of styled cells, the hit boxes of its
 * nodes and their reading order. It knows nothing about colours (cells carry a tone), the pointer or the clock; `plan-sidebar.ts` paints and drives it.
 *
 * Reading rule: an arrow means "then"; cards with no arrow between them run in parallel.
 *
 * Algorithm (deterministic, no crossing minimisation):
 *  1. Top-level nodes are phases, stacked in id order with one blank row before each but the first, each one line: fold glyph (parents), a status glyph only
 *     while the phase is running, waiting, failed or interrupted, the title, then at the right the owner (only when it is not the Director), a thin progress bar
 *     `━━━━━━` and the count of the leaves below (`3/5 · 1 failed`). An open phase lays its children out as a group; an accepted or abandoned phase starts
 *     collapsed (`expanded` overrides either way).
 *  2. A group is a set of siblings. A node's layer is 0 without prerequisites among its siblings, else 1 + the largest layer of those prerequisites.
 *     Layers are drawn top to bottom, nodes of a layer in id order. One layer is one row of side-by-side cards.
 *  3. A layer that does not fit wraps onto the next row (nothing between: the borders separate the cards, rows filled evenly): as many cards per row as fit `MIN_BOX` (15)
 *     cells each with `GAP` (2) cells between (`perFit()`), at most `FlowOptions.perRow`. The cards of a printed row share the full width evenly (a lone card
 *     is full width, two are halves, three thirds); connectors land on the centres of the actual cards. A node that is open and has children stands alone in
 *     its row and its children follow as a group indented by two cells.
 *  4. Between the last row of layer k-1 and the first row of layer k an arrow connector is drawn in the faint `line` tone: where the prerequisites sit in those two
 *     rows, a bus (rounded `╭ ╮ ╰ ╯` corners, `┬ ┴ ├ ┼ ┤ ─` with `▼` over each target); otherwise one centred `▼`. Only a prerequisite that skips a layer or sits in
 *     another group is a `↳ after <title>` note under the node, so no line ever crosses a node. Ids are never drawn.
 *  5. A node is a fill-less 2-row rounded card whose borders carry the content: the top border `╭─ ◉ Title ───── ▾ ─╮` (status glyph, title, and for a parent its
 *     fold glyph) and the bottom border `╰─ owner ◦3 ───── 3m12s ─╯` (owner, workers, right-aligned meta: the live clock while running, what it waits for, the finished
 *     duration, `failed` or `interrupted`). The meta is dropped whole when it does not fit, then the workers; the owner is only clipped. The result lives in the
 *     tooltip and the detail page. The title cell carries `title` (the node id) so hover and selection can recolour it; border cells carry `frame`.
 */
import stringWidth from 'string-width';
import {PLAN_GLYPHS} from '../../commands/plan-page.js';
import {isDirector} from '../../runtime/director-id.js';
import {isEnvelope} from '../../runtime/delegations.js';
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
  /** The title cell of this node's card: the painter brightens it on hover and makes it bold accent when selected (a card has no fill). */
  readonly title?: string;
  /** A border cell of a card (`owner`: the owner's colour at a faint level, `faint` for an interrupted node): full owner colour on hover, accent when selected. */
  readonly frame?: 'owner' | 'faint';
  /** The text is a fixed-width placeholder for the elapsed time since this epoch time (ms); the painter fills it. */
  readonly clock?: number;
}
export type FlowRow = readonly FlowCell[];
export interface FlowBox {
  readonly id: string;
  /** Rows `y0..y1` (inclusive, notes included) and columns `x0..x1` (exclusive) of the node; a phase spans the whole width. */
  readonly y0: number; readonly y1: number; readonly x0: number; readonly x1: number;
  /** The owner's name (second row of a box, the header of a phase), a click target of its own; empty (`x0 === x1`) when none is shown. */
  readonly owner: {readonly y: number; readonly x0: number; readonly x1: number};
  /** The fold glyph of a parent (and a cell either side): the only click target that folds it; absent for a node without children. */
  readonly fold?: {readonly y: number; readonly x0: number; readonly x1: number};
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
  /** The most nodes a row may hold (`plan-sidebar.ts:flowOptionsFor` derives it from the panel width); a group narrower than that many boxes holds fewer. */
  readonly perRow: number;
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
/** The narrowest card the layout draws, and the cells between cards of a row. */
export const MIN_BOX = 15;
export const GAP = 2;
/** How many cards of at least `MIN_BOX` cells fit side by side in `room` cells (`GAP` cells between them). */
export const perFit = (room: number): number => Math.max(1, Math.floor((room + GAP) / (MIN_BOX + GAP)));
/** `45s`, `3m12s`, `2m`, `1h05m`: how long finished work took. */
export function formatTook(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000)), minutes = Math.floor(total / 60), seconds = total % 60;
  if (minutes < 1) return total + 's';
  if (minutes < 60) return minutes + 'm' + (seconds ? String(seconds).padStart(2, '0') + 's' : '');
  return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
}
export const rowWidth = (row: FlowRow): number => row.reduce((sum, cell) => sum + stringWidth(cell.text), 0);

export const STATUS_TONE: Readonly<Record<NodeStatus, FlowTone>> = {pending: 'muted', ready: 'fg', running: 'accent', waiting: 'warning', done: 'success', accepted: 'success', failed: 'error', interrupted: 'muted', abandoned: 'muted'};
/** Whether a parent's children are drawn when the person has not chosen: everything except finished-and-accepted or abandoned subtrees. */
export const defaultOpen = (node: Pick<DerivedNode, 'status'>): boolean => node.status !== 'accepted' && node.status !== 'abandoned';

const cell = (text: string, tone: FlowTone, extra: Partial<FlowCell> = {}): FlowCell => ({text, tone, ...extra});
const spaces = (count: number): FlowCell => cell(' '.repeat(Math.max(0, count)), 'fg');

interface Slot {readonly node: DerivedNode; readonly x: number; readonly width: number; readonly block: Block}
interface Block {readonly rows: readonly FlowRow[]; readonly ownerX0: number; readonly ownerX1: number; readonly fold?: {readonly x0: number; readonly x1: number}}
interface Chunk {readonly slots: readonly Slot[]; readonly slotWidth: number}
interface Context {
  readonly options: FlowOptions;
  readonly rows: FlowRow[];
  readonly boxes: FlowBox[];
  readonly byParent: Map<string | undefined, DerivedNode[]>;
  /** Node titles by id: the person never sees ids, so a prerequisite is named by its title. */
  readonly titles: Map<string, string>;
  /** Node owners by id (a blocked node names who it waits for). */
  readonly ownerOf: Map<string, string>;
}

/** The progress of a parent's leaves (`3/5 · 1 failed`); `short` leaves the failures out. A node with workers and no leaves shows their number (`◦3`). */
export function progressText(node: DerivedNode, short = false): string {
  const leaves = node.leaves;
  if (!leaves) {
    const workers = node.links.filter(link => link.automaJob).length;
    return workers ? '◦' + workers : '';
  }
  return `${leaves.done}/${leaves.total}` + (short ? '' : (leaves.failed ? ` · ${leaves.failed} failed` : '') + (leaves.interrupted ? ` · ${leaves.interrupted} interrupted` : ''));
}

/** What a card says about waiting on its second line: who it waits for (`blocked by kalon`) or `waiting`; nothing for work that is running or finished. */
function waitText(node: DerivedNode, ctx: Context): string {
  if (node.status !== 'pending' && node.status !== 'waiting' && node.status !== 'ready') return '';
  const names = [...new Set(node.blockedBy.map(id => ctx.options.owners(ctx.ownerOf.get(id) ?? '').name))];
  if (names.length) return 'blocked by ' + names.join(', ');
  return node.status === 'waiting' ? 'waiting' : '';
}
/** The latest line of a node's result, without message envelopes (shown in the tooltip, never on the card). */
export function resultText(node: DerivedNode): string {
  const note = node.note?.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';
  return isEnvelope(note) ? '' : note;
}

/** The right-aligned meta of a card's bottom border: the live clock (running), what it waits for, the finished duration, `failed` or `interrupted`; nothing otherwise. */
function metaOf(node: DerivedNode, ctx: Context): FlowCell | undefined {
  if (node.status === 'running') return node.runningSince === undefined ? undefined : cell(' '.repeat(CLOCK_WIDTH), 'faint', {clock: node.runningSince});
  const wait = waitText(node, ctx);
  if (wait) return cell(wait, 'faint', {italic: true});
  if ((node.status === 'done' || node.status === 'accepted') && node.took !== undefined) return cell(formatTook(node.took), 'faint');
  if (node.status === 'failed') return cell('failed', 'error');
  if (node.status === 'interrupted') return cell('interrupted', 'faint');
  return undefined;
}

/** The note under a node for the prerequisites no arrow shows (those that skip a layer or sit in another group). */
function notesOf(undrawn: readonly string[], ctx: Context, width: number): FlowRow[] {
  const room = width - 2;
  if (!undrawn.length || room <= 0) return [];
  // Each prerequisite by its title, joined with `, `; the titles share what is left of the line equally and a cut one ends with `…`.
  const prefix = '↳ after ';
  const titles = undrawn.map(id => ctx.titles.get(id) ?? '…');
  const share = Math.max(1, Math.floor((room - stringWidth(prefix) - (titles.length - 1) * 2) / titles.length));
  let text = prefix + titles.map(title => fit(title, share)).join(', ');
  if (stringWidth(text) > room) text = fit(text, room);
  return [[spaces(2), cell(text, 'faint')]];
}
const foldGlyph = (isOpen: boolean): string => isOpen ? '▾' : '▸';

/**
 * A node as a fill-less two-row rounded card whose borders carry the content: `╭─ ◉ Title ───── ▾ ─╮` over `╰─ owner ◦3 ───── 3m12s ─╯`. The border is the owner's colour
 * at a faint level (`FlowCell.frame`; an interrupted card's border and title are faint); the meta is dropped whole when it does not fit, then the workers, never the owner.
 */
function boxBlock(node: DerivedNode, ctx: Context, width: number, isOpen: boolean, undrawn: readonly string[]): Block {
  const parent = (ctx.byParent.get(node.id)?.length ?? 0) > 0;
  const frame = (text: string): FlowCell => cell(text, 'line', {frame: node.status === 'interrupted' ? 'faint' : 'owner', owner: node.owner, node: node.id});
  const dashes = (count: number): FlowCell => frame('─'.repeat(Math.max(0, count)));
  // Top border: `╭─ ` glyph space title space fill [` ▾ `] `─╮`.
  const running = node.status === 'running';
  const folds = parent ? 3 : 0;
  const label = fit(node.title, Math.max(1, width - 9 - folds));
  const titleTone: FlowTone = node.status === 'interrupted' ? 'faint' : running ? 'strong' : 'fg';
  const lead = 3 + 1 + 1 + stringWidth(label) + 1;
  const first: FlowRow = [frame('╭─ '), cell(PLAN_GLYPHS[node.status], STATUS_TONE[node.status]), frame(' '), cell(label, titleTone, {title: node.id, ...(running ? {bold: true} : {})}), frame(' '),
    dashes(width - lead - folds - 2), ...(parent ? [frame(' '), cell(foldGlyph(isOpen), 'muted'), frame(' ')] : []), frame('─╮')];
  // Bottom border: `╰─ ` owner [` ◦3`] space fill [` ` meta] ` ─╯`; the first variant that fits wins.
  const owner = ctx.options.owners(node.owner);
  const ownerText = fit(owner.name + (node.forked ? ' ⑂' : ''), Math.max(1, width - 7));
  const workers = node.leaves ? 0 : node.links.filter(link => link.automaJob).length;
  const workerText = workers ? ' ◦' + workers : '';
  const meta = metaOf(node, ctx);
  const metaSize = meta ? stringWidth(meta.text) : 0;
  const variants: {workers: boolean; meta: boolean}[] = [{workers: true, meta: true}, {workers: false, meta: true}, {workers: true, meta: false}, {workers: false, meta: false}];
  const chosen = variants.find(variant => (variant.workers || !workerText) && (variant.meta || !meta) &&
    3 + stringWidth(ownerText) + (variant.workers ? stringWidth(workerText) : 0) + 1 + 1 + (variant.meta ? metaSize + 4 : 2) <= width) ?? {workers: false, meta: false};
  const showWorkers = chosen.workers && workerText !== '', showMeta = chosen.meta && meta !== undefined;
  const left = 3 + stringWidth(ownerText) + (showWorkers ? stringWidth(workerText) : 0);
  const tail = showMeta ? metaSize + 4 : 2;
  const second: FlowRow = [frame('╰─ '), cell(ownerText, 'owner', {owner: node.owner}), ...(showWorkers ? [cell(workerText, 'faint')] : []), frame(' '), dashes(width - left - 1 - tail),
    ...(showMeta ? [frame(' '), meta!, frame(' ─╯')] : [frame('─╯')])];
  const foldX = lead + (width - lead - folds - 2) + 1;
  return {rows: [first, second, ...notesOf(undrawn, ctx, width)], ownerX0: 3, ownerX1: 3 + stringWidth(ownerText), ...(parent ? {fold: {x0: foldX, x1: foldX + 1}} : {})};
}

/**
 * A phase, one line: `▾ ● Title      owner ━━━━━━ 3/5 · 1 failed`: the fold glyph for a parent, a status glyph only while the phase is not done, the owner only when it
 * is not the Director, then a thin progress bar (accent for the finished part, faint for the rest) and the count of the leaves below.
 */
function phaseBlock(node: DerivedNode, ctx: Context, width: number, isOpen: boolean, undrawn: readonly string[]): Block {
  const parent = (ctx.byParent.get(node.id)?.length ?? 0) > 0;
  const mark = {node: node.id};
  const owner = isDirector(node.owner) ? undefined : ctx.options.owners(node.owner);
  const ownerText = owner ? owner.name + (node.forked ? ' ⑂' : '') : '';
  const counts = progressText(node);
  const showStatus = !['done', 'accepted', 'pending', 'ready', 'abandoned'].includes(node.status);
  const lead: FlowCell[] = [parent ? cell(foldGlyph(isOpen), 'muted', mark) : spaces(1), spaces(1), ...(showStatus ? [cell(PLAN_GLYPHS[node.status], STATUS_TONE[node.status], mark), spaces(1)] : [])];
  const leadWidth = rowWidth(lead);
  const total = node.leaves?.total ?? 0;
  const own = stringWidth(ownerText), countWidth = stringWidth(counts);
  // The right side by variant: a 6-cell bar, a 3-cell bar, none; the title keeps at least 8 cells (or all of itself) before the bar shrinks.
  let barWidth = 0, tailWidth = 0;
  for (const bar of total ? [6, 3, 0] : [0]) {
    const size = (own ? own + 2 : 0) + (bar ? bar + (countWidth ? 1 : 0) : 0) + countWidth;
    barWidth = bar; tailWidth = size;
    if (width - leadWidth - (size ? size + 1 : 0) >= Math.min(8, stringWidth(node.title))) break;
  }
  const title = fit(node.title, Math.max(1, width - leadWidth - (tailWidth ? tailWidth + 1 : 0)));
  const gap = Math.max(1, width - leadWidth - stringWidth(title) - tailWidth);
  const tail: FlowCell[] = [];
  if (ownerText) tail.push(cell(ownerText, 'owner', {owner: node.owner}));
  if (ownerText && (barWidth || counts)) tail.push(spaces(2));
  if (barWidth) {
    const filled = Math.round(barWidth * (node.leaves?.done ?? 0) / total);
    tail.push(cell('━'.repeat(filled), 'accent'), cell('━'.repeat(barWidth - filled), 'faint'));
    if (counts) tail.push(spaces(1));
  }
  if (counts) tail.push(cell(counts, 'muted'));
  const ownerX0 = leadWidth + stringWidth(title) + gap;
  const first: FlowRow = [...lead, cell(title, 'strong', {...mark, bold: true}), spaces(gap), ...tail];
  return {rows: [first, ...notesOf(undrawn, ctx, width)], ownerX0: ownerText ? ownerX0 : 0, ownerX1: ownerText ? ownerX0 + own : 0, ...(parent ? {fold: {x0: 0, x1: 1}} : {})};
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

/**
 * The arrow between the last row of a layer and the first of the next. Where prerequisites sit in those two rows, a bus with `▼` over each target; otherwise
 * one centred `▼` (an arrow means "then"). Returns the prerequisite pairs a bus drew (`from>to`).
 */
function connect(ctx: Context, from: Chunk, to: Chunk, indent: number, available: number): Set<string> {
  const width = ctx.options.width;
  const edges: {from: string; to: string; sx: number; tx: number}[] = [];
  for (const target of to.slots) for (const ref of target.node.after) {
    const source = from.slots.find(slot => slot.node.id === ref);
    if (source) edges.push({from: ref, to: target.node.id, sx: source.x + Math.floor(source.width / 2), tx: target.x + Math.floor(target.width / 2)});
  }
  const drawn = new Set(edges.map(edge => edge.from + '>' + edge.to));
  if (!edges.length) {
    const ids = [...from.slots, ...to.slots].map(slot => slot.node.id);
    ctx.rows.push(marksRow(width, new Map([[indent + Math.floor(available / 2), {ch: '▼', links: ids}]])));
    return drawn;
  }
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
      ch = edge === 'left' ? (source && target ? '├' : source ? '╰' : '╭') : edge === 'right' ? (source && target ? '┤' : source ? '╯' : '╮') : (source && target ? '┼' : source ? '┴' : '┬');
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
  const perRow = Math.max(1, Math.min(ctx.options.perRow, perFit(available)));
  let previous: Chunk | undefined;
  for (let level = 0; level <= last; level++) {
    const members = nodes.filter(node => layers.get(node.id) === level);
    const chunks: DerivedNode[][] = [];
    // A layer wraps into evenly filled rows (4 cards at 3 per row are 2 + 2); an open parent stands alone in its row.
    const isOpenParent = (node: DerivedNode) => (ctx.byParent.get(node.id)?.length ?? 0) > 0 && open(node, ctx);
    const plain = members.filter(node => !isOpenParent(node)).length;
    const even = Math.max(1, Math.ceil(plain / Math.max(1, Math.ceil(plain / perRow))));
    for (const node of members) {
      const tail = chunks.at(-1);
      const tailParent = tail && isOpenParent(tail.at(-1)!);
      if (!tail || isOpenParent(node) || tailParent || tail.length >= even) chunks.push([node]); else tail.push(node);
    }
    let lastChunk: Chunk | undefined;
    chunks.forEach((chunk, index) => {
      // The borders tell the cards of a wrapped layer apart: no blank row between its rows.
      const slots: Slot[] = [];
      const shell: Chunk = {slots, slotWidth: available};
      // The cards of a row share the whole width: a lone card is full width, two are halves, three thirds (the remainder goes to the first cards).
      const count = chunk.length, room = available - GAP * (count - 1);
      const widths = chunk.map((_, slot) => Math.floor(room / count) + (slot < room % count ? 1 : 0));
      const x0s = widths.map((_, slot) => indent + widths.slice(0, slot).reduce((sum, w) => sum + w + GAP, 0));
      // The arrow into a layer is drawn before its first row; the connector needs the slot positions first.
      const placeholder: Slot[] = chunk.map((node, slot) => ({node, x: x0s[slot]!, width: widths[slot]!, block: {rows: [], ownerX0: 0, ownerX1: 0}}));
      const drawn = index === 0 && previous ? connect(ctx, previous, {slots: placeholder, slotWidth: available}, indent, available) : new Set<string>();
      for (const [slot, node] of chunk.entries()) {
        // Prerequisites in the layer just above are what the arrow says; the others (a skipped layer, another group) are notes.
        const undrawn = node.after.filter(ref => !drawn.has(ref + '>' + node.id) && layers.get(ref) !== level - 1);
        const block = boxBlock(node, ctx, widths[slot]!, open(node, ctx), undrawn);
        slots.push({node, x: x0s[slot]!, width: widths[slot]!, block});
      }
      const height = Math.max(...slots.map(slot => slot.block.rows.length));
      const y0 = ctx.rows.length;
      for (let r = 0; r < height; r++) {
        const row: FlowCell[] = [spaces(indent)];
        slots.forEach((slot, slotIndex) => {
          if (slotIndex > 0) row.push(spaces(GAP));
          const source = slot.block.rows[r];
          row.push(...(source ?? [spaces(slot.width)]));
          if (source) row.push(spaces(slot.width - rowWidth(source)));
        });
        ctx.rows.push(row);
      }
      for (const slot of slots) {
        const kids = ctx.byParent.get(slot.node.id) ?? [];
        ctx.boxes.push({id: slot.node.id, y0, y1: y0 + slot.block.rows.length - 1, x0: slot.x, x1: slot.x + slot.width,
          owner: {y: y0 + 1, x0: slot.x + slot.block.ownerX0, x1: slot.x + slot.block.ownerX1},
          ...(slot.block.fold ? {fold: {y: y0, x0: slot.x + slot.block.fold.x0 - 1, x1: slot.x + slot.block.fold.x1 + 1}} : {}),
          hasChildren: kids.length > 0, open: open(slot.node, ctx), ...(slot.node.parent ? {parent: slot.node.parent} : {})});
      }
      // The first row of a layer follows the arrow; wrapped rows of the same layer follow each other with nothing between.
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
  const ctx: Context = {options, rows: [], boxes: [], byParent, titles: new Map(plan.nodes.map(node => [node.id, node.title] as const)),
    ownerOf: new Map(plan.nodes.map(node => [node.id, node.owner] as const))};
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
    ctx.boxes.push({id: node.id, y0, y1: y0 + block.rows.length - 1, x0: 0, x1: options.width, owner: {y: y0, x0: block.ownerX0, x1: block.ownerX1},
      ...(block.fold ? {fold: {y: y0, x0: 0, x1: 3}} : {}), hasChildren: kids.length > 0, open: isOpen});
    if (kids.length && isOpen) layoutGroup(ctx, kids, 0, options.width);
  });
  return {rows: ctx.rows, boxes: ctx.boxes, order: ctx.boxes.map(box => box.id), width: options.width};
}

/** The box under a point of the flow (columns from the content edge, rows from the top of the flow), whether the point is on the owner's name and whether it is on the fold glyph. */
export function flowHit(flow: FlowLayout, x: number, y: number): {readonly box: FlowBox; readonly onOwner: boolean; readonly onFold: boolean} | undefined {
  // Boxes of one row group never overlap; a node's notes belong to it, children (below an open node) have their own boxes.
  let found: FlowBox | undefined;
  for (const box of flow.boxes) if (y >= box.y0 && y <= box.y1 && x >= box.x0 && x < box.x1 && (!found || box.y0 >= found.y0)) found = box;
  if (!found) return undefined;
  const fold = found.fold;
  return {box: found, onOwner: y === found.owner.y && x >= found.owner.x0 && x < found.owner.x1, onFold: fold !== undefined && y === fold.y && x >= fold.x0 && x < fold.x1};
}
