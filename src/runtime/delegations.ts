/**
 * The delegation record: who delegated what to whom, what it waits on, and how it ended, as a pure projection of a runtime snapshot. Nothing here is
 * stored or written to a journal; the activities (their origin fields, `stopReason`, timings and summary) and the Automa swarm states of their tool
 * messages are the records, and this function reads them again whenever the store changes. `/tasks` (`src/commands/tasks-page.ts`) and the headless
 * report (`src/headless.ts`) both read it, so they cannot disagree. Records from older sessions lack the newer optional fields and project without them.
 */
import type {Activity, ActivityStatus, AutomaJobState, RuntimeSnapshot} from './contracts.js';
import {isDirector} from './director-id.js';
import {normalizeStopReason, type StopReasonCode} from './stop-reason.js';

export type DelegationKind = 'director' | 'actor' | 'automa';
export type JobState = AutomaJobState['state'];
/** What a settled delegation handed back, aligned with the `Finish` fields; the full report stays where it is and is named by `reportRef`. */
export interface DelegationResult {
  readonly summary: string;
  readonly evidence?: readonly string[];
  readonly notVerified?: readonly string[];
  readonly question?: string;
  readonly stopReason: StopReasonCode;
  readonly finishedAt?: number;
  /** The delivery that holds the full report (`terminal:<activityId>:<status>`), else the activity id (read it with `ReadActor`). */
  readonly reportRef: string;
  /** The work wrote a report of its own (a model-written round summary, a worker's summary); absent when the text is the runtime's fallback. */
  readonly final?: true;
}
export type WaitingKind = 'blocked' | 'approval' | 'question' | 'queued' | 'paused';
export interface Delegation {
  /** The activity id, or `<activityId>/<jobId>` for an Automa job. */
  readonly id: string;
  readonly kind: DelegationKind;
  readonly ownerId: string;
  readonly title: string;
  readonly status: ActivityStatus | JobState;
  readonly parentId?: string;
  readonly rootId: string;
  readonly children: readonly string[];
  /** Unfinished activities named by `after`; empty once they have all ended. */
  readonly blockedBy: readonly string[];
  /** Every delegation id this one was told to follow (`after`), finished or not; `blockedBy` is the unfinished part. Absent without prerequisites. */
  readonly after?: readonly string[];
  readonly batchId?: string;
  readonly waiting?: {readonly kind: WaitingKind; readonly text: string};
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
  readonly stopReason?: StopReasonCode;
  readonly diagnostic?: string;
  readonly assignment: {readonly title: string; readonly owns: readonly string[]; readonly acceptance: readonly string[]};
  readonly result?: DelegationResult;
  /** Actors only: the activity this one resumes (`resumeTaskId`), a continuation of the same task. */
  readonly resumes?: string;
  /** The work ended without a result of its own (see `endedWithoutResult()`). */
  readonly unfinished?: true;
  /** Automa jobs only: the job is a fork (a copy of its dispatcher with its whole context), not a worker with a brief. */
  readonly fork?: boolean;
  /** Automa jobs only: the readable worker id (`T1`), the route and the model. */
  readonly jobId?: string;
  readonly route?: 'read' | 'code' | 'vision';
  readonly model?: string;
  /** Automa jobs of a background dispatch: `background`, and whether the result reached the dispatcher (`delivered`; absent while it is outstanding). */
  readonly background?: boolean;
  readonly delivered?: boolean;
}

const LIVE: ReadonlySet<string> = new Set(['queued', 'running', 'waiting_input', 'paused']);
const SETTLED_JOB: ReadonlySet<string> = new Set(['done', 'blocked', 'failed', 'cancelled', 'denied', 'interrupted', 'skipped']);
const SUMMARY_LIMIT = 400;
const UNFINISHED_STOPS: ReadonlySet<string> = new Set(['interrupted', 'shutdown', 'stalled', 'cancelled_by_user', 'cancelled_by_director', 'error', 'max_tokens']);
const UNFINISHED_STATUS: ReadonlySet<string> = new Set(['failed', 'interrupted', 'cancelled']);
/**
 * Work that ended without handing back a result: stopped by quota, a timeout, an interrupt or an error (a stop reason of `interrupted`, `shutdown`, `stalled`,
 * `cancelled_by_*`, `error`, `max_tokens`, or a failed / interrupted / cancelled status when no stop reason was recorded) and carrying no report of its own.
 * A failure that did report (a model-written summary, a stop reason of `completed` under a failed status) is a result and not unfinished.
 */
