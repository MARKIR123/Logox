import type {JobGrant} from '../tools/orchestration/AutomaTool/grant.js';
import type {AutomaSwarm} from '../runtime/contracts.js';
import {randomUUID} from 'node:crypto';
import {RuntimeStore} from '../runtime/store.js';
import {immutable, type InteractionInput, type InteractionOutcome, type Step, type TaskProgressSnapshot, type TaskOriginData} from '../runtime/contracts.js';
import {repairToolResults, type ModelMessage} from '../runtime/messages.js';
import {summarizeRound, type RoundSummary, type RoundStatus} from '../context/contracts.js';
import {omitInternalToolPairs, type TaskDelivery} from '../context/round-memory.js';
import {storedMessage, type HistoryEntry, type HistoryStore, type TaskCheckpoint} from '../store/journal.js';
import {inputKind, type InputKind} from '../runtime/provenance.js';
import {DeliveryQueue} from './delivery-queue.js';
import type {DeliveryKind} from '../runtime/delivery.js';
import {UserCancelledError} from '../kernel/agent.js';
import {killActiveProcess, killActivityProcesses, killBackgroundJobs} from '../tools/process.js';
import {createRuntimeContextMessage, type RuntimeContextMessage} from '../runtime/context-updates.js';
import {DIRECTOR_STOP_DEFAULT_REASON, USER_INTERRUPT_MARKER, directorStopMarker} from '../prompts/runtime/interruption.js';

import {builtinActors} from './builtins.js';

// Fallback roles share the shipped profile colors with builtinActors. Runtime
// prefers the loaded catalog; keep this compatibility shape without card surfaces.
function builtinColor(id: string): string {
  const actor = builtinActors.find(actor => actor.id === id);
  if (!actor) throw new Error('Missing shipped actor: ' + id);
  return actor.color;
}
export const cast = immutable({
  logox: {symbol: '◈', name: 'Logox', title: 'Director', color: builtinColor('logox')},
  aletheia: {symbol: '◎', name: 'Aletheia', title: 'Scout', color: builtinColor('aletheia')},
  techne: {symbol: '⊞', name: 'Techne', title: 'Builder', color: builtinColor('techne')},
  kalon: {symbol: '✧', name: 'Kalon', title: 'Aesthete', color: builtinColor('kalon')},
});
export type ActorId = keyof typeof cast;
export type StopReason = 'user' | 'shutdown' | 'interrupted' | 'director_cancel';

