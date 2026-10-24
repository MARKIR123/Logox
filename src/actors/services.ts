import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {ActorContext, TaskHandle, TaskOrigin, TaskResult} from './ensemble.js';
import {ActorRecovery, modelUnavailable} from './recovery.js';
import {isProviderInterruption, ProviderError} from '../providers/http.js';
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
  borrowSkillSchema,
  BORROW_SKILL_DESCRIPTION,
  listActorsSchema,
  LIST_ACTORS_DESCRIPTION,
  executeListActors,
  cancelActorSchema,
  CANCEL_ACTOR_DESCRIPTION,
  executeCancelActor,
  canonicalToolName,
} from '../tools/index.js';
import type {RuntimeSnapshot} from '../runtime/contracts.js';
import {DeliveryQueue} from './delivery-queue.js';
import {directorFacts} from './facts.js';
import {DIRECTOR_FACTS_HEADER, DIRECTOR_COORDINATION_WAKE, DIRECTOR_RESULTS_READY, DIRECTOR_FAILURE,
  DIRECTOR_RECOVERY_EXHAUSTED, DIRECTOR_EXECUTION_REVIEW, DIRECTOR_STREAM_REVIEW, DIRECTOR_USER_STOP,
  DIRECTOR_PAUSED_BATCH, DIRECTOR_PAUSED_BATCH_RULE, directorResumeAdvice} from '../prompts/runtime/director.js';
import {deliveryPriority, deliverySchema, type Delivery} from '../runtime/delivery.js';
import {inputKind} from '../runtime/provenance.js';

const tool = (name: string, description: string, schema: z.ZodType): ToolDefinition => ({name, description, parameters: z.toJSONSchema(schema)});
const listActorsTool = tool('ListActors', LIST_ACTORS_DESCRIPTION, listActorsSchema);
const cancelActorTool = tool('CancelActor', CANCEL_ACTOR_DESCRIPTION, cancelActorSchema);
const directorTools = [
  tool('Actor', ACTOR_DESCRIPTION, actorSchema),
  cancelActorTool,
  listActorsTool,
  tool('CraftActor', CRAFT_ACTOR_DESCRIPTION, craftActorSchema),
  tool('ReadActor', READ_ACTOR_DESCRIPTION, readActorSchema),
];
const borrowTool = tool('BorrowSkill', BORROW_SKILL_DESCRIPTION, borrowSkillSchema);

