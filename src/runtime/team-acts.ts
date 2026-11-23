/**
 * The acts of a session. An act is one natural round of work: it opens at the first dispatch (a companion assignment or an Automa job) after nothing was open,
 * and everything that happens while it is open belongs to it: the person's interjections and steering, questions to the person and their answers, an Esc and the
 * resume that follows, a discussion with the Director while companions or background workers still run, re-dispatches, folded attempts, the Director's follow-up on
 * reports. It closes when the round ends naturally: a Director activity ended normally (`completed`, `directorCloses()`) at or after the last dispatch AND none of
 * the work the act started is still running or waiting (every dispatched activity and job has its report or result). An interrupted round has no normal close, so
 * it stays open. The next dispatch after a natural close opens the next act, unless the Director marked it `continueAct` (a follow-up of the same piece of work):
 * the act that closed then reopens and takes the dispatch (mid-act the flag changes nothing). A discussion that dispatches nothing opens no act, and posts between acts belong to
 * none (the stage then shows the last act at rest); the person's request that preceded a dispatch (the last `user` post since the previous act ended) opens the act.
 * There is no fallback for sessions without close records: with none, the whole session is one act.
 *
 * Everything is a pure projection of the team event stream (`team-events.ts`), the Director's normal close times and the task graph (`task-graph.ts`); nothing
 * is stored.
 *  - `computeActs()` is the one function that decides the acts and the act of every event (tested alone in `tests/team-acts.test.ts`).
 *  - `actModel()` adds the tasks of each act: a plan inside an act gives it its nodes as tasks (a plan phase is no longer an act), delegations nobody planned are
 *    tasks too; a node belongs to the act of its work (a parent to the earliest act below it, a node with no work yet to the act the plan is progressing in).
 *    The act's title is the plan's title when it has plan nodes, else the Director's assignment title of its first dispatch.
 *  - `actIndexAt()` is the act of a replay point (an event in no act shows the last act before it, at rest), `stepTarget()` the first event of the previous or next
 *    act, `actProgress()` and `actStatus()` the header's bar and colour at a replay point.
 *  - `sceneAt()` is the stage of a replay point: `stageAt()` over the events of the current act only (so each act is its own scene and an actor of an earlier act
 *    stays off the stage unless it takes part), with each card filled by `stageCards()` (the actor's current task, `n/m`, wait reason, outcome and next task).
 *  - `programme()` lists every act with its tasks for the Programme page (`src/commands/plan-page.ts`).
 * Settled-ness follows the replay point, not the present: a node counts as settled at index i when the last event linked to it up to i is its report or result,
 * and a node that never had an event takes its derived status (a plan node accepted by hand counts from its `accepted.at`).
 */
import {isDirector} from './director-id.js';
import type {RuntimeSnapshot} from './contracts.js';
import {AUTOMA_OWNER, PLAN_USER, type DerivedNode, type NodeStatus} from './plan.js';
import {normalizeStopReason} from './stop-reason.js';
import type {TaskGraph} from './task-graph.js';
import type {TeamEvent} from './team-events.js';
import {stageAt, type StageActor, type StageCard, type StageSnapshot} from './team-stage.js';