/** The ledger marker for a deliberate stop, or nothing for shutdown and crash recovery (their wording lives in runtime recovery texts). */
export function stopNotice(reason: StopReason | undefined, detail: string | undefined, activityId: string): RuntimeContextMessage | undefined {
  if (reason === 'user') return createRuntimeContextMessage('interruption', USER_INTERRUPT_MARKER, {activityId, slot: 'interruption', by: 'user'});
  if (reason === 'director_cancel') return createRuntimeContextMessage('interruption', directorStopMarker(detail?.trim() || DIRECTOR_STOP_DEFAULT_REASON), {activityId, slot: 'interruption', by: 'director'});
  return undefined;
}
export interface TaskOrigin extends Omit<TaskOriginData, 'authorization' | 'stopReason'> {
  authorization?: readonly string[] | undefined;
  priority?: boolean;
}
export interface TaskResult<Id extends string = string> extends TaskOrigin {
  sessionId: string; ownerId: Id; activityId: string; source: string;
  summary: RoundSummary; delivery?: TaskDelivery; status: RoundStatus; error?: unknown; stopReason?: StopReason;
}
export interface ActorContext<Id extends string = string> extends TaskOrigin {
  readonly progress?: TaskProgressSnapshot;
  saveProgress?(progress: TaskProgressSnapshot): Promise<void>;
  readonly source?: string;
  /** Set when a stateless worker acts for this actor: permissions stay the principal's, reads never count as the principal's own. */
  readonly via?: {readonly label: string; readonly workerId: string; readonly grant: JobGrant};
  startTool?(): void;
  reportSwarm?(swarm: AutomaSwarm): void;
  wait?(reason: string): () => void;
  drainInbox?(): readonly ModelMessage[] | Promise<readonly ModelMessage[]>;
  humanInputs?(): readonly string[];
  hasPendingInbox?(): boolean;
  inboundRecovery?(): TaskOrigin['recovery'];
  closeInbox?(): Promise<readonly ModelMessage[]>;
  acceptRoundMemory?(callId: string | null): void;
  readonly sessionId: string;
  readonly activityId: string;
  readonly ownerId: Id;
  readonly history: readonly HistoryEntry[];
  readonly reviewMessages?: () => readonly ModelMessage[];
  readonly signal: AbortSignal;
  /** Why this run is being stopped, once it is (`user` for Esc / Ctrl+C, `director_cancel` for CancelActor). */
  readonly stopReason?: () => StopReason | undefined;
  report(stage: string, detail: string): void;
  say(text: string): void;
  record(message: ModelMessage, step?: Step): Promise<void>;
  ask(input: Omit<Extract<InteractionInput, {kind: 'question'}>, 'sessionId' | 'activityId' | 'ownerId'>): Promise<InteractionOutcome>;
  permission(input: Omit<Extract<InteractionInput, {kind: 'permission'}>, 'sessionId' | 'activityId' | 'ownerId'>): Promise<boolean>;
  /** Like `permission`, but returns the user's full answer (grant scope, denial note). Absent in minimal contexts; callers fall back to `permission`. */
  askPermission?(input: Omit<Extract<InteractionInput, {kind: 'permission'}>, 'sessionId' | 'activityId' | 'ownerId'>): Promise<PermissionAnswer>;
}
export interface PermissionAnswer {readonly decision: 'allow_once' | 'allow_session' | 'allow_project' | 'deny'; readonly note?: string}
export type ActorExecutor<Id extends string = ActorId> = (prompt: string, context: ActorContext<Id>) => Promise<void>;
export interface EnsembleOptions<Id extends string = ActorId> {
  concurrency?: 'serial' | 'actor';
  deliveries?: DeliveryQueue;
  settled?(activityId: string, status: RoundStatus): Promise<void>;
  member?(ownerId: string): {name: string; title: string} | undefined;
  taskStart?(context: ActorContext<Id>): Promise<void>;
  taskEnd?(context: ActorContext<Id>, summary: RoundSummary, status: RoundStatus): Promise<void>;
  directAnchor?(result: {sessionId: string; ownerId: Id; activityId: string; status: RoundStatus}): Promise<void>;
  handoff?(result: TaskResult<Id>): Promise<void>;
}
export interface TaskHandle {readonly activityId: string; readonly done: Promise<void>; cancel(): void}
interface Task<Id extends string> {ownerId: Id; prompt: string}
interface QueuedTask<Id extends string> extends Task<Id> {
  activityId: string; source: string; origin: TaskOrigin; controller: AbortController;
  ready: Promise<void>; done: Promise<void>; resolve(): void; stopReason?: StopReason; stopDetail?: string;
  progress?: TaskProgressSnapshot;
  /** Final status and full report once the task has ended; read by tasks that run `after` it. */
  outcome?: {status: RoundStatus; title: string; text: string};
  /** A dependency failed or was stopped: the task is being cancelled and never runs. */
  doomed?: boolean;
  dependenciesReleased?: boolean;
}
const DEPENDENCY_REPORT_LIMIT = 8000;
const DEPENDENCY_REPORTS_HEADER = 'Reports from the work this task was waiting for:';
export class EnsembleRuntime<Id extends string> {
  private readonly queue: QueuedTask<Id>[] = [];
  private readonly tasks = new Map<string, QueuedTask<Id>>();
  private readonly finished = new Map<string, {ownerId: string; status: RoundStatus; title: string; text: string}>();
  private readonly activeSlots = new Map<Id, Promise<void>>();
  private readonly pausedBatches = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingWrites = new Set<Promise<void>>();
  readonly deliveries: DeliveryQueue;
  private readonly inboxes = new Map<string, {pending: Set<Promise<void>>; sealed: boolean}>();
  private closed = false;
  constructor(readonly sessionId: string, readonly store: RuntimeStore, private readonly history: HistoryStore,
    private readonly execute: ActorExecutor<NoInfer<Id>>, private readonly options: EnsembleOptions<Id> = {}) {
    this.deliveries = options.deliveries ?? new DeliveryQueue(sessionId, history);
  }

  dispatchBatch(tasks: readonly Task<Id>[]): readonly TaskHandle[] {
    const grouped = new Map<Id, string[]>();
    for (const task of tasks) {
      const prompts = grouped.get(task.ownerId) ?? [];
      prompts.push(task.prompt);
      grouped.set(task.ownerId, prompts);
    }
    return [...grouped].map(([ownerId, prompts]) => this.dispatch(ownerId, prompts.join('\n\n')));
  }

