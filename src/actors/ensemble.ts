import {randomUUID} from 'node:crypto';
import {RuntimeStore} from '../runtime/store.js';
import {immutable, type InteractionInput, type InteractionOutcome} from '../runtime/contracts.js';
import {repairToolResults, type ModelMessage} from '../runtime/messages.js';
import type {HistoryEntry, HistoryStore} from '../store/journal.js';

export const cast = immutable({
  logox: {symbol: '◈', name: 'Logox', title: '执导者', color: '#9ec488'},
  aletheia: {symbol: '◇', name: 'Aletheia', title: '澄明 · 侦察者', color: '#a8f0d4'},
  techne: {symbol: '⊞', name: 'Techne', title: '精工 · 构建匠人', color: '#a8d8ff'},
  kalon: {symbol: '✧', name: 'Kalon', title: '雅正 · 审美官', color: '#f4b8e8'},
});
export type ActorId = keyof typeof cast;
export interface ActorContext {
  readonly sessionId: string;
  readonly activityId: string;
  readonly ownerId: ActorId;
  readonly history: readonly HistoryEntry[];
  readonly signal: AbortSignal;
  report(stage: string, detail: string): void;
  say(text: string): void;
  record(message: ModelMessage): Promise<void>;
  ask(input: Omit<Extract<InteractionInput, {kind: 'question'}>, 'sessionId' | 'activityId' | 'ownerId'>): Promise<InteractionOutcome>;
  permission(input: Omit<Extract<InteractionInput, {kind: 'permission'}>, 'sessionId' | 'activityId' | 'ownerId'>): Promise<boolean>;
}
export type ActorExecutor = (prompt: string, context: ActorContext) => Promise<void>;
export interface TaskHandle {readonly activityId: string; readonly done: Promise<void>; cancel(): void}
interface Task {ownerId: ActorId; prompt: string}
export class Ensemble {
  private tail: Promise<void> = Promise.resolve();
  private readonly controllers = new Map<string, AbortController>();
  private closed = false;
  constructor(readonly sessionId: string, readonly store: RuntimeStore, private readonly history: HistoryStore,
    private readonly execute: ActorExecutor) {}

  dispatchBatch(tasks: readonly Task[]): readonly TaskHandle[] {
    const grouped = new Map<ActorId, string[]>();
    for (const task of tasks) {
      const prompts = grouped.get(task.ownerId) ?? [];
      prompts.push(task.prompt);
      grouped.set(task.ownerId, prompts);
    }
    return [...grouped].map(([ownerId, prompts]) => this.dispatch(ownerId, prompts.join('\n\n')));
  }

  dispatch(ownerId: ActorId, prompt: string, source: ActorId = 'logox'): TaskHandle {
    if (this.closed) throw new Error('剧团已关闭');
    if (!Object.hasOwn(cast, ownerId) || !prompt.trim()) throw new Error('角色或任务无效');
    const activityId = randomUUID();
    const controller = new AbortController();
    this.controllers.set(activityId, controller);
    this.store.activities.create({
      sessionId: this.sessionId, activityId, ownerId, kind: ownerId === 'logox' ? 'director' : 'actor',
      title: cast[ownerId].name + ' · ' + cast[ownerId].title,
      status: 'queued', stage: '等待登场', detail: prompt,
    });
    this.store.message(this.sessionId, ownerId, 'user', prompt, {activityId, source});
    let finishCancelled!: () => void;
    const cancelled = new Promise<void>(resolve => {finishCancelled = resolve;});
    const cancelQueued = () => {
      if (this.store.activities.get(this.sessionId, activityId)?.status !== 'queued') return;
      this.store.activities.update(this.sessionId, activityId, {status: 'cancelled', stage: '已中断', detail: '排队任务已取消'});
      this.controllers.delete(activityId);
      finishCancelled();
    };
    controller.signal.addEventListener('abort', cancelQueued, {once: true});
    const execution = this.tail.then(() => this.run(ownerId, prompt, activityId, controller, source))
      .finally(() => controller.signal.removeEventListener('abort', cancelQueued));
    this.tail = execution.catch(() => {});
    const done = Promise.race([execution, cancelled]);
    return {activityId, done, cancel: () => controller.abort()};
  }
  isBusy(): boolean { return this.controllers.size > 0; }
  cancel(activityId: string): boolean {
    const controller = this.controllers.get(activityId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.tail;
  }
  private async run(ownerId: ActorId, prompt: string, activityId: string, controller: AbortController, source: ActorId): Promise<void> {
    if (this.store.activities.get(this.sessionId, activityId)?.status === 'cancelled') return;
    const signal = controller.signal;
    const update = (status: 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled', stage: string, detail = '') =>
      this.store.activities.update(this.sessionId, activityId, {status, stage, detail});
    const identity = {sessionId: this.sessionId, activityId, ownerId};
    const finish = async (status: 'completed' | 'failed' | 'cancelled') => {
      try {await this.history.finish?.(this.sessionId, ownerId, activityId, status);}
      catch {this.store.message(this.sessionId, ownerId, 'notice', '轮次摘要未能保存，原始消息保留；后续整理使用本地兜底。', {activityId});}
    };
    const output: string[] = [];
    let recorded = false;
    const request = async (input: InteractionInput): Promise<InteractionOutcome> => {
      signal.throwIfAborted();
      update('waiting_input', input.kind === 'permission' ? '等待许可' : '等待回答');
      try { return await this.store.interactions.open(input, signal).result; }
      finally {
        if (!signal.aborted) update('running', '继续处理');
      }
    };
    try {
      signal.throwIfAborted();
      update('running', '已登场');
      const entries = immutable([...await this.history.load(this.sessionId, ownerId)]);
      signal.throwIfAborted();
      for (const message of repairToolResults(entries.flatMap(entry => entry.message ? [entry.message] : []))) {
        await this.history.append({version: 1, ...identity, role: 'tool', text: message.text, message});
      }
      await this.history.append({version: 1, ...identity, source, role: 'user', text: prompt, message: {role: 'user', text: prompt}});
      signal.throwIfAborted();
      await this.execute(prompt, {
        ...identity, history: entries, signal,
        record: async message => {
          await this.history.append({version: 1, ...identity, role: message.role, text: message.text, message});
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
      });
      signal.throwIfAborted();
      if (output.length && !recorded) await this.history.append({version: 1, ...identity, role: 'assistant', text: output.join('\n')});
      signal.throwIfAborted();
      await finish('completed');
      signal.throwIfAborted();
      update('completed', '已完成');
    } catch (error) {
      await finish(signal.aborted ? 'cancelled' : 'failed');
      update(signal.aborted ? 'cancelled' : 'failed', signal.aborted ? '已中断' : '执行失败',
        error instanceof Error ? error.message : String(error));
    } finally {
      this.store.interactions.cancelActivity(this.sessionId, activityId);
      this.controllers.delete(activityId);
    }
  }
}