/** The times (ms) at which a Director activity of the session ended normally (`completed`): the candidates for the close of an act. */
export function directorCloses(snapshot: RuntimeSnapshot, sessionId: string): number[] {
  const times: number[] = [];
  for (const activity of snapshot.activities) {
    if (activity.sessionId !== sessionId || !isDirector(activity.ownerId) || activity.kind !== 'director' || activity.status !== 'completed' || activity.finishedAt === undefined) continue;
    const stop = normalizeStopReason(activity.stopReason);
    if (stop === undefined || stop === 'completed') times.push(activity.finishedAt);
  }
  return times.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------------------------- the acts
export interface ActSpan {
  readonly index: number;
  /** The first and last event of the act (the opening request included), as indexes into the stream. */
  readonly first: number;
  readonly last: number;
  /** The event of its first dispatch. */
  readonly dispatch: number;
  /** When it closed naturally (ms); absent while it is open. */
  readonly closedAt?: number;
  /** The delegation ids dispatched in it (`<activityId>` or `<activityId>/<jobId>`). */
  readonly works: readonly string[];
  /** The Director's assignment title of its first dispatch. */
  readonly seed: string;
}
const dispatchedBy = (event: TeamEvent): readonly string[] => event.kind === 'assign' || event.kind === 'workers' ? event.refs ?? [event.ref] : [];
const isSettle = (event: TeamEvent): boolean => event.kind === 'report' || event.kind === 'result';
const seedOf = (event: TeamEvent): string => event.kind === 'workers' ? event.items?.[0]?.title ?? event.text : event.text.split(' ／ ')[0]!;

/**
 * The acts of `events` and the act of every event (-1: none). `closes` are the times a Director activity ended normally, ascending (`directorCloses()`); an act
 * closes at the first one at or after its last dispatch and the end of all its work, and the next dispatch after that opens a new act.
 */
export function computeActs(events: readonly TeamEvent[], closes: readonly number[]): {spans: ActSpan[]; actOf: number[]} {
  // When each piece of work ended (the index of its report or result); work with none is still running or waiting.
  const ended = new Map<string, number>();
  events.forEach((event, at) => {if (isSettle(event) && !ended.has(event.ref)) ended.set(event.ref, at);});
  interface Draft {readonly index: number; readonly dispatch: number; readonly works: Set<string>; lastAt: number; last: number; seed: string}
  const drafts: Draft[] = [];
  const closeOf = (draft: Draft): number | undefined => {
    let ready = draft.lastAt;
    for (const work of draft.works) {
      const at = ended.get(work);
      if (at === undefined) return undefined;
      ready = Math.max(ready, events[at]!.at);
    }
    return closes.find(time => time >= ready);
  };
  let open: Draft | undefined;
  events.forEach((event, at) => {
    const works = dispatchedBy(event);
    if (!works.length) return;
    // The act that closed before this dispatch is over; this one starts the next, unless the Director asked to continue the act that just closed.
    if (open) {const closed = closeOf(open); if (closed !== undefined && closed < event.at) open = undefined;}
    if (!open && event.continueAct && drafts.length) open = drafts.at(-1);
    if (!open) {open = {index: drafts.length, dispatch: at, works: new Set(), lastAt: event.at, last: at, seed: seedOf(event)}; drafts.push(open);}
    for (const work of works) open.works.add(work);
    open.lastAt = event.at; open.last = at;
  });
  const closedAt = drafts.map(closeOf);
  const spans: ActSpan[] = drafts.map(draft => {
    const closed = closedAt[draft.index];
    const last = closed === undefined ? events.length - 1 : Math.max(draft.last, events.findLastIndex(event => event.at <= closed));
    return {index: draft.index, first: draft.dispatch, last, dispatch: draft.dispatch, ...(closed !== undefined ? {closedAt: closed} : {}), works: [...draft.works], seed: draft.seed};
  });
  const actOf: number[] = events.map(() => -1);
  const workAct = new Map<string, number>();
  for (const span of spans) {
    for (let at = span.dispatch; at <= span.last; at++) actOf[at] = span.index;
    for (const work of span.works) workAct.set(work, span.index);
  }
  // A report, result or wait names its work: it belongs to that act whenever it happens.
  events.forEach((event, at) => {
    if (event.kind === 'user' || event.kind === 'message') return;
    const act = workAct.get(event.ref) ?? workAct.get(event.ref.split('/')[0]!);
    if (act !== undefined) actOf[at] = act;
  });
  // The request that preceded a dispatch: the last person's post since the previous act ended opens the act.
  const opened = spans.map((span, k) => {
    const from = k ? spans[k - 1]!.last + 1 : 0;
    for (let at = span.dispatch - 1; at >= from; at--) if (events[at]!.kind === 'user' && actOf[at] === -1) {actOf[at] = span.index; return at;}
    return span.dispatch;
  });
  return {spans: spans.map(span => ({...span, first: opened[span.index]!})), actOf};
}

// ---------------------------------------------------------------------------------------------------------------------------------- the model
export type Outcome = 'done' | 'failed' | 'interrupted';
export interface Act {
  readonly index: number;
  readonly title: string;
  readonly span: ActSpan;
  /** The work items the act counts: its tasks without tasks below them. */
  readonly leaves: readonly string[];
}
export interface ActModel {
  readonly acts: readonly Act[];
  readonly events: readonly TeamEvent[];
  readonly graph: TaskGraph | undefined;
  /** Per event index: the act it belongs to (-1: none). */
  readonly actOf: readonly number[];
  /** Per act: the indexes of its events, ascending. */
  readonly byAct: readonly (readonly number[])[];
  /** Per event index: its position in its act's list (-1 for an event in no act). */
  readonly position: readonly number[];
  /** Node id -> the act whose task it is (nodes that are tasks of no act, and the synthesized phase of a Director round, are absent). */
  readonly nodeAct: ReadonlyMap<string, number>;
  /** Node id -> the indexes of the events linked to it, ascending. */
  readonly nodeEvents: ReadonlyMap<string, readonly number[]>;
  /** Per event index: how the event settled work (a done, failed or interrupted report or result). */
  readonly outcomeAt: readonly (Outcome | undefined)[];
  /** Delegation or job id -> the index of the event that settled it. */
  readonly resultAt: ReadonlyMap<string, number>;
  readonly nodes: ReadonlyMap<string, DerivedNode>;
}

const settleOf = (event: TeamEvent): Outcome | undefined =>
  isSettle(event) && (event.status === 'done' || event.status === 'failed' || event.status === 'interrupted') ? event.status : undefined;

/** The acts of the session and the act of every event; `graph` supplies the tasks, `closes` the Director's normal closes (`directorCloses()`). */
export function actModel(graph: TaskGraph | undefined, events: readonly TeamEvent[], closes: readonly number[] = []): ActModel {
  const {spans, actOf} = computeActs(events, closes);
  const nodes = graph?.plan.nodes ?? [];
  const byId = new Map(nodes.map(node => [node.id, node] as const));
  const synthetic = graph?.synthetic ?? new Set<string>();
  const workAct = new Map<string, number>();
  for (const span of spans) for (const work of span.works) workAct.set(work, span.index);
  // The act of each node: that of its work, a parent's the earliest below it, a plan node with no work yet in the act the plan is progressing in (the latest).
  const direct = new Map<string, number>();
  for (const node of nodes) for (const link of node.links) {
    const act = workAct.get(link.activityId ?? link.automaJob ?? '');
    if (act !== undefined) direct.set(node.id, Math.min(direct.get(node.id) ?? act, act));
  }
  for (const node of [...nodes].sort((a, b) => b.depth - a.depth)) {
    const act = direct.get(node.id);
    if (act !== undefined && node.parent !== undefined) direct.set(node.parent, Math.min(direct.get(node.parent) ?? act, act));
  }
  const planned = nodes.filter(node => !synthetic.has(node.id) && direct.has(node.id)).map(node => direct.get(node.id)!);
  const home = planned.length ? Math.max(...planned) : undefined;
  for (const node of nodes) if (!direct.has(node.id) && !synthetic.has(node.id) && home !== undefined) direct.set(node.id, home);
  // The phase synthesized for a Director round is the round itself, not a task.
  const roundPhase = (id: string): boolean => synthetic.has(id) && byId.get(id)!.depth === 1 && !spans.some(span => span.works.includes(graph!.delegationOf.get(id) ?? ''));
  const nodeAct = new Map<string, number>();
  for (const node of nodes) {
    const act = direct.get(node.id);
    if (act !== undefined && node.status !== 'abandoned' && !roundPhase(node.id)) nodeAct.set(node.id, act);
  }
  const acts: Act[] = spans.map(span => {
    const mine = nodes.filter(node => nodeAct.get(node.id) === span.index);
    const leaves = mine.filter(node => !mine.some(other => other.parent === node.id)).map(node => node.id);
    const title = graph?.planned && mine.some(node => !synthetic.has(node.id)) ? graph.plan.title : span.seed;
    return {index: span.index, title, span, leaves};
  });
  const token = new Map<string, string>();
  for (const node of nodes) for (const link of node.links) {const key = link.activityId ?? link.automaJob; if (key && !token.has(key)) token.set(key, node.id);}
  const nodeOf = (ref: string): string | undefined => token.get(ref) ?? token.get(ref.split('/')[0]!);
  /** The nodes an event is about: the work of its ref (a dispatch names every delegation of it). */
  const nodesOfEvent = events.map((event): string[] => {
    if (event.kind === 'user' || event.kind === 'message') return [];
    return [...new Set((event.refs ?? [event.ref]).flatMap(ref => {const id = nodeOf(ref); return id === undefined ? [] : [id];}))];
  });
  const byAct: number[][] = acts.map(() => []);
  const position = actOf.map((act, at) => act < 0 ? -1 : byAct[act]!.push(at) - 1);
  const nodeEvents = new Map<string, number[]>(), resultAt = new Map<string, number>();
  const outcomeAt = events.map(settleOf);
  nodesOfEvent.forEach((ids, at) => {
    for (const id of ids) nodeEvents.set(id, [...nodeEvents.get(id) ?? [], at]);
    if (outcomeAt[at]) resultAt.set(events[at]!.ref, at);
  });
  return {acts, events, graph, actOf, byAct, position, nodeAct, nodeEvents, outcomeAt, resultAt, nodes: byId};
}

/** The act whose scene a replay point shows: the act of the event at `index`; an event in no act shows the last act before it, at rest (the first act when none came yet); -1 with no acts. */
export function actIndexAt(model: ActModel, index: number): number {
  if (!model.acts.length) return -1;
  if (index < 0 || index >= model.actOf.length) return model.acts.length - 1;
  const own = model.actOf[index]!;
  if (own >= 0) return own;
  for (let act = model.acts.length - 1; act >= 0; act--) if (model.acts[act]!.span.first <= index) return act;
  return 0;
}
/** The index of the event a step to the previous (`-1`) or next (`1`) act lands on (its first event); undefined at the ends. */
export function stepTarget(model: ActModel, act: number, direction: 1 | -1): number | undefined {
  const next = act + direction;
  return next >= 0 && next < model.byAct.length ? model.byAct[next]![0] : undefined;
}
/** The first event index of `act` (its request included). */
export const firstEventOf = (model: ActModel, act: number): number | undefined => model.byAct[act]?.[0];

// ---------------------------------------------------------------------------------------------------------------------------------- state at a replay point
interface NodeState {readonly begun: boolean; readonly last: number; readonly outcome?: Outcome}
function stateOf(model: ActModel, id: string, index: number): NodeState {
  const list = model.nodeEvents.get(id) ?? [];
  // A task of an activity is settled by the activity's report; the results of the workers it started only show it has begun.
  const ofActivity = model.nodes.get(id)?.links.some(link => link.activityId) ?? false;
  let last = -1, lead = -1;
  for (const at of list) {
    if (at > index) break;
    last = at;
    if (!(ofActivity && model.events[at]!.kind === 'result')) lead = at;
  }
  if (last < 0) return {begun: false, last: -1};
  const outcome = lead < 0 ? undefined : model.outcomeAt[lead];
  return {begun: true, last, ...(outcome ? {outcome} : {})};
}
/** How a work item stands at `index`: its outcome once settled, else undefined. */
function leafOutcome(model: ActModel, id: string, index: number): Outcome | undefined {
  const state = stateOf(model, id, index);
  if (state.outcome) return state.outcome;
  if (state.begun || (model.nodeEvents.get(id)?.length ?? 0) > 0) return undefined;
  const node = model.nodes.get(id);
  if (!node) return undefined;
  if (node.status === 'done' || node.status === 'accepted') {
    // At the newest event (Live) everything accepted so far counts; earlier in a replay only what was accepted by then.
    const at = node.accepted?.at, now = index >= model.events.length - 1 ? undefined : model.events[index]?.at;
    return at !== undefined && now !== undefined && at > now ? undefined : 'done';
  }
  return node.status === 'failed' ? 'failed' : node.status === 'interrupted' ? 'interrupted' : undefined;
}
export interface ActProgress {readonly done: number; readonly failed: number; readonly interrupted: number; readonly total: number}
/** The act's tasks settled at a replay point (`done` counts done and accepted alike). */
export function actProgress(model: ActModel, act: Act, index: number): ActProgress {
  let done = 0, failed = 0, interrupted = 0;
  for (const id of act.leaves) {
    const outcome = leafOutcome(model, id, index);
    if (outcome === 'done') done++; else if (outcome === 'failed') failed++; else if (outcome === 'interrupted') interrupted++;
  }
  return {done, failed, interrupted, total: act.leaves.length};
}
export type ActStatus = 'pending' | 'running' | 'done' | 'failed';
/** The colour state of the act header at a replay point: done or failed once every task settled, running once work began, else pending. */
export function actStatus(model: ActModel, act: Act, index: number, progress = actProgress(model, act, index)): ActStatus {
  if (progress.total > 0 && progress.done + progress.failed + progress.interrupted >= progress.total) return progress.failed > 0 ? 'failed' : 'done';
  const begun = model.byAct[act.index]?.some(at => at <= index) ?? false;
  return begun || progress.done + progress.failed + progress.interrupted > 0 ? 'running' : 'pending';
}

// ---------------------------------------------------------------------------------------------------------------------------------- cards
/** The nodes of `act` an actor can be working on: its own (never an Automa worker's), in plan order. */
function nodesOf(model: ActModel, act: Act, actor: string): DerivedNode[] {
  const synthetic = model.graph?.delegationOf;
  return [...model.nodes.values()].filter(node => model.nodeAct.get(node.id) === act.index && node.owner === actor && !(synthetic?.get(node.id)?.includes('/')));
}
const approvalWait = (text: string): string => /\?|question|answer|\bask/i.test(text) ? 'awaiting your answer' : 'awaiting approval';

/** The card of every actor on the stage of `act` at `index` (an index into all events). */
export function stageCards(model: ActModel, act: Act, index: number, snapshot: StageSnapshot): ReadonlyMap<string, StageCard> {
  const cards = new Map<string, StageCard>();
  for (const actor of snapshot.actors) {
    const mine = nodesOf(model, act, actor.id);
    const states = mine.map(node => ({node, state: stateOf(model, node.id, index)})).filter(item => item.state.begun);
    const pick = (list: typeof states) => [...list].sort((a, b) => b.state.last - a.state.last || b.node.depth - a.node.depth)[0];
    const current = pick(states.filter(item => !item.state.outcome)) ?? pick(states);
    let card: {-readonly [K in keyof StageCard]: StageCard[K]} = {};
    if (current) {
      card.title = current.node.title;
      if (current.state.outcome) card.outcome = current.state.outcome;
      else {
        const below = current.node.children.length ? subleaves(model, current.node.id) : [];
        if (below.length) {card.m = below.length; card.n = below.filter(id => leafOutcome(model, id, index) !== undefined).length;}
        else {
          const jobs = current.node.links.flatMap(link => link.automaJob ? [link.automaJob] : []);
          if (jobs.length) {card.m = jobs.length; card.n = jobs.filter(id => (model.resultAt.get(id) ?? Infinity) <= index).length;}
        }
      }
    }
    if (actor.state === 'waiting') {
      const waits = snapshot.waits.filter(wait => wait.from === actor.id);
      if (!waits.length) card.wait = 'waiting';
      else if (waits.every(wait => wait.to === 'user')) {
        const asked = model.events.slice(0, index + 1).findLast(event => event.kind === 'waiting' && event.from === actor.id && event.to.includes('user'));
        card.wait = approvalWait(asked?.text ?? '');
      } else card.wait = 'waits ' + [...new Set(waits.map(wait => wait.to))].join(', ');
    }
    const next = mine.find(node => !node.children.length && node !== current?.node && !stateOf(model, node.id, index).begun
      && !((model.nodeEvents.get(node.id)?.length ?? 0) === 0 && ['done', 'accepted', 'failed', 'interrupted'].includes(node.status)));
    if (next) card = {...card, next: next.title};
    cards.set(actor.id, card);
  }
  return cards;
}
/** The work items below `id` (nodes without live children). */
function subleaves(model: ActModel, id: string): string[] {
  const below = [...model.nodes.values()].filter(node => node.id.startsWith(id + '.') && node.status !== 'abandoned');
  return below.filter(node => !below.some(other => other.id.startsWith(node.id + '.'))).map(node => node.id);
}

/** The plan names tasks of companions (nodes no delegation was synthesized for): some card may have a `next:` task to show before its work begins. */
export function plannedWork(model: ActModel): boolean {
  const graph = model.graph;
  if (!graph?.planned) return false;
  return graph.plan.nodes.some(node => !graph.synthetic.has(node.id) && !node.children.length && node.status !== 'abandoned' && !isDirector(node.owner) && node.owner !== AUTOMA_OWNER && node.owner !== PLAN_USER);
}

// ---------------------------------------------------------------------------------------------------------------------------------- scenes
export interface Scene {
  /** The act shown (-1: none). */
  readonly act: number;
  /** The events of the act and the position of the replay point among them (-1: none yet). */
  readonly events: readonly TeamEvent[];
  readonly at: number;
  readonly snapshot: StageSnapshot;
}
const actEvents = new WeakMap<ActModel, (readonly TeamEvent[])[]>();
const NONE: readonly TeamEvent[] = [];
/** The events of one act (the same array for the same model, so memoised layouts can key on it). */
export function eventsOfAct(model: ActModel, act: number): readonly TeamEvent[] {
  if (act < 0 || act >= model.acts.length) return NONE;
  let lists = actEvents.get(model);
  if (!lists) {lists = []; actEvents.set(model, lists);}
  return lists[act] ??= model.byAct[act]!.map(at => model.events[at]!);
}
const withCards = (base: StageSnapshot, cards: ReadonlyMap<string, StageCard>): StageSnapshot =>
  ({...base, actors: base.actors.map((actor): StageActor => ({...actor, ...(cards.has(actor.id) ? {card: cards.get(actor.id)!} : {})}))});
/**
 * The stage of the replay point `index` (an index into all events; -1 before the first): the current act's events up to it, with every card filled. An event in
 * no act shows the act before it as it ended (at rest); before the first act the first act is on stage with nobody on it yet.
 */
export function sceneAt(model: ActModel, index: number): Scene {
  const act = actIndexAt(model, index), events = eventsOfAct(model, act);
  if (act < 0) return {act, events, at: -1, snapshot: stageAt(events, -1)};
  const own = index >= 0 && index < model.actOf.length && model.actOf[index] === act;
  const started = index >= 0 && model.acts[act]!.span.first <= index;
  const at = own ? model.position[index]! : started || index < 0 ? events.length - 1 : -1;
  const base = stageAt(events, at);
  const upTo = at < 0 ? -1 : model.byAct[act]![at]!;
  return {act, events, at, snapshot: withCards(base, stageCards(model, model.acts[act]!, upTo, base))};
}
/** The stage of `act` at its end: the state that reserves the height of its scene. */
export function finalScene(model: ActModel, act: number): StageSnapshot {
  const events = eventsOfAct(model, act), base = stageAt(events, events.length - 1);
  if (act < 0 || !events.length) return base;
  return withCards(base, stageCards(model, model.acts[act]!, model.byAct[act]!.at(-1)!, base));
}

// ---------------------------------------------------------------------------------------------------------------------------------- programme
export interface ProgrammeTask {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly status: NodeStatus;
  readonly depth: number;
  /** How long its finished work took (ms), or the start of its running work (epoch ms). */
  readonly took?: number;
  readonly runningSince?: number;
  /** The titles of the tasks it runs after. */
  readonly after: readonly string[];
  /** Its Automa workers, and whether one of them is a fork. */
  readonly workers: number;
  readonly forked: boolean;
  /** The delegation behind a task the plan did not name (opens the delegation page). */
  readonly delegation?: string;
}
export interface ProgrammeAct {
  readonly index: number;
  readonly title: string;
  readonly status: ActStatus;
  readonly progress: ActProgress;
  /** The act is open (its round has not closed naturally). */
  readonly open: boolean;
  readonly tasks: readonly ProgrammeTask[];
}
/** Every act with its tasks, the progress as of the end of the stream. */
export function programme(model: ActModel): ProgrammeAct[] {
  const last = model.events.length - 1;
  return model.acts.map(act => {
    const progress = actProgress(model, act, last);
    const mine = [...model.nodes.values()].filter(node => model.nodeAct.get(node.id) === act.index);
    const depthOf = (node: DerivedNode): number => {
      let depth = 0;
      for (let at = node.parent; at !== undefined; at = model.nodes.get(at)?.parent) if (model.nodeAct.get(at) === act.index) depth++;
      return depth;
    };
    const tasks = mine.map((node): ProgrammeTask => {
      const delegation = model.graph?.delegationOf.get(node.id);
      return {id: node.id, title: node.title, owner: node.owner, status: node.status, depth: depthOf(node), ...(node.took !== undefined ? {took: node.took} : {}),
        ...(node.runningSince !== undefined ? {runningSince: node.runningSince} : {}), after: node.after.map(id => model.nodes.get(id)?.title ?? 'an earlier step'),
        workers: node.links.filter(link => link.automaJob).length, forked: node.forked === true, ...(delegation ? {delegation} : {})};
    });
    return {index: act.index, title: act.title, status: actStatus(model, act, last, progress), progress, open: act.span.closedAt === undefined, tasks};
  });
}
