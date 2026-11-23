/**
 * The state of the team's stage at one point of a replay: a pure function of the ordered team events (`team-events.ts`) and an index. Which actors are on
 * stage (only those that appeared in an event up to and including the index, in a fixed roster order so cards never jump), what each one is doing, the workers
 * it has dispatched (name, status, duration), which edges the story has used so far (with counts), which waits are still open, the messages of the last few
 * events and the edge of the current event. `src/tui/panels/team-stage.ts` lays it out and draws it; `actorDetail()` is what an actor's detail page shows.
 * Nothing here reads a clock or a store. Which events make up a scene (one act of the task graph) is decided by `team-acts.ts`, which hands `stageAt()` that
 * act's events.
 */
import {DIRECTOR_ID} from './director-id.js';
import type {TeamEvent, TeamItem, TeamStatus} from './team-events.js';

/** The fixed order of the companions on stage; any other actor follows, alphabetically. */
export const STAGE_ROSTER: readonly string[] = ['kalon', 'techne', 'aletheia'];
/** How many of the latest events keep their message drawn on the stage (the current one included); older messages fade out entirely. */
export const RECENT_EVENTS = 4;
export type StageState = 'working' | 'waiting' | 'done' | 'idle' | 'failed';
export type JobStatus = 'running' | 'done' | 'failed';
export interface StageJob {
  /** What the stage shows: the job's `name` when the Automa job has one, else its title. */
  readonly name: string;
  readonly title: string;
  readonly fork: boolean;
  readonly status: JobStatus;
  /** Epoch ms the dispatch happened and, once settled, how long the job took. */
  readonly startedAt: number;
  readonly ms?: number;
}
/** What a card says of the actor's work in the current act (`team-acts.ts:stageCards` fills it from the task graph; absent for a stage with no acts). */
export interface StageCard {
  /** The title of the actor's current task (the node it is working on, or the last one it settled). */
  readonly title?: string;
  /** Settled over total of what the task holds (its sub-tasks, else its workers); absent when it holds nothing. */
  readonly n?: number;
  readonly m?: number;
  /** The last task of the actor in this act settled this way (shown instead of the progress). */
  readonly outcome?: 'done' | 'failed' | 'interrupted';
  /** Why the actor waits (`waits techne`, `awaiting approval`). */
  readonly wait?: string;
  /** The title of a task assigned to the actor in this act that has no work yet. */
  readonly next?: string;
}
export interface StageActor {
  readonly id: string;
  readonly state: StageState;
  readonly card?: StageCard;
  /** Workers and forks running now (dispatched and not yet settled). */
  readonly workers: number;
  readonly forks: number;
  /** Every job the actor dispatched up to the index, in dispatch order. */
  readonly jobs: readonly StageJob[];
}
export interface StageEdge {
  readonly from: string;
  readonly to: string;
  /** How many events travelled this edge so far. */
  readonly count: number;
}
export interface StageCurrent {
  readonly id: string;
  readonly kind: TeamEvent['kind'];
  readonly from: string;
  readonly to: readonly string[];
  readonly status?: TeamStatus;
}
/** A message of the last few events (`age` 0 is the current event). */
export interface StageRecent extends StageCurrent {readonly age: number}
export interface StageSnapshot {
  /** The index this state is at (-1: before the first event). */
  readonly index: number;
  readonly actors: readonly StageActor[];
  /** The stream has had a `user` event by now: the `you` marker is shown. */
  readonly hasUser: boolean;
  /** Edges used up to the index, `from -> to`: assign down, report up, messages between actors, `user -> logox`, `automa -> actor` for a worker's result. */
  readonly edges: readonly StageEdge[];
  /** Waits that are still open at the index (the waiter points at what it waits on). */
  readonly waits: readonly {readonly from: string; readonly to: string}[];
  /** Traffic between two companions of the last `RECENT_EVENTS` events, newest first. */
  readonly recent: readonly StageRecent[];
  /** Some edge or wait between two companions has been used by now (the stage keeps channel rows for it). */
  readonly peers: boolean;
  readonly current?: StageCurrent;
}