export interface ActorServicesOptions {
  sessionId: string; catalog: ActorCatalog; registry: ProviderRegistry; resources: Resources; journal: Journal; config: Config;
  deliveries?: DeliveryQueue;
  enqueue(owner: string, prompt: string, source: string, origin?: TaskOrigin): TaskHandle;
  getActiveTask?(ownerId: string): { activityId: string } | undefined;
  canReceiveMessage?(ownerId: string): boolean;
  injectMessage?(targetOwnerId: string, message: string, source: string, summary?: string, mode?: 'interrupt' | 'queue'): Promise<boolean> | boolean;
  interrupt?(targetOwnerId: string, message: string, source: string, summary?: string): boolean;
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
}
/** 角色配置、单次技能借阅与摘要交接；执行队列仍由 Ensemble 拥有。 */
export class ActorServices {
  readonly management: ActorManagement;
  readonly collaboration: Collaboration;
  readonly recovery: ActorRecovery;
  readonly deliveries: DeliveryQueue;
  private readonly definitions = new Map<string, ActorDefinition>();
  private readonly active = new Map<string, ActorDefinition>();
  private readonly borrowed = new Map<string, Set<string>>();
  private readonly depths = new Map<string, number>();
  private readonly origins = new Map<string, TaskOrigin>();
  private readonly stoppedActors = new Set<string>();
  private readonly pendingHandoffs = new Map<string, Delivery>();
  private wakeTask: TaskHandle | undefined;
  private releaseTask: Promise<void> = Promise.resolve();
  private readonly continuedTasks = new Set<string>();
  private readonly resumableBatches = new Set<string>();
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
      projectDir: options.projectDir,
    });
    this.recovery = new ActorRecovery(options.sessionId, options.coordinationPath);
  }
  definition(context: ActorContext): ActorDefinition {
    this.origins.set(context.activityId, context);
    if (context.dispatchDepth !== undefined) this.depths.set(context.activityId, context.dispatchDepth);
    let definition = this.definitions.get(context.activityId);
    if (!definition) {
      definition = this.options.catalog.find(context.ownerId);
      if (!definition) throw new Error('角色已不可用：' + context.ownerId);
      this.definitions.set(context.activityId, definition); this.active.set(context.ownerId, definition);
    }
    return definition;
  }
  facts(context: Pick<ActorContext, 'ownerId' | 'activityId' | 'rootActivityId'>): string {
    const snapshot = this.options.getSnapshot?.();
    const facts = snapshot && directorFacts(snapshot, context, this.deliveries.snapshot());
    return facts ? DIRECTOR_FACTS_HEADER + '\n' + JSON.stringify(facts) : '';
  }
  policy(ownerId: string) {
    const role = this.active.get(ownerId) ?? this.options.catalog.find(ownerId);
    if (ownerId === 'logox' && role?.id === 'logox') return this.options.config.context;
    return contextPolicySchema.parse({...this.options.config.context, ...role?.context});
  }
  contract(ownerId: string): string | undefined {return (this.active.get(ownerId) ?? this.options.catalog.find(ownerId))?.compression;}
  skills(context: ActorContext) {return {actorId: context.ownerId, skills: this.definition(context).skills,
    borrowed: [...this.borrowed.get(context.activityId) ?? []]};}
  tools(ownerId: string): readonly ToolDefinition[] {
    return [
      ...(ownerId === 'logox' ? directorTools : [borrowTool, listActorsTool]),
      ...this.collaboration.tools(ownerId),
    ];
  }
  definitionsForValidation(): readonly ToolDefinition[] {
    return [...directorTools, borrowTool, listActorsTool, ...this.collaboration.tools('logox'), ...this.collaboration.tools('actor')];
  }
  async execute(call: ToolCall, context: ActorContext): Promise<ToolResult> {
    try {
      const canonical = canonicalToolName(call.name) ?? call.name;
      const matchedTool = this.tools(context.ownerId).find(tool =>
        tool.name.toLowerCase() === call.name.toLowerCase() ||
        canonicalToolName(tool.name) === canonical
      );
      if (!matchedTool) throw new Error('角色无权执行此工具');
      const input: unknown = JSON.parse(call.arguments);
      z.fromJSONSchema(matchedTool.parameters).parse(input);
      if (canonical !== 'CraftActor' && this.options.authorize && !await this.options.authorize(call, context)) return {text: '角色操作未获许可，请寻找其他方案。', isError: true, disposition: 'denied'};
      if (canonical !== 'CraftActor') context.startTool?.();
      if (canonical === 'Actor') {
        if (context.recovery?.exhausted) throw new Error('同一故障已补救两次，需要用户决定下一步，不能继续自动派工');
        let parsedInput: z.infer<typeof actorSchema>;
        if (input && typeof input === 'object' && 'actor' in input && typeof (input as {actor: unknown}).actor === 'string') {
          const single = input as {actor: string; prompt: string; description?: string};
          parsedInput = {tasks: [{ownerId: single.actor, prompt: single.prompt, goal: single.description}]};
        } else {
          parsedInput = actorSchema.parse(input);
        }
        const {tasks, resumeBatch} = parsedInput;
        const saved = tasks.some(task => task.resumeTask) ? await this.options.journal.activeTasks(context.sessionId) : [];
        const resumed = new Set<string>(), roots = new Set<string>();
        for (const task of tasks) {
          if (task.goal || task.minDeliverable || task.stopCondition || task.constraints?.length) {
            const parts: string[] = [];
            if (task.goal) parts.push('【User Goal / 用户目标】\n' + task.goal);
            if (task.constraints?.length) parts.push('【Confirmed Constraints / 硬约束】\n' + task.constraints.join('; '));
            if (task.minDeliverable) parts.push('【Minimum Deliverable / 本轮最小成果】\n' + task.minDeliverable + '\n(Deliver a runnable/usable version in the text channel; do not perform work entirely in thinking blocks)');
            if (task.stopCondition) parts.push('【Completion Criteria / 收尾条件】\n' + task.stopCondition + '\n(Return deliverables and findings once sufficient evidence is gathered; avoid unbounded exploration)');
            parts.push('【Task Instructions / 任务要求】\n' + task.prompt);
            task.prompt = parts.join('\n\n');
          }
          if (task.ownerId === 'logox' || !this.options.catalog.find(task.ownerId)) throw new Error('角色无效：' + task.ownerId);
          for (const name of task.skills ?? []) if (!this.options.resources.snapshot().skills.some(skill => skill.name === name)) throw new Error('技能不存在：' + name);
          if (task.resumeTask) {
            const previous = saved.find(previous => previous.activityId === task.resumeTask);
            if (!previous) throw new Error('续做活动不存在或不在当前会话有效历史中：' + task.resumeTask);
            if (previous.ownerId !== task.ownerId) throw new Error('续做角色不匹配：原活动属于 ' + previous.ownerId);
            if (previous.stopReason === 'user') throw new Error('该活动由用户主动停止，不能自动续做');
            if (previous.status !== 'failed') throw new Error('只能续做失败活动；该活动当前状态：' + previous.status);
            const root = previous.rootActivityId ?? previous.activityId;
            if (root !== (context.rootActivityId ?? context.activityId) && !this.recovery.canResume(context.activityId, root) &&
              !this.deliveries.snapshot().some(item => item.recipientActivityId === context.activityId && item.rootActivityId === root)) {
              throw new Error('续做目标未交接到当前任务，不能续做其它根目标');
            }
            if (resumed.has(task.resumeTask) || this.continuedTasks.has(task.resumeTask)) throw new Error('该失败活动已经安排续做，不能重复派发：' + task.resumeTask);
            roots.add(root);
            resumed.add(task.resumeTask);
            task.prompt = '【原 Actor 任务断点续做】\n原活动：' + previous.activityId + '\n原目标：' + previous.prompt +
              '\n继续要求：' + task.prompt + '\n先核对自身历史摘要和已完成工具结果，只做未完成部分。保留已有输出，不重新执行已成功的写入或命令；未完整生成的工具调用没有执行，审批拒绝仍有效。';
          }
        }
        if (roots.size > 1) throw new Error('一次派发不能混合不同根目标的续做，请分别安排');
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
          throw new Error('已达到三次无新进展的角色调度，请根据已有结果收束任务');
        }
        const grouped = new Map<string, {prompts: string[]; skills: Set<string>; resumeTaskId?: string}>();
        for (const task of tasks) {
          const group = grouped.get(task.ownerId) ?? {prompts: [], skills: new Set<string>(), ...(task.resumeTask ? {resumeTaskId: task.resumeTask} : {})};
          if (task.resumeTask && group.resumeTaskId && task.resumeTask !== group.resumeTaskId) throw new Error('同一角色一次只能续做一个原活动，不能合并不同断点');
          if (task.resumeTask) group.resumeTaskId = task.resumeTask;
          group.prompts.push(task.prompt); for (const skill of task.skills ?? []) group.skills.add(skill); grouped.set(task.ownerId, group);
        }
        if (resumeBatch) {
          const group = [...this.groups.values()].find(group => group.batchId === resumeBatch);
          const finishedBatch = !group && saved.some(previous => previous.batchId === resumeBatch && resumed.has(previous.activityId)) &&
            !saved.some(previous => previous.batchId === resumeBatch && !['completed', 'failed', 'cancelled'].includes(previous.status));
          if (!finishedBatch && (!group || (group.origin.rootActivityId !== rootActivityId && !this.resumableBatches.has(resumeBatch)))) {
            throw new Error('不能恢复其它任务或不存在的批次');
          }
          if (group) {this.resumableBatches.delete(resumeBatch); group.paused = false; this.options.resumeBatch?.(resumeBatch);}
          if (!tasks.length) return {text: '已恢复原批次：' + resumeBatch, isError: false};
        }
        const origin: TaskOrigin = {parentActivityId: context.activityId, rootActivityId,
          inputKind: 'director', authorization: context.reviewMessages?.().filter(message => message.role === 'user').map(message => message.text).slice(-8) ?? context.authorization ?? [],
          ...(recovery ? {recovery} : {})};
        const nextDepth = baseDepth + (tasks.every(task => task.resumeTask) ? 0 : 1);
        const group = {remaining: new Set<string>(), depth: nextDepth, batchId: randomUUID(), origin, paused: false};
        const handles = [...grouped].map(([owner, task]) => {
          const childOrigin = {...origin, batchId: group.batchId, ...(task.resumeTaskId ? {resumeTaskId: task.resumeTaskId} : {})};
          const handle = this.options.enqueue(owner, task.prompts.join('\n\n'), 'logox', childOrigin);
          this.origins.set(handle.activityId, childOrigin);
          this.depths.set(handle.activityId, nextDepth); this.borrowed.set(handle.activityId, task.skills);
          group.remaining.add(handle.activityId); this.groups.set(handle.activityId, group);
          return handle;
        });
        for (const activityId of resumed) this.continuedTasks.add(activityId);
        return {text: '角色任务已排队（批次 ' + group.batchId + '）：' + handles.map(handle => handle.activityId).join('、'), isError: false};
      }
      if (canonical === 'CraftActor') {
        const {content} = craftActorSchema.parse(input);
        const result = await this.management.craftActor(content, async review => {
          const allowed = await this.options.approve(context, review); if (allowed) context.startTool?.(); return allowed;
        }, context.signal);
        return {text: (result.status === 'saved' ? '已保存并重载：' : '用户拒绝，未写入：') + result.path, isError: result.status === 'denied', ...(result.status === 'denied' ? {disposition: 'denied' as const} : {})};
      }
      if (canonical === 'ReadActor') {
        const {ownerId, activityId} = readActorSchema.parse(input);
        const entries = await this.options.journal.load(context.sessionId, ownerId);
        const rounds = await this.options.journal.rounds(context.sessionId, ownerId, entries);
        const relevantRounds = rounds.filter(round => !activityId || round.activityId === activityId).slice(-4);
        const relevantEntries = entries.filter(entry => !activityId || entry.activityId === activityId);
        const finalAssistant = relevantEntries.findLast(entry => entry.role === 'assistant' && entry.text.trim());
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
          getSnapshot: this.options.getSnapshot ?? (() => ({revision: 0, activities: [], interactions: [], messages: []})),
          roles,
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
      if (canonical === 'BorrowSkill') {
        const {name} = borrowSkillSchema.parse(input);
        if (!this.options.resources.snapshot().skills.some(skill => skill.name === name)) throw new Error('技能不存在');
        const borrowed = this.borrowed.get(context.activityId) ?? new Set<string>(); borrowed.add(name); this.borrowed.set(context.activityId, borrowed);
        return {text: '本任务已借阅 ' + name + '；请读取技能正文后使用。', isError: false};
      }
      const collab = await this.collaboration.execute(call, context);
      return {text: collab.text, isError: collab.isError, ...(collab.images ? {images: collab.images} : {})};
    } catch (error) {return {text: error instanceof Error ? error.message : '角色操作失败', isError: true};}
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
    if (activityId) this.releaseTask = this.deliveries.releaseDeferred();
    const report = this.recovery.resume(activityId);
    const batches = [...new Set([...this.groups.values()].filter(group => group.paused).map(group => group.batchId))];
    if (activityId) for (const batch of batches) this.resumableBatches.add(batch);
    return [report, batches.length ? '此前依赖任务仍暂停。先根据用户新指示判断；需要续做时用 dispatch_role({resumeBatch: "批次ID"}) 恢复已有队列，不重复派发。批次：' + batches.join('、') : ''].filter(Boolean).join('\n');
  }
  async recover(validActivities?: ReadonlySet<string>): Promise<void> {
    await this.recovery.recover(validActivities);
    const tasks = await this.options.journal.activeTasks(this.options.sessionId);
    await this.deliveries.recover(tasks);
    for (const task of tasks) {
      if (task.handoff && (!validActivities || !task.handoff.rootActivityId || validActivities.has(task.handoff.rootActivityId)) &&
        !this.deliveries.snapshot().some(item => item.id === task.handoff!.id)) await this.deliveries.enqueue(task.handoff);
    }
  }
  async flush(): Promise<void> {await this.releaseTask; await this.deliveries.flush(); await this.recovery.flush();}
  private wakeDirector(): void {
    if (this.recovery.stopped() || this.wakeTask) return;
    if (this.options.canReceiveMessage?.('logox') ?? !!this.options.getActiveTask?.('logox')) return;
    const pending = [...this.deliveries.pending('logox')].filter(item => !item.deferredUntilHuman)
      .sort((a, b) => deliveryPriority[a.kind] - deliveryPriority[b.kind]);
    const first = pending[0];
    if (!first) return;
    const handle = this.options.enqueue('logox', DIRECTOR_COORDINATION_WAKE, first.source,
      {...first.origin, rootActivityId: first.rootActivityId ?? first.origin?.rootActivityId ?? first.sourceActivityId,
        inputKind: 'actor', coordinationWake: true, priority: first.kind === 'failure' || first.kind === 'help'});
    this.wakeTask = handle;
    const admitted = new Set(pending.map(item => item.id));
    void handle.done.then(() => {
      if (this.wakeTask?.activityId !== handle.activityId) return;
      this.wakeTask = undefined;
      if (this.options.getSnapshot?.().activities.find(activity => activity.activityId === handle.activityId)?.status === 'completed' ||
        this.deliveries.pending('logox').some(item => !item.deferredUntilHuman && !admitted.has(item.id))) {
        try {this.wakeDirector();} catch {this.options.notice?.('Coordination wake-up failed; pending reports remain saved.');}
      }
    });
  }
  private closeHandoff(activityId: string): void {
    this.groups.get(activityId)?.remaining.delete(activityId);
    this.groups.delete(activityId); this.pendingHandoffs.delete(activityId);
  }
  private async admitHandoff(event: Delivery): Promise<void> {
    const activityId = event.sourceActivityId!;
    this.pendingHandoffs.set(activityId, event);
    await this.options.journal.stageHandoff?.(this.options.sessionId, activityId, event);
    await this.deliveries.enqueue(event);
    this.closeHandoff(activityId);
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
    const cause = executionError?.message ?? (result.error instanceof ProviderError ? result.error.message : undefined);
    const failure = cause ? '\nRuntime termination cause: ' + cause + '. Earlier tool failures are separate observations.' : '';
    const report = `Actor ${result.ownerId} activity ${result.activityId} (${result.status})${failure}\nTitle: ${result.delivery?.title ?? result.summary.title}\nReport:\n${result.delivery?.text ?? result.summary.report}`;
    if (result.stopReason === 'shutdown') {this.closeHandoff(result.activityId); return;}
    const userStopped = result.stopReason === 'user' || this.stoppedActors.delete(result.activityId);
    const failed = result.status !== 'completed';
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
        : isProviderInterruption(result.error) ? {ownerId: result.ownerId, activityId: result.activityId} : undefined;
      delete recovery.actorTask;
      if (actorTask) recovery.actorTask = actorTask;
    }
    const instruction = userStopped ? DIRECTOR_USER_STOP
      : executionError ? executionError.kind === 'no_delivery' ? DIRECTOR_EXECUTION_REVIEW : DIRECTOR_STREAM_REVIEW
      : recovery?.exhausted ? DIRECTOR_RECOVERY_EXHAUSTED
      : failed && recovery?.actorTask ? directorResumeAdvice(recovery.actorTask)
      : failed ? DIRECTOR_FAILURE : DIRECTOR_RESULTS_READY;
    const batches = group?.paused && [...group.remaining].some(id => id !== result.activityId) ? '\n' + DIRECTOR_PAUSED_BATCH + group.batchId + DIRECTOR_PAUSED_BATCH_RULE : '';
    await this.admitHandoff(deliverySchema.parse({id: eventId, sessionId: this.options.sessionId, status: 'pending', time: Date.now(),
      ownerId: 'logox', source: result.ownerId, sourceActivityId: result.activityId,
      rootActivityId, kind: failed ? 'failure' : 'report', inputKind: 'actor', text: instruction + batches + '\n' + report,
      deferredUntilHuman: !!(deferred || noClaim), origin: {parentActivityId: result.activityId, rootActivityId,
        dispatchDepth: group?.depth ?? this.depths.get(result.activityId) ?? origin.dispatchDepth ?? 0,
        authorization: [...origin.authorization ?? []], ...(recovery ? {recovery} : {})}}));
  }
  async settled(activityId: string, status: RoundStatus) {
    await this.recovery.settled(activityId, status);
    await this.collaboration.settle(activityId, status);
    const pending = this.pendingHandoffs.get(activityId);
    if (pending) await this.admitHandoff(pending);
    else if (this.groups.has(activityId)) await this.handoff({ownerId: this.definitions.get(activityId)?.id ?? 'actor', activityId,
      source: 'logox', status, summary: {title: '任务未正常交接', report: '任务在排队或记录阶段结束，请核对状态。', source: 'local'},
      ...(status === 'cancelled' ? {stopReason: 'shutdown'} : {})});
    const definition = this.definitions.get(activityId);
    if (definition && this.active.get(definition.id) === definition) this.active.delete(definition.id);
    this.definitions.delete(activityId); this.borrowed.delete(activityId); this.depths.delete(activityId); this.origins.delete(activityId); this.stoppedActors.delete(activityId);
  }
}
