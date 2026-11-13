import {isDirector} from '../runtime/director-id.js';
import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ActorContext} from './ensemble.js';
import {ProviderRegistry} from '../providers/registry.js';
import {ProviderError} from '../providers/http.js';
import type {ModelCapacity} from '../context/contracts.js';
import type {Provider} from '../runtime/messages.js';

const selectionSchema = z.object({provider: z.string().min(1), model: z.string().min(1)});
export type TaskModelSelection = z.infer<typeof selectionSchema>;
const checkpointSchema = z.strictObject({version: z.literal(1), sessionId: z.string(), ownerId: z.string(), activityId: z.string(),
  initial: selectionSchema, actual: selectionSchema, inherited: z.boolean(), switched: z.boolean(),
  phase: z.enum(['started', 'confirming', 'ready', 'completed', 'failed', 'cancelled']),
  candidate: selectionSchema.optional(), confirmationId: z.string().optional()});
export type TaskModelCheckpoint = z.infer<typeof checkpointSchema>;
type Identity = {sessionId: string; ownerId: string};
const same = (a: TaskModelSelection, b: TaskModelSelection) => a.provider === b.provider && a.model === b.model;

/** Standalone credential-free ledger; the caller supplies the activity set of the currently effective branch; waits are not restored and nothing is replayed automatically. */
export class TaskModelLedger {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private path(sessionId: string): string {return join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.task-models.jsonl');}
  save(checkpoint: TaskModelCheckpoint): Promise<void> {
    const safe = checkpointSchema.parse(checkpoint);
    const pending = this.tail.then(async () => {await mkdir(this.directory, {recursive: true}); await appendFile(this.path(safe.sessionId), JSON.stringify(safe) + '\n', 'utf8');});
    this.tail = pending.catch(() => {});
    return pending;
  }
  async load(sessionId: string, validActivities: ReadonlySet<string>): Promise<readonly TaskModelCheckpoint[]> {
    await this.tail;
    let text: string;
    try {text = await readFile(this.path(sessionId), 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    const latest = new Map<string, TaskModelCheckpoint>();
    for (const line of text.split('\n').slice(0, -1)) {
      const value = checkpointSchema.parse(JSON.parse(line));
      if (value.sessionId !== sessionId) throw new Error('Task model ledger session mismatch');
      if (validActivities.has(value.activityId)) latest.set(value.activityId, value);
    }
    return [...latest.values()];
  }
}
export interface TaskModelsOptions {
  registry: ProviderRegistry;
  defaultModel(ownerId: string): TaskModelSelection | undefined;
  defaultFallbackModel?: TaskModelSelection | (() => TaskModelSelection | undefined);
  ledger?: TaskModelLedger;
  checkpoint?(state: Readonly<TaskModelCheckpoint>): Promise<void>;
  /** Wraps an existing provider (e.g. observation hooks) without separate billing. */
  provider?(selection: Readonly<TaskModelSelection>, provider: Provider): Provider;
  summaryModel?(identity: Identity): TaskModelSelection | undefined;
}
export class TaskModels {
  private readonly current = new Map<string, TaskModelScope>();
  constructor(private readonly options: TaskModelsOptions) {}
  private key(identity: Identity): string {return JSON.stringify([identity.sessionId, identity.ownerId]);}
  async begin(context: ActorContext): Promise<TaskModelScope> {
    const initial = this.idleSelection(context.ownerId);
    const configured = isDirector(context.ownerId) ? undefined : this.configured(context.ownerId);
    const state: TaskModelCheckpoint = {version: 1, sessionId: context.sessionId, ownerId: context.ownerId, activityId: context.activityId,
      initial, actual: initial, inherited: !configured, switched: false, phase: 'started'};
    const scope = new TaskModelScope(this.options, context, state);
    this.current.set(this.key(context), scope);
    await scope.save();
    return scope;
  }
  selection(identity: Identity): TaskModelSelection {
    const scope = this.current.get(this.key(identity));
    if (scope && (!isDirector(identity.ownerId) || !['completed', 'failed', 'cancelled'].includes(scope.snapshot().phase))) return scope.selection();
    return this.idleSelection(identity.ownerId);
  }
  /** The model the owner's next task starts with: its configured default (after the unregistered-provider fallback), else the session model. */
  idleSelection(ownerId: string): TaskModelSelection {
    return selectionSchema.parse(this.configured(ownerId) ?? this.options.registry.selection());
  }
  private configured(ownerId: string): TaskModelSelection | undefined {
    let configured = isDirector(ownerId) ? undefined : this.options.defaultModel(ownerId);
    if (configured && !this.options.registry.names().includes(configured.provider)) {
      const fallback = typeof this.options.defaultFallbackModel === 'function' ? this.options.defaultFallbackModel() : this.options.defaultFallbackModel;
      if (fallback) configured = fallback;
    }
    return configured;
  }
  model(identity: Identity): ModelCapacity {
    const selection = this.selection(identity);
    const scope = this.current.get(this.key(identity));
    return scope && same(scope.selection(), selection) ? scope.model() : this.options.registry.capacity(selection.provider, selection.model);
  }
  thinking(identity: Identity) {
    const scope = this.current.get(this.key(identity));
    const selected = this.selection(identity);
    return scope && same(scope.selection(), selected) && !['completed', 'failed', 'cancelled'].includes(scope.snapshot().phase)
      ? scope.thinking() : this.options.registry.candidate(selected.provider, selected.model).thinking();
  }
  summarizer(identity: Identity): {model: ModelCapacity; provider: Provider} {
    const override = this.options.summaryModel?.(identity);
    const scope = this.current.get(this.key(identity));
    if (!override && scope && (!isDirector(identity.ownerId) || !['completed', 'failed', 'cancelled'].includes(scope.snapshot().phase))) {
      return {model: scope.model(), provider: scope.provider()};
    }
    const selection = override ?? this.selection(identity);
    const registry = this.options.registry.candidate(selection.provider, selection.model);
    return {model: registry.capacity(), provider: this.options.provider?.(selection, registry.provider()) ?? registry.provider()};
  }
  /** Restores display and later summary identity; does not resume interrupted tasks or reuse unconfirmed candidates. */
  restore(states: readonly TaskModelCheckpoint[]): void {
    this.current.clear();
    for (const raw of states) {
      const state = checkpointSchema.parse(raw);
      this.current.set(this.key(state), new TaskModelScope(this.options, undefined, state));
    }
  }
}
export class TaskModelScope {
  private registry: ProviderRegistry;
  constructor(private readonly options: TaskModelsOptions, private readonly context: ActorContext | undefined,
    private readonly state: TaskModelCheckpoint) {
    this.registry = options.registry.candidate(state.actual.provider, state.actual.model);
  }
  selection(): TaskModelSelection {return {...this.state.actual};}
  model(): ModelCapacity {return this.registry.capacity();}
  provider(): Provider {return this.options.provider?.(this.selection(), this.registry.provider()) ?? this.registry.provider();}
  snapshot(): TaskModelCheckpoint {return structuredClone(this.state);}
  thinking() {return this.registry.thinking();}
  async save(): Promise<void> {await this.options.ledger?.save(this.snapshot()); await this.options.checkpoint?.(this.snapshot());}
  async finish(phase: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    this.state.phase = phase; delete this.state.candidate; delete this.state.confirmationId; await this.save();
  }
  async fallback(error: unknown): Promise<boolean> {
    const context = this.context;
    if (!context || isDirector(context.ownerId) || this.state.inherited || this.state.switched ||
      !(error instanceof ProviderError) || !['model_missing', 'authentication', 'quota'].includes(error.category)) return false;
    context.signal.throwIfAborted();
    for (;;) {
      const candidate = selectionSchema.parse(this.options.registry.selection());
      if (same(candidate, this.state.actual)) {context.report('Model unavailable', 'The current session model is the same as the failed model; the task ends.'); return false;}
      // Check the window before confirming; with no window, do not guess or send a substitute request.
      const next = this.options.registry.candidate(candidate.provider, candidate.model);
      next.capacity();
      this.state.phase = 'confirming'; this.state.candidate = candidate; this.state.confirmationId = randomUUID(); await this.save();
      const answer = await context.ask({kind: 'question', title: 'Switch model for this task?', questions: [{id: 'task_model', header: 'Task model',
        question: this.state.actual.provider + '/' + this.state.actual.model + ': ' + error.message + '\nSwitch to ' + candidate.provider + '/' + candidate.model + '? Existing tool results are kept; applies to this task only.',
        options: [{id: 'switch', label: 'Switch', description: 'Continue from the next model request.'}, {id: 'stop', label: 'Do not switch', description: 'Keep current progress and end the task.'}]}]});
      context.signal.throwIfAborted();
      if (answer.status !== 'answered' || answer.response.kind !== 'question' || answer.response.answers.task_model?.type !== 'option' ||
        answer.response.answers.task_model.optionId !== 'switch') return false;
      if (!same(candidate, this.options.registry.selection())) {context.report('Candidate model changed', 'Please reconfirm the current session model.'); continue;}
      await next.settings(); context.signal.throwIfAborted();
      if (!same(candidate, this.options.registry.selection())) continue;
      this.registry = next; this.state.actual = candidate; this.state.switched = true; this.state.phase = 'ready';
      delete this.state.candidate; delete this.state.confirmationId;
      await this.save();
      context.report('Task model switched', candidate.provider + '/' + candidate.model);
      return true;
    }
  }
}
