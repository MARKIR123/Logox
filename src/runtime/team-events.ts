/**
 * The team event stream: every dispatch and every reply of the team as one ordered list, a pure projection of the runtime snapshot (and the pending
 * deliveries), never stored. The task sidebar's Team tab (`src/tui/panels/team-sidebar.ts`) draws it, the session hub and the headless report carry it, and the
 * graph with replay of a later step reads the same events and the same selected index. Records from older sessions lack the newer optional fields and
 * project without them; an event with no timestamp takes the time of the message record it sits at.
 *
 * Where each kind comes from:
 *  - `user`: a human message (`inputKind` human) in any window; `to` is the window's owner.
 *  - `assign`: a companion activity started by the Director (`inputKind` director); one event per batch (or per round and moment), `to` the owners, `text` the titles.
 *  - `message`: `SendMessage` as the recipient received it (a user-role message with `inputKind` collaboration, envelope `[Event ...]` / `[Message from X · ...]`
 *    removed), and a still pending collaboration or help delivery; one event for a broadcast.
 *  - `workers`: the Automa swarm of a tool message (`step.swarm`): `items` are the jobs; `result` is each settled job (`status` from its state).
 *  - `report`: a settled companion activity handing back its result (`Delegation.result`), to whoever dispatched it.
 *  - `waiting`: work ordered `after` others (`Delegation.after`), and work waiting for an approval or an answer.
 */
import type {Message, RuntimeSnapshot} from './contracts.js';
import {isDirector, DIRECTOR_ID} from './director-id.js';
import {isEnvelope, projectDelegations, withoutStatusLine, type Delegation} from './delegations.js';
import {inputKind} from './provenance.js';
import {USER_STEER_NOTICE} from '../prompts/runtime/interruption.js';

export type TeamKind = 'assign' | 'message' | 'workers' | 'result' | 'report' | 'waiting' | 'user';
export type TeamStatus = 'done' | 'blocked' | 'failed' | 'interrupted';
export interface TeamItem {readonly title: string; readonly fork: boolean}
export interface TeamEvent {
  /** Stable across projections (`user:<messageId>`, `assign:<activityId>`, ...). */
  readonly id: string;
  /** Epoch ms. */
  readonly at: number;
  /** An actor id, `user`, or `automa` (a worker: `worker` is its readable id, `dispatcher` the actor that dispatched it). */
  readonly from: string;
  readonly to: readonly string[];
  readonly kind: TeamKind;
  readonly status?: TeamStatus;
  /** A label the sender gave (a message summary, a job title). */
  readonly title?: string;
  /** One line, no `⏵` status line, no message envelope. */
  readonly text: string;
  /** What the detail page opens: a delegation id (`<activityId>` or `<activityId>/<jobId>`), or the id of the message record (then `detail` holds its text). */
  readonly ref: string;
  /** `workers` only: the jobs, in dispatch order. */
  readonly items?: readonly TeamItem[];
  /** `message` and `user`: the full text without its envelope. */
  readonly detail?: string;
  readonly worker?: string;
  readonly dispatcher?: string;
}

export interface TeamInput {
  readonly snapshot: RuntimeSnapshot;
  readonly sessionId: string;
  readonly deliveries?: readonly TeamDelivery[] | undefined;
  readonly now?: number;
}
export interface TeamDelivery {
  readonly id: string; readonly kind: string; readonly status: string; readonly ownerId: string; readonly source: string; readonly text: string; readonly time: number;
}

const LINE_LIMIT = 240;
const MERGE_MS = 3000, ASSIGN_MERGE_MS = 5000;
const KIND_RANK: Record<TeamKind, number> = {user: 0, assign: 1, workers: 2, message: 3, waiting: 4, result: 5, report: 6};
const oneLine = (text: string, limit = LINE_LIMIT): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + '…' : flat;
};

