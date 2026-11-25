import {DIRECTOR_ID, isDirector} from '../runtime/director-id.js';
import {z} from 'zod';
import {stripNarration} from '../runtime/narration.js';
import {randomUUID} from 'node:crypto';
import type {ActorContext, TaskHandle, TaskOrigin, TaskResult} from './ensemble.js';
import {ActorRecovery, faultKey, modelUnavailable} from './recovery.js';
import {formatFailureDetail, isProviderOutage, ProviderError} from '../providers/http.js';
import {OutageBackoff} from './outage.js';
import type {ActorCatalog} from './catalog.js';
import {ActorManagement} from './management.js';
import type {ActorDefinition} from './definitions.js';
import {builtinActors} from './builtins.js';
import {Collaboration} from './collaboration.js';
import type {Resources} from '../resources/manager.js';
import {storedMessage, type Journal} from '../store/journal.js';
import {dispatchNotes, liveOwnsNotes, ownsConflicts} from '../tools/orchestration/ActorTool/notes.js';
import {buildRuntimeRecord} from './runtime-record.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ToolCall, ToolDefinition} from '../runtime/messages.js';
import {defaultToolRegistry, type ToolRegistry} from '../tools/registry.js';
import {builtinToolRegistrations} from '../tools/catalog.js';
import {normalizeToolInput} from '../tools/normalize.js';
import type {ToolResult} from '../tools/tools.js';
import {contextPolicySchema, type Config} from '../config/config.js';
import type {RoundStatus} from '../context/contracts.js';
import {ExecutionRecoveryError} from '../kernel/execution-recovery.js';
import {
  actorSchema,
  type TaskSpec,
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
  planSchema,
  executePlan,
  canonicalToolName,
} from '../tools/index.js';
import type {PlanBoard} from '../store/plans.js';
import {planUnknownLinkNode} from '../prompts/runtime/plan.js';
import {renderBrief} from '../tools/orchestration/ActorTool/brief.js';
import type {ListActorsMemo} from '../tools/coordination/ListActorsTool/ListActorsTool.js';
import type {RuntimeSnapshot} from '../runtime/contracts.js';
import {DeliveryQueue} from './delivery-queue.js';
import {activeEnsembleRoster, directorFacts, hasOpenWork, heldProgress, openWork, teammatesBlock} from './facts.js';
import {ENSEMBLE_RECORD_HEADER, DIRECTOR_COORDINATION_WAKE, DIRECTOR_FAILURE,
  DIRECTOR_RECOVERY_EXHAUSTED, DIRECTOR_RECOVERY_LIFTED, DIRECTOR_EXECUTION_REVIEW, DIRECTOR_STREAM_REVIEW, DIRECTOR_USER_STOP,
  DIRECTOR_PAUSED_BATCH, DIRECTOR_PAUSED_BATCH_RULE, directorResumeAdvice, pausedBatchesHint, automatedEvent} from '../prompts/runtime/director.js';
import {BRIEF_CHECK_CLEAR, BRIEF_CHECK_SKIPPED, NO_PLAN_NOTE, briefCheckBlocked, briefCheckFailed, dispatchedResult, ownsConflictRefusal, endedBatchResult, queuedBehindNote, resumedBatchResult, type DispatchedTask} from '../tools/orchestration/ActorTool/prompt.js';
import {briefCheckNeeded, type BriefChecker, type BriefCheckInput, type BriefCheckOutcome} from '../tools/orchestration/ActorTool/brief-check.js';
import {checkpointOrigin, restartStopped} from './restart.js';
import type {TaskCheckpoint} from '../store/journal.js';
import {deliveryPriority, deliverySchema, type Delivery} from '../runtime/delivery.js';
import {inputKind} from '../runtime/provenance.js';
import {normalizeStopReason} from '../runtime/stop-reason.js';
import {definitionChangeNote, definitionChanges, definitionFingerprint} from '../runtime/definition-fingerprint.js';
import {dispatchGraph} from './dispatch-graph.js';

const serviceTools = new Set(['Actor', 'CancelActor', 'ListActors', 'CraftActor', 'ReadActor', 'SendMessage', 'Plan']);