  dispatch(ownerId: Id, prompt: string, source: string = 'logox', origin: TaskOrigin = {}): TaskHandle {
    if (this.closed) throw new Error('Ensemble is closed');
    const member = this.options.member ? this.options.member(ownerId) : Object.hasOwn(cast, ownerId) ? cast[ownerId as ActorId] : undefined;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(ownerId) || !member || !prompt.trim() || !/^(?:direct|[a-z][a-z0-9_-]{0,63})$/.test(source)) throw new Error('Invalid actor or task');
    const host = origin.inputKind === 'collaboration' && !origin.resumeTaskId ? this.queuedHost(ownerId) : undefined;
    if (host) return this.foldIntoQueued(host, prompt, source);
    const activityId = randomUUID();
    origin = {...origin, rootActivityId: origin.rootActivityId ?? activityId, inputKind: inputKind({ownerId, source, ...origin})};
    const controller = new AbortController();
    this.controllers.set(activityId, controller);
    this.store.activities.create({
      sessionId: this.sessionId, activityId, ownerId, kind: ownerId === 'logox' ? 'director' : 'actor',
      title: origin.taskTitle ?? (member.name + ' · ' + member.title),
      status: origin.batchId && this.pausedBatches.has(origin.batchId) ? 'paused' : 'queued', stage: this.waitingStage(origin.after) ?? 'Waiting to enter', detail: prompt,
      ...this.identityOrigin(origin),
    });
    if (!(ownerId === 'logox' && origin.inputKind === 'actor')) this.store.message(this.sessionId, ownerId, 'user', prompt, {activityId, source, inputKind: origin.inputKind ?? 'unknown'});
    let resolve!: () => void;
    const done = new Promise<void>(finish => {resolve = finish;});
    const task: QueuedTask<Id> = {ownerId, prompt, activityId, source, origin, controller, resolve, done, ready: Promise.resolve()};
    task.ready = this.trackWrite((async () => {
      const progress = origin.resumeTaskId
        ? await this.history.progress?.(this.sessionId, ownerId, origin.resumeTaskId)
        : undefined;
      if (progress) {
        task.progress = progress;
        this.store.activities.update(this.sessionId, activityId, {progress});
      }
      await this.checkpoint(task, origin.batchId && this.pausedBatches.has(origin.batchId) ? 'paused' : 'queued');
    })());
    void task.ready.catch(() => {});
    this.tasks.set(activityId, task);
    const priority = (item: QueuedTask<Id>) => item.origin.inputKind === 'human' ? 0 : item.origin.priority ? 1 : item.origin.coordinationWake ? 3 : 2;
    const nextIndex = this.queue.findIndex(item => priority(item) > priority(task));
    if (nextIndex >= 0) this.queue.splice(nextIndex, 0, task); else this.queue.push(task);
    queueMicrotask(() => this.pump());
    return {activityId, done, cancel: () => {this.cancel(activityId);}};
  }
  /** A Director-dispatched task of `ownerId` that has not started yet (held by `after`, a paused batch or a busy actor). */
  private queuedHost(ownerId: string): QueuedTask<Id> | undefined {
    return this.queue.find(task => task.ownerId === ownerId && task.origin.inputKind === 'director' && !task.doomed && !task.controller.signal.aborted);
  }
  /** A peer message for an actor whose dispatched task has not started joins that task instead of opening a second card that would run first and hold the actor's slot. */
  private foldIntoQueued(host: QueuedTask<Id>, text: string, source: string): TaskHandle {
    host.prompt = host.prompt + '\n\n' + text;
    this.store.message(this.sessionId, host.ownerId, 'user', text, {activityId: host.activityId, source, inputKind: 'collaboration'});
    host.ready = this.trackWrite(host.ready.then(() => this.checkpoint(host, this.store.activities.get(this.sessionId, host.activityId)?.status === 'paused' ? 'paused' : 'queued')));
    void host.ready.catch(() => {});
    return {activityId: host.activityId, done: host.done, cancel: () => {}};
  }
  isBusy(): boolean {return [...this.controllers.keys()].some(id => this.store.activities.get(this.sessionId, id)?.status !== 'paused') || this.pendingWrites.size > 0;}
  queuedInputs(ownerId?: string) {
    return this.queue.filter(task => task.origin.inputKind === 'human' && (!ownerId || task.ownerId === ownerId))
      .map(task => ({activityId: task.activityId, ownerId: task.ownerId, text: task.prompt}));
  }

  getActiveTask(ownerId: string): QueuedTask<Id> | undefined {
    return [...this.tasks.values()].find(task => task.ownerId === ownerId &&
      ['running', 'waiting_input'].includes(this.store.activities.get(this.sessionId, task.activityId)?.status ?? ''));
  }
  canReceiveMessage(ownerId: string): boolean {
    const active = this.getActiveTask(ownerId);
    const inbox = active && this.inboxes.get(active.activityId);
    return !!active && !!inbox && !inbox.sealed && !active.controller.signal.aborted;
  }

  async injectTaskMessage(targetOwnerId: string, message: string, source = 'logox', summary?: string, mode: 'interrupt' | 'queue' = 'queue',
    delivery: {activityId?: string; inputKind?: InputKind; kind?: DeliveryKind} = {}): Promise<boolean> {
    const active = this.getActiveTask(targetOwnerId);
    const inbox = active && this.inboxes.get(active.activityId);
    if (!active || !inbox || inbox.sealed || active.controller.signal.aborted ||
      delivery.activityId && delivery.activityId !== active.activityId) return false;
    const human = delivery.inputKind === 'human';
    const kind = human ? 'human_steer' : delivery.kind ?? 'collaboration';
    const input = human ? 'human' : mode === 'interrupt' ? 'collaboration_interrupt' : 'collaboration';
    const fullText = human ? message : `[Message from ${source}${summary ? ' · ' + summary : ''}]\n${message}`;
    const write = this.trackWrite((async () => {
      await this.deliveries.enqueue({ownerId: targetOwnerId, targetActivityId: active.activityId,
        source, kind, inputKind: input, text: fullText});
      this.store.message(this.sessionId, targetOwnerId as Id, 'user', fullText, {
        activityId: active.activityId, source, inputKind: input,
      });
      if (mode === 'interrupt' && !human && !active.controller.signal.aborted) {
        killActivityProcesses(active.activityId, `Interrupted by ${source}: ${summary || message.slice(0, 80)}`);
      }
    })());
    inbox.pending.add(write);
    try {await write;} finally {inbox.pending.delete(write);}
    return true;
  }

  interruptTask(targetOwnerId: string, message: string, source = 'logox', summary?: string): boolean {
    const active = this.getActiveTask(targetOwnerId);
    if (!active) return false;
    void this.injectTaskMessage(targetOwnerId, message, source, summary, 'interrupt');
    return true;
  }

  cancelTool(actorId: string, toolId?: string, reason = 'Cancelled by Director'): {success: boolean; message: string} {
    const active = this.getActiveTask(actorId);
    if (!active) return {success: false, message: `No active running task found for actor '${actorId}'.`};
    const targetId = toolId || active.activityId;
    const killed = toolId ? killActiveProcess(toolId, reason, 'director') : killActivityProcesses(active.activityId, reason, 'director') > 0;
    if (killed) {
      return {success: true, message: `Successfully cancelled tool process for ${actorId} (target: ${targetId}): ${reason}`};
    }
    return {success: true, message: `Tool cancellation signal delivered to ${actorId}. Tool may have already completed.`};
  }

  cancelActor(actorId: string, scope: 'tool' | 'activity', toolId?: string, reason = 'Cancelled by Director'): {success: boolean; message: string} {
    if (scope === 'tool') {
      return this.cancelTool(actorId, toolId, reason);
    }
    const active = this.getActiveTask(actorId);
    if (!active) {
      return {success: false, message: `No active running activity found for actor '${actorId}'.`};
    }
    const cancelled = this.cancel(active.activityId, 'director_cancel', reason);
    return {
      success: cancelled,
      message: cancelled
        ? `Successfully cancelled activity ${active.activityId} for actor '${actorId}': ${reason}`
        : `Activity ${active.activityId} was already finalized.`,
    };
  }
  cancel(activityId: string, reason: StopReason = 'user', detail?: string): boolean {
    const task = this.tasks.get(activityId);
    if (!task) return false;
    if (['completed', 'failed', 'cancelled'].includes(this.store.activities.get(this.sessionId, activityId)?.status ?? '')) return false;
    task.stopReason = reason;
    if (detail) task.stopDetail = detail;
    this.store.activities.update(this.sessionId, activityId, {stopReason: reason});
    task.controller.abort();
    const index = this.queue.indexOf(task);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.controllers.delete(activityId); this.tasks.delete(activityId);
      this.finished.set(activityId, {ownerId: task.ownerId, status: 'cancelled', title: 'Queued task cancelled', text: detail ?? 'The task had not started.'});
      this.store.activities.update(this.sessionId, activityId, {status: 'cancelled', stage: 'Interrupted', detail: detail ?? 'Queued task cancelled'});
      void this.trackWrite(task.ready.catch(() => {}).then(async () => {
        await this.checkpoint(task, 'cancelled');
        await this.options.handoff?.({sessionId: this.sessionId, ownerId: task.ownerId, activityId, source: task.source,
          ...task.origin, status: 'cancelled', stopReason: reason, summary: {title: 'Queued task cancelled', report: 'The task had not started.', source: 'local'}});
        await this.options.settled?.(activityId, 'cancelled');
      })).catch(() => {this.store.message(this.sessionId, task.ownerId, 'notice', 'Failed to save queued-cancel checkpoint; the task will not run automatically after restart', {activityId});});
      task.resolve();
    }
    return true;
  }
  pauseBatch(batchId: string): void {
    this.pausedBatches.add(batchId);
    for (const task of this.queue.filter(task => task.origin.batchId === batchId)) {
      this.store.activities.update(this.sessionId, task.activityId, {status: 'paused', stage: 'Waiting for further instructions'});
      task.ready = this.trackWrite(task.ready.then(() => this.checkpoint(task, 'paused')));
      void task.ready.catch(() => {});
    }
  }
  resumeBatch(batchId: string): void {
    this.pausedBatches.delete(batchId);
    for (const task of this.queue.filter(task => task.origin.batchId === batchId)) {
      this.store.activities.update(this.sessionId, task.activityId, {status: 'queued', stage: this.waitingStage(task.origin.after) ?? 'Waiting to enter'});
      task.ready = this.trackWrite(task.ready.then(() => this.checkpoint(task, 'queued')));
      void task.ready.catch(() => {});
    }
    this.pump();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const task of [...this.tasks.values()]) this.cancel(task.activityId, 'shutdown');
    await Promise.allSettled([...this.activeSlots.values()]);
    killBackgroundJobs();
    await Promise.allSettled([...this.pendingWrites]);
  }
  private identityOrigin(origin: TaskOrigin) {
    const {parentActivityId, rootActivityId, batchId, resumeTaskId, taskTitle} = origin;
    return {...(parentActivityId ? {parentActivityId} : {}), ...(rootActivityId ? {rootActivityId} : {}), ...(batchId ? {batchId} : {}),
      ...(resumeTaskId ? {resumeTaskId} : {}),
      ...(taskTitle ? {taskTitle} : {}),
      ...(origin.ownedFiles?.length ? {ownedFiles: [...origin.ownedFiles]} : {}),
      ...(origin.grantExecution ? {grantExecution: true} : {}),
      ...(origin.dispatchDepth !== undefined ? {dispatchDepth: origin.dispatchDepth} : {}),
      ...(origin.coordinationWake ? {coordinationWake: true} : {}),
      ...(origin.recovery ? {recovery: {key: origin.recovery.key, attempt: origin.recovery.attempt,
        ...(origin.recovery.actorTask ? {actorTask: origin.recovery.actorTask} : {}),
        ...(origin.recovery.exhausted !== undefined ? {exhausted: origin.recovery.exhausted} : {})}} : {}),
      ...(origin.inputKind ? {inputKind: origin.inputKind} : {}), ...(origin.authorization ? {authorization: [...origin.authorization]} : {})};
  }
  private checkpoint(task: QueuedTask<Id>, status: 'queued' | 'paused' | 'running' | 'waiting_input' | RoundStatus, error?: string): Promise<void> {
    return this.history.checkpoint?.(this.sessionId, {activityId: task.activityId, ownerId: task.ownerId, prompt: task.prompt, source: task.source,
      ...this.identityOrigin(task.origin), ...(task.stopReason ? {stopReason: task.stopReason} : {}), status, time: Date.now(),
      ...(task.progress ? {progress: task.progress} : {}),
      ...(error ? {error: error.slice(0, 2048)} : {})}) ?? Promise.resolve();
  }
  private pump(): void {
    if (this.closed) return;
    const actorConcurrency = this.options.concurrency === 'actor';
    if (!actorConcurrency && this.activeSlots.size > 0) return;
    for (let index = 0; index < this.queue.length; index++) {
      const task = this.queue[index]!;
      if (task.origin.batchId && this.pausedBatches.has(task.origin.batchId)) continue;
      if (task.doomed) continue;
      if (this.releaseDependencies(task)) continue;
      if (this.activeSlots.has(task.ownerId)) {this.markBusy(task); continue;}
      this.queue.splice(index, 1);
      index--;
      const execution = (async () => {
        try {await task.ready; await this.run(task);}
        catch (error) {
          this.store.activities.update(this.sessionId, task.activityId, {status: 'failed', stage: 'Checkpoint save failed', detail: error instanceof Error ? error.message : String(error)});
          await this.options.handoff?.({sessionId: this.sessionId, ownerId: task.ownerId, activityId: task.activityId, source: task.source,
            ...task.origin, status: 'failed', error, summary: {title: 'Task recording failed', report: 'The task has not run; the checkpoint could not be saved.', source: 'local'}});
          await this.options.settled?.(task.activityId, 'failed');
        }
      })().catch(() => {}).finally(() => {
        this.finished.set(task.activityId, {ownerId: task.ownerId, ...(task.outcome ?? this.fallbackOutcome(task))});
        this.tasks.delete(task.activityId); this.controllers.delete(task.activityId); this.activeSlots.delete(task.ownerId); this.inboxes.delete(task.activityId);
        task.resolve(); this.pump();
      });
      this.activeSlots.set(task.ownerId, execution);
      if (!actorConcurrency) break;
    }
  }
  /** Shows why a task that is ready but not running yet waits: its actor is still on an earlier activity. */
  private markBusy(task: QueuedTask<Id>): void {
    if (task.origin.batchId && this.pausedBatches.has(task.origin.batchId)) return;
    const member = this.options.member ? this.options.member(task.ownerId as Id) : Object.hasOwn(cast, task.ownerId) ? cast[task.ownerId as ActorId] : undefined;
    const stage = `Waiting on ${member?.name ?? task.ownerId}'s current task`;
    const current = this.store.activities.get(this.sessionId, task.activityId);
    if (current?.status === 'queued' && current.stage !== stage) this.store.activities.update(this.sessionId, task.activityId, {stage});
  }
  /** Ids named in `after` that are still unfinished (queued, running or waiting). Unknown ids count as finished. */
  private blockers(after: readonly string[] | undefined): string[] {
    return (after ?? []).filter(id => this.tasks.has(id) && !this.finished.has(id));
  }
  private waitingStage(after: readonly string[] | undefined): string | undefined {
    const names = this.blockers(after).map(id => {const owner = this.tasks.get(id)!.ownerId; const member = this.options.member ? this.options.member(owner as Id) : Object.hasOwn(cast, owner) ? cast[owner as ActorId] : undefined; return member?.name ?? owner;});
    return names.length ? 'Waiting on ' + [...new Set(names)].join(', ') : undefined;
  }
  private fallbackOutcome(task: QueuedTask<Id>) {
    const status = this.store.activities.get(this.sessionId, task.activityId)?.status;
    return {status: (status === 'completed' || status === 'failed' ? status : 'cancelled') as RoundStatus, title: '', text: ''};
  }
  /** Holds a task with unfinished `after` dependencies; on release prepends their reports, or cancels the task when one did not complete. Returns true while the task must stay queued. */
  private releaseDependencies(task: QueuedTask<Id>): boolean {
    const after = task.origin.after;
    if (!after?.length || task.dependenciesReleased) return false;
    const waiting = this.waitingStage(after);
    if (waiting) {
      if (this.store.activities.get(this.sessionId, task.activityId)?.stage !== waiting && !(task.origin.batchId && this.pausedBatches.has(task.origin.batchId))) {
        this.store.activities.update(this.sessionId, task.activityId, {stage: waiting});
      }
      return true;
    }
    task.dependenciesReleased = true;
    const reports = after.flatMap(id => {const done = this.finished.get(id); return done ? [{id, ...done}] : [];});
    const failed = reports.find(report => report.status !== 'completed');
    if (failed) {
      task.doomed = true;
      queueMicrotask(() => {this.cancel(task.activityId, 'director_cancel', `Not started: the task it waited for (${failed.ownerId}, ${failed.id}) ${failed.status === 'failed' ? 'failed' : 'was stopped'}.`);});
      return true;
    }
    if (reports.length) {
      task.prompt = [DEPENDENCY_REPORTS_HEADER, reports.map(report => `[${report.ownerId} · ${report.title || report.id}]\n${report.text.slice(0, DEPENDENCY_REPORT_LIMIT)}`).join('\n\n'), task.prompt].join('\n\n');
    }
    this.store.activities.update(this.sessionId, task.activityId, {stage: 'Waiting to enter'});
    task.ready = this.trackWrite(task.ready.then(() => this.checkpoint(task, 'queued')));
    void task.ready.catch(() => {});
    return false;
  }
  private trackWrite(operation: Promise<void>): Promise<void> {
    this.pendingWrites.add(operation);
    const remove = () => {this.pendingWrites.delete(operation);};
    void operation.then(remove, remove);
    return operation;
  }
  private async run(task: QueuedTask<Id>): Promise<void> {
    const {ownerId, prompt, activityId, controller, source, origin} = task;
    if (this.store.activities.get(this.sessionId, activityId)?.status === 'cancelled') return;
    const signal = controller.signal;
    const update = (status: 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled', stage: string, detail = '') =>
      this.store.activities.update(this.sessionId, activityId, {status, stage, detail});
    const identity = {sessionId: this.sessionId, activityId, ownerId};
    const checkpoint = async (status: 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled', error?: string) => {
      await this.checkpoint(task, status, error);
    };
    let delivery: TaskDelivery | undefined;
    let acceptedFinalizer: string | null | undefined;
    const finish = async (status: 'completed' | 'failed' | 'cancelled') => {
      const inbox = this.inboxes.get(activityId);
      if (inbox) {inbox.sealed = true; await Promise.allSettled([...inbox.pending]);}
      try {
        if (!this.history.finishRecord) return await this.history.finish?.(this.sessionId, ownerId, activityId, status);
        const record = await this.history.finishRecord(this.sessionId, ownerId, activityId, status, acceptedFinalizer);
        delivery = record.delivery;
        return record.summary;
      } catch {
        this.store.message(this.sessionId, ownerId, 'notice', 'Round memory could not be saved; original messages are preserved.', {activityId});
        const entries = (await this.history.load(this.sessionId, ownerId).catch(() => [])).filter(entry => entry.activityId === activityId);
        const messages: ModelMessage[] = entries.map(storedMessage);
        const summary = summarizeRound(messages.filter(message => message.role !== 'assistant' || !message.memoryOnly), status);
        const text = messages.findLast(message => message.role === 'assistant' && !message.contextExcluded && !message.memoryOnly && message.text.trim())?.text;
        if (ownerId !== 'logox' && origin.inputKind === 'director' && text) delivery = {title: summary.title, text};
        return summary;
      }
    };
    const output: string[] = [];
    let recorded = false;
    let context: ActorContext<Id> | undefined;
    const settle = async (status: RoundStatus) => {
      await this.deliveries.settle(activityId, status);
      if (!this.options.settled) return;
      try {await this.options.settled(activityId, status);}
      catch {this.store.message(this.sessionId, ownerId, 'notice', 'Failed to save collaboration wrap-up checkpoint', {activityId});}
    };
    const request = async (input: InteractionInput): Promise<InteractionOutcome> => {
      signal.throwIfAborted();
      update('waiting_input', input.kind === 'permission' ? 'Awaiting permission' : 'Awaiting answer');
      const waiting = this.store.interactions.open(input, signal);
      try {await checkpoint('waiting_input'); return await waiting.result; }
      finally {
        if (!signal.aborted) update('running', 'Continuing');
      }
    };
    this.inboxes.set(activityId, {pending: new Set(), sealed: false});
    try {
      signal.throwIfAborted();
      update('running', 'On stage');
      await checkpoint('running');
      const entries = immutable([...await this.history.load(this.sessionId, ownerId)]);
      signal.throwIfAborted();
      for (const message of repairToolResults(omitInternalToolPairs(entries.flatMap(entry => entry.message ? [entry.message] : [])))) {
        await this.history.append({version: 1, ...identity, role: 'tool', text: message.text, message});
      }
      await this.history.append({version: 1, ...identity, source, inputKind: origin.inputKind ?? 'unknown', role: 'user', text: prompt, message: {role: 'user', text: prompt}});
      signal.throwIfAborted();
      const authorization = [...origin.authorization ?? [], ...entries.filter(entry => entry.role === 'user' && inputKind(entry) === 'human').map(entry => entry.text),
        ...(origin.inputKind === 'human' ? [prompt] : [])].slice(-8);
      const drain = async () => {
        const inbox = this.inboxes.get(activityId);
        if (inbox) await Promise.all([...inbox.pending]);
        signal.throwIfAborted();
        const received = await this.deliveries.drain(ownerId, activityId);
        authorization.push(...received.humanInputs);
        if (authorization.length > 8) authorization.splice(0, authorization.length - 8);
        return received.messages;
      };
      context = {
        ...identity, ...origin, source, history: entries, signal,
        drainInbox: drain,
        humanInputs: () => authorization,
        hasPendingInbox: () => this.deliveries.pending(ownerId, activityId).some(item => !item.deferredUntilHuman),
        inboundRecovery: () => this.deliveries.recoveryFor(activityId, origin.rootActivityId ?? activityId, origin.recovery),
        closeInbox: async () => {
          const inbox = this.inboxes.get(activityId);
          if (!inbox) return [];
          inbox.sealed = true;
          const incoming = await drain();
          if (incoming.length) inbox.sealed = false;
          return incoming;
        },
        acceptRoundMemory: callId => {acceptedFinalizer = callId;},
        stopReason: () => task.stopReason,
        ...(task.progress ? {progress: task.progress} : {}),
        saveProgress: async progress => {
          signal.throwIfAborted();
          const status = this.store.activities.get(this.sessionId, activityId)?.status;
          if (!status || ['completed', 'failed', 'cancelled', 'queued', 'paused'].includes(status)) throw new Error('Activity is not executing; cannot update its progress label');
          await this.history.checkpoint?.(this.sessionId, {activityId, ownerId, prompt, source, ...this.identityOrigin(origin),
            ...(task.stopReason ? {stopReason: task.stopReason} : {}), status, time: Date.now(), progress});
          task.progress = progress;
          signal.throwIfAborted();
        },
        authorization,
        record: async (message, step) => {
          await this.history.append({version: 1, ...identity, role: message.role, text: message.text, message, ...(step ? {step} : {})});
          recorded = true;
        },
        report: (stage, detail) => { signal.throwIfAborted(); update('running', stage, detail); },
        say: text => { signal.throwIfAborted(); output.push(text); this.store.message(this.sessionId, ownerId, 'assistant', text, {activityId}); },
        ask: input => request({...identity, ...input}),
        askPermission: async input => {
          const result = await request({...identity, ...input});
          signal.throwIfAborted();
          if (result.status !== 'answered' || result.response.kind !== 'permission') return {decision: 'deny'};
          return {decision: result.response.decision, ...(result.response.note ? {note: result.response.note} : {})};
        },
        permission: async input => {
          const result = await request({...identity, ...input});
          signal.throwIfAborted();
          return result.status === 'answered' && result.response.kind === 'permission' && result.response.decision !== 'deny';
        },
      };
      await this.options.taskStart?.(context);
      signal.throwIfAborted();
      await this.execute(prompt, context);
      signal.throwIfAborted();
      if (output.length && !recorded) await this.history.append({version: 1, ...identity, role: 'assistant', text: output.join('\n')});
      signal.throwIfAborted();
      const summary = await finish('completed');
      if (summary) task.outcome = {status: 'completed', title: summary.title, text: delivery?.text ?? summary.report};
      if (summary) {
        this.store.activities.update(this.sessionId, activityId, {phase: 'finalizing', stage: 'Wrapping up', detail: summary.report});
        // Only a real task end (Director assignment or human request) may compact; collaboration and peer wakes never do.
        try {if (origin.inputKind === 'director' || origin.inputKind === 'human') await this.options.taskEnd?.(context, summary, 'completed');}
        catch {this.store.message(this.sessionId, ownerId, 'notice', 'Task completed, but wrap-up did not finish; the raw ledger is preserved.', {activityId});}
        try {
          if (source === 'direct') await this.options.directAnchor?.({...identity, status: 'completed'});
          else await this.options.handoff?.({...identity, ...origin, source, summary, ...(delivery ? {delivery} : {}), status: 'completed'});
        }
        catch {this.store.message(this.sessionId, ownerId, 'notice', 'Summary handoff did not finish; it can be read from the actor ledger.', {activityId});}
      }
      await checkpoint('completed');
      await settle('completed');
      this.controllers.delete(activityId);
      this.store.activities.update(this.sessionId, activityId, {status: 'completed', stage: 'Completed', ...(summary ? {summary, title: summary.title, detail: summary.report} : {})});
      if (ownerId !== 'logox' && task.stopReason !== 'director_cancel') {
        const member = this.options.member ? this.options.member(ownerId) : Object.hasOwn(cast, ownerId) ? cast[ownerId as ActorId] : undefined;
        const roleName = member?.name ?? ownerId;
        this.store.message(this.sessionId, 'logox', 'notice', `[Notice] ${roleName} (${ownerId}) completed activity ${activityId}.`, {
          activityId,
          source: ownerId,
          inputKind: 'human',
        });
      }
    } catch (error) {
      const isUserCancel = (error instanceof UserCancelledError) ||
        (error instanceof Error && (error.name === 'UserCancelledError' || error.message.includes('User chose to stop'))) ||
        task.stopReason === 'user';
      if (isUserCancel) task.stopReason = 'user';
      const status: RoundStatus = signal.aborted || isUserCancel ? 'cancelled' : 'failed';
      const detail = error instanceof Error ? error.message : String(error);
      // Tell the stopped actor's own ledger who stopped it, once, before the round is closed.
      const stopMarker = status === 'cancelled' ? stopNotice(task.stopReason, task.stopDetail, activityId) : undefined;
      if (stopMarker) await this.history.append({version: 1, ...identity, role: 'context', text: stopMarker.text, message: stopMarker}).catch(() => {});
      const summary = await finish(status);
      task.outcome = {status, title: summary?.title ?? '', text: (delivery?.text ?? summary?.report ?? detail).slice(0, 2000)};
      try {await checkpoint(status, signal.aborted || isUserCancel ? undefined : detail);}
      catch {this.store.message(this.sessionId, ownerId, 'notice', 'Failed to save final activity state; restart will mark it interrupted and will not run tools automatically', {activityId});}
      if (summary) {
        // On technical termination, hand off a local summary first instead of waiting for the failing model to compact.
        try {
          if (source === 'direct') await this.options.directAnchor?.({...identity, status});
          await this.options.handoff?.({...identity, ...origin, source, summary, ...(delivery ? {delivery} : {}), status, error, ...(task.stopReason ? {stopReason: task.stopReason} : {})});
        } catch {this.store.message(this.sessionId, ownerId, 'notice', 'Final summary handoff did not finish', {activityId});}
      } else {
        await this.options.handoff?.({...identity, ...origin, source, status, error,
          summary: {title: 'Task incomplete', report: detail.slice(0, 2000), source: 'local'}, ...(task.stopReason ? {stopReason: task.stopReason} : {})});
      }
      await settle(status);
      this.controllers.delete(activityId);
      this.store.activities.update(this.sessionId, activityId, {status, stage: status === 'cancelled' ? 'Interrupted' : 'Failed', detail, ...(summary ? {summary, title: summary.title} : {})});
      if (ownerId !== 'logox' && task.stopReason !== 'director_cancel') {
        const member = this.options.member ? this.options.member(ownerId) : Object.hasOwn(cast, ownerId) ? cast[ownerId as ActorId] : undefined;
        const roleName = member?.name ?? ownerId;
        const noticeText = status === 'cancelled'
          ? `[Notice] ${roleName} (${ownerId}) activity ${activityId} was cancelled (${task.stopReason ?? 'user'}).`
          : `[Notice] ${roleName} (${ownerId}) activity ${activityId} failed: ${detail.slice(0, 300)}.`;
        this.store.message(this.sessionId, 'logox', 'notice', noticeText, {
          activityId,
          source: ownerId,
          inputKind: 'human',
        });
      }
    } finally {
      killBackgroundJobs(activityId);
      this.store.interactions.cancelActivity(this.sessionId, activityId);
      this.controllers.delete(activityId);
    }
  }
}

/** Built-in demo and existing assemblies keep the four-role type. Dynamic catalog assembly uses DynamicEnsemble. */
export class Ensemble extends EnsembleRuntime<ActorId> {}
export class DynamicEnsemble extends EnsembleRuntime<string> {}