interface Parsed {readonly from?: string; readonly title?: string; readonly body: string}
const EVENT_LINE = /^\[Event [^;\]]*;\s*([^;\]]*);\s*source\s+([^;\]\s]+)[^\]]*\]\s*$/;
const MESSAGE_LINE = /^\[(?:Message|Interrupt) from ([^\]·]+?)(?:\s·\s([^\]]*))?\]\s*$/;
/** A collaboration message without its envelope: who sent it (lower case), the label the sender gave, and the text. */
export function parseMessage(text: string): Parsed {
  const lines = text.split('\n');
  let from: string | undefined, title: string | undefined, help = false;
  const event = EVENT_LINE.exec(lines[0] ?? '');
  if (event) {lines.shift(); help = event[1]!.trim() === 'help'; from = event[2]!.trim().toLowerCase();}
  const header = MESSAGE_LINE.exec(lines[0] ?? '');
  if (header) {lines.shift(); from = header[1]!.trim().toLowerCase(); title = header[2]?.trim() || undefined;}
  while (lines.length && /^\[Question for you[^\]]*\]\s*$/.test(lines[0]!.trim())) lines.shift();
  // A help event opens with the label the actor gave it, then its text.
  if (help && !header && lines.length > 1) {title = lines.shift()!.trim() || undefined;}
  return {...(from ? {from} : {}), ...(title ? {title} : {}), body: lines.join('\n').trim()};
}

interface Candidate {readonly event: Omit<TeamEvent, 'at'>; readonly at: number | undefined; readonly seq: number; readonly order: number}

const jobStatus = (state: string): TeamStatus | undefined =>
  state === 'done' ? 'done' : state === 'blocked' ? 'blocked' : state === 'failed' || state === 'denied' ? 'failed' : state === 'cancelled' || state === 'interrupted' ? 'interrupted' : undefined;
function reportStatus(item: Delegation): TeamStatus {
  const stop = item.stopReason;
  if (item.result?.question) return 'blocked';
  if (item.status === 'cancelled' || stop === 'interrupted' || stop === 'shutdown' || stop === 'cancelled_by_user' || stop === 'cancelled_by_director') return 'interrupted';
  if (item.status === 'failed' || stop === 'error' || stop === 'max_tokens' || stop === 'stalled' || stop === 'refusal') return 'failed';
  return 'done';
}

