import {z} from 'zod';
import {stripNarration} from '../runtime/narration.js';
import {randomUUID} from 'node:crypto';
import type {ActorContext, TaskHandle, TaskOrigin, TaskResult} from './ensemble.js';
import {ActorRecovery, modelUnavailable} from './recovery.js';
import {formatFailureDetail, isProviderOutage, ProviderError} from '../providers/http.js';
import {OutageBackoff} from './outage.js';
import type {ActorCatalog} from './catalog.js';
import {ActorManagement} from './management.js';
import type {ActorDefinition} from './definitions.js';
import {builtinActors} from './builtins.js';
import {Collaboration} from './collaboration.js';
import type {Resources} from '../resources/manager.js';
import type {Journal} from '../store/journal.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ToolCall, ToolDefinition} from '../runtime/messages.js';
import {defaultToolRegistry, type ToolRegistry} from '../tools/registry.js';
import {builtinToolRegistrations} from '../tools/catalog.js';
import type {ToolResult} from '../tools/tools.js';
import {contextPolicySchema, type Config} from '../config/config.js';
import type {RoundStatus} from '../context/contracts.js';
import {ExecutionRecoveryError} from '../kernel/execution-recovery.js';
import {
  actorSchema,
  ACTOR_DESCRIPTION,
  craftActorSchema,
  CRAFT_ACTOR_DESCRIPTION,
  readActorSchema,
  READ_ACTOR_DESCRIPTION,
  listActorsSchema,
  LIST_ACTORS_DESCRIPTION,
  executeListActors,
  cancelActorSchema,
  CANCEL_ACTOR_DESCRIPTION,
  executeCancelActor,
  canonicalToolName,
} from '../tools/index.js';
import {renderBrief} from '../tools/orchestration/ActorTool/brief.js';
import type {ListActorsMemo} from '../tools/coordination/ListActorsTool/ListActorsTool.js';
import type {RuntimeSnapshot} from '../runtime/contracts.js';
import {DeliveryQueue} from './delivery-queue.js';
import {activeEnsembleRoster, directorFacts, hasOpenWork, openWork} from './facts.js';
import {DIRECTOR_FACTS_HEADER, DIRECTOR_COORDINATION_WAKE, DIRECTOR_FAILURE,
  DIRECTOR_RECOVERY_EXHAUSTED, DIRECTOR_RECOVERY_LIFTED, DIRECTOR_EXECUTION_REVIEW, DIRECTOR_STREAM_REVIEW, DIRECTOR_USER_STOP,
  DIRECTOR_PAUSED_BATCH, DIRECTOR_PAUSED_BATCH_RULE, directorResumeAdvice, pausedBatchesHint, automatedEvent} from '../prompts/runtime/director.js';
import {dispatchedResult, endedBatchResult, resumedBatchResult} from '../tools/orchestration/ActorTool/prompt.js';
import {checkpointOrigin, restartStopped} from './restart.js';
import type {TaskCheckpoint} from '../store/journal.js';
import {deliveryPriority, deliverySchema, type Delivery} from '../runtime/delivery.js';
import {inputKind} from '../runtime/provenance.js';

/** Orders per-owner groups so an owner dispatched `after` another owner of the same call comes later; rejects cycles. */
function orderByDependency<T extends {after: ReadonlySet<string>}>(grouped: ReadonlyMap<string, T>): [string, T][] {
  const ordered: [string, T][] = [], visiting = new Set<string>(), done = new Set<string>();
  const visit = (owner: string) => {
    if (done.has(owner)) return;
    if (visiting.has(owner)) throw new Error('Circular `after` dependency involving ' + owner);
    visiting.add(owner);
    for (const ref of grouped.get(owner)!.after) if (grouped.has(ref)) visit(ref);
    visiting.delete(owner); done.add(owner); ordered.push([owner, grouped.get(owner)!]);
  };
  for (const owner of grouped.keys()) visit(owner);
  return ordered;
}
const serviceTools = new Set(['Actor', 'CancelActor', 'ListActors', 'CraftActor', 'ReadActor', 'SendMessage']);