export interface ActorServicesOptions {
  toolRegistry?: ToolRegistry;
  /** The session's plan board (the `Plan` tool, `node` links of dispatches); without one plans are unavailable. */
  plans?: PlanBoard;
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
  /** The outage wait is over (recovered, a person wrote, or the Director was stopped): the host hides the wait notices it showed. */
  outageEnded?(): void;
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
  private briefChecker: BriefChecker | undefined;
  /** Installs the brief check run before a larger dispatch (`src/app/request.ts` wires `Tools.runBriefCheck()`); without one no check runs. */
  setBriefCheck(checker: BriefChecker | undefined): void {this.briefChecker = checker;}
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
        await this.deliveries.enqueue({id: 'help:' + context.activityId + ':' + callId, ownerId: DIRECTOR_ID, source: context.ownerId,
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
    }, (text, first) => options.outageNotice?.(text, first), options.outageDelaysMs, () => options.outageEnded?.());
  }
  /** What the actor's definition is now: its profile text and bound model. Stored on the work it starts, compared when that work is resumed. */
  private fingerprintOf(ownerId: string): string | undefined {
    const definition = this.options.catalog.find(ownerId);
    if (!definition) return undefined;
    const model = this.options.modelResolver?.(ownerId);
    return definitionFingerprint({prompt: [definition.prompt, definition.execution, definition.collaboration, definition.compression, definition.skills.join(',')],
      model: model ? model.provider + '/' + model.model + (model.effort ? ' ' + model.effort : '') : undefined});
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
  /** The ensemble record text: who holds which task and in what status, owned files, held-report progress and paused batches. Empty when nothing is open. */
  facts(context: Pick<ActorContext, 'ownerId' | 'activityId' | 'rootActivityId'>): string {
    const snapshot = this.options.getSnapshot?.();
    if (!snapshot) return '';
    if (!isDirector(context.ownerId)) return activeEnsembleRoster(snapshot, context);
    const facts = directorFacts(snapshot, context, this.deliveries.snapshot());
    return facts ? ENSEMBLE_RECORD_HEADER + '\n' + JSON.stringify(facts) : '';
  }
  /** Owners whose history was folded or whose session restarted and that still wait for their one ensemble record; the value is the record once computed. */
  private readonly recordDue = new Map<string, string>();
  /** A fold, compaction or restart removed (or never held) what the actor was told about the ensemble: it gets one record with its next request. */
  recordDueFor(ownerId: string): void {this.recordDue.set(ownerId, '\0');}
  /** The record this actor is due, computed once and kept until it is stored; empty (and no longer due) when no work is open. */
  restoreRecord(context: Pick<ActorContext, 'ownerId' | 'activityId' | 'rootActivityId'>): string {
    const cached = this.recordDue.get(context.ownerId);
    if (cached === undefined) return '';
    // The Director's record is due only while dispatched work is open (a queued, running, waiting or paused task, or a held report).
    const open = !isDirector(context.ownerId) || (this.options.getSnapshot?.().activities.some(activity => !isDirector(activity.ownerId) && activity.inputKind === 'director' &&
      ['queued', 'running', 'waiting_input', 'paused'].includes(activity.status)) ?? false) || this.deliveries.held(DIRECTOR_ID).length > 0;
    const text = cached === '\0' ? open ? this.facts(context) : '' : cached;
    if (text) this.recordDue.set(context.ownerId, text); else this.recordDue.delete(context.ownerId);
    return text;
  }
  /** The record was stored (or an identical one is already the latest). */
  recordStored(ownerId: string): void {this.recordDue.delete(ownerId);}
  policy(ownerId: string) {
    const role = this.active.get(ownerId) ?? this.options.catalog.find(ownerId);
    if (isDirector(ownerId) && role?.id === DIRECTOR_ID) return this.options.config.context;
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
      const input: unknown = normalizeToolInput(canonical, JSON.parse(call.arguments));
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
        const {tasks, resumeBatch, briefCheck, continueAct} = parsedInput;
        const saved = tasks.some(task => task.resumeTask) ? await this.options.journal.activeTasks(context.sessionId) : [];
        const resumed = new Set<string>(), roots = new Set<string>(), resumeNotes: string[] = [];
        for (const task of tasks) {
          const explicitTitle = task.title?.replace(/\s+/g, ' ').trim().slice(0, 120);
          if (explicitTitle) task.title = explicitTitle;
          if (isDirector(task.ownerId) || !this.options.catalog.find(task.ownerId)) throw new Error('Invalid actor: ' + task.ownerId);
          if (task.node) {
            const refusal = this.options.plans ? this.options.plans.check(task.node) : planUnknownLinkNode(task.node, []);
            if (refusal) throw new Error(refusal);
          }
          if (task.resumeTask) {
            const previous = saved.find(previous => previous.activityId === task.resumeTask);
            if (!previous) throw new Error('Resume activity does not exist or is not in the current session effective history: ' + task.resumeTask);
            if (previous.ownerId !== task.ownerId) throw new Error('Resume actor mismatch: the original activity belongs to ' + previous.ownerId);
            if (normalizeStopReason(previous.stopReason) === 'cancelled_by_user') throw new Error('This activity was stopped by the user and cannot be resumed automatically');
            if (previous.status !== 'failed' && !restartStopped(previous)) throw new Error('Only failed or restart-interrupted activities can be resumed; current status: ' + previous.status);
            const root = previous.rootActivityId ?? previous.activityId;
            if (root !== (context.rootActivityId ?? context.activityId) && !this.recovery.canResume(context.activityId, root) && !this.restartInterrupted.has(task.resumeTask) &&
              !this.deliveries.snapshot().some(item => isDirector(item.ownerId) && item.kind === 'failure' && item.sourceActivityId === task.resumeTask) &&
              !this.deliveries.snapshot().some(item => item.recipientActivityId === context.activityId && item.rootActivityId === root)) {
              throw new Error('The resume target was not handed off to the current task; other root goals cannot be resumed');
            }
            if (resumed.has(task.resumeTask) || this.continuedTasks.has(task.resumeTask)) throw new Error('This failed activity is already scheduled to resume and cannot be dispatched again: ' + task.resumeTask);
            roots.add(root);
            resumed.add(task.resumeTask);
            // A definition that changed since the work started does not stop the resume; the resumed task and the receipt both say so once.
            const current = this.fingerprintOf(task.ownerId);
            const changed = current ? definitionChangeNote(this.options.catalog.find(task.ownerId)?.name ?? task.ownerId, definitionChanges(previous.fingerprint, current)) : undefined;
            if (changed) resumeNotes.push(changed);
            task.prompt = '[Resuming interrupted Actor task]\n' + (changed ? changed + '\n' : '') + 'Original activity: ' + previous.activityId + '\nOriginal goal: ' + previous.prompt +
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
        // Two or more new tasks with no plan to hang them on: the receipt says so once (advice, never a refusal).
        const planAdvice = isDirector(context.ownerId) && !!this.options.plans && tasks.filter(task => !task.resumeTask).length >= 2 && !this.options.plans.active();
        // Every task is its own activity; `after` names tasks (an `id` of this call, `#n`, or an earlier activity id). All of it is checked before anything starts.
        const known = this.options.getSnapshot?.().activities.filter(activity => activity.sessionId === this.options.sessionId) ?? [];
        const graph = dispatchGraph(tasks, ref => {
          const activity = known.find(item => item.activityId === ref);
          return activity ? (['queued', 'running', 'waiting_input', 'paused'].includes(activity.status) ? 'open' : 'ended') : undefined;
        }, ref => !!this.options.catalog.find(ref));
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
        // The deterministic gate comes first and is never skipped: tasks that may run at the same time cannot both own a file.
        const conflicts = ownsConflicts(tasks, this.options.projectDir ?? process.cwd(), graph);
        if (conflicts.length) return {text: ownsConflictRefusal(conflicts), isError: true};
        // A larger dispatch is read by a read-only check first: gaps return to the Director with nothing started; a failed check never blocks.
        let briefLine: string | undefined = briefCheck === 'skip' ? BRIEF_CHECK_SKIPPED : undefined;
        if (!briefLine && this.briefChecker && briefCheckNeeded(tasks)) {
          const fresh = tasks.filter(task => !task.resumeTask);
          const input: BriefCheckInput = {companions: [...new Set(fresh.map(task => this.options.catalog.find(task.ownerId)?.name ?? task.ownerId))],
            tasks: fresh.map(task => ({ownerId: task.ownerId, title: task.title ?? task.prompt.split('\n', 1)[0]!.slice(0, 80), prompt: task.prompt,
              owns: task.owns ?? [], acceptance: task.acceptance ?? [], after: task.after ?? [],
              ...(task.node ? this.briefNode(task.node) : {})}))};
          const resume = context.wait?.('Checking briefs');
          let outcome: BriefCheckOutcome;
          try {outcome = await this.briefChecker(input, context);}
          catch (error) {
            context.signal.throwIfAborted();
            outcome = {status: 'failed', reason: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error'};
          } finally {resume?.();}
          if (outcome.status === 'blocked') return {text: briefCheckBlocked(outcome.gaps), isError: false};
          briefLine = outcome.status === 'clear' ? BRIEF_CHECK_CLEAR : briefCheckFailed(outcome.reason);
        }
        const origin: TaskOrigin = {parentActivityId: context.activityId, rootActivityId,
          inputKind: 'director', authorization: context.reviewMessages?.().filter(message => message.role === 'user').map(message => message.text).slice(-8) ?? context.authorization ?? [],
          ...(recovery ? {recovery} : {}), ...(continueAct && isDirector(context.ownerId) ? {continueAct: true} : {})};
        const nextDepth = baseDepth + (tasks.every(task => task.resumeTask) ? 0 : 1);
        const group = {remaining: new Set<string>(), depth: nextDepth, batchId: randomUUID(), origin, paused: false};
        const dispatched = new Map<string, string>();
        const titleOf = (task: TaskSpec) => task.title ?? task.prompt.split('\n', 1)[0]!.slice(0, 80);
        const batch = graph.ordered.map(({key, task}) => ({key, ownerId: task.ownerId, title: titleOf(task), owns: task.owns ?? []}));
        const snapshot = this.options.getSnapshot?.();
        const receipt: DispatchedTask[] = [];
        for (const {key, task, inCall, external} of graph.ordered) {
          const owner = task.ownerId;
          const after = [...inCall.map(ref => dispatched.get(ref)!), ...external];
          const fingerprint = this.fingerprintOf(owner);
          const childOrigin = {...origin, batchId: group.batchId, ...(fingerprint ? {fingerprint} : {}), ...(task.resumeTask ? {resumeTaskId: task.resumeTask} : {}), ...(task.title ? {taskTitle: task.title} : {}),
            ...(task.owns?.length ? {ownedFiles: [...new Set(task.owns)]} : {}), ...(task.acceptance?.length ? {acceptance: task.acceptance} : {}), ...(after.length ? {after} : {}),
            ...(task.node ? {planNode: task.node} : {})};
          // Teammates are the other tasks of the call it does not wait for, and live work on the same root it does not wait for.
          const earlier = graph.ancestors(key);
          const teammates = teammatesBlock(owner, batch.filter(mate => mate.key !== key && !earlier.has(mate.key)), snapshot, rootActivityId, new Set(external));
          const brief = renderBrief(task);
          // A task on a plan node is told where its node sits: the path from the root and its own subtree, after the brief.
          const planBlock = task.node ? this.options.plans?.contextFor(task.node) : undefined;
          const prompt = (brief ? task.prompt + '\n\n' + brief : task.prompt) + (planBlock ? '\n\n' + planBlock : '') + (teammates ? '\n\n' + teammates : '');
          const handle = this.options.enqueue(owner, prompt, DIRECTOR_ID, childOrigin);
          this.origins.set(handle.activityId, childOrigin);
          if (task.node) this.options.plans?.link(task.node, {activityId: handle.activityId});
          this.depths.set(handle.activityId, nextDepth);
          group.remaining.add(handle.activityId); this.groups.set(handle.activityId, group);
          dispatched.set(key, handle.activityId);
          receipt.push({activityId: handle.activityId, ownerId: owner, title: titleOf(task), owns: [...new Set(task.owns ?? [])], after, ...(task.id ? {id: task.id} : {})});
        }
        applyBatch?.();
        for (const activityId of resumed) {
          this.continuedTasks.add(activityId); this.restartInterrupted.delete(activityId);
          for (const waiting of this.restartBlockers.values()) waiting.delete(activityId);
        }
        return {
          text: dispatchedResult(receipt, group.batchId, [...dispatchNotes(tasks, this.options.projectDir ?? process.cwd()), ...liveOwnsNotes(tasks, snapshot?.activities.filter(activity => activity.sessionId === context.sessionId) ?? [], this.options.projectDir ?? process.cwd()), ...resumeNotes, ...this.queuedNotes(receipt, snapshot), ...(planAdvice ? [NO_PLAN_NOTE] : [])], briefLine),
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
        const reported = activityId ? this.deliveries.snapshot().find(item => isDirector(item.ownerId) && item.kind === 'report' && item.sourceActivityId === activityId && item.source === ownerId) : undefined;
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
          deliveries: () => this.deliveries.snapshot(),
          memo: this.listActorsMemo,
        });
      }
      if (canonical === 'Plan') return executePlan(planSchema.parse(input), {caller: context.ownerId, board: this.options.plans});
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
  /** What the brief check reads of a plan node a task names: its title, owner and acceptance. */
  private briefNode(id: string): {node?: {id: string; title: string; owner: string; acceptance: readonly string[]}} {
    const node = this.options.plans?.node(id);
    return node ? {node: {id: node.id, title: node.title, owner: node.owner, acceptance: node.acceptance}} : {};
  }
  /** One line per dispatched task whose companion is still on an earlier task (read from the snapshot taken before the dispatch): it queues behind that running task. */
  private queuedNotes(receipt: readonly DispatchedTask[], before: RuntimeSnapshot | undefined): string[] {
    if (!before) return [];
    const name = (ownerId: string) => this.options.catalog.find(ownerId)?.name ?? ownerId;
    return receipt.flatMap(task => {
      const running = before.activities.findLast(activity => activity.sessionId === this.options.sessionId && activity.ownerId === task.ownerId && activity.kind === 'actor' &&
        (activity.status === 'running' || activity.status === 'waiting_input'));
      return running ? [queuedBehindNote(task, name(task.ownerId), running.taskTitle ?? running.title, running.activityId)] : [];
    });
  }
  /** Resolves `after` references (activity ids or actor ids) to unfinished activity ids; finished or unknown activity ids are dropped, unknown actors are rejected. */
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
        .then(() => this.deliveries.release(DIRECTOR_ID)).then(() => {});
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
    const director = this.options.modelResolver?.(DIRECTOR_ID)?.provider, failed = error.context?.provider;
    return !!director && !!failed && director !== failed;
  }
  private wakeDirector(): void {
    if (this.recovery.stopped() || this.wakeTask || this.backoff.waiting) return;
    if (this.options.canReceiveMessage?.(DIRECTOR_ID) ?? !!this.options.getActiveTask?.(DIRECTOR_ID)) return;
    const pending = [...this.deliveries.pending(DIRECTOR_ID)].filter(item => !item.deferredUntilHuman)
      .sort((a, b) => deliveryPriority[a.kind] - deliveryPriority[b.kind]);
    const first = pending[0];
    if (!first) return;
    // An early wake (something urgent, or a root that is not held) still says which reports are outstanding.
    const snapshot = this.options.getSnapshot?.();
    const outstanding = snapshot ? heldProgress(snapshot, this.deliveries.snapshot()) : undefined;
    const handle = this.options.enqueue(DIRECTOR_ID, automatedEvent(DIRECTOR_COORDINATION_WAKE + (outstanding ? '\n' + outstanding : '')), first.source,
      {...first.origin, rootActivityId: first.rootActivityId ?? first.origin?.rootActivityId ?? first.sourceActivityId,
        inputKind: 'actor', coordinationWake: true, priority: first.kind === 'failure' || first.kind === 'help'});
    this.wakeTask = handle;
    const admitted = new Set(pending.map(item => item.id));
    void handle.done.then(() => {
      if (this.wakeTask?.activityId !== handle.activityId) return;
      this.wakeTask = undefined;
      const completed = this.options.getSnapshot?.().activities.find(activity => activity.activityId === handle.activityId)?.status === 'completed';
      if (completed) this.backoff.reset();
      if (completed || this.deliveries.pending(DIRECTOR_ID).some(item => !item.deferredUntilHuman && !admitted.has(item.id))) {
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
      const held = this.deliveries.held(DIRECTOR_ID);
      if (!held.length) return false;
      const snapshot = this.options.getSnapshot?.();
      const ended = new Set(this.ended); if (reporting) ended.add(reporting);
      const open = (root: string) => !!snapshot && hasOpenWork(openWork(snapshot, root, this.deliveries.snapshot(), ended));
      const roots = new Set(held.map(item => item.rootActivityId ?? '')); let released = false;
      for (const root of roots) if (!open(root) && await this.deliveries.release(DIRECTOR_ID, item => (item.rootActivityId ?? '') === root)) released = true;
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
    if (isDirector(result.ownerId) && (result.status === 'completed' || (!result.recovery && !executionError))) return;
    const origin = group?.origin ?? this.origins.get(result.activityId) ?? result;
    if (!isDirector(result.ownerId) && !group && inputKind({...origin, ownerId: result.ownerId, source: result.source}) !== 'director') return;
    const eventId = 'terminal:' + result.activityId + ':' + result.status;
    if (this.deliveries.snapshot().some(item => item.id === eventId)) {this.closeHandoff(result.activityId); return;}
    const rootActivityId = origin.rootActivityId ?? result.rootActivityId ?? result.activityId;
    const [cause, ...diagnostics] = (executionError?.message ?? (result.error instanceof ProviderError ? formatFailureDetail(result.error) : undefined))?.split('\n') ?? [];
    const failure = cause ? '\nRuntime termination cause: ' + cause + '. Earlier tool failures are separate observations.' + (diagnostics.length ? '\n' + diagnostics.join('\n') : '') : '';
    const stopLine = result.stop ? `\nStop reason: ${result.stop}` + (result.diagnostic && !failure ? `\nDiagnostic: ${result.diagnostic}` : '') : '';
    const body = `Actor ${result.ownerId} activity ${result.activityId} (${result.status})${stopLine}${failure}\nTitle: ${result.delivery?.title ?? result.summary.title}\nReport:\n${result.delivery?.text ?? result.summary.report}`;
    const record = isDirector(result.ownerId) ? '' : await this.runtimeRecord(result.ownerId, result.activityId, origin);
    const report = record ? body + '\n\n' + record : body;
    if (result.stopReason === 'shutdown') {this.closeHandoff(result.activityId); return;}
    const userStopped = result.stopReason === 'user' || result.stop === 'cancelled_by_user' || this.stoppedActors.delete(result.activityId);
    const failed = result.status !== 'completed';
    // A Director wake that failed on a provider outage is not a new failure: its deliveries return to pending and the backoff schedules the next try, without spending recovery budget.
    if (isDirector(result.ownerId) && failed && !userStopped && isProviderOutage(result.error) &&
      (origin.coordinationWake || origin.recovery?.key.startsWith('provider:temporary:'))) {
      this.armOutage(result.error); this.closeHandoff(result.activityId); return;
    }
    if (failed || userStopped) {
      if (group) group.paused = true;
      const batchId = group?.batchId ?? origin.batchId;
      if (batchId) this.options.pauseBatch?.(batchId);
    }
    // Recovery state describes one failure: it follows the work only while the failure it names is the cause that ended it (never across a resume that failed differently).
    const faultCause = executionError ? 'execution:' + (executionError.kind === 'no_delivery' ? 'no_delivery' : 'truncated') : faultKey(result.error, result.stop);
    const sameFault = origin.recovery?.key === faultCause;
    // A companion's execution failure always reaches the Director (its claim budget is the loop guard); only a Director's own 'stop' waits for a human.
    const deferred = userStopped || this.recovery.stopped() || modelUnavailable(result.error) || (executionError?.disposition === 'stop' && isDirector(result.ownerId)) ||
      !!(origin.recovery?.exhausted && sameFault && !origin.recovery.key.startsWith('execution:'));
    const inheritedRecovery = origin.recovery && (sameFault || userStopped) ? {...origin.recovery} : undefined;
    // A completed task resolves its failure and the Director's own cancel is not a fault: neither carries nor spends recovery state.
    const recovery = !failed || result.stop === 'cancelled_by_director' ? undefined : deferred ? inheritedRecovery
      : executionError ? await this.recovery.directorClaim(rootActivityId, executionError.kind)
      : await this.recovery.next(rootActivityId, result.error, origin.recovery, result.stop);
    const noClaim = !!executionError && !recovery && failed && result.stop !== 'cancelled_by_director';
    if (recovery) {
      const actorTask = !failed ? undefined : isDirector(result.ownerId) ? origin.recovery?.actorTask
        : isProviderOutage(result.error) ? {ownerId: result.ownerId, activityId: result.activityId} : undefined;
      delete recovery.actorTask;
      if (actorTask) recovery.actorTask = actorTask;
    }
    const outage = failed && !userStopped && !deferred && !isDirector(result.ownerId) && isProviderOutage(result.error) && !this.otherProvider(result.error) ? result.error : undefined;
    const instruction = userStopped ? DIRECTOR_USER_STOP
      : executionError ? executionError.kind === 'no_delivery' ? DIRECTOR_EXECUTION_REVIEW : DIRECTOR_STREAM_REVIEW
      : recovery?.exhausted ? DIRECTOR_RECOVERY_EXHAUSTED
      : failed && recovery?.actorTask ? directorResumeAdvice(recovery.actorTask)
      : failed ? DIRECTOR_FAILURE : '';
    const batches = group?.paused && [...group.remaining].some(id => id !== result.activityId) ? '\n' + DIRECTOR_PAUSED_BATCH + group.batchId + DIRECTOR_PAUSED_BATCH_RULE : '';
    await this.admitHandoff(deliverySchema.parse({id: eventId, sessionId: this.options.sessionId, status: 'pending', time: Date.now(),
      ownerId: DIRECTOR_ID, source: result.ownerId, sourceActivityId: result.activityId,
      rootActivityId, kind: failed ? 'failure' : 'report', inputKind: 'actor', text: (instruction + batches ? instruction + batches + '\n' : '') + report,
      deferredUntilHuman: !!(deferred || noClaim), ...(!failed && !userStopped && !deferred && !isDirector(result.ownerId) ? {hold: 'root' as const} : {}), origin: {parentActivityId: result.activityId, rootActivityId,
        dispatchDepth: group?.depth ?? this.depths.get(result.activityId) ?? origin.dispatchDepth ?? 0,
        authorization: [...origin.authorization ?? []], ...(recovery ? {recovery} : {})}}), outage);
  }
  /** The runtime's own account of an activity for the Director, built from the ledger; a missing ledger yields no block rather than a failed handoff. */
  private async runtimeRecord(ownerId: string, activityId: string, origin: TaskOrigin): Promise<string> {
    try {
      const sessionId = this.options.sessionId;
      const entries = await this.options.journal.load(sessionId, ownerId);
      const round = (await this.options.journal.rounds(sessionId, ownerId, entries)).find(record => record.activityId === activityId);
      const source = this.origins.get(activityId) ?? origin;
      const memory = round?.memory, model = memory?.source;
      return buildRuntimeRecord({actor: ownerId, cwd: this.options.projectDir ?? process.cwd(),
        messages: entries.filter(entry => entry.activityId === activityId).map(storedMessage),
        ownedFiles: source.ownedFiles, acceptance: source.acceptance,
        roundKnown: model === 'model' || model === 'runtime',
        marker: model === 'runtime' ? /^\[[a-z]+\]/.exec(memory!.summary)?.[0] : undefined});
    } catch {return '';}
  }
  async settled(activityId: string, status: RoundStatus) {
    this.ended.add(activityId);
    await this.recovery.settled(activityId, status);
    await this.collaboration.settle(activityId, status);
    const pending = this.pendingHandoffs.get(activityId);
    if (pending) await this.admitHandoff(pending);
    else if (this.groups.has(activityId)) await this.handoff({ownerId: this.definitions.get(activityId)?.id ?? 'actor', activityId,
      source: DIRECTOR_ID, status, summary: {title: 'Task not handed off normally', report: 'The task ended during queueing or recording; please verify its state.', source: 'local'},
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
