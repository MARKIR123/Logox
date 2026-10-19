import {randomUUID} from 'node:crypto';
import {RuntimeStore} from '../runtime/store.js';
import {immutable, type InteractionInput, type InteractionOutcome, type Step, type TaskProgressSnapshot} from '../runtime/contracts.js';
import {repairToolResults, type ModelMessage} from '../runtime/messages.js';
import type {RoundSummary, RoundStatus} from '../context/contracts.js';
import type {HistoryEntry, HistoryStore, TaskCheckpoint} from '../store/journal.js';
import {inputKind, type InputKind} from '../runtime/provenance.js';
import {UserCancelledError} from '../kernel/agent.js';
import {killActiveProcess, killActivityProcesses} from '../tools/process.js';

export const cast = immutable({
  logox: {symbol: '◈', name: 'Logox', title: '执导者', color: '#d97757'},
  aletheia: {symbol: '◎', name: 'Aletheia', title: '澄明 · 侦察者', color: '#7ee7c4'},
  techne: {symbol: '⊞', name: 'Techne', title: '精工 · 构建匠人', color: '#e5b567'},
  kalon: {symbol: '✧', name: 'Kalon', title: '雅正 · 审美官', color: '#e8a8dc'},
});
export type ActorId = keyof typeof cast;
export type StopReason = 'user' | 'shutdown' | 'interrupted' | 'director_cancel';
export interface TaskOrigin {
  inputKind?: InputKind;
  authorization?: readonly string[];
  parentActivityId?: string;
  rootActivityId?: string;
  batchId?: string;
  resumeTaskId?: string;
  priority?: boolean;
  recovery?: {key: string; attempt: number; exhausted?: boolean; actorTask?: {ownerId: string; activityId: string}};
}
export interface TaskResult<Id extends string = string> extends TaskOrigin {
  sessionId: string; ownerId: Id; activityId: string; source: string;
  summary: RoundSummary; status: RoundStatus; error?: unknown; stopReason?: StopReason;
}
export interface ActorContext<Id extends string = string> extends TaskOrigin {
  readonly progress?: TaskProgressSnapshot;
  saveProgress?(progress: TaskProgressSnapshot): Promise<void>;
  readonly source?: string;
  startTool?(): void;
  wait?(reason: string): () => void;
  drainInbox?(): readonly ModelMessage[];
  readonly sessionId: string;
  readonly activityId: string;
  readonly ownerId: Id;
  readonly history: readonly HistoryEntry[];
  readonly reviewMessages?: () => readonly ModelMessage[];
  readonly signal: AbortSignal;
  report(stage: string, detail: string): void;
  say(text: string): void;
  record(message: ModelMessage, step?: Step): Promise<void>;
  ask(input: Omit<Extract<InteractionInput, {kind: 'question'}>, 'sessionId' | 'activityId' | 'ownerId'>): Promise<InteractionOutcome>;
  permission(input: Omit<Extract<InteractionInput, {kind: 'permission'}>, 'sessionId' | 'activityId' | 'ownerId'>): Promise<boolean>;
}
export type ActorExecutor<Id extends string = ActorId> = (prompt: string, context: ActorContext<Id>) => Promise<void>;
export interface EnsembleOptions<Id extends string = ActorId> {
  concurrency?: 'serial' | 'actor';
  settled?(activityId: string, status: RoundStatus): Promise<void>;
  member?(ownerId: string): {name: string; title: string} | undefined;
  taskEnd?(context: ActorContext<Id>, summary: RoundSummary, status: RoundStatus): Promise<void>;
  directAnchor?(result: {sessionId: string; ownerId: Id; activityId: string; status: RoundStatus}): Promise<void>;
  handoff?(result: TaskResult<Id>): Promise<void>;
}
export interface TaskHandle {readonly activityId: string; readonly done: Promise<void>; cancel(): void}
interface Task<Id extends string> {ownerId: Id; prompt: string}
interface QueuedTask<Id extends string> extends Task<Id> {
  activityId: string; source: string; origin: TaskOrigin; controller: AbortController;
  ready: Promise<void>; resolve(): void; stopReason?: StopReason;
  progress?: TaskProgressSnapshot;
}
export class EnsembleRuntime<Id extends string> {
  private readonly queue: QueuedTask<Id>[] = [];
  private readonly tasks = new Map<string, QueuedTask<Id>>();
  private readonly activeSlots = new Map<Id, Promise<void>>();
  private readonly pausedBatches = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly inboxes = new Map<string, ModelMessage[]>();
  private closed = false;
  constructor(readonly sessionId: string, readonly store: RuntimeStore, private readonly history: HistoryStore,
    private readonly execute: ActorExecutor<NoInfer<Id>>, private readonly options: EnsembleOptions<Id> = {}) {}

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
    if (this.closed) throw new Error('剧团已关闭');
    const member = this.options.member ? this.options.member(ownerId) : Object.hasOwn(cast, ownerId) ? cast[ownerId as ActorId] : undefined;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(ownerId) || !member || !prompt.trim() || !/^(?:direct|[a-z][a-z0-9_-]{0,63})$/.test(source)) throw new Error('角色或任务无效');
    const activityId = randomUUID();
    origin = {...origin, rootActivityId: origin.rootActivityId ?? activityId, inputKind: inputKind({ownerId, source, ...origin})};
    const controller = new AbortController();
    this.controllers.set(activityId, controller);
    this.store.activities.create({
      sessionId: this.sessionId, activityId, ownerId, kind: ownerId === 'logox' ? 'director' : 'actor',
      title: member.name + ' · ' + member.title,
      status: origin.batchId && this.pausedBatches.has(origin.batchId) ? 'paused' : 'queued', stage: '等待登场', detail: prompt,
      ...this.identityOrigin(origin),
    });
    if (!(ownerId === 'logox' && origin.inputKind === 'actor')) this.store.message(this.sessionId, ownerId, 'user', prompt, {activityId, source, inputKind: origin.inputKind ?? 'unknown'});
    let resolve!: () => void;
    const done = new Promise<void>(finish => {resolve = finish;});
    const task: QueuedTask<Id> = {ownerId, prompt, activityId, source, origin, controller, resolve, ready: Promise.resolve()};
    task.ready = this.trackWrite((async () => {
      const progress = origin.resumeTaskId
        ? await this.history.progress?.(this.sessionId, ownerId, origin.resumeTaskId)
        : (origin.parentActivityId ? await this.history.progress?.(this.sessionId, ownerId, origin.parentActivityId) : undefined)
          ?? (ownerId === 'logox' && this.history.activeTasks ? (await this.history.activeTasks(this.sessionId)).findLast((t: TaskCheckpoint) => t.ownerId === 'logox' && t.progress)?.progress : undefined);
      if (progress) {
        task.progress = progress;
        this.store.activities.update(this.sessionId, activityId, {progress});
      }
      await this.checkpoint(task, origin.batchId && this.pausedBatches.has(origin.batchId) ? 'paused' : 'queued');
    })());
    void task.ready.catch(() => {});
    this.tasks.set(activityId, task);
    if (origin.priority) this.queue.unshift(task); else this.queue.push(task);
    queueMicrotask(() => this.pump());
    return {activityId, done, cancel: () => {this.cancel(activityId);}};
  }
  isBusy(): boolean {return [...this.controllers.keys()].some(id => this.store.activities.get(this.sessionId, id)?.status !== 'paused') || this.pendingWrites.size > 0;}

  getActiveTask(ownerId: string): QueuedTask<Id> | undefined {
    return [...this.tasks.values()].find(task =>
      task.ownerId === ownerId && this.store.activities.get(this.sessionId, task.activityId)?.status === 'running'
    );
  }

  async injectTaskMessage(targetOwnerId: string, message: string, source = 'logox', summary?: string, mode: 'interrupt' | 'queue' = 'queue'): Promise<boolean> {
    const active = this.getActiveTask(targetOwnerId);
    if (!active) return false;
    // 1. If interrupt mode, kill active process tree for this activity so blocked tools abort immediately
    if (mode === 'interrupt') {
      killActivityProcesses(active.activityId, `Interrupted by ${source}: ${summary || message.slice(0, 80)}`);
    }
    // 2. Format message
    const label = summary ? `[Message from ${source} · ${summary}]` : `[Message from ${source}]`;
    const fullText = `${label}\n${message}`;
    const modelMsg: ModelMessage = {
      role: 'user',
      text: fullText,
    };
    // 3. Inject into runtime store so TUI renders it live in the active card
    this.store.message(this.sessionId, targetOwnerId as Id, 'user', fullText, {
      activityId: active.activityId,
      source,
      inputKind: mode === 'interrupt' ? 'collaboration_interrupt' : 'collaboration',
    });
    // 4. Append to journal on disk for permanent transcript
    await this.history.append({
      version: 1,
      sessionId: this.sessionId,
      activityId: active.activityId,
      ownerId: targetOwnerId,
      source,
      inputKind: mode === 'interrupt' ? 'collaboration_interrupt' : 'collaboration',
      role: 'user',
      text: fullText,
      message: modelMsg,
      time: Date.now(),
    });
    // 5. Enqueue into active task inbox for agent.ts loop to consume
    const inbox = this.inboxes.get(active.activityId);
    if (inbox) {
      inbox.push(modelMsg);
    }
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
    const killed = toolId ? killActiveProcess(toolId, reason) : killActivityProcesses(active.activityId, reason) > 0;
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
    const cancelled = this.cancel(active.activityId, 'director_cancel');
    return {
      success: cancelled,
      message: cancelled
        ? `Successfully cancelled activity ${active.activityId} for actor '${actorId}': ${reason}`
        : `Activity ${active.activityId} was already finalized.`,
    };
  }
  cancel(activityId: string, reason: StopReason = 'user'): boolean {
    const task = this.tasks.get(activityId);
    if (!task) return false;
    if (['completed', 'failed', 'cancelled'].includes(this.store.activities.get(this.sessionId, activityId)?.status ?? '')) return false;
    task.stopReason = reason;
    this.store.activities.update(this.sessionId, activityId, {stopReason: reason});
    task.controller.abort();
    const index = this.queue.indexOf(task);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.controllers.delete(activityId); this.tasks.delete(activityId);
      this.store.activities.update(this.sessionId, activityId, {status: 'cancelled', stage: '已中断', detail: '排队任务已取消'});
      void this.trackWrite(task.ready.catch(() => {}).then(async () => {
        await this.checkpoint(task, 'cancelled');
        await this.options.handoff?.({sessionId: this.sessionId, ownerId: task.ownerId, activityId, source: task.source,
          ...task.origin, status: 'cancelled', stopReason: reason, summary: {title: '排队任务已取消', report: '任务尚未执行。', source: 'local'}});
        await this.options.settled?.(activityId, 'cancelled');
      })).catch(() => {this.store.message(this.sessionId, task.ownerId, 'notice', '排队取消检查点保存失败；重启不会自动执行此任务', {activityId});});
      task.resolve();
    }
    return true;
  }
  pauseBatch(batchId: string): void {
    this.pausedBatches.add(batchId);
    for (const task of this.queue.filter(task => task.origin.batchId === batchId)) {
      this.store.activities.update(this.sessionId, task.activityId, {status: 'paused', stage: '等待后续指示'});
      task.ready = this.trackWrite(task.ready.then(() => this.checkpoint(task, 'paused')));
      void task.ready.catch(() => {});
    }
  }
  resumeBatch(batchId: string): void {
    this.pausedBatches.delete(batchId);
    for (const task of this.queue.filter(task => task.origin.batchId === batchId)) {
      this.store.activities.update(this.sessionId, task.activityId, {status: 'queued', stage: '等待登场'});
      task.ready = this.trackWrite(task.ready.then(() => this.checkpoint(task, 'queued')));
      void task.ready.catch(() => {});
    }
    this.pump();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const task of [...this.tasks.values()]) this.cancel(task.activityId, 'shutdown');
    await Promise.allSettled([...this.activeSlots.values()]);
    await Promise.allSettled([...this.pendingWrites]);
  }
  private identityOrigin(origin: TaskOrigin) {
    const {parentActivityId, rootActivityId, batchId, resumeTaskId} = origin;
    return {...(parentActivityId ? {parentActivityId} : {}), ...(rootActivityId ? {rootActivityId} : {}), ...(batchId ? {batchId} : {}),
      ...(resumeTaskId ? {resumeTaskId} : {}),
      ...(origin.recovery ? {recovery: {key: origin.recovery.key, attempt: origin.recovery.attempt,
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
      if (this.activeSlots.has(task.ownerId)) continue;
      this.queue.splice(index, 1);
      index--;
      const execution = (async () => {
        try {await task.ready; await this.run(task);}
        catch (error) {
          this.store.activities.update(this.sessionId, task.activityId, {status: 'failed', stage: '检查点保存失败', detail: error instanceof Error ? error.message : String(error)});
          await this.options.handoff?.({sessionId: this.sessionId, ownerId: task.ownerId, activityId: task.activityId, source: task.source,
            ...task.origin, status: 'failed', error, summary: {title: '任务记录失败', report: '尚未执行任务，检查点保存失败。', source: 'local'}});
          await this.options.settled?.(task.activityId, 'failed');
        }
      })().catch(() => {}).finally(() => {
        this.tasks.delete(task.activityId); this.controllers.delete(task.activityId); this.activeSlots.delete(task.ownerId); this.inboxes.delete(task.activityId);
        task.resolve(); this.pump();
      });
      this.activeSlots.set(task.ownerId, execution);
      if (!actorConcurrency) break;
    }
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
    const finish = async (status: 'completed' | 'failed' | 'cancelled') => {
      try {return await this.history.finish?.(this.sessionId, ownerId, activityId, status);}
      catch {this.store.message(this.sessionId, ownerId, 'notice', '轮次摘要未能保存，原始消息保留；后续整理使用本地兜底。', {activityId});}
    };
    const output: string[] = [];
    let recorded = false;
    let context: ActorContext<Id> | undefined;
    const settle = async (status: RoundStatus) => {
      if (!this.options.settled) return;
      try {await this.options.settled(activityId, status);}
      catch {this.store.message(this.sessionId, ownerId, 'notice', '协作收尾检查点保存失败', {activityId});}
    };
    const request = async (input: InteractionInput): Promise<InteractionOutcome> => {
      signal.throwIfAborted();
      update('waiting_input', input.kind === 'permission' ? '等待许可' : '等待回答');
      const waiting = this.store.interactions.open(input, signal);
      try {await checkpoint('waiting_input'); return await waiting.result; }
      finally {
        if (!signal.aborted) update('running', '继续处理');
      }
    };
    this.inboxes.set(activityId, []);
    try {
      signal.throwIfAborted();
      update('running', '已登场');
      await checkpoint('running');
      const entries = immutable([...await this.history.load(this.sessionId, ownerId)]);
      signal.throwIfAborted();
      for (const message of repairToolResults(entries.flatMap(entry => entry.message ? [entry.message] : []))) {
        await this.history.append({version: 1, ...identity, role: 'tool', text: message.text, message});
      }
      await this.history.append({version: 1, ...identity, source, inputKind: origin.inputKind ?? 'unknown', role: 'user', text: prompt, message: {role: 'user', text: prompt}});
      signal.throwIfAborted();
      context = {
        ...identity, ...origin, source, history: entries, signal,
        drainInbox: () => {
          const queue = this.inboxes.get(activityId);
          if (!queue || queue.length === 0) return [];
          return queue.splice(0, queue.length);
        },
        ...(task.progress ? {progress: task.progress} : {}),
        saveProgress: async progress => {
          signal.throwIfAborted();
          const status = this.store.activities.get(this.sessionId, activityId)?.status;
          if (!status || ['completed', 'failed', 'cancelled', 'queued', 'paused'].includes(status)) throw new Error('活动未在执行，不能更新阶段');
          await this.history.checkpoint?.(this.sessionId, {activityId, ownerId, prompt, source, ...this.identityOrigin(origin),
            ...(task.stopReason ? {stopReason: task.stopReason} : {}), status, time: Date.now(), progress});
          task.progress = progress;
          signal.throwIfAborted();
        },
        authorization: [...origin.authorization ?? [], ...entries.filter(entry => entry.role === 'user' && inputKind(entry) === 'human').map(entry => entry.text),
          ...(origin.inputKind === 'human' ? [prompt] : [])].slice(-8),
        record: async (message, step) => {
          await this.history.append({version: 1, ...identity, role: message.role, text: message.text, message, ...(step ? {step} : {})});
          recorded = true;
        },
        report: (stage, detail) => { signal.throwIfAborted(); update('running', stage, detail); },
        say: text => { signal.throwIfAborted(); output.push(text); this.store.message(this.sessionId, ownerId, 'assistant', text, {activityId}); },
        ask: input => request({...identity, ...input}),
        permission: async input => {
          const result = await request({...identity, ...input});
          signal.throwIfAborted();
          return result.status === 'answered' && result.response.kind === 'permission' && result.response.decision === 'allow_once';
        },
      };
      await this.execute(prompt, context);
      signal.throwIfAborted();
      if (output.length && !recorded) await this.history.append({version: 1, ...identity, role: 'assistant', text: output.join('\n')});
      signal.throwIfAborted();
      const summary = await finish('completed');
      if (summary) {
        this.store.activities.update(this.sessionId, activityId, {phase: 'finalizing', stage: '收尾中', detail: summary.report});
        try {await this.options.taskEnd?.(context, summary, 'completed');}
        catch {this.store.message(this.sessionId, ownerId, 'notice', '任务已完成，收尾整理未完成；原始账本保留。', {activityId});}
        try {
          if (source === 'direct') await this.options.directAnchor?.({...identity, status: 'completed'});
          else await this.options.handoff?.({...identity, ...origin, source, summary, status: 'completed'});
        }
        catch {this.store.message(this.sessionId, ownerId, 'notice', '摘要交接未完成；可从角色账本读取。', {activityId});}
      }
      await checkpoint('completed');
      await settle('completed');
      this.controllers.delete(activityId);
      this.store.activities.update(this.sessionId, activityId, {status: 'completed', stage: '已完成', ...(summary ? {summary, title: summary.title, detail: summary.report} : {})});
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
        (error instanceof Error && (error.name === 'UserCancelledError' || error.message.includes('用户选择停止'))) ||
        task.stopReason === 'user';
      if (isUserCancel) task.stopReason = 'user';
      const status: RoundStatus = signal.aborted || isUserCancel ? 'cancelled' : 'failed';
      const detail = error instanceof Error ? error.message : String(error);
      const summary = await finish(status);
      try {await checkpoint(status, signal.aborted || isUserCancel ? undefined : detail);}
      catch {this.store.message(this.sessionId, ownerId, 'notice', '活动终态保存失败；重启将标记中断，不会自动执行工具', {activityId});}
      if (summary) {
        // 技术终止先交接本地摘要，不再等待出错模型做收尾压缩。
        try {
          if (source === 'direct') await this.options.directAnchor?.({...identity, status});
          await this.options.handoff?.({...identity, ...origin, source, summary, status, error, ...(task.stopReason ? {stopReason: task.stopReason} : {})});
        } catch {this.store.message(this.sessionId, ownerId, 'notice', '终态摘要交接未完成', {activityId});}
      } else {
        await this.options.handoff?.({...identity, ...origin, source, status, error,
          summary: {title: '任务未完成', report: detail.slice(0, 2000), source: 'local'}, ...(task.stopReason ? {stopReason: task.stopReason} : {})});
      }
      await settle(status);
      this.controllers.delete(activityId);
      this.store.activities.update(this.sessionId, activityId, {status, stage: status === 'cancelled' ? '已中断' : '执行失败', detail, ...(summary ? {summary, title: summary.title} : {})});
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
      this.store.interactions.cancelActivity(this.sessionId, activityId);
      this.controllers.delete(activityId);
    }
  }
}

/** 内置 demo / 既有装配保留四角色类型。动态目录装配使用 DynamicEnsemble。 */
export class Ensemble extends EnsembleRuntime<ActorId> {}
export class DynamicEnsemble extends EnsembleRuntime<string> {}
