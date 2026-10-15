import {z} from 'zod';
import {StateFile} from '../config/model-preferences.js';
import {ProviderError} from '../providers/http.js';
import type {TaskOrigin} from './ensemble.js';
import type {RoundStatus} from '../context/contracts.js';
import type {ExecutionRecoveryDecision, ExecutionRecoveryKind} from '../kernel/execution-recovery.js';

const reportSchema = z.strictObject({rootActivityId: z.string(), report: z.string().max(12000)});
const budgetSchema = z.strictObject({used: z.number().int().min(0).max(2), total: z.number().int().nonnegative()});
const executionSchema = z.strictObject({noDelivery: budgetSchema, truncation: budgetSchema, truncationReviewed: z.boolean(),
  signatures: z.array(z.string()), history: z.array(z.strictObject({event: z.enum(['retry', 'director', 'progress', 'grant']),
    kind: z.string(), total: z.number().int().nonnegative()})).max(128)});
const stateSchema = z.strictObject({version: z.literal(1), sessionId: z.string(), stopped: z.boolean(),
  roots: z.record(z.string(), z.record(z.string(), z.number().int().min(0).max(2))),
  execution: z.record(z.string(), executionSchema).default({}),
  pending: z.array(reportSchema).max(128),
  assigned: z.array(reportSchema.extend({activityId: z.string()})).max(128).default([])});
type RecoveryState = z.infer<typeof stateSchema>;

