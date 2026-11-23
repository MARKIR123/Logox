/**
 * The team stage drawn above the Team feed: Logox at the top centre, the companions in rows of equal rounded cards below it, a `you` marker for the person,
 * the assign and report edges along a bus and the messages between companions along channels. Everything is pure: `buildStage()` turns a `StageSnapshot`
 * (`src/runtime/team-stage.ts:stageAt`) and a width into rows of toned cells, the card hit boxes and the paths of the current event's edge; `pulseAt()` is the
 * position of the travelling dot as a function of elapsed milliseconds; `controlsRow()` and `stripRow()` are the timeline controls and the one-line status the
 * stage collapses to on a short sidebar. No cell ever carries a background.
 *
 * Cards: rounded (`╭╮╰╯`), equal width per row (`MIN_CARD` to `CAP_CARD`, `GAP` between), four rows (border, `<glyph> Name`, state, border) plus one row for the
 * workers the actor dispatched when any actor ever did (`◦ scout ✓  ◦ palette …  ⑂ sketch`, `◦3 ✓2` when narrow); a narrow or crowded stage uses the compact
 * form (name and a state glyph share a row). Companions that do not fit one row wrap into evenly filled rows left aligned at column 2.
 *
 * Edges are right-angled box characters on one canvas with connection masks (left, right, up, down), so lines join wherever they meet and never enter a card
 * (cards are locked cells). Assign and report run along the bus: down the stem under Logox, along the bus row, a trunk in column 0 to the next card row, and
 * two columns beside each card's centre (`▼` down, `▲` up). A message between companions uses the channel rows under its row of cards: every card has a port
 * under its bottom border, a message is the segment between the sender's port and the receiver's with an arrowhead before the receiver's port (`╰──▶╯`,
 * `╭◀──╯`), in the sender's colour, accent while it is the current event. At most `CHANNELS` rows; a message that would overlap another on every channel row
 * is not drawn (the current one is placed first, then the newer ones). A message between two card rows goes down the sender's port, along its channel to a
 * trunk in the last column, and into the receiver row's channel. Only the messages of the last `RECENT_EVENTS` events are drawn and open waits (dashed,
 * warning tone). Height never moves while a replay runs: it is reserved from the final state.
 */
import stringWidth from 'string-width';
import {DIRECTOR_ID} from '../../runtime/director-id.js';
import type {StageActor, StageJob, StageSnapshot, StageState} from '../../runtime/team-stage.js';
import {fit, formatTook, type FlowTone} from './plan-flow.js';

export const GAP = 3, MIN_CARD = 11, CAP_CARD = 16, LOGOX_CARD = 13, LOGOX_ROWS = 3;
/** Rows of channels under every card row that has message traffic. */
export const CHANNELS = 2;
/** How long the pulse takes along one edge. */
export const PULSE_MS = 500;
/** The sidebar height from which the full stage is drawn; shorter ones show the one-line strip, and under `STRIP_MIN` nothing. */
export const STAGE_FULL_MIN = 30, STRIP_MIN = 12;
/** The rows the feed keeps at least when the full stage is on. */
export const FEED_MIN = 5;

export interface StageCell {
  readonly text: string;
  readonly tone: FlowTone;
  /** The actor whose colour an `owner` cell wears. */
  readonly owner?: string;
  /** A card border or message at rest: the owner colour, faint; not set means the full colour. */
  readonly frame?: boolean;
  readonly bold?: boolean;
  /** The card this cell belongs to (hover and clicks). */
  readonly actor?: string;
}
export type StageRow = readonly StageCell[];
export interface StageBox {readonly id: string; readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number}
export interface Point {readonly x: number; readonly y: number}
export interface StagePlan {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly StageRow[];
  /** Card hit boxes: `x0` inclusive, `x1` exclusive, `y0` and `y1` inclusive; `user` is the marker above Logox. */
  readonly boxes: readonly StageBox[];
  /** One path per recipient of the current event, from the sender to the receiver (empty when the edge is not drawn). */
  readonly paths: readonly (readonly Point[])[];
}
export interface StageLabel {readonly symbol: string; readonly name: string}
export type StageLabeler = (id: string) => StageLabel;