export interface ActorServicesOptions {
  toolRegistry?: ToolRegistry;
  sessionId: string; catalog: ActorCatalog; registry: ProviderRegistry; resources: Resources; journal: Journal; config: Config;
  deliveries?: DeliveryQueue;
  enqueue(owner: string, prompt: string, source: string, origin?: TaskOrigin): TaskHandle;
  getActiveTask?(ownerId: string): { activityId: string } | undefined;
  canReceiveMessage?(ownerId: string): boolean;
  injectMessage?(targetOwnerId: string, message: string, source: string, summary?: string, mode?: 'interrupt' | 'queue'): Promise<boolean> | boolean;
  interrupt?(targetOwnerId: string, message: string, source: string, summary?: string): boolean;
  recordPeerMessage?(targetOwnerId: string, activityId: string, text: string, source: string): void;
  pauseBatch?(batchId: string): void;
  resumeBatch?(batchId: string): void;
  cancelActivity?(activityId: string, reason?: string): boolean;
  cancelTool?(actorId: string, toolId?: string, reason?: string): {success: boolean; message: string};
  cancelActor?(actorId: string, scope: 'tool' | 'activity', toolId?: string, reason?: string): {success: boolean; message: string};
  getSnapshot?(): RuntimeSnapshot;
  projectDir?: string;
  coordinationPath?: string;
  approve(context: ActorContext, review: {path: string; content: string; previous: string | undefined}): Promise<boolean>;
  requireIdle(): void;
  authorize?(call: ToolCall, context: ActorContext): Promise<boolean>;
  modelResolver?: (actorId: string) => {provider: string; model: string; effort?: string; levels?: readonly string[]} | undefined;
  modelPool?: ModelPool;
  notice?(text: string): void;
  /** One line per outage backoff step; `first` is true for the first step of an outage (shown in the timeline, later steps only flash). */
  outageNotice?(text: string, first: boolean): void;
  /** Test hook: replaces the 30 s, 2 min, 5 min wake delays used while a provider is down. */
  outageDelaysMs?: readonly number[];
}
/** Actor configuration, one-off skill borrowing, and summary handoff; the execution queue is still owned by the Ensemble. */
export class ActorServices {
  readonly management: ActorManagement;
  readonly collaboration: Collaboration;
  readonly recovery: ActorRecovery;
  readonly deliveries: DeliveryQueue;
  private readonly backoff: OutageBackoff;
  private readonly definitions = new Map<string, ActorDefinition>();
  private readonly active = new Map<string, ActorDefinition>();
  private readonly depths = new Map<string, number>();
  private readonly origins = new Map<string, TaskOrigin>();
  private readonly stoppedActors = new Set<string>();
  /** Activities that called `settled`; their status may still read non-terminal for a moment. */
  private readonly ended = new Set<string>();
  private releasing: Promise<void> = Promise.resolve();
  private readonly pendingHandoffs = new Map<string, Delivery>();
  /** Per-caller ListActors fingerprints, owned by this ensemble so no-change replies never depend on function identity. */
  private readonly listActorsMemo: ListActorsMemo = {fingerprints: new Map()};
  private wakeTask: TaskHandle | undefined;
  private releaseTask: Promise<void> = Promise.resolve();
  private readonly continuedTasks = new Set<string>();
  private readonly resumableBatches = new Set<string>();
  /** Activities a restart interrupted that the Director may resume from a later root, and the interrupted blockers each restored batch still waits for. */
  private readonly restartInterrupted = new Set<string>();
  private readonly restartBlockers = new Map<string, Set<string>>();
  private readonly dispatchSignatures = new Map<string, number>();
  private readonly groups = new Map<string, {remaining: Set<string>; depth: number; batchId: string; origin: TaskOrigin; paused: boolean}>();
  constructor(readonly options: ActorServicesOptions) {
    this.deliveries = options.deliveries ?? new DeliveryQueue(options.sessionId, options.journal);
    this.management = new ActorManagement(options.catalog, options.registry, options.requireIdle, owner => this.policy(owner), options.modelResolver, options.modelPool);
    this.collaboration = new Collaboration({
      ...options,
      member: owner => !!options.catalog.find(owner),
      members: () => options.catalog.list().map(a => a.id),
      coordinate: async (callId, message, summary, context) => {
        const root = context.rootActivityId ?? context.activityId;
        await this.deliveries.enqueue({id: 'help:' + context.activityId + ':' + callId, ownerId: 'logox', source: context.ownerId,
          sourceActivityId: context.activityId, rootActivityId: root, kind: 'help', inputKind: 'collaboration',
          text: (summary ? summary + '\n' : '') + message, origin: {rootActivityId: root, parentActivityId: context.activityId,
            authorization: [...context.authorization ?? []], ...(context.recovery ? {recovery: context.recovery} : {})}});
        this.wakeDirector();
      },
      getActiveTask: options.getActiveTask ? (owner) => options.getActiveTask!(owner) : undefined,
      injectMessage: options.injectMessage ? (target, msg, src, sum, mode) => options.injectMessage!(target, msg, src, sum, mode) : undefined,
      interrupt: (target, message, source, summary) => {
        return options.interrupt ? options.interrupt(target, message, source, summary) : false;
      },
      deliverToCompletedPeer: async (target, message, source, summary, context) => {
        const snapshot = options.getSnapshot?.();
        if (!snapshot) return false;
        const root = context.rootActivityId ?? context.activityId;
        const completedPeer = [...snapshot.activities].reverse().find(activity =>
          activity.ownerId === target &&
          activity.status === 'completed' &&
          (activity.rootActivityId === root || activity.parentActivityId === root)
        );
        if (!completedPeer) return false;
        const fullText = `[Message from ${source}${summary ? ' · ' + summary : ''}]\n${message}`;
        await options.journal.append({
          version: 1, sessionId: options.sessionId, activityId: completedPeer.activityId,
          ownerId: target, source, inputKind: 'collaboration', role: 'user',
          text: fullText, message: {role: 'user', text: fullText}, time: Date.now(),
        });
        options.recordPeerMessage?.(target, completedPeer.activityId, fullText, source);
        return true;
      },
      hasOnStageActivity: (target, context) => {
        const snapshot = options.getSnapshot?.();
        if (!snapshot) return false;
        const root = context.rootActivityId ?? context.activityId;
        return snapshot.activities.some(activity =>
          activity.sessionId === options.sessionId &&
          activity.ownerId === target &&
          (activity.rootActivityId === root || activity.parentActivityId === root || activity.activityId === root)
        );
      },
      projectDir: options.projectDir,
    });
    this.recovery = new ActorRecovery(options.sessionId, options.coordinationPath);
    this.backoff = new OutageBackoff(() => {
      const wake = () => {try {this.wakeDirector();} catch {options.notice?.('Coordination wake-up failed; pending reports remain saved.');}};
      // A wake-up that is still winding down must finish first, or its late bookkeeping would swallow this one.
      if (this.wakeTask) void this.wakeTask.done.then(wake, wake); else wake();
    }, (text, first) => options.outageNotice?.(text, first), options.outageDelaysMs);
  }
  definition(context: ActorContext): ActorDefinition {
    this.origins.set(context.activityId, context);
    if (context.dispatchDepth !== undefined) this.depths.set(context.activityId, context.dispatchDepth);
    let definition = this.definitions.get(context.activityId);
    if (!definition) {
      definition = this.options.catalog.find(context.ownerId);
      if (!definition) throw new Error('Actor is no longer available: ' + context.ownerId);
      this.definitions.set(context.activityId, definition); this.active.set(context.ownerId, definition);
    }
    return definition;
  }
  facts(context: Pick<ActorContext, 'ownerId' | 'activityId' | 'rootActivityId'>): string {
    const snapshot = this.options.getSnapshot?.();
    if (!snapshot) return '';
    if (context.ownerId !== 'logox') return activeEnsembleRoster(snapshot, context);
    const facts = directorFacts(snapshot, context, this.deliveries.snapshot());
    return facts ? DIRECTOR_FACTS_HEADER + '\n' + JSON.stringify(facts) : '';
  }
  policy(ownerId: string) {
    const role = this.active.get(ownerId) ?? this.options.catalog.find(ownerId);
    if (ownerId === 'logox' && role?.id === 'logox') return this.options.config.context;
    return contextPolicySchema.parse({...this.options.config.context, ...role?.context});
  }
  contract(ownerId: string): string | undefined {return (this.active.get(ownerId) ?? this.options.catalog.find(ownerId))?.compression;}
  skills(context: ActorContext) {return {actorId: context.ownerId, skills: this.definition(context).skills};}
  tools(ownerId: string): readonly ToolDefinition[] {
    return (this.options.toolRegistry ?? defaultToolRegistry).getToolsForActor(ownerId).filter(tool => serviceTools.has(tool.name));
  }
  definitionsForValidation(): readonly ToolDefinition[] {
    return builtinToolRegistrations().filter(item => serviceTools.has(item.definition.name)).map(item => item.definition);
  }
  async execute(call: ToolCall, context: ActorContext): Promise<ToolResult> {
    try {
      const canonical = canonicalToolName(call.name) ?? call.name;
      const matchedTool = this.tools(context.ownerId).find(tool =>
        tool.name.toLowerCase() === call.name.toLowerCase() ||
        canonicalToolName(tool.name) === canonical
      );
      if (!matchedTool) throw new Error('Actor is not allowed to run this tool');
      const input: unknown = JSON.parse(call.arguments);
      z.fromJSONSchema(matchedTool.parameters).parse(input);
      if (canonical !== 'CraftActor' && this.options.authorize && !await this.options.authorize(call, context)) return {text: 'Actor action was not permitted; find another approach.', isError: true, disposition: 'denied'};
      if (canonical !== 'CraftActor') context.startTool?.();
      if (canonical === 'Actor') {
        if (context.recovery?.exhausted) throw new Error('The same failure has been remediated twice; the user must decide the next step and work cannot be auto-dispatched further');
        let parsedInput: z.infer<typeof actorSchema>;
        if (input && typeof input === 'object' && 'actor' in input && typeof (input as {actor: unknown}).actor === 'string') {
          const single = input as {actor: string; prompt: string; title?: string; description?: string; goal?: string};
          parsedInput = {tasks: [{ownerId: single.actor, prompt: single.prompt, title: single.title ?? single.description ?? single.goal}]};
        } else {
          parsedInput = actorSchema.parse(input);
        }
        const {tasks, resumeBatch} = parsedInput;
        const saved = tasks.some(task => task.resumeTask) ? await this.options.journal.activeTasks(context.sessionId) : [];
        const resumed = new Set<string>(), roots = new Set<string>();
        for (const task of tasks) {
          const explicitTitle = (task.title ?? task.description ?? task.goal)?.replace(/\s+/g, ' ').trim().slice(0, 120);
          if (explicitTitle) task.title = explicitTitle;
          if (task.ownerId === 'logox' || !this.options.catalog.find(task.ownerId)) throw new Error('Invalid actor: ' + task.ownerId);
          if (task.resumeTask) {
            const previous = saved.find(previous => previous.activityId === task.resumeTask);
            if (!previous) throw new Error('Resume activity does not exist or is not in the current session effective history: ' + task.resumeTask);
            if (previous.ownerId !== task.ownerId) throw new Error('Resume actor mismatch: the original activity belongs to ' + previous.ownerId);
            if (previous.stopReason === 'user') throw new Error('This activity was stopped by the user and cannot be resumed automatically');
            if (previous.status !== 'failed' && !restartStopped(previous)) throw new Error('Only failed or restart-interrupted activities can be resumed; current status: ' + previous.status);
            const root = previous.rootActivityId ?? previous.activityId;
            if (root !== (context.rootActivityId ?? context.activityId) && !this.recovery.canResume(context.activityId, root) && !this.restartInterrupted.has(task.resumeTask) &&
              !this.deliveries.snapshot().some(item => item.ownerId === 'logox' && item.kind === 'failure' && item.sourceActivityId === task.resumeTask) &&
              !this.deliveries.snapshot().some(item => item.recipientActivityId === context.activityId && item.rootActivityId === root)) {
              throw new Error('The resume target was not handed off to the current task; other root goals cannot be resumed');
            }
            if (resumed.has(task.resumeTask) || this.continuedTasks.has(task.resumeTask)) throw new Error('This failed activity is already scheduled to resume and cannot be dispatched again: ' + task.resumeTask);
            roots.add(root);
            resumed.add(task.resumeTask);
            task.prompt = '[Resuming interrupted Actor task]\nOriginal activity: ' + previous.activityId + '\nOriginal goal: ' + previous.prompt +
              '\nContinuation request: ' + task.prompt + '\nFirst check your own history summary and completed tool results, and do only the unfinished part. Keep existing output and do not re-run writes or commands that already succeeded; tool calls that were not fully generated were not executed, and approval denials still stand.';
          }
        }
        if (roots.size > 1) throw new Error('A single dispatch cannot mix resumes of different root goals; schedule them separately');
        const rootActivityId = roots.values().next().value ?? context.rootActivityId ?? context.activityId;
        const recovery = this.deliveries.recoveryFor(context.activityId, rootActivityId,
          rootActivityId === (context.rootActivityId ?? context.activityId) ? context.recovery : undefined);
        if (recovery?.exhausted) throw new Error('Recovery for the target task is exhausted; new human instructions are required.');
        const currentSigs = this.recovery.signaturesCount(rootActivityId);
        const lastSigs = this.dispatchSignatures.get(rootActivityId) ?? 0;
        const hasProgress = currentSigs > lastSigs;
        if (hasProgress) this.dispatchSignatures.set(rootActivityId, currentSigs);
        const receivedDepth = Math.max(0, ...this.deliveries.snapshot().filter(item => item.recipientActivityId === context.activityId && item.rootActivityId === rootActivityId)
          .map(item => item.origin?.dispatchDepth ?? 0));
        const baseDepth = hasProgress ? 0 : Math.max(this.depths.get(context.activityId) ?? 0, receivedDepth);
        if (tasks.some(task => !task.resumeTask) && baseDepth >= 3) {
          throw new Error('Actor dispatch has made no new progress three times; wrap up the task using the existing results');
        }
        const grouped = new Map<string, {prompts: string[]; files: Set<string>; after: Set<string>; resumeTaskId?: string; taskTitle?: string}>();
        for (const task of tasks) {
          const group = grouped.get(task.ownerId) ?? {prompts: [], files: new Set<string>(), after: new Set<string>(), ...(task.resumeTask ? {resumeTaskId: task.resumeTask} : {}), ...(task.title ? {taskTitle: task.title} : {})};
          if (task.resumeTask && group.resumeTaskId && task.resumeTask !== group.resumeTaskId) throw new Error('An actor can resume only one original activity at a time; different checkpoints cannot be merged');
          if (task.resumeTask) group.resumeTaskId = task.resumeTask;
          if (!group.taskTitle && task.title) group.taskTitle = task.title;
          const brief = renderBrief(task);
          group.prompts.push(brief ? task.prompt + '\n\n' + brief : task.prompt);
          for (const file of [...task.owns ?? [], ...task.files ?? []]) group.files.add(file);
          for (const ref of task.after ?? []) group.after.add(ref);
          grouped.set(task.ownerId, group);
        }
        // The batch resumes after the new tasks exist, so a resumed blocker can take over its waiting dependents first.
        let applyBatch: (() => void) | undefined;
        if (resumeBatch) {
          const group = [...this.groups.values()].find(group => group.batchId === resumeBatch);
          const finishedBatch = !group && saved.some(previous => previous.batchId === resumeBatch && resumed.has(previous.activityId)) &&
            !saved.some(previous => previous.batchId === resumeBatch && !['completed', 'failed', 'cancelled'].includes(previous.status));
          if (!finishedBatch && (!group || (group.origin.rootActivityId !== rootActivityId && !this.resumableBatches.has(resumeBatch)))) {
            throw new Error('Cannot resume a batch from another task or a batch that does not exist');
          }
          if (group) applyBatch = () => {this.resumableBatches.delete(resumeBatch); this.restartBlockers.delete(resumeBatch); group.paused = false; this.options.resumeBatch?.(resumeBatch);};
          if (!tasks.length) {applyBatch?.(); return {text: applyBatch ? resumedBatchResult(resumeBatch) : endedBatchResult(resumeBatch), isError: false};}
        }
        const origin: TaskOrigin = {parentActivityId: context.activityId, rootActivityId,
          inputKind: 'director', authorization: context.reviewMessages?.().filter(message => message.role === 'user').map(message => message.text).slice(-8) ?? context.authorization ?? [],
          ...(recovery ? {recovery} : {})};
        const nextDepth = baseDepth + (tasks.every(task => task.resumeTask) ? 0 : 1);
        const group = {remaining: new Set<string>(), depth: nextDepth, batchId: randomUUID(), origin, paused: false};
        const dispatched = new Map<string, string>();
        const handles = orderByDependency(grouped).map(([owner, task]) => {
          const after = this.resolveAfter(owner, task.after, dispatched);
          const childOrigin = {...origin, batchId: group.batchId, ...(task.resumeTaskId ? {resumeTaskId: task.resumeTaskId} : {}), ...(task.taskTitle ? {taskTitle: task.taskTitle} : {}),
            ...(task.files.size ? {ownedFiles: [...task.files]} : {}), ...(after.length ? {after} : {})};
          const handle = this.options.enqueue(owner, task.prompts.join('\n\n'), 'logox', childOrigin);
          this.origins.set(handle.activityId, childOrigin);
          this.depths.set(handle.activityId, nextDepth);
          group.remaining.add(handle.activityId); this.groups.set(handle.activityId, group);
          dispatched.set(owner, handle.activityId);
          return handle;
        });
        applyBatch?.();
        for (const activityId of resumed) {
          this.continuedTasks.add(activityId); this.restartInterrupted.delete(activityId);
          for (const waiting of this.restartBlockers.values()) waiting.delete(activityId);
        }
        const targets = [...new Set(tasks.map(t => t.ownerId))].join(', ');
        return {
          text: dispatchedResult(targets, group.batchId),
          isError: false,
        };
      }
      if (canonical === 'CraftActor') {
        const {content} = craftActorSchema.parse(input);
        const result = await this.management.craftActor(content, async review => {
          const allowed = await this.options.approve(context, review); if (allowed) context.startTool?.(); return allowed;
        }, context.signal);
        return {text: (result.status === 'saved' ? 'Saved and reloaded: ' : 'Denied by user, not written: ') + result.path, isError: result.status === 'denied', ...(result.status === 'denied' ? {disposition: 'denied' as const} : {})};
      }
      if (canonical === 'ReadActor') {
        const {ownerId, activityId} = readActorSchema.parse(input);
        const reported = activityId ? this.deliveries.snapshot().find(item => item.ownerId === 'logox' && item.kind === 'report' && item.sourceActivityId === activityId && item.source === ownerId) : undefined;
        if (reported) return {text: '# Task report: ' + ownerId + ' (' + activityId + ')' + (reported.hold && reported.status === 'pending' ? ' (held, not yet delivered)' : '') + '\n\n' + reported.text, isError: false};
        const entries = await this.options.journal.load(context.sessionId, ownerId);
        const rounds = await this.options.journal.rounds(context.sessionId, ownerId, entries);
        const relevantRounds = rounds.filter(round => !activityId || round.activityId === activityId).slice(-4);
        const relevantEntries = entries.filter(entry => !activityId || entry.activityId === activityId);
        const finalAssistant = relevantEntries.findLast(entry => entry.role === 'assistant' && stripNarration(entry.text).trim());
        const toolsCalled = [...new Set(relevantEntries.flatMap(e => (e.message && e.message.role === 'assistant' ? e.message.toolCalls?.map(c => c.name) ?? [] : [])))];

        const summaryText = relevantRounds.map(r => `[Round ${r.activityId}]: ${r.summary.title}\n${r.summary.report}`).join('\n\n');
        const report = [
          `# Subagent Report: ${ownerId}`,
          summaryText ? summaryText : (finalAssistant?.text ? `Final Output:\n${finalAssistant.text}` : 'No text response recorded.'),
          toolsCalled.length ? `Tools executed: ${toolsCalled.join(', ')}` : '',
        ].filter(Boolean).join('\n\n');

        return {text: report.slice(0, 4000), isError: false};
      }
      if (canonical === 'ListActors') {
        const roles = this.options.catalog.snapshot().definitions.reduce((acc, a) => ({...acc, [a.id]: {name: a.name, title: a.title}}), {});
        return executeListActors({}, {
          caller: context.ownerId,
          getSnapshot: this.options.getSnapshot ?? (() => ({revision: 0, pending: [], activities: [], interactions: [], messages: []})),
          roles,
          memo: this.listActorsMemo,
        });
      }
      if (canonical === 'CancelActor') {
        const cancelArgs = cancelActorSchema.parse(input);
        return executeCancelActor(cancelArgs, {
          caller: context.ownerId,
          cancelTool: (actorId, toolId, reason) => {
            return this.options.cancelTool ? this.options.cancelTool(actorId, toolId, reason) : {success: false, message: 'Tool cancellation not available.'};
          },
          cancelActivity: (actorId, reason) => {
            if (this.options.cancelActor) {
              return this.options.cancelActor(actorId, 'activity', undefined, reason);
            }
            const success = this.options.cancelActivity ? this.options.cancelActivity(actorId, reason) : false;
            return {success, message: success ? `Activity for ${actorId} cancelled.` : `Failed to cancel activity for ${actorId}.`};
          },
        });
      }
      const collab = await this.collaboration.execute(call, context);
      return {text: collab.text, isError: collab.isError, ...(collab.images ? {images: collab.images} : {})};
    } catch (error) {return {text: error instanceof Error ? error.message : 'Actor operation failed', isError: true};}
  }
  /** Resolves `after` references (activity ids or actor ids) to unfinished activity ids; finished or unknown activity ids are dropped, unknown actors are rejected. */
  private resolveAfter(owner: string, refs: ReadonlySet<string>, dispatched: ReadonlyMap<string, string>): string[] {
    const activities = this.options.getSnapshot?.().activities.filter(activity => activity.sessionId === this.options.sessionId) ?? [];
    const open = (status: string) => ['queued', 'running', 'waiting_input', 'paused'].includes(status);
    const ids = new Set<string>();
    for (const ref of refs) {
      if (ref === owner) throw new Error('A task cannot run after itself: ' + ref);
      const sameCall = dispatched.get(ref);
      if (sameCall) {ids.add(sameCall); continue;}
      const byId = activities.find(activity => activity.activityId === ref);
      if (byId) {if (open(byId.status)) ids.add(byId.activityId); continue;}
      if (!this.options.catalog.find(ref)) throw new Error('Unknown `after` reference (not an actor id or activity id): ' + ref);
      const latest = activities.filter(activity => activity.ownerId === ref && open(activity.status)).at(-1);
      if (latest) ids.add(latest.activityId);
    }
    return [...ids];
  }
  async grantExecution(context: ActorContext): Promise<void> {
    if (context.inputKind !== 'human' || !context.grantExecution) return;
    const root = context.rootActivityId ?? context.activityId;
    await this.recovery.grantExecution(root);
    context.signal.throwIfAborted();
    await this.deliveries.grantRecovery(root, context.activityId);
  }
  stopDirector(_activityId: string): void {
    this.recovery.stop();
    this.backoff.reset();
    this.wakeTask?.cancel();
  }
  stopActor(activityId: string): void {
    this.stoppedActors.add(activityId);
    const group = this.groups.get(activityId);
    const batchId = group?.batchId ?? this.origins.get(activityId)?.batchId;
    if (group) group.paused = true;
    if (batchId) this.options.pauseBatch?.(batchId);
  }
  resumeDirector(activityId?: string): string {
    // New human input releases deferred items and held reports together.
    if (activityId) {
      // A human message ends any outage wait, and it takes precedence over a recovery budget a deferred failure had exhausted.
      this.backoff.reset();
      const exhausted = this.deliveries.snapshot().filter(item => item.status === 'pending' && item.deferredUntilHuman &&
        item.origin?.recovery?.exhausted && !item.origin.recovery.key.startsWith('execution:'));
      this.releaseTask = this.deliveries.releaseDeferred(liftExhaustion).then(() => this.recovery.lift(exhausted.map(item => item.rootActivityId ?? item.origin?.rootActivityId)))
        .then(() => this.deliveries.release('logox')).then(() => {});
    }
    const report = this.recovery.resume(activityId);
    const batches = [...new Set([...this.groups.values()].filter(group => group.paused).map(group => group.batchId))];
    if (activityId) for (const batch of batches) this.resumableBatches.add(batch);
    return [report, batches.length ? pausedBatchesHint(batches.map(id => ({id, interrupted: [...this.restartBlockers.get(id) ?? []]}))) : ''].filter(Boolean).join('\n');
  }
  /**
   * After a restart: Director dispatches that never started return as paused groups (listed by `resumeDirector` and resumable from the next root),
   * and `resumable` names the activities the restart interrupted, which the Director may resume with `resumeTask`.
   */
  restoreRestart(restore: readonly TaskCheckpoint[], blockers: ReadonlyMap<string, string>, resumable: readonly string[]): void {
    for (const id of resumable) this.restartInterrupted.add(id);
    const batches = new Map<string, TaskCheckpoint[]>();
    for (const task of restore) if (task.batchId) batches.set(task.batchId, [...batches.get(task.batchId) ?? [], task]);
    for (const [batchId, tasks] of batches) {
      const origin: TaskOrigin = {...checkpointOrigin(tasks[0]!), inputKind: 'director'};
      const depth = Math.max(0, ...tasks.map(task => task.dispatchDepth ?? 0)), group = {remaining: new Set(tasks.map(task => task.activityId)), depth, batchId, origin, paused: true};
      for (const task of tasks) {this.groups.set(task.activityId, group); this.origins.set(task.activityId, checkpointOrigin(task)); this.depths.set(task.activityId, depth);}
      this.resumableBatches.add(batchId);
      const waiting = new Set(tasks.flatMap(task => task.after ?? []).filter(id => blockers.has(id)));
      if (waiting.size) this.restartBlockers.set(batchId, waiting);
    }
  }
  async recover(validActivities?: ReadonlySet<string>): Promise<void> {
    await this.recovery.recover(validActivities);
    const tasks = await this.options.journal.activeTasks(this.options.sessionId);
    await this.deliveries.recover(tasks);
    await this.releaseEndedRoots();
    for (const task of tasks) {
      if (task.handoff && (!validActivities || !task.handoff.rootActivityId || validActivities.has(task.handoff.rootActivityId)) &&
        !this.deliveries.snapshot().some(item => item.id === task.handoff!.id)) await this.deliveries.enqueue(task.handoff);
    }
  }
  async flush(): Promise<void> {await this.releaseTask; await this.deliveries.flush(); await this.recovery.flush();}
  /** True while a Director wake-up is held back by a provider outage. */
  get outageWaiting(): boolean {return this.backoff.waiting;}
  /** Drops the pending outage wake-up. */
  close(): void {this.backoff.close();}
  private armOutage(error: ProviderError): void {this.backoff.arm(error.context?.provider ?? 'the model provider');}
  /** A failure on another provider does not predict the Director's own provider, so it needs no wait. */
  private otherProvider(error: ProviderError): boolean {
    const director = this.options.modelResolver?.('logox')?.provider, failed = error.context?.provider;
    return !!director && !!failed && director !== failed;
  }
  private wakeDirector(): void {
    if (this.recovery.stopped() || this.wakeTask || this.backoff.waiting) return;
    if (this.options.canReceiveMessage?.('logox') ?? !!this.options.getActiveTask?.('logox')) return;
    const pending = [...this.deliveries.pending('logox')].filter(item => !item.deferredUntilHuman)
      .sort((a, b) => deliveryPriority[a.kind] - deliveryPriority[b.kind]);
    const first = pending[0];
    if (!first) return;
    const handle = this.options.enqueue('logox', automatedEvent(DIRECTOR_COORDINATION_WAKE), first.source,
      {...first.origin, rootActivityId: first.rootActivityId ?? first.origin?.rootActivityId ?? first.sourceActivityId,
        inputKind: 'actor', coordinationWake: true, priority: first.kind === 'failure' || first.kind === 'help'});
    this.wakeTask = handle;
    const admitted = new Set(pending.map(item => item.id));
    void handle.done.then(() => {
      if (this.wakeTask?.activityId !== handle.activityId) return;
      this.wakeTask = undefined;
      const completed = this.options.getSnapshot?.().activities.find(activity => activity.activityId === handle.activityId)?.status === 'completed';
      if (completed) this.backoff.reset();
      if (completed || this.deliveries.pending('logox').some(item => !item.deferredUntilHuman && !admitted.has(item.id))) {
        try {this.wakeDirector();} catch {this.options.notice?.('Coordination wake-up failed; pending reports remain saved.');}
      }
    });
  }
  /**
   * Releases the held reports of every root that has no open work left (see `facts.ts:openWork`); true when any were released.
   * `reporting` is the activity whose report is being admitted (its status may not be terminal yet); activities that already called `settled` are ended too.
   */
  private releaseEndedRoots(reporting?: string): Promise<boolean> {
    const run = this.releasing.then(async () => {
      const held = this.deliveries.held('logox');
      if (!held.length) return false;
      const snapshot = this.options.getSnapshot?.();
      const ended = new Set(this.ended); if (reporting) ended.add(reporting);
      const open = (root: string) => !!snapshot && hasOpenWork(openWork(snapshot, root, this.deliveries.snapshot(), ended));
      const roots = new Set(held.map(item => item.rootActivityId ?? '')); let released = false;
      for (const root of roots) if (!open(root) && await this.deliveries.release('logox', item => (item.rootActivityId ?? '') === root)) released = true;
      return released;
    });
    this.releasing = run.then(() => {}, () => {});
    return run;
  }
  private closeHandoff(activityId: string): void {
    this.groups.get(activityId)?.remaining.delete(activityId);
    this.groups.delete(activityId); this.pendingHandoffs.delete(activityId);
  }
  private async admitHandoff(event: Delivery, outage?: ProviderError): Promise<void> {
    const activityId = event.sourceActivityId!;
    this.pendingHandoffs.set(activityId, event);
    await this.options.journal.stageHandoff?.(this.options.sessionId, activityId, event);
    await this.deliveries.enqueue(event);
    this.closeHandoff(activityId);
    // The wake-up waits only once the failure is queued, so a short delay can never fire before there is something to deliver.
    if (outage) this.armOutage(outage);
    await this.releaseEndedRoots(activityId);
    if (!event.deferredUntilHuman) this.wakeDirector();
  }
  async handoff(result: Omit<TaskResult, 'sessionId'> & {sessionId?: string}) {
    const pending = this.pendingHandoffs.get(result.activityId);
    if (pending) return this.admitHandoff(pending);
    const group = this.groups.get(result.activityId);
    const executionError = result.error instanceof ExecutionRecoveryError ? result.error : undefined;
    if (result.ownerId === 'logox' && (result.status === 'completed' || (!result.recovery && !executionError))) return;
    const origin = group?.origin ?? this.origins.get(result.activityId) ?? result;
    if (result.ownerId !== 'logox' && !group && inputKind({...origin, ownerId: result.ownerId, source: result.source}) !== 'director') return;
    const eventId = 'terminal:' + result.activityId + ':' + result.status;
    if (this.deliveries.snapshot().some(item => item.id === eventId)) {this.closeHandoff(result.activityId); return;}
    const rootActivityId = origin.rootActivityId ?? result.rootActivityId ?? result.activityId;
    const [cause, ...diagnostics] = (executionError?.message ?? (result.error instanceof ProviderError ? formatFailureDetail(result.error) : undefined))?.split('\n') ?? [];
    const failure = cause ? '\nRuntime termination cause: ' + cause + '. Earlier tool failures are separate observations.' + (diagnostics.length ? '\n' + diagnostics.join('\n') : '') : '';
    const report = `Actor ${result.ownerId} activity ${result.activityId} (${result.status})${failure}\nTitle: ${result.delivery?.title ?? result.summary.title}\nReport:\n${result.delivery?.text ?? result.summary.report}`;
    if (result.stopReason === 'shutdown') {this.closeHandoff(result.activityId); return;}
    const userStopped = result.stopReason === 'user' || this.stoppedActors.delete(result.activityId);
    const failed = result.status !== 'completed';
    // A Director wake that failed on a provider outage is not a new failure: its deliveries return to pending and the backoff schedules the next try, without spending recovery budget.
    if (result.ownerId === 'logox' && failed && !userStopped && isProviderOutage(result.error) &&
      (origin.coordinationWake || origin.recovery?.key.startsWith('provider:temporary:'))) {
      this.armOutage(result.error); this.closeHandoff(result.activityId); return;
    }
    if (failed || userStopped) {
      if (group) group.paused = true;
      const batchId = group?.batchId ?? origin.batchId;
      if (batchId) this.options.pauseBatch?.(batchId);
    }
    const deferred = userStopped || this.recovery.stopped() || modelUnavailable(result.error) || executionError?.disposition === 'stop' ||
      !!(origin.recovery?.exhausted && !origin.recovery.key.startsWith('execution:'));
    const inheritedRecovery = origin.recovery ? {...origin.recovery} : undefined;
    const recovery = deferred ? inheritedRecovery : failed ? executionError ? await this.recovery.directorClaim(rootActivityId, executionError.kind)
      : await this.recovery.next(rootActivityId, result.error, origin.recovery) : inheritedRecovery;
    const noClaim = !!executionError && !recovery;
    if (recovery) {
      const actorTask = !failed ? undefined : result.ownerId === 'logox' ? origin.recovery?.actorTask
        : isProviderOutage(result.error) ? {ownerId: result.ownerId, activityId: result.activityId} : undefined;
      delete recovery.actorTask;
      if (actorTask) recovery.actorTask = actorTask;
    }
    const outage = failed && !userStopped && !deferred && result.ownerId !== 'logox' && isProviderOutage(result.error) && !this.otherProvider(result.error) ? result.error : undefined;
    const instruction = userStopped ? DIRECTOR_USER_STOP
      : executionError ? executionError.kind === 'no_delivery' ? DIRECTOR_EXECUTION_REVIEW : DIRECTOR_STREAM_REVIEW
      : recovery?.exhausted ? DIRECTOR_RECOVERY_EXHAUSTED
      : failed && recovery?.actorTask ? directorResumeAdvice(recovery.actorTask)
      : failed ? DIRECTOR_FAILURE : '';
    const batches = group?.paused && [...group.remaining].some(id => id !== result.activityId) ? '\n' + DIRECTOR_PAUSED_BATCH + group.batchId + DIRECTOR_PAUSED_BATCH_RULE : '';
    await this.admitHandoff(deliverySchema.parse({id: eventId, sessionId: this.options.sessionId, status: 'pending', time: Date.now(),
      ownerId: 'logox', source: result.ownerId, sourceActivityId: result.activityId,
      rootActivityId, kind: failed ? 'failure' : 'report', inputKind: 'actor', text: (instruction + batches ? instruction + batches + '\n' : '') + report,
      deferredUntilHuman: !!(deferred || noClaim), ...(!failed && !userStopped && !deferred && result.ownerId !== 'logox' ? {hold: 'root' as const} : {}), origin: {parentActivityId: result.activityId, rootActivityId,
        dispatchDepth: group?.depth ?? this.depths.get(result.activityId) ?? origin.dispatchDepth ?? 0,
        authorization: [...origin.authorization ?? []], ...(recovery ? {recovery} : {})}}), outage);
  }
  async settled(activityId: string, status: RoundStatus) {
    this.ended.add(activityId);
    await this.recovery.settled(activityId, status);
    await this.collaboration.settle(activityId, status);
    const pending = this.pendingHandoffs.get(activityId);
    if (pending) await this.admitHandoff(pending);
    else if (this.groups.has(activityId)) await this.handoff({ownerId: this.definitions.get(activityId)?.id ?? 'actor', activityId,
      source: 'logox', status, summary: {title: 'Task not handed off normally', report: 'The task ended during queueing or recording; please verify its state.', source: 'local'},
      ...(status === 'cancelled' ? {stopReason: 'shutdown'} : {})});
    if (await this.releaseEndedRoots()) this.wakeDirector();
    const definition = this.definitions.get(activityId);
    if (definition && this.active.get(definition.id) === definition) this.active.delete(definition.id);
    this.definitions.delete(activityId); this.depths.delete(activityId); this.origins.delete(activityId); this.stoppedActors.delete(activityId);
  }
}

/** Rewrites a deferred failure whose recovery budget was exhausted so that the human's new message is not overridden by the old stop. */
function liftExhaustion(item: Delivery): Delivery {
  const recovery = item.origin?.recovery;
  if (!recovery?.exhausted || recovery.key.startsWith('execution:')) return item;
  const {exhausted: _, ...open} = recovery;
  return {...item, text: item.text.replace(DIRECTOR_RECOVERY_EXHAUSTED, DIRECTOR_RECOVERY_LIFTED), origin: {...item.origin, recovery: open}};
}