/** 主循环接续门、待交接报告与跨执行者的故障预算；关闭和重启不会重新派工。 */
export class ActorRecovery {
  private state: RecoveryState;
  private readonly file: StateFile<RecoveryState> | undefined;
  private saving = Promise.resolve();
  constructor(sessionId: string, path?: string) {
    this.state = {version: 1, sessionId, stopped: false, roots: {}, execution: {}, pending: [], assigned: []};
    this.file = path ? new StateFile(path, stateSchema) : undefined;
  }
  async recover(validActivities?: ReadonlySet<string>): Promise<void> {
    const saved = await this.file?.read();
    if (saved && saved.sessionId !== this.state.sessionId) throw new Error('角色协调状态的会话身份不一致');
    if (saved) this.state = saved;
    if (saved) {
      const before = JSON.stringify(this.state);
      if (validActivities) {
        this.state.roots = Object.fromEntries(Object.entries(this.state.roots).filter(([root]) => validActivities.has(root)));
        this.state.execution = Object.fromEntries(Object.entries(this.state.execution).filter(([root]) => validActivities.has(root)));
        this.state.pending = this.state.pending.filter(result => validActivities.has(result.rootActivityId));
        this.state.assigned = this.state.assigned.filter(result => validActivities.has(result.rootActivityId));
      }
      // 协调保存可能先于接收任务的排队检查点完成；按原结果的根身份恢复，不能因接收方缺记录而丢失。
      this.state.pending.push(...this.state.assigned.map(({rootActivityId, report}) => ({rootActivityId, report})));
      this.state.pending = this.state.pending.slice(-128); this.state.assigned = [];
      if (JSON.stringify(this.state) !== before) await this.persist();
    }
  }
  stop(): void {this.state.stopped = true; void this.persist().catch(() => {});}
  stopped(): boolean {return this.state.stopped;}
  defer(rootActivityId: string, report: string): void {
    this.state.pending.push({rootActivityId, report: report.slice(0, 12000)});
    this.state.pending = this.state.pending.slice(-128);
    void this.persist().catch(() => {});
  }
  resume(activityId?: string): string {
    if (!activityId) return this.report(this.state.pending);
    const changed = this.state.stopped || this.state.pending.length > 0;
    this.state.assigned.push(...this.state.pending.map(result => ({...result, activityId})));
    this.state.assigned = this.state.assigned.slice(-128); this.state.pending = []; this.state.stopped = false;
    if (changed) void this.persist().catch(() => {});
    return this.report(this.state.assigned.filter(result => result.activityId === activityId));
  }
  canResume(activityId: string, rootActivityId: string): boolean {
    return this.state.assigned.some(result => result.activityId === activityId && result.rootActivityId === rootActivityId);
  }
  async settled(activityId: string, status: RoundStatus): Promise<void> {
    const reports = this.state.assigned.filter(result => result.activityId === activityId);
    if (!reports.length) return;
    this.state.assigned = this.state.assigned.filter(result => result.activityId !== activityId);
    if (status !== 'completed') {
      this.state.pending.push(...reports.map(({rootActivityId, report}) => ({rootActivityId, report})));
      this.state.pending = this.state.pending.slice(-128);
    }
    await this.persist();
  }
  private report(items: readonly {report: string}[]): string {
    const reports = items.map(result => result.report);
    return reports.length ? '此前角色任务的待处理结果（用户新指示优先）：\n' + reports.join('\n\n') : '';
  }
  async next(root: string, error: unknown, inherited?: TaskOrigin['recovery']): Promise<NonNullable<TaskOrigin['recovery']>> {
    const key = faultKey(error);
    const counts = this.state.roots[root] ?? {};
    // 提供商按类别/诊断码归一；相同故障换执行者不重置，不同故障独立计数。
    const fault = error === undefined && inherited ? inherited.key : key;
    const count = counts[fault] ?? (inherited?.key === fault ? inherited.attempt : 0);
    const exhausted = count >= 2;
    counts[fault] = exhausted ? 2 : count + 1; this.state.roots[root] = counts;
    await this.persist();
    return {key: fault, attempt: counts[fault]!, ...(exhausted ? {exhausted: true} : {})};
  }
  async execution(root: string, kind: ExecutionRecoveryKind, ownerId: string): Promise<ExecutionRecoveryDecision> {
    const state = this.executionState(root), budget = kind === 'no_delivery' ? state.noDelivery : state.truncation;
    if (kind === 'no_delivery' && ownerId !== 'logox' && budget.used === 1) return 'handoff';
    if (budget.used >= 2) return kind !== 'no_delivery' && ownerId !== 'logox' ? 'handoff' : 'stop';
    budget.used++; budget.total++;
    this.executionEvent(state, 'retry', kind, budget.total);
    await this.persist();
    return 'retry';
  }
  async directorClaim(root: string, kind: ExecutionRecoveryKind): Promise<TaskOrigin['recovery'] | undefined> {
    const state = this.executionState(root), budget = kind === 'no_delivery' ? state.noDelivery : state.truncation;
    if (kind === 'no_delivery') {
      if (budget.used >= 2) return;
      budget.used++; budget.total++;
      this.executionEvent(state, 'director', kind, budget.total);
    } else {
      if (state.truncationReviewed) return;
      state.truncationReviewed = true;
      this.executionEvent(state, 'director', kind, budget.total);
    }
    await this.persist();
    return {key: 'execution:' + (kind === 'no_delivery' ? kind : 'truncated'), attempt: budget.used};
  }
  async progress(root: string, fingerprint: string): Promise<boolean> {
    const state = this.executionState(root);
    if (state.signatures.includes(fingerprint)) return false;
    state.signatures.push(fingerprint);
    state.noDelivery.used = 0;
    state.truncation.used = 0;
    state.truncationReviewed = false;
    // 取得真实进展后，清空此前已解决的瞬态网络故障计数，防止历史抖动永久锁死后续正常请求
    delete this.state.roots[root];
    this.executionEvent(state, 'progress', 'execution', state.noDelivery.total + state.truncation.total);
    await this.persist();
    return true;
  }
  async grantExecution(root: string): Promise<void> {
    const state = this.executionState(root);
    state.noDelivery.used = 0; state.truncation.used = 0; state.truncationReviewed = false;
    this.executionEvent(state, 'grant', 'execution', state.noDelivery.total + state.truncation.total);
    await this.persist();
  }
  hasExecution(root: string): boolean {
    const state = this.state.execution[root];
    return !!state && state.noDelivery.total + state.truncation.total > 0;
  }
  signaturesCount(root: string): number {
    return this.state.execution[root]?.signatures.length ?? 0;
  }
  private executionState(root: string): z.infer<typeof executionSchema> {
    return this.state.execution[root] ??= {noDelivery: {used: 0, total: 0}, truncation: {used: 0, total: 0}, truncationReviewed: false, signatures: [], history: []};
  }
  private executionEvent(state: z.infer<typeof executionSchema>, event: 'retry' | 'director' | 'progress' | 'grant', kind: string, total: number): void {
    state.history.push({event, kind, total}); state.history = state.history.slice(-128);
  }
  async flush(): Promise<void> {await this.saving;}
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const saving = this.saving.catch(() => {}).then(() => this.file?.save(snapshot));
    this.saving = saving;
    return saving;
  }
}

export function modelUnavailable(error: unknown): boolean {
  return error instanceof ProviderError && ['model_missing', 'authentication', 'quota'].includes(error.category);
}
function faultKey(error: unknown): string {
  if (error instanceof ProviderError) return 'provider:' + error.category + ':' + (error.diagnostic?.code ?? error.diagnostic?.issue ?? 'request');
  const name = error instanceof Error ? error.name : 'Error';
  const text = error instanceof Error ? error.message : String(error);
  return (name + ':' + text.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '<id>').replace(/\d+/g, '#')).slice(0, 256);
}