// ---------------------------------------------------------------------------------------------------------------------------------- canvas
const L = 1, R = 2, U = 4, D = 8;
const GLYPH: Readonly<Record<number, string>> = {
  [L]: '─', [R]: '─', [L | R]: '─', [U]: '│', [D]: '│', [U | D]: '│', [R | D]: '╭', [L | D]: '╮', [R | U]: '╰', [L | U]: '╯',
  [L | R | D]: '┬', [L | R | U]: '┴', [U | D | R]: '├', [U | D | L]: '┤', [L | R | U | D]: '┼',
};
interface Style {readonly tone: FlowTone; readonly rank: number; readonly dashed: boolean; readonly owner?: string; readonly frame?: boolean}
const FAINT: Style = {tone: 'faint', rank: 1, dashed: false}, WAIT: Style = {tone: 'warning', rank: 2, dashed: true};
const NOW: Style = {tone: 'accent', rank: 4, dashed: false}, NOW_WAIT: Style = {tone: 'accent', rank: 4, dashed: true};
const sent = (from: string, age: number): Style => ({tone: 'owner', owner: from, rank: 3, dashed: false, ...(age >= 2 ? {frame: true} : {})});
interface Px {
  ch: string; tone: FlowTone; owner?: string | undefined; frame?: boolean | undefined; bold?: boolean | undefined; actor?: string | undefined;
  mask: number; rank: number; dashed: boolean; ink: boolean; locked: boolean;
}
const blank = (): Px => ({ch: ' ', tone: 'fg', mask: 0, rank: 0, dashed: false, ink: false, locked: false});
interface Paint {readonly tone?: FlowTone; readonly owner?: string; readonly frame?: boolean; readonly bold?: boolean; readonly actor?: string}
const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});

