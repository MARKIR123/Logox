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

/** Main-loop continuation gate, pending handoff reports, and cross-executor failure budget; closing and restarting never re-dispatch work. */
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
    if (saved && saved.sessionId !== this.state.sessionId) throw new Error('Actor coordination state session identity mismatch');
    if (saved) this.state = saved;
    if (saved) {
      const before = JSON.stringify(this.state);
      if (validActivities) {
        this.state.roots = Object.fromEntries(Object.entries(this.state.roots).filter(([root]) => validActivities.has(root)));
        this.state.execution = Object.fromEntries(Object.entries(this.state.execution).filter(([root]) => validActivities.has(root)));
        this.state.pending = this.state.pending.filter(result => validActivities.has(result.rootActivityId));
        this.state.assigned = this.state.assigned.filter(result => validActivities.has(result.rootActivityId));
      }
      // Coordination saves may finish before the receiving task's queue checkpoint; restore by the original result's root identity so it is not lost when the receiver has no record.
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
    return reports.length ? 'Pending results from earlier actor tasks (new user instructions take priority):\n' + reports.join('\n\n') : '';
  }
  async next(root: string, error: unknown, inherited?: TaskOrigin['recovery']): Promise<NonNullable<TaskOrigin['recovery']>> {
    const key = faultKey(error);
    const counts = this.state.roots[root] ?? {};
    // Providers are normalized by category/diagnostic code; the same failure does not reset on a new executor, and distinct failures count independently.
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
    // After real progress, clear earlier resolved transient network failure counts so past flakiness cannot permanently block later normal requests
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