/** The team event stream of one session, ordered by time (equal times keep record order). */
export function teamEvents(input: TeamInput): TeamEvent[] {
  const {snapshot, sessionId} = input;
  const now = input.now ?? 0;
  const messages = snapshot.messages.filter(message => message.sessionId === sessionId);
  const activities = snapshot.activities.filter(activity => activity.sessionId === sessionId && activity.kind !== 'anamnesis');
  const byId = new Map(activities.map(activity => [activity.activityId, activity] as const));
  const delegations = projectDelegations({snapshot, sessionId, now, ...(input.deliveries ? {deliveries: input.deliveries} : {})});
  const delegationById = new Map(delegations.map(item => [item.id, item] as const));
  const candidates: Candidate[] = [];
  let order = 0;
  const add = (event: Omit<TeamEvent, 'at'>, at: number | undefined, seq: number) => {candidates.push({event, at, seq, order: order++});};

  // Where each activity first and last appears among the message records, and when.
  const first = new Map<string, number>(), last = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.activityId) return;
    if (!first.has(message.activityId)) first.set(message.activityId, index);
    last.set(message.activityId, index);
  });
  const startOf = (activityId: string, depth = 0): number | undefined => {
    const index = first.get(activityId), activity = byId.get(activityId);
    const time = index === undefined ? undefined : messages[index]!.time;
    if (time !== undefined) return time;
    if (activity?.startedAt !== undefined) return activity.startedAt;
    return activity?.parentActivityId && depth < 8 ? startOf(activity.parentActivityId, depth + 1) : undefined;
  };
  const seqOf = (activityId: string, where: Map<string, number>, depth = 0): number => {
    const index = where.get(activityId);
    if (index !== undefined) return index;
    const parent = byId.get(activityId)?.parentActivityId;
    return parent && depth < 8 ? seqOf(parent, where, depth + 1) : Number.POSITIVE_INFINITY;
  };

  // ------------------------------------------------------------------------------------------------------------------------------ messages
  const pendingKeys = new Set<string>();
  const messageEvents: Candidate[] = [];
  messages.forEach((message: Message, seq) => {
    if (message.role !== 'user' || message.kind !== undefined || !message.text.trim()) return;
    const kind = inputKind(message);
    if (kind === 'human') {
      const body = message.text.startsWith(USER_STEER_NOTICE) ? message.text.slice(USER_STEER_NOTICE.length).trim() : message.text.trim();
      if (!body) return;
      add({id: 'user:' + message.id, from: 'user', to: [message.ownerId], kind: 'user', text: oneLine(body), ref: message.id, detail: body}, message.time, seq);
    } else if (kind === 'collaboration' || kind === 'collaboration_interrupt') {
      const parsed = parseMessage(message.text);
      const from = parsed.from ?? (message.source && message.source !== 'coordination' ? message.source.toLowerCase() : undefined);
      if (!from || !parsed.body) return;
      const key = from + '\0' + parsed.body;
      messageEvents.push({event: {id: 'msg:' + message.id, from, to: [message.ownerId], kind: 'message', ...(parsed.title ? {title: oneLine(parsed.title, 120)} : {}), text: oneLine(parsed.body),
        ref: message.id, detail: parsed.body}, at: message.time, seq, order: order++});
      pendingKeys.add(key);
    }
  });
  // A broadcast reaches every companion as its own record: one event per sender, text and moment.
  const merged: Candidate[] = [];
  for (const item of messageEvents) {
    const previous = merged.findLast(other => other.event.from === item.event.from && other.event.detail === item.event.detail && Math.abs((item.at ?? 0) - (other.at ?? 0)) <= MERGE_MS);
    if (!previous) {merged.push(item); continue;}
    const to = [...new Set([...previous.event.to, ...item.event.to])];
    merged[merged.indexOf(previous)] = {...previous, event: {...previous.event, to}};
  }
  candidates.push(...merged);
  // A collaboration or help delivery that has not reached its recipient yet.
  for (const delivery of input.deliveries ?? []) {
    if (delivery.status !== 'pending' || (delivery.kind !== 'collaboration' && delivery.kind !== 'help')) continue;
    const parsed = parseMessage(delivery.text);
    const from = parsed.from ?? delivery.source.toLowerCase();
    if (!parsed.body || pendingKeys.has(from + '\0' + parsed.body)) continue;
    add({id: 'msg:' + delivery.id, from, to: [delivery.ownerId], kind: 'message', ...(parsed.title ? {title: oneLine(parsed.title, 120)} : {}), text: oneLine(parsed.body), ref: delivery.id, detail: parsed.body}, delivery.time, Number.POSITIVE_INFINITY);
  }

  // ------------------------------------------------------------------------------------------------------------------------------ assignments
  interface Assign {readonly from: string; readonly activities: typeof activities; readonly at: number | undefined; readonly seq: number}
  const assigns: Assign[] = [];
  const dispatched = activities.filter(activity => !isDirector(activity.ownerId) && (activity.inputKind === 'director' ||
    activity.inputKind === undefined && messages.some(message => message.activityId === activity.activityId && message.role === 'user' && message.kind === undefined && inputKind(message) === 'director')));
  for (const activity of [...dispatched].sort((a, b) => (startOf(a.activityId) ?? 0) - (startOf(b.activityId) ?? 0))) {
    const parent = activity.parentActivityId ? byId.get(activity.parentActivityId) : undefined;
    const from = parent?.ownerId ?? DIRECTOR_ID, at = startOf(activity.activityId), seq = seqOf(activity.activityId, first);
    const group = assigns.findLast(item => item.from === from && (activity.batchId !== undefined
      ? item.activities.some(other => other.batchId === activity.batchId)
      : item.activities.every(other => other.batchId === undefined && other.parentActivityId === activity.parentActivityId) && Math.abs((at ?? 0) - (item.at ?? 0)) <= ASSIGN_MERGE_MS));
    if (group) assigns[assigns.indexOf(group)] = {...group, activities: [...group.activities, activity]};
    else assigns.push({from, activities: [activity], at, seq});
  }
  for (const item of assigns) {
    const titles = item.activities.map(activity => oneLine(activity.taskTitle ?? activity.title, 120));
    add({id: 'assign:' + item.activities[0]!.activityId, from: item.from, to: [...new Set(item.activities.map(activity => activity.ownerId))], kind: 'assign',
      text: oneLine(titles.join(' ／ ')), ref: item.activities[0]!.activityId}, item.at, item.seq);
  }

  // ------------------------------------------------------------------------------------------------------------------------------ Automa
  const jobAt = new Map<string, {at: number | undefined; seq: number}>();
  messages.forEach((message, seq) => {
    const swarm = message.step?.swarm, dispatcher = message.activityId ? byId.get(message.activityId) : undefined;
    if (!swarm || !dispatcher || !swarm.jobs.length) return;
    const ids = swarm.jobs.map((job, index) => dispatcher.activityId + '/' + (job.id ?? '#' + (index + 1)));
    ids.forEach(id => {if (!jobAt.has(id)) jobAt.set(id, {at: message.time, seq});});
    const forks = swarm.jobs.filter(job => job.kind === 'fork').length;
    add({id: 'workers:' + message.id, from: dispatcher.ownerId, to: [], kind: 'workers', text: swarm.jobs.length + (forks === swarm.jobs.length ? (forks === 1 ? ' fork' : ' forks') : swarm.jobs.length === 1 ? ' worker' : ' workers'),
      ref: ids[0]!, items: swarm.jobs.map(job => ({title: oneLine(job.title, 80), fork: job.kind === 'fork'}))}, message.time, seq);
  });

  // ------------------------------------------------------------------------------------------------------------------------------ results, reports, waits
  for (const item of delegations) {
    if (item.kind === 'automa') {
      const status = jobStatus(item.status);
      if (item.result && status) {
        const where = jobAt.get(item.id);
        add({id: 'result:' + item.id, from: 'automa', to: [item.ownerId], kind: 'result', status, title: oneLine(item.title, 80), text: oneLine(withoutStatusLine(item.result.summary)),
          ref: item.id, ...(item.jobId ? {worker: item.jobId} : {}), dispatcher: item.ownerId},
        where?.at === undefined ? undefined : where.at + (item.durationMs ?? 0), where?.seq ?? Number.POSITIVE_INFINITY);
      }
      if (item.after?.length && item.status !== 'skipped') {
        const where = jobAt.get(item.id);
        const owners = item.after.map(id => delegationById.get(id)?.jobId ?? id.split('/')[1] ?? id);
        add({id: 'wait:' + item.id, from: 'automa', to: [item.ownerId], kind: 'waiting', text: 'waiting on ' + owners.join(', '), ref: item.id, ...(item.jobId ? {worker: item.jobId} : {}), dispatcher: item.ownerId}, where?.at, where?.seq ?? Number.POSITIVE_INFINITY);
      }
      continue;
    }
    if (item.kind !== 'actor') continue;
    const activity = byId.get(item.id);
    if (!activity) continue;
    const parent = activity.parentActivityId ? byId.get(activity.parentActivityId) : undefined;
    const directed = activity.inputKind === 'director' || activity.inputKind === undefined && dispatched.some(other => other.activityId === activity.activityId);
    if (item.result) {
      const status = reportStatus(item);
      // A task woken by a message reports through its messages; only how it went wrong is told.
      if (directed || status !== 'done') {
        const summary = item.result.summary && !isEnvelope(item.result.summary) ? item.result.summary : item.title;
        const to = directed ? [parent?.ownerId ?? DIRECTOR_ID] : [DIRECTOR_ID];
        const finished = item.result.finishedAt ?? (last.has(item.id) ? messages[last.get(item.id)!]!.time : undefined);
        add({id: 'report:' + item.id, from: item.ownerId, to, kind: 'report', status, text: oneLine(summary), ref: item.id}, finished, seqOf(item.id, last));
      }
    }
    const waitAt = startOf(item.id);
    if (item.after?.length) {
      const names = [...new Set(item.after.map(id => delegationById.get(id)?.ownerId ?? id))];
      // Only a wait that held up the work: a prerequisite that had already ended when this was dispatched is not one.
      const held = item.after.some(id => {const other = delegationById.get(id); return !other || other.finishedAt === undefined || waitAt === undefined || other.finishedAt > waitAt;});
      if (held) add({id: 'wait:' + item.id, from: item.ownerId, to: names, kind: 'waiting', text: 'waiting on ' + names.join(', '), ref: item.id}, waitAt, seqOf(item.id, first));
    } else if (item.waiting && (item.waiting.kind === 'approval' || item.waiting.kind === 'question')) {
      add({id: 'wait:' + item.id, from: item.ownerId, to: ['user'], kind: 'waiting', text: item.waiting.text, ref: item.id}, last.has(item.id) ? messages[last.get(item.id)!]!.time : waitAt, seqOf(item.id, last));
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------------ order
  // A record without a time takes the time of the nearest earlier message record, so older sessions keep their record order.
  const known: number[] = [];
  let carried = 0;
  for (const message of messages) {if (message.time !== undefined) carried = message.time; known.push(carried);}
  const timed = candidates.map(item => {
    const at = item.at ?? (Number.isFinite(item.seq) ? known[item.seq] : known.at(-1)) ?? 0;
    return {event: {...item.event, at} as TeamEvent, seq: item.seq, order: item.order};
  });
  timed.sort((a, b) => a.event.at - b.event.at || (a.seq === b.seq ? 0 : a.seq - b.seq) || KIND_RANK[a.event.kind] - KIND_RANK[b.event.kind] || a.order - b.order);
  return timed.map(item => item.event);
}

/** The ids of the members that took part in a list of events (senders and recipients, `user` last), in order of first appearance. */
export function teamMembers(events: readonly TeamEvent[]): string[] {
  const members: string[] = [];
  for (const event of events) for (const id of [event.kind === 'result' || event.kind === 'waiting' && event.from === 'automa' ? event.dispatcher ?? event.from : event.from, ...event.to]) {
    if (id !== 'automa' && !members.includes(id)) members.push(id);
  }
  return [...members.filter(id => id !== 'user'), ...members.filter(id => id === 'user')];
}
/** Whether a member took part in an event (as the sender, a recipient, or the dispatcher of a worker). */
export const involves = (event: TeamEvent, member: string): boolean => event.from === member || event.to.includes(member) || event.dispatcher === member;

/**
 * Memoises the projection: the same events (the same array) while the store revision, the session and the pending deliveries are unchanged, and also while
 * a new revision projects to an identical list, so a view that lays the stream out again only when it changes never does for an unrelated store change.
 */
export class TeamStream {
  private key = '';
  private signature = '';
  private events: readonly TeamEvent[] = [];
  /** Counts projections computed; tests assert an unchanged revision computes none. */
  computed = 0;
  /** Moves exactly when the list of events changes (the revision the hub reports). */
  changes = 0;
  get(input: TeamInput): readonly TeamEvent[] {
    const pending = (input.deliveries ?? []).filter(item => item.status === 'pending').map(item => item.id).join(',');
    const key = input.sessionId + '|' + input.snapshot.revision + '|' + pending;
    if (key === this.key) return this.events;
    this.key = key;
    this.computed++;
    const next = teamEvents(input);
    const signature = JSON.stringify(next);
    if (signature === this.signature) return this.events;
    this.signature = signature;
    this.events = next;
    this.changes++;
    return next;
  }
}