export function endedWithoutResult(item: Pick<Delegation, 'status' | 'stopReason' | 'result'>): boolean {
  if (item.result?.final) return false;
  return item.stopReason !== undefined ? UNFINISHED_STOPS.has(item.stopReason) && item.status !== 'completed' && item.status !== 'done' : UNFINISHED_STATUS.has(item.status);
}
/** The text without its leading `⏵ ...` status lines (a companion opens each reply with one; it says what the reply is doing, not what it found). */
export function withoutStatusLine(text: string): string {
  const lines = text.split('\n');
  while (lines.length) {
    const head = lines[0]!.trim().replace(/^[`*_\s]+/, '');
    if (head === '') {lines.shift(); continue;}
    if (!head.startsWith('⏵')) break;
    lines.shift();
  }
  return lines.join('\n').trim();
}
const oneLine = (text: string, limit = SUMMARY_LIMIT) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + '…' : flat;
};

/** Outcome of an Automa job that predates `stopReason`: what its state says. */
function jobStop(job: AutomaJobState): StopReasonCode | undefined {
  if (job.stopReason) return job.stopReason;
  if (job.state === 'done' || job.state === 'blocked' || job.state === 'denied') return 'completed';
  if (job.state === 'failed') return 'error';
  if (job.state === 'skipped') return 'dependency_unmet';
  if (job.state === 'cancelled' || job.state === 'interrupted') return 'interrupted';
  return undefined;
}

export interface ProjectionInput {
  readonly snapshot: RuntimeSnapshot;
  readonly sessionId: string;
  /** Deliveries that hold reports, to name `reportRef`; optional. */
  readonly deliveries?: readonly {readonly id: string; readonly sourceActivityId?: string | undefined; readonly kind: string}[] | undefined;
  readonly now?: number;
}

/** Every delegation of a session: the Director's human rounds, companion activities and Automa jobs, in creation order. */
export function projectDelegations(input: ProjectionInput): Delegation[] {
  const {snapshot, sessionId, now = Date.now()} = input;
  const activities = snapshot.activities.filter(activity => activity.sessionId === sessionId && activity.kind !== 'anamnesis' &&
    // A Director activity that only continues a round (a wake-up, a report) is not a delegation of its own.
    (!isDirector(activity.ownerId) || (activity.rootActivityId ?? activity.activityId) === activity.activityId));
  const byId = new Map(activities.map(activity => [activity.activityId, activity] as const));
  const references = new Map((input.deliveries ?? []).filter(item => item.sourceActivityId && (item.kind === 'report' || item.kind === 'failure')).map(item => [item.sourceActivityId!, item.id] as const));
  const interactions = snapshot.interactions.filter(item => item.sessionId === sessionId && item.status === 'pending');
  const nodes: Delegation[] = [];
  // What each activity last said (assistant text, no reasoning), and the round summary of a Director round whose last words came from a continuation of it.
  const spoken = new Map<string, string>();
  for (const message of snapshot.messages) if (message.activityId && message.role === 'assistant' && message.kind !== 'thinking' && message.text.trim()) spoken.set(message.activityId, withoutStatusLine(message.text));
  const continued = new Map<string, Activity>();
  for (const activity of snapshot.activities) {
    const root = activity.rootActivityId ?? activity.activityId;
    if (activity.sessionId === sessionId && isDirector(activity.ownerId) && root !== activity.activityId && activity.summary) continued.set(root, activity);
  }
  const parents = new Map<string, string | undefined>();

  for (const activity of activities) {
    const rootId = activity.rootActivityId ?? activity.activityId;
    let parentId = activity.parentActivityId && byId.has(activity.parentActivityId) ? activity.parentActivityId : undefined;
    // A parent that is a continuing Director activity is not listed: its dispatches belong to the round's root.
    if (!parentId && rootId !== activity.activityId && byId.has(rootId)) parentId = rootId;
    if (parentId === activity.activityId) parentId = undefined;
    parents.set(activity.activityId, parentId);
    const blockedBy = (activity.after ?? []).filter(id => id !== activity.activityId && LIVE.has(byId.get(id)?.status ?? ''));
    const follows = (activity.after ?? []).filter(id => id !== activity.activityId && byId.has(id));
    const ask = activity.status === 'waiting_input' ? interactions.find(item => item.activityId === activity.activityId) : undefined;
    const waiting = ask ? ask.kind === 'permission' ? {kind: 'approval' as const, text: 'awaiting approval (' + ask.tool + ')'} : {kind: 'question' as const, text: 'awaiting your answer'}
      : activity.status === 'paused' ? {kind: 'paused' as const, text: 'paused'}
      : activity.status === 'queued' ? blockedBy.length ? {kind: 'blocked' as const, text: 'blocked by ' + blockedBy.map(id => byId.get(id)?.ownerId ?? id).join(', ')}
        : {kind: 'queued' as const, text: activity.stage.startsWith('Waiting on ') ? activity.stage.replace(/^Waiting on /, 'queued behind ') : 'queued'}
      : undefined;
    const stop = normalizeStopReason(activity.stopReason);
    const settled = activity.status === 'completed' || activity.status === 'failed' || activity.status === 'cancelled';
    const finalStop = settled ? stop ?? (activity.status === 'completed' ? 'completed' : activity.status === 'failed' ? 'error' : 'interrupted') : undefined;
    const recorded = activity.summary ?? (isDirector(activity.ownerId) ? continued.get(activity.activityId)?.summary : undefined);
    const startedAt = activity.startedAt, finishedAt = activity.finishedAt;
    const durationMs = startedAt === undefined ? undefined : Math.max(0, (finishedAt ?? (settled ? startedAt : now)) - startedAt);
    // The structured summary (the model's round summary line) when there is one, else the report without its status line, else what the activity last said.
    const written = recorded?.source === 'model';
    const summary = oneLine(written ? recorded!.title : withoutStatusLine(recorded?.report ?? '') || activity.diagnostic || spoken.get(activity.activityId) || recorded?.title || '');
    nodes.push({
      id: activity.activityId, kind: isDirector(activity.ownerId) ? 'director' : 'actor', ownerId: activity.ownerId, title: activity.taskTitle ?? activity.title, status: activity.status,
      ...(parentId ? {parentId} : {}), rootId, children: [], blockedBy, ...(follows.length ? {after: follows} : {}), ...(activity.batchId ? {batchId: activity.batchId} : {}), ...(waiting ? {waiting} : {}),
      ...(startedAt !== undefined ? {startedAt} : {}), ...(finishedAt !== undefined ? {finishedAt} : {}), ...(durationMs !== undefined ? {durationMs} : {}),
      ...(finalStop ? {stopReason: finalStop} : {}), ...(activity.diagnostic ? {diagnostic: activity.diagnostic} : {}),
      assignment: {title: activity.taskTitle ?? activity.title, owns: [...activity.ownedFiles ?? []], acceptance: [...activity.acceptance ?? []]},
      ...(settled && finalStop ? {result: {summary, ...(finishedAt !== undefined ? {finishedAt} : {}), stopReason: finalStop, reportRef: references.get(activity.activityId) ?? activity.activityId, ...(written ? {final: true as const} : {})}} : {}),
      ...(activity.resumeTaskId && activity.resumeTaskId !== activity.activityId ? {resumes: activity.resumeTaskId} : {}),
    });
  }

  // Automa jobs: the swarm state of the dispatching activity's tool messages, the latest state of each job id.
  const jobs = new Map<string, Delegation>();
  for (const message of snapshot.messages) {
    const swarm = message.step?.swarm;
    const dispatcher = message.activityId ? byId.get(message.activityId) : undefined;
    if (!swarm || !dispatcher) continue;
    const rootId = dispatcher.rootActivityId ?? dispatcher.activityId;
    swarm.jobs.forEach((job, index) => {
      const jobId = job.id ?? '#' + (index + 1), id = dispatcher.activityId + '/' + jobId;
      const settled = SETTLED_JOB.has(job.state), stop = jobStop(job);
      const durationMs = job.state === 'running' && job.startedAt !== undefined ? Math.max(0, now - job.startedAt) : job.elapsedMs;
      // A job that follows others waits on those that have not ended; their delegation ids are `<activityId>/<jobId>`.
      const unfinished = job.state === 'waiting' ? (job.after ?? []).filter(afterId => { const other = swarm.jobs.find(item => item.id === afterId); return other ? !SETTLED_JOB.has(other.state) : false; }) : [];
      jobs.set(id, {
        id, kind: 'automa', ownerId: dispatcher.ownerId, title: job.title, status: job.state, parentId: dispatcher.activityId, rootId, children: [],
        blockedBy: unfinished.map(afterId => dispatcher.activityId + '/' + afterId),
        ...(job.after?.length ? {after: job.after.map(afterId => dispatcher.activityId + '/' + afterId)} : {}),
        ...(job.state === 'queued' ? {waiting: {kind: 'queued' as const, text: 'queued for a worker slot'}} : {}),
        ...(job.state === 'waiting' ? {waiting: {kind: 'blocked' as const, text: 'waiting on ' + (unfinished.length ? unfinished : job.after ?? []).join(', ')}} : {}),
        ...(swarm.background ? {background: true, ...(job.delivered !== undefined ? {delivered: job.delivered} : {})} : {}),
        durationMs, ...(stop ? {stopReason: stop} : {}), jobId, ...(job.kind === 'fork' ? {fork: true} : {}), ...(job.route ? {route: job.route} : {}), ...(job.model ? {model: job.model} : {}),
        assignment: {title: job.title, owns: [], acceptance: []},
        ...(settled && stop ? {result: {summary: oneLine(withoutStatusLine(job.summary ?? '') || job.title), ...(job.summary?.trim() && (job.state === 'done' || job.state === 'blocked') ? {final: true as const} : {}), ...(job.evidence?.length ? {evidence: job.evidence} : {}), ...(job.notVerified?.length ? {notVerified: job.notVerified} : {}),
          ...(job.question ? {question: job.question} : {}), stopReason: stop, reportRef: id}} : {}),
      });
    });
  }

  const all = [...nodes, ...jobs.values()];
  const children = new Map<string, string[]>();
  for (const node of all) if (node.parentId) children.set(node.parentId, [...children.get(node.parentId) ?? [], node.id]);
  return all.map(node => {
    const full = children.has(node.id) ? {...node, children: children.get(node.id)!} : node;
    // A Director round that ended in error is a failure of the round itself; its other stops (an interrupt) leave the request unfinished.
    return endedWithoutResult(full) && !(node.kind === 'director' && node.stopReason === 'error') ? {...full, unfinished: true as const} : full;
  });
}

/** One row of the `/tasks` list: a delegation and how deep it sits. */
export interface DelegationRow {readonly node: Delegation; readonly depth: number}
/** The tree in display order: the latest root first (its children below it, in creation order), then the earlier roots. */
export function delegationRows(nodes: readonly Delegation[]): DelegationRow[] {
  const byId = new Map(nodes.map(node => [node.id, node] as const));
  const isTop = (node: Delegation) => !node.parentId || !byId.has(node.parentId);
  const rows: DelegationRow[] = [];
  const visit = (node: Delegation, depth: number, seen: Set<string>) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({node, depth});
    for (const child of node.children) {const next = byId.get(child); if (next) visit(next, depth + 1, seen);}
  };
  const seen = new Set<string>();
  for (const top of nodes.filter(isTop).reverse()) visit(top, 0, seen);
  return rows;
}

/** The priced cost (USD) of each activity from its ledger entries; an activity none of whose turns carry a USD price has no entry. */
export function activityCosts(entries: readonly {readonly activityId?: string | undefined; readonly usage?: {readonly cost?: number | undefined; readonly currency?: string | undefined} | undefined}[]): Map<string, number> {
  const costs = new Map<string, number>();
  for (const entry of entries) {
    const usage = entry.usage;
    if (!entry.activityId || usage?.cost === undefined || (usage.currency ?? 'USD') !== 'USD') continue;
    costs.set(entry.activityId, (costs.get(entry.activityId) ?? 0) + usage.cost);
  }
  return costs;
}