const isActor = (id: string): boolean => id !== DIRECTOR_ID && id !== 'user' && id !== 'automa';
/** The name the stage shows for an Automa job: its `name` when it has one, else its title. The one place that decides. */
export const workerName = (item: {readonly title: string; readonly name?: string | undefined}): string => item.name?.trim() || item.title;
/** The roster rank of an actor id (unknown ones after the known ones, alphabetical). */
export function rosterOrder(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => {
    const ra = STAGE_ROSTER.indexOf(a), rb = STAGE_ROSTER.indexOf(b);
    if (ra >= 0 || rb >= 0) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

interface Job {readonly item: TeamItem; readonly startedAt: number; status: JobStatus; ms?: number}
/** The stage at `index` (clamped to the events; -1 or an empty stream is the empty stage). */
export function stageAt(events: readonly TeamEvent[], index: number): StageSnapshot {
  const last = Math.min(index, events.length - 1);
  const seen = new Set<string>();
  const state = new Map<string, StageState>();
  const jobs = new Map<string, Job[]>();
  const edges = new Map<string, {from: string; to: string; count: number}>();
  const waits = new Map<string, {from: string; to: string}>();
  let hasUser = false, peers = false;
  const touch = (...ids: (string | undefined)[]) => {for (const id of ids) if (id && isActor(id)) seen.add(id);};
  const travel = (from: string, to: string) => {
    if (from === to) return;
    const key = from + '>' + to, known = edges.get(key);
    if (known) known.count++; else edges.set(key, {from, to, count: 1});
    if (isActor(from) && isActor(to)) peers = true;
  };
  const endWaitsOf = (waiter: string) => {for (const key of [...waits.keys()]) if (waits.get(key)!.from === waiter) waits.delete(key);};
  for (let i = 0; i <= last; i++) {
    const event = events[i]!;
    const dispatcher = event.dispatcher ?? event.from;
    touch(event.from, ...event.to, event.dispatcher);
    if (event.kind === 'user') {
      hasUser = true;
      travel('user', DIRECTOR_ID);
      for (const id of event.to) if (isActor(id)) {state.set(id, 'working'); endWaitsOf(id);}
      continue;
    }
    if (event.kind === 'workers') {
      jobs.set(event.from, [...(jobs.get(event.from) ?? []), ...(event.items ?? []).map((item): Job => ({item, startedAt: event.at, status: 'running'}))]);
      continue;
    }
    if (event.kind === 'result') {
      const owner = event.to[0] ?? dispatcher;
      const list = jobs.get(owner) ?? [];
      // The job it settles: the first running one with the same title, else the first running one.
      const job = list.find(item => item.status === 'running' && item.item.title === event.title) ?? list.find(item => item.status === 'running');
      if (job) {job.status = event.status === 'done' ? 'done' : 'failed'; job.ms = Math.max(0, event.at - job.startedAt);}
      for (const id of event.to) travel('automa', id);
      continue;
    }
    if (event.kind === 'waiting') {
      if (event.from === 'automa') continue;
      for (const id of event.to) {
        waits.set(event.from + '>' + id, {from: event.from, to: id});
        if (isActor(event.from) && isActor(id)) peers = true;
      }
      if (isActor(event.from)) state.set(event.from, 'waiting');
      continue;
    }
    // assign, message, report
    for (const id of event.to) travel(event.from, id);
    if (event.kind === 'assign' || event.kind === 'message') {
      for (const id of event.to) if (isActor(id)) {state.set(id, 'working'); endWaitsOf(id);}
    } else if (event.kind === 'report' && isActor(event.from)) {
      state.set(event.from, event.status === 'blocked' ? 'waiting' : event.status === 'failed' ? 'failed' : event.status === 'interrupted' ? 'idle' : 'done');
      endWaitsOf(event.from);
      // Whoever waited on this actor can go on.
      for (const key of [...waits.keys()]) {
        const wait = waits.get(key)!;
        if (wait.to !== event.from) continue;
        waits.delete(key);
        if (isActor(wait.from) && state.get(wait.from) === 'waiting') state.set(wait.from, 'working');
      }
    }
    if (event.kind === 'message' && isActor(event.from) && !state.has(event.from)) state.set(event.from, 'working');
  }
  const point = (event: TeamEvent): StageCurrent => ({id: event.id, kind: event.kind, from: event.from, to: event.to, ...(event.status ? {status: event.status} : {})});
  const current = last >= 0 ? events[last] : undefined;
  const recent: StageRecent[] = [];
  for (let i = last; i >= 0 && i > last - RECENT_EVENTS; i--) {
    const event = events[i]!;
    if (event.kind !== 'message' && event.kind !== 'assign' && event.kind !== 'report') continue;
    if (!isActor(event.from) || !event.to.some(isActor)) continue;
    recent.push({...point(event), to: event.to.filter(isActor), age: last - i});
  }
  return {
    index: last,
    actors: rosterOrder(seen).map(id => {
      const list = jobs.get(id) ?? [];
      return {id, state: state.get(id) ?? 'idle', workers: list.filter(job => job.status === 'running' && !job.item.fork).length, forks: list.filter(job => job.status === 'running' && job.item.fork).length,
        jobs: list.map((job): StageJob => ({name: workerName(job.item), title: job.item.title, fork: job.item.fork, status: job.status, startedAt: job.startedAt, ...(job.ms !== undefined ? {ms: job.ms} : {})}))};
    }),
    hasUser,
    edges: [...edges.values()],
    waits: [...waits.values()],
    recent,
    peers,
    ...(current ? {current: point(current)} : {}),
  };
}

/** What an actor's detail page shows at a point of the replay. */
export interface ActorDetail {
  readonly id: string;
  readonly state: StageState;
  /** The latest assignment (or message, or the person's words) the actor received, as one line. */
  readonly task?: string;
  readonly jobs: readonly StageJob[];
  /** The actor's latest messages (sent and received), newest first. */
  readonly messages: readonly {readonly id: string; readonly at: number; readonly direction: 'in' | 'out'; readonly peer: string; readonly kind: TeamEvent['kind']; readonly text: string}[];
  /** Messages exchanged per peer. */
  readonly peers: readonly {readonly peer: string; readonly sent: number; readonly received: number}[];
}
export const DETAIL_MESSAGES = 8;
/** The detail of actor `id` from the events up to and including `index`. */
export function actorDetail(events: readonly TeamEvent[], index: number, id: string): ActorDetail {
  const snapshot = stageAt(events, index), actor = snapshot.actors.find(item => item.id === id);
  const upTo = events.slice(0, Math.max(0, Math.min(index, events.length - 1) + 1));
  const task = upTo.findLast(event => (event.kind === 'assign' || event.kind === 'message' || event.kind === 'user') && event.to.includes(id));
  const counts = new Map<string, {sent: number; received: number}>();
  const bump = (peer: string, side: 'sent' | 'received') => {const known = counts.get(peer) ?? {sent: 0, received: 0}; known[side]++; counts.set(peer, known);};
  const messages: ActorDetail['messages'][number][] = [];
  for (const event of upTo) {
    if (event.kind === 'workers' || event.kind === 'result' || event.kind === 'waiting') continue;
    if (event.from === id) for (const to of event.to) {bump(to, 'sent'); messages.push({id: event.id, at: event.at, direction: 'out', peer: to, kind: event.kind, text: event.text});}
    else if (event.to.includes(id)) {bump(event.from, 'received'); messages.push({id: event.id, at: event.at, direction: 'in', peer: event.from, kind: event.kind, text: event.text});}
  }
  return {id, state: actor?.state ?? 'idle', ...(task ? {task: task.text} : {}), jobs: actor?.jobs ?? [], messages: messages.reverse().slice(0, DETAIL_MESSAGES),
    peers: [...counts.entries()].map(([peer, value]) => ({peer, ...value})).sort((a, b) => b.sent + b.received - a.sent - a.received || (a.peer < b.peer ? -1 : 1))};
}