class Canvas {
  readonly rows: Px[][] = [];
  constructor(readonly width: number) {}
  at(x: number, y: number): Px | undefined {
    if (x < 0 || x >= this.width || y < 0) return undefined;
    while (this.rows.length <= y) this.rows.push(Array.from({length: this.width}, blank));
    return this.rows[y]![x];
  }
  free(x: number, y: number): boolean {const px = this.at(x, y); return px !== undefined && !px.ink && px.mask === 0;}
  /** Writes `text` from (x, y); a wide character takes two cells. Locked cells (cards) are only overwritten with `force`. */
  put(x: number, y: number, text: string, paint: Paint = {}, options: {lock?: boolean; force?: boolean} = {}): number {
    let at = x;
    for (const {segment} of segmenter.segment(text)) {
      const size = Math.max(1, stringWidth(segment)), px = this.at(at, y);
      if (!px || at + size > this.width) break;
      if (!px.locked || options.force) {
        px.ch = segment; px.tone = paint.tone ?? 'fg'; px.ink = true; px.owner = paint.owner; px.frame = paint.frame; px.bold = paint.bold; px.actor = paint.actor;
        px.locked = Boolean(options.lock) || px.locked;
        if (size === 2) {
          const next = this.at(at + 1, y);
          if (next) Object.assign(next, {ch: '', ink: true, tone: paint.tone ?? 'fg', owner: paint.owner, frame: paint.frame, bold: paint.bold, actor: paint.actor, locked: px.locked});
        }
      }
      at += size;
    }
    return at - x;
  }
  /** Draws a polyline of axis-aligned points as connection masks; the strongest style wins a cell and locked cells are left alone. */
  trace(points: readonly Point[], style: Style): void {
    const cells = expand(points);
    for (let i = 0; i < cells.length; i++) {
      const here = cells[i]!, px = this.at(here.x, here.y);
      if (!px || px.locked) continue;
      for (const other of [cells[i - 1], cells[i + 1]]) {
        if (!other) continue;
        px.mask |= other.x > here.x ? R : other.x < here.x ? L : other.y > here.y ? D : U;
      }
      if (style.rank > px.rank) {px.rank = style.rank; px.tone = style.tone; px.dashed = style.dashed; px.owner = style.owner; px.frame = style.frame;}
    }
  }
  resolve(): void {
    for (const row of this.rows) for (const px of row) {
      if (px.ink || !px.mask) continue;
      const glyph = GLYPH[px.mask] ?? '┼';
      px.ch = px.dashed ? glyph === '─' ? '┄' : glyph === '│' ? '┆' : glyph : glyph;
    }
  }
  toRows(height: number): StageRow[] {
    while (this.rows.length < height) this.at(0, this.rows.length);
    return this.rows.slice(0, height).map(row => {
      const out: StageCell[] = [];
      for (const px of row) {
        const cell: StageCell = {text: px.ch, tone: px.tone, ...(px.owner !== undefined ? {owner: px.owner} : {}), ...(px.frame ? {frame: true} : {}), ...(px.bold ? {bold: true} : {}), ...(px.actor !== undefined ? {actor: px.actor} : {})};
        const last = out.at(-1);
        if (last && last.tone === cell.tone && last.owner === cell.owner && last.frame === cell.frame && last.bold === cell.bold && last.actor === cell.actor) out[out.length - 1] = {...last, text: last.text + cell.text};
        else out.push(cell);
      }
      return out;
    });
  }
}
/** Every cell on the polyline between consecutive points, ends included, no repeats. */
export function expand(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  const push = (point: Point) => {const last = out.at(-1); if (!last || last.x !== point.x || last.y !== point.y) out.push(point);};
  points.forEach((point, index) => {
    const from = points[index - 1];
    if (!from) {push(point); return;}
    const dx = Math.sign(point.x - from.x), dy = Math.sign(point.y - from.y);
    let {x, y} = from;
    while (x !== point.x || y !== point.y) {
      if (x !== point.x) x += dx; else y += dy;
      push({x, y});
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------- cards
const title = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const STATE_TONE: Readonly<Record<StageState, FlowTone>> = {working: 'accent', waiting: 'warning', done: 'success', idle: 'muted', failed: 'error'};
/** The one-cell state of the compact card. */
const STATE_GLYPH: Readonly<Record<StageState, string>> = {working: '●', waiting: '◌', done: '✓', idle: '·', failed: '✗'};
const MARK: Readonly<Record<StageJob['status'], {text: string; tone: FlowTone}>> = {running: {text: '…', tone: 'accent'}, done: {text: '✓', tone: 'success'}, failed: {text: '✗', tone: 'error'}};
interface Piece {readonly text: string; readonly tone: FlowTone}
/** The pieces of a card's worker row in `room` cells: as many jobs as fit (`◦ scout ✓  ◦ palette …  +2`), else the counts (`◦3 ✓2`), else `◦3`. */
export function workerPieces(jobs: readonly StageJob[], room: number): Piece[] {
  if (!jobs.length || room < 2) return [];
  const piece = (job: StageJob): Piece[] => [{text: job.fork ? '⑂ ' : '◦ ', tone: 'muted'}, {text: fit(job.name, 12) + ' ', tone: 'fg'}, MARK[job.status]];
  const width = (pieces: readonly Piece[]) => pieces.reduce((sum, item) => sum + stringWidth(item.text), 0);
  for (let count = jobs.length; count >= 1; count--) {
    const shown = jobs.slice(0, count).flatMap((job, at) => at ? [{text: '  ', tone: 'fg' as const}, ...piece(job)] : piece(job));
    const rest = jobs.length - count, all = rest ? [...shown, {text: ' +' + rest, tone: 'muted' as const}] : shown;
    if (width(all) <= room) return all;
  }
  const forks = jobs.filter(job => job.fork).length, plain = jobs.length - forks, done = jobs.filter(job => job.status === 'done').length, failed = jobs.filter(job => job.status === 'failed').length;
  // Counts, the failures going first when short of room, then the marks of the finished, then only the total.
  const kinds: Piece[] = [...(plain ? [{text: '◦' + plain, tone: 'muted' as const}] : []), ...(forks ? [{text: '⑂' + forks, tone: 'muted' as const}] : [])];
  const variants: Piece[][] = [[...kinds, ...(done ? [{text: '✓' + done, tone: 'success' as const}] : []), ...(failed ? [{text: '✗' + failed, tone: 'error' as const}] : [])],
    [...kinds, ...(done ? [{text: '✓' + done, tone: 'success' as const}] : [])], kinds, [{text: '◦' + jobs.length, tone: 'muted'}]];
  const spaced = (pieces: Piece[]) => pieces.flatMap((item, at) => at ? [{text: ' ', tone: 'fg' as const}, item] : [item]);
  for (const variant of variants) if (width(spaced(variant)) <= room) return spaced(variant);
  return [{text: fit('◦' + jobs.length, room), tone: 'muted'}];
}

interface Cards {readonly cw: number; readonly rows: readonly (readonly StageActor[])[]; readonly x0: number}
function cardsFor(actors: readonly StageActor[], width: number, centre: number): Cards {
  const n = actors.length;
  if (!n) return {cw: MIN_CARD, rows: [], x0: 0};
  const kSingle = Math.max(1, Math.floor((width + GAP) / (MIN_CARD + GAP)));
  if (n <= kSingle) {
    const cw = Math.min(CAP_CARD, Math.floor((width - GAP * (n - 1)) / n)), total = n * cw + (n - 1) * GAP;
    // An odd number of cards keeps the middle one under Logox's centre column so the bus has no jog.
    const aligned = n % 2 === 1 ? centre - Math.floor(cw / 2) - Math.floor(n / 2) * (cw + GAP) : Math.floor((width - total) / 2);
    const x0 = aligned >= 0 && aligned + total <= width ? aligned : Math.max(0, Math.floor((width - total) / 2));
    return {cw, rows: [actors], x0};
  }
  // Wrapped: column 0 carries the bus trunk and the last column the message trunk.
  const room = width - 4, k = Math.max(1, Math.floor((room + GAP) / (MIN_CARD + GAP)));
  const count = Math.ceil(n / k), per = Math.ceil(n / count);
  const cw = Math.max(MIN_CARD, Math.min(CAP_CARD, Math.floor((room - GAP * (per - 1)) / per)));
  return {cw, rows: Array.from({length: count}, (_, r) => actors.slice(r * per, (r + 1) * per)), x0: 2};
}

// ---------------------------------------------------------------------------------------------------------------------------------- layout
/** What the vertical geometry keeps free so it never moves while a replay runs: derived from the final state of the stream. */
export interface Reserve {readonly user: boolean; readonly workers: boolean; readonly channels: number}
export const reserveFor = (final: StageSnapshot): Reserve => ({user: final.hasUser, workers: final.actors.some(actor => actor.jobs.length > 0), channels: final.peers ? CHANNELS : 0});

interface Edge {readonly from: string; readonly to: string; readonly style: Style}
interface Slot {readonly actor: StageActor; readonly row: number; readonly index: number; readonly x: number; readonly ccx: number}
const isActorId = (id: string) => id !== DIRECTOR_ID && id !== 'user' && id !== 'automa';

function layout(snapshot: StageSnapshot, width: number, label: StageLabeler, need: Reserve): StagePlan {
  const canvas = new Canvas(width);
  const lw = Math.max(9, Math.min(LOGOX_CARD, width - (width % 2 === 0 ? 1 : 0)));
  const lx = Math.floor((width - lw) / 2), cx = lx + Math.floor(lw / 2);
  const cards = cardsFor(snapshot.actors, width, cx);
  const user = need.user || snapshot.hasUser;
  const workersRow = need.workers || snapshot.actors.some(actor => actor.jobs.length > 0);
  const compact = cards.cw < 13 || snapshot.actors.length > 6;
  const height = (compact ? 3 : 4) + (workersRow ? 1 : 0);
  const channels = Math.max(need.channels, snapshot.peers ? CHANNELS : 0);
  const yL = user ? 2 : 0, yS = yL + LOGOX_ROWS, yB = yS + 1;
  const trunkX = width - 1;
  const current = snapshot.current;

  const slots = new Map<string, Slot>();
  cards.rows.forEach((list, row) => list.forEach((actor, index) => {
    const x = cards.x0 + index * (cards.cw + GAP);
    slots.set(actor.id, {actor, row, index, x, ccx: x + Math.floor(cards.cw / 2)});
  }));
  const busY: number[] = [], dropY: number[] = [], top: number[] = [], bottom: number[] = [];
  cards.rows.forEach((_, row) => {
    busY[row] = row === 0 ? yB : bottom[row - 1]! + channels + 1;
    dropY[row] = busY[row]! + 1;
    top[row] = dropY[row]! + 1;
    bottom[row] = top[row]! + height - 1;
  });
  const endY = cards.rows.length ? bottom[cards.rows.length - 1]! + channels + 1 : yL + LOGOX_ROWS;

  // Who is lit: the sender and the receivers of the current event.
  const lit = new Set<string>(current ? [current.from, ...current.to] : []);
  if (current?.kind === 'user') lit.add(DIRECTOR_ID);
  const boxes: StageBox[] = [];

  // ---- cards
  const draw = (id: string, x: number, y: number, w: number, rows: number) => {
    const info = label(id), bright = lit.has(id), actor = id;
    const border: Paint = {tone: 'owner', owner: id, actor, ...(bright ? {} : {frame: true})};
    canvas.put(x, y, '╭' + '─'.repeat(w - 2) + '╮', border, {lock: true});
    canvas.put(x, y + rows - 1, '╰' + '─'.repeat(w - 2) + '╯', border, {lock: true});
    for (let row = y + 1; row < y + rows - 1; row++) {
      canvas.put(x, row, '│', border, {lock: true});
      canvas.put(x + 1, row, ' '.repeat(w - 2), {actor}, {lock: true});
      canvas.put(x + w - 1, row, '│', border, {lock: true});
    }
    boxes.push({id, x0: x, x1: x + w, y0: y, y1: y + rows - 1});
    return info;
  };
  const centred = (id: string, x: number, y: number, w: number, pieces: readonly Piece[], bold = false, owner?: string) => {
    const inner = w - 2, used = pieces.reduce((sum, item) => sum + stringWidth(item.text), 0);
    let at = x + 1 + Math.max(0, Math.floor((inner - used) / 2));
    for (const item of pieces) at += canvas.put(at, y, item.text, {tone: item.tone, actor: id, ...(bold ? {bold: true} : {}), ...(owner && item.tone === 'owner' ? {owner} : {})}, {force: true, lock: true});
  };
  const left = (id: string, x: number, y: number, pieces: readonly Piece[]) => {
    let at = x + 2;
    for (const item of pieces) at += canvas.put(at, y, item.text, {tone: item.tone, actor: id}, {force: true, lock: true});
  };
  const info = draw(DIRECTOR_ID, lx, yL, lw, LOGOX_ROWS);
  centred(DIRECTOR_ID, lx, yL + 1, lw, [{text: fit(info.symbol + ' ' + title(info.name), lw - 2), tone: 'owner'}], true, DIRECTOR_ID);
  for (const slot of slots.values()) {
    const {actor} = slot, id = actor.id, y = top[slot.row]!, name = draw(id, slot.x, y, cards.cw, height);
    const inner = cards.cw - 2;
    if (compact) {
      const text = fit(name.symbol + ' ' + title(name.name), inner - 3);
      canvas.put(slot.x + 2, y + 1, text, {tone: 'owner', owner: id, bold: true, actor: id}, {force: true, lock: true});
      canvas.put(slot.x + cards.cw - 3, y + 1, STATE_GLYPH[actor.state], {tone: STATE_TONE[actor.state], actor: id}, {force: true, lock: true});
    } else {
      centred(id, slot.x, y + 1, cards.cw, [{text: fit(name.symbol + ' ' + title(name.name), inner), tone: 'owner'}], true, id);
      centred(id, slot.x, y + 2, cards.cw, [{text: actor.state, tone: STATE_TONE[actor.state]}]);
    }
    if (workersRow) left(id, slot.x, y + height - 2, workerPieces(actor.jobs, inner - 2));
  }
  if (user) {
    const text = '✓ you', x = Math.max(0, cx - Math.floor(stringWidth(text) / 2));
    canvas.put(x, 0, text, {tone: 'owner', owner: 'user', bold: snapshot.hasUser}, {});
    if (snapshot.hasUser) boxes.push({id: 'user', x0: x, x1: x + stringWidth(text), y0: 0, y1: 0});
  }

  // ---- the bus (Logox, the person) and the channel messages
  const bus = new Map<string, Edge>();
  const addBus = (edge: Edge) => {
    const touches = edge.from === DIRECTOR_ID || edge.to === DIRECTOR_ID || edge.from === 'user' || edge.to === 'user';
    if (!touches || edge.from === 'automa') return;
    const key = edge.from + '>' + edge.to, known = bus.get(key);
    if (!known || edge.style.rank > known.style.rank) bus.set(key, edge);
  };
  for (const edge of snapshot.edges) addBus({from: edge.from, to: edge.to, style: FAINT});
  for (const wait of snapshot.waits) addBus({from: wait.from, to: wait.to, style: WAIT});
  if (current) {
    const style = current.kind === 'waiting' ? NOW_WAIT : NOW;
    if (current.kind === 'user') addBus({from: 'user', to: DIRECTOR_ID, style});
    else if (current.kind !== 'result' && current.kind !== 'workers') for (const to of current.to) addBus({from: current.from, to, style});
  }
  const stemY = yL + LOGOX_ROWS - 1;
  const down = (slot: Slot): Point[] => {
    const dl = slot.ccx - 1, r = slot.row;
    return r === 0 ? [{x: cx, y: yS}, {x: cx, y: busY[0]!}, {x: dl, y: busY[0]!}, {x: dl, y: dropY[0]!}]
      : [{x: cx, y: yS}, {x: cx, y: busY[0]!}, {x: 0, y: busY[0]!}, {x: 0, y: busY[r]!}, {x: dl, y: busY[r]!}, {x: dl, y: dropY[r]!}];
  };
  const up = (slot: Slot): Point[] => {
    const du = slot.ccx + 1, r = slot.row;
    return r === 0 ? [{x: du, y: dropY[0]!}, {x: du, y: busY[0]!}, {x: cx, y: busY[0]!}, {x: cx, y: yS}]
      : [{x: du, y: dropY[r]!}, {x: du, y: busY[r]!}, {x: 0, y: busY[r]!}, {x: 0, y: busY[0]!}, {x: cx, y: busY[0]!}, {x: cx, y: yS}];
  };
  interface Route {readonly points: readonly Point[]; readonly head?: {readonly at: Point; readonly ch: string}; readonly path: readonly Point[]}
  const busRoute = (from: string, to: string): Route | undefined => {
    if (from === 'user' || to === 'user') {
      if (!user) return undefined;
      return from === 'user' ? {points: [{x: cx, y: 1}, {x: cx, y: yL}], head: {at: {x: cx, y: yL}, ch: '▼'}, path: [{x: cx, y: 1}, {x: cx, y: yL}]}
        : {points: [{x: cx, y: 1}, {x: cx, y: yL}], head: {at: {x: cx, y: 1}, ch: '▲'}, path: [{x: cx, y: yL}, {x: cx, y: 1}]};
    }
    const a = slots.get(from), b = slots.get(to);
    if (from === DIRECTOR_ID && b) {const points = down(b); return {points, head: {at: points.at(-1)!, ch: '▼'}, path: [{x: cx, y: stemY}, ...expand(points)]};}
    if (to === DIRECTOR_ID && a) {const points = up(a); return {points, head: {at: points[0]!, ch: '▲'}, path: [...expand(points), {x: cx, y: stemY}]};}
    return undefined;
  };
  const heads: {at: Point; ch: string; style: Style}[] = [];
  let stemUsed = false;
  for (const edge of bus.values()) {
    const route = busRoute(edge.from, edge.to);
    if (!route) continue;
    canvas.trace(route.points, edge.style);
    if (route.head) heads.push({...route.head, style: edge.style});
    if (edge.from !== 'user' && edge.to !== 'user') stemUsed = true;
  }

  // Channel messages: the current one first, then the newer ones, then the open waits.
  const messages: Edge[] = [];
  const seen = new Set<string>();
  const addMessage = (edge: Edge) => {
    const key = edge.from + '>' + edge.to;
    if (seen.has(key) || !isActorId(edge.from) || !isActorId(edge.to) || edge.from === edge.to || !slots.has(edge.from) || !slots.has(edge.to)) return;
    seen.add(key); messages.push(edge);
  };
  if (current?.kind === 'waiting') for (const to of current.to) addMessage({from: current.from, to, style: NOW_WAIT});
  for (const item of snapshot.recent) for (const to of item.to) addMessage({from: item.from, to, style: item.age === 0 ? NOW : sent(item.from, item.age)});
  for (const wait of snapshot.waits) addMessage({from: wait.from, to: wait.to, style: WAIT});
  const taken = new Map<string, [number, number][]>();
  const claim = (row: number, lo: number, hi: number): number | undefined => {
    for (let channel = 0; channel < channels; channel++) {
      const list = taken.get(row + ':' + channel) ?? [];
      if (list.some(([a, b]) => a <= hi && lo <= b)) continue;
      taken.set(row + ':' + channel, [...list, [lo, hi]]);
      return channel;
    }
    return undefined;
  };
  const release = (row: number, channel: number, lo: number, hi: number) => {
    taken.set(row + ':' + channel, (taken.get(row + ':' + channel) ?? []).filter(([a, b]) => a !== lo || b !== hi));
  };
  const drawn: {edge: Edge; points: Point[]; head: Point; ch: string; label?: {x0: number; x1: number; y: number}}[] = [];
  for (const edge of messages) {
    const a = slots.get(edge.from)!, b = slots.get(edge.to)!;
    if (a.row === b.row) {
      const lo = Math.min(a.ccx, b.ccx), hi = Math.max(a.ccx, b.ccx), channel = claim(a.row, lo, hi);
      if (channel === undefined) continue;
      const y = bottom[a.row]! + 1 + channel, right = b.ccx > a.ccx;
      drawn.push({edge, points: [{x: a.ccx, y: bottom[a.row]!}, {x: a.ccx, y}, {x: b.ccx, y}, {x: b.ccx, y: bottom[b.row]!}], head: {x: b.ccx + (right ? -1 : 1), y}, ch: right ? '▶' : '◀', label: {x0: lo, x1: hi, y}});
      continue;
    }
    const first = claim(a.row, a.ccx, trunkX);
    if (first === undefined) continue;
    const second = claim(b.row, b.ccx, trunkX);
    if (second === undefined) {release(a.row, first, a.ccx, trunkX); continue;}
    const y1 = bottom[a.row]! + 1 + first, y2 = bottom[b.row]! + 1 + second;
    drawn.push({edge, points: [{x: a.ccx, y: bottom[a.row]!}, {x: a.ccx, y: y1}, {x: trunkX, y: y1}, {x: trunkX, y: y2}, {x: b.ccx, y: y2}, {x: b.ccx, y: bottom[b.row]!}], head: {x: b.ccx + 1, y: y2}, ch: '◀'});
  }
  for (const item of drawn) canvas.trace(item.points, item.edge.style);
  canvas.resolve();
  for (const head of heads) canvas.put(head.at.x, head.at.y, head.ch, {tone: head.style.tone}, {});
  for (const item of drawn) canvas.put(item.head.x, item.head.y, item.ch, {tone: item.edge.style.tone, ...(item.edge.style.owner ? {owner: item.edge.style.owner} : {}), ...(item.edge.style.frame ? {frame: true} : {})}, {});
  // The card borders show where a line enters or leaves them: Logox's stem and every port a message uses.
  const port = (id: string, x: number, y: number) => canvas.put(x, y, '┬', {tone: 'owner', owner: id, ...(lit.has(id) ? {} : {frame: true}), actor: id}, {force: true});
  if (stemUsed) port(DIRECTOR_ID, cx, stemY);
  for (const item of drawn) for (const id of [item.edge.from, item.edge.to]) {const slot = slots.get(id)!; port(id, slot.ccx, bottom[slot.row]!);}
  if (user && snapshot.hasUser) canvas.put(cx, yL, '▼', {tone: bus.get('user>' + DIRECTOR_ID)?.style.tone ?? 'faint'}, {force: true});

  // Labels on the current edge, only where the cells are free.
  const place = (text: string, x: number, y: number) => {
    if (y < endY && [...text].every((_, i) => canvas.free(x + i, y))) canvas.put(x, y, text, {tone: 'accent'}, {});
  };
  if (current && (current.kind === 'assign' || current.kind === 'message' || current.kind === 'report')) {
    for (const to of current.to) {
      const a = slots.get(current.from), b = slots.get(to);
      if (current.from === DIRECTOR_ID && b) place(current.kind === 'assign' ? 'assign' : 'msg', b.ccx - 7, dropY[b.row]!);
      else if (to === DIRECTOR_ID && a) place(current.kind === 'report' ? (current.status ?? 'done') : 'msg', a.ccx + 2, dropY[a.row]!);
      else {
        const item = drawn.find(entry => entry.edge.from === current.from && entry.edge.to === to && entry.label);
        if (item?.label && current.kind === 'message') place('msg', Math.floor((item.label.x0 + item.label.x1) / 2) - 1, item.label.y + 1);
      }
    }
  }

  // ---- the pulse paths of the current event
  const paths: Point[][] = [];
  if (current) {
    if (current.kind === 'user') {const route = busRoute('user', DIRECTOR_ID); if (route) paths.push([...route.path]);}
    else if (current.kind === 'result') {
      for (const to of current.to) {
        const slot = slots.get(to);
        if (!slot || !workersRow) continue;
        const wy = top[slot.row]! + height - 2;
        paths.push([{x: slot.ccx, y: wy}, {x: slot.ccx, y: wy - 1}, ...(compact ? [] : [{x: slot.ccx, y: wy - 2}])]);
      }
    } else if (current.kind !== 'workers') {
      for (const to of current.to) {
        const route = current.from === DIRECTOR_ID || to === DIRECTOR_ID ? busRoute(current.from, to) : undefined;
        if (route) {paths.push([...route.path]); continue;}
        const item = drawn.find(entry => entry.edge.from === current.from && entry.edge.to === to);
        if (item) paths.push(expand(item.points));
      }
    }
  }
  const rows = canvas.toRows(Math.max(endY, 1));
  return {width, height: rows.length, rows, boxes, paths};
}

/** The rows the stage needs at the end of the replay (and so at every point of it); 0 when `width` is too small for a stage. */
export function stageHeight(final: StageSnapshot, width: number, label: StageLabeler): number {
  if (width < 20) return 0;
  return layout(final, width, label, reserveFor(final)).height;
}

/**
 * The stage of `snapshot`, `width` cells wide. `final` is the state at the end of the stream: it reserves the rows (the user marker, the worker row and the
 * channel rows) so the height never changes while a replay steps through.
 */
export function buildStage(snapshot: StageSnapshot, final: StageSnapshot, width: number, label: StageLabeler): StagePlan {
  if (width < 20) return {width, height: 0, rows: [], boxes: [], paths: []};
  const need = reserveFor(final);
  const plan = layout(snapshot, width, label, need), full = layout(final, width, label, need).height;
  if (plan.height >= full) return plan;
  const pad: StageRow[] = Array.from({length: full - plan.height}, () => [{text: ' '.repeat(width), tone: 'fg'}]);
  return {...plan, height: full, rows: [...plan.rows, ...pad]};
}

// ---------------------------------------------------------------------------------------------------------------------------------- pulse
/** The cell the pulse is on `ms` after it started, along `path`; nothing before it starts, after it ends or along an empty path. */
export function pulseAt(path: readonly Point[], ms: number): Point | undefined {
  if (!path.length || ms < 0 || ms >= PULSE_MS) return undefined;
  return path[Math.min(path.length - 1, Math.floor(ms / PULSE_MS * path.length))];
}

// ---------------------------------------------------------------------------------------------------------------------------------- controls
export type StageControl = 'prev' | 'next' | 'play' | 'scrub' | 'speed';
export interface StageRegion {readonly x0: number; readonly x1: number; readonly control: StageControl}
export interface ControlsInput {
  readonly width: number;
  readonly playing: boolean;
  readonly speed: number;
  /** 1-based position among the visible events and their count. */
  readonly position: number;
  readonly total: number;
  /** Milliseconds from the first event to the selected one. */
  readonly elapsed: number;
  readonly hovered?: string | undefined;
}
export interface ControlsRow {
  readonly cells: readonly StageCell[];
  readonly regions: readonly StageRegion[];
  /** The scrubber bar: first column and length (0 when it has no room). */
  readonly bar: {readonly x0: number; readonly length: number};
}
export const SPEEDS: readonly number[] = [1, 2, 4];
/** `◀ ▶ ▶ Play ━━━━●━━━━ 13/26 · +9m47s  1×` in `width` cells; the words and then the elapsed time go first when narrow. */
export function controlsRow(input: ControlsInput): ControlsRow {
  const {width, playing, speed, position, total} = input;
  const hot = (control: StageControl, base: FlowTone): FlowTone => input.hovered === control ? 'accent' : base;
  const playLong = playing ? '❚❚ Pause' : '▶ Play', playShort = playing ? '❚❚' : '▶';
  const counter = `${position}/${total}`, elapsed = ' · +' + formatTook(Math.max(0, input.elapsed)), speedText = speed + '×';
  let chosen: {play: string; elapsed: boolean; bar: number} | undefined;
  for (const [play, withElapsed] of [[playLong, true], [playLong, false], [playShort, true], [playShort, false]] as const) {
    const fixed = 4 + stringWidth(play) + 1 + 1 + counter.length + (withElapsed ? elapsed.length : 0) + 2 + speedText.length;
    if (width - fixed >= 6) {chosen = {play, elapsed: withElapsed, bar: width - fixed}; break;}
  }
  chosen ??= {play: playShort, elapsed: false, bar: Math.max(0, width - (4 + 1 + 1 + 1 + counter.length + 2 + speedText.length))};
  const playX = 4, barX = playX + stringWidth(chosen.play) + 1;
  const thumb = total <= 1 ? chosen.bar - 1 : Math.round((position - 1) / (total - 1) * (chosen.bar - 1));
  const cells: StageCell[] = [
    {text: '◀', tone: hot('prev', position > 1 ? 'fg' : 'faint')}, {text: ' ', tone: 'fg'}, {text: '▶', tone: hot('next', position > 0 && position < total ? 'fg' : 'faint')}, {text: ' ', tone: 'fg'},
    {text: chosen.play, tone: hot('play', 'strong'), bold: playing}, {text: ' ', tone: 'fg'},
    ...(chosen.bar > 0 ? [{text: '━'.repeat(Math.max(0, thumb)), tone: hot('scrub', 'accent')}, {text: '●', tone: 'accent' as const, bold: true},
      {text: '─'.repeat(Math.max(0, chosen.bar - thumb - 1)), tone: 'line' as const}] : []),
    {text: ' ', tone: 'fg'}, {text: counter, tone: 'fg'}, ...(chosen.elapsed ? [{text: elapsed, tone: 'muted' as const}] : []),
    {text: '  ', tone: 'fg'}, {text: speedText, tone: hot('speed', 'muted')},
  ];
  const speedX = width - speedText.length;
  return {cells, regions: [{x0: 0, x1: 1, control: 'prev'}, {x0: 2, x1: 3, control: 'next'}, {x0: playX, x1: playX + stringWidth(chosen.play), control: 'play'},
    {x0: barX, x1: barX + chosen.bar, control: 'scrub'}, {x0: speedX, x1: width, control: 'speed'}], bar: {x0: barX, length: chosen.bar}};
}
/** The 1-based position a click or drag at content column `x` on the scrubber means (clamped to the bar). */
export function scrubPosition(bar: {readonly x0: number; readonly length: number}, x: number, total: number): number {
  if (total <= 1 || bar.length <= 1) return Math.max(1, total);
  const fraction = Math.max(0, Math.min(1, (x - bar.x0) / (bar.length - 1)));
  return 1 + Math.round(fraction * (total - 1));
}
/** The next speed in `1× -> 2× -> 4×` (or the previous one for `-1`), clamped for keys and cycling for clicks. */
export function nextSpeed(speed: number, step: 1 | -1, wrap: boolean): number {
  const at = Math.max(0, SPEEDS.indexOf(speed)), next = at + step;
  if (wrap) return SPEEDS[(next + SPEEDS.length) % SPEEDS.length]!;
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, next))]!;
}

// ---------------------------------------------------------------------------------------------------------------------------------- strip
/** `Working ✧ kalon ⊞ techne · Waiting ◎ aletheia · Done —`: the one line the stage collapses to on a short sidebar, clipped with `…`. */
export function stripRow(actors: readonly StageActor[], width: number, label: StageLabeler): StageRow {
  const groups: [string, StageState[]][] = [['Working', ['working']], ['Waiting', ['waiting']], ['Done', ['done']]];
  const build = (symbols: boolean): StageCell[] => {
    const cells: StageCell[] = [];
    groups.forEach(([name, states], index) => {
      if (index) cells.push({text: ' · ', tone: 'muted'});
      cells.push({text: name + ' ', tone: 'muted'});
      const list = actors.filter(actor => states.includes(actor.state));
      if (!list.length) cells.push({text: '—', tone: 'faint'});
      list.forEach((actor, at) => {
        const info = label(actor.id);
        cells.push({text: (at ? ' ' : '') + (symbols ? info.symbol + ' ' : '') + info.name, tone: 'owner', owner: actor.id, actor: actor.id});
      });
    });
    return cells;
  };
  // With the glyphs when they fit, else the names alone, else clipped.
  const full = build(true), cells = full.reduce((sum, cell) => sum + stringWidth(cell.text), 0) <= width ? full : build(false);
  const out: StageCell[] = [];
  let used = 0;
  for (const cell of cells) {
    const size = stringWidth(cell.text);
    if (used + size <= width) {out.push(cell); used += size; continue;}
    const room = width - used;
    if (room > 0) out.push({...cell, text: fit(cell.text, room)});
    break;
  }
  return out;
}
