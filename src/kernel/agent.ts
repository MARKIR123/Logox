import {z} from 'zod';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Resources, type SkillVisibility} from '../resources/manager.js';
import type {ActorExecutor} from '../actors/ensemble.js';
import {builtinActors} from '../actors/builtins.js';
import type {RuntimeStore} from '../runtime/store.js';
import {normalizeMessages, type Delta, type ModelMessage, type ModelRequest, type Provider, type ProviderCapabilities, type ToolCall, type ToolDefinition, type TurnUsage} from '../runtime/messages.js';
import {FALLBACK_CAPABILITIES} from '../providers/capabilities.js';
import {buildToolExposure, extractDiscoveredToolNames, retainDiscoveryPairs, planToolCatalog, resolveExposureProtocol, resolveToolLoad} from '../tools/discovery.js';
import {loadToolsSchema} from '../tools/protocol/LoadToolsTool/LoadToolsTool.js';
import {ProviderError, isProviderInterruption} from '../providers/http.js';
import {Tools, toolDefinitions, validToolCall, validateToolCall, canonicalToolName, type ToolResult} from '../tools/tools.js';
import {ToolRegistry} from '../tools/registry.js';
import type {ToolRegistration, ResolvedTool} from '../tools/catalog.js';
import {diagnoseToolError} from '../tools/diagnostics.js';

import type {ContextManager} from '../context/manager.js';
import {inputKind, inputMessage} from '../runtime/provenance.js';
import {Steps} from '../runtime/steps.js';
import {STAGE_HISTORY_LIMIT, type Step} from '../runtime/contracts.js';
import type {TaskModels} from '../actors/task-models.js';
import {ActorRecovery} from '../actors/recovery.js';
import {ExecutionRecoveryError, executionRecoveryInstruction, toolProgressFingerprint, type ExecutionRecoveryKind} from './execution-recovery.js';
import {ToolPacing} from './tool-pacing.js';
import {PeerWait} from './peer-wait.js';
import {asksFor} from '../runtime/asks.js';
import {sendMessageSchema} from '../tools/coordination/SendMessageTool/SendMessageTool.js';
import {textToolCallName} from './text-tool-call.js';
import {EMPTY_REPLY_REMINDER, TEXT_TOOL_CALL_NOTE, TOOLS_WITHDRAWN_RESULT, COMPANION_WAIT_INSTRUCTION, DIRECTOR_WAIT_INSTRUCTION, askOwedAtClose, askOwedWhileWorking} from '../prompts/runtime/recovery.js';
import {AUTOMA_TOOL_NAME} from '../tools/orchestration/AutomaTool/prompt.js';
import {storedMessage} from '../store/journal.js';
import {createRuntimeContextMessage, isTransientContext, withoutAnsweredTransient, type RuntimeContextMessage} from '../runtime/context-updates.js';
import {composeBaseSystemPrompt} from '../prompts/index.js';
import {settleToolResults} from './scratchpad.js';
import {DIRECTOR_INTERRUPTED_TOOL_TEXT, TOOL_CANCELLED_TEXT, USER_INTERRUPTED_TOOL_TEXT} from '../prompts/runtime/interruption.js';
import {normalizeFinishRound, omitInternalToolPairs} from '../context/round-memory.js';
import {isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {FINISH_ROUND_FOLLOW_UP, FINISH_ROUND_CLOSING_TOOL_RESULT} from '../tools/protocol/_FinishRoundTool/prompt.js';
import {extractNarration, stripNarration, withStageLines} from '../runtime/narration.js';
import {roleCacheRetention} from '../providers/cache.js';
import type {CacheKeeper} from './cache-keepalive.js';

/** The tool result for a call cut off by a stop: names the user or the Director, else the generic fallback. */
export function interruptedToolText(reason: 'user' | 'shutdown' | 'interrupted' | 'director_cancel' | undefined, fallback: string): string {
  return reason === 'user' ? USER_INTERRUPTED_TOOL_TEXT : reason === 'director_cancel' ? DIRECTOR_INTERRUPTED_TOOL_TEXT : fallback;
}

/** One cache route per session and actor, opaque and bounded so no path or name leaves the machine. */
export function promptCacheKey(sessionId: string, ownerId: string): string {
  return 'logox-' + createHash('sha256').update(sessionId + '\0' + ownerId).digest('hex').slice(0, 32);
}

export class UserCancelledError extends Error {
  readonly stopReason = 'user' as const;
  constructor(message = 'Reached this round\'s execution limit; user chose to stop') {
    super(message);
    this.name = 'UserCancelledError';
  }
}

export interface AgentAssembly {capabilities: ProviderCapabilities; history: readonly ModelMessage[]}
export interface AgentRequestBase {
  toolDiscovery?: NonNullable<ModelRequest['toolDiscovery']>;
  system: string;
  tools: readonly ToolDefinition[];
  pool: readonly ResolvedTool[];
  contextUpdates?: readonly RuntimeContextMessage[];
  /** When set, every business tool call of this request is answered with this text instead of running; the tool list itself never changes. */
  refuseTools?: string;
  /** The ensemble as it is right now: sent last on this request only, so earlier states never pile up in context. */
  snapshot?: string;
  /** The actor's own `cache_retention`; unset leaves the model's setting and the role default. */
  cacheRetention?: 'short' | 'long';
}
export interface AgentOptions {
  cwd: string;
  store: RuntimeStore;
  tools: Tools;
  provider(): Provider;
  taskModels?: TaskModels;
  requestBase?(context: Parameters<ActorExecutor<string>>[1], assembly: AgentAssembly): Promise<Omit<AgentRequestBase, 'pool'> & {pool?: readonly ResolvedTool[]}>;
  iterations: number;
  retries: number;
  retryProvider?(context: Parameters<ActorExecutor<string>>[1], error: ProviderError): Promise<boolean>;
  recoverExecution?(context: Parameters<ActorExecutor<string>>[1], kind: ExecutionRecoveryKind): Promise<'retry' | 'handoff' | 'stop'>;
  executionProgress?(context: Parameters<ActorExecutor<string>>[1], fingerprint: string): Promise<boolean>;
  contextUpdated?(context: Parameters<ActorExecutor<string>>[1], update: RuntimeContextMessage): void;
  executionNotice?(context: Parameters<ActorExecutor<string>>[1], text: string): void;
  readonlyConcurrency?: number;
  /** Replays an idle actor's last request to keep its short prompt cache alive while it is certain to wake again. */
  keepAlive?: CacheKeeper;
  /** Directory for the serialized request bodies of one actor (debug switch `LOGOX_DUMP_REQUESTS=1`); undefined when off. */
  requestDumpDir?(context: Parameters<ActorExecutor<string>>[1]): string | undefined;
  supportsVision?: boolean | (() => boolean);
  context?: ContextManager;
  resources?: Resources;
  extraRegistrations?: readonly ToolRegistration[];
  extraTools?: readonly ToolDefinition[];
  /** Trusted assembly config only: these extensions call authorizeExtension themselves after the executor fully validates arguments. */
  extraApprovalHandled?: readonly string[];
  executeExtra?(call: ToolCall, context: Parameters<ActorExecutor<string>>[1]): Promise<ToolResult>;
}
export async function agentRequestBase(cwd: string, ownerId: string, extraTools: readonly (ToolDefinition | ToolRegistration)[] = [], resources?: Resources,
  role?: {prompt: string; execution?: string | undefined; collaboration?: string | undefined; compression?: string; visibility: SkillVisibility}, includeSummary = true, scratchpadDir?: string, environmentBaseline?: string,
  registry = new ToolRegistry(cwd), assembly: AgentAssembly = {capabilities: FALLBACK_CAPABILITIES, history: []}): Promise<AgentRequestBase> {
  const extras = extraTools.map(item => {
    if ('metadata' in item) return item;
    const metadata = registry.getMetadata(item.name);
    if (!metadata) throw new Error('Extension metadata is required: ' + item.name);
    return {metadata, definition: item};
  });
  const pool = registry.resolveForActor(ownerId, extras);
  const protocol = resolveExposureProtocol(pool, assembly.capabilities.toolDiscovery);
  const catalog = planToolCatalog(registry, pool, protocol, assembly.history);
  const effective = resources ?? new Resources(cwd);
  if (!resources) await effective.reload();
  const rules = effective.promptSections(role?.visibility);
  const builtin = builtinActors.find(actor => actor.id === ownerId);
  const {system} = composeBaseSystemPrompt({
    cwd,
    ownerId,
    builtinPrompt: builtin?.prompt,
    customPrompt: role?.prompt,
    execution: role?.execution ?? builtin?.execution,
    collaboration: role?.collaboration ?? builtin?.collaboration,
    memoryFocus: role?.compression,
    guidelines: rules.guidelines,
    skillsIndex: rules.skills,
    toolsIndex: catalog.catalog,
    includeSummary,
    scratchpadDir,
    environmentBaseline,
  });
  const discoveryPairs = retainDiscoveryPairs(assembly.history, extractDiscoveredToolNames(assembly.history));
  return {system, pool, tools: buildToolExposure(pool, extractDiscoveredToolNames(discoveryPairs), protocol),
    contextUpdates: catalog.updates, ...(protocol !== 'none' ? {toolDiscovery: protocol} : {})};
}
/** A drafting update reaches the store when the call grew by this many characters or this many milliseconds passed (or its tool or target changed). */
const DRAFT_CHARS_STEP = 1024, DRAFT_MS_STEP = 250;
/** Times a finishing actor is told to answer before it may finish anyway; the asker is then told it ended without replying. */
const ASK_CLOSE_REMINDERS = 2;
/** Model requests an actor may work with an unanswered question before its single working reminder. */
const ASK_WORK_REMINDER_AFTER = 4;
/** Consecutive tool batches refused (withdrawn or restricted tools) before the runtime ends the exchange itself. */
const REFUSED_BATCH_LIMIT = 2;

export function createAgent(options: AgentOptions): ActorExecutor<string> {
  const localRecoveries = new Map<string, ActorRecovery>();
  const approvalHandled = new Set(options.extraApprovalHandled ?? []);
  for (const name of approvalHandled) if (!options.executeExtra || !options.extraTools?.some(tool => tool.name === name)) throw new Error('Approval handoff must point to an assembled extension: ' + name);
  const concurrency = options.readonlyConcurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Read-only concurrency must be 1-8');
  return async (prompt, context) => {
    if (context.coordinationWake && context.hasPendingInbox?.() === false) return;
    const stages: string[] = [...(context.progress && 'stageHistory' in context.progress ? context.progress.stageHistory ?? [] : [])];
    const steps = new Steps(options.store, context);
    const root = context.rootActivityId ?? context.activityId;
    let localRecovery = localRecoveries.get(context.sessionId);
    if (!localRecovery) {localRecovery = new ActorRecovery(context.sessionId); localRecoveries.set(context.sessionId, localRecovery);}
    const observeProgress = (fingerprint: string) => options.executionProgress?.(context, fingerprint) ?? localRecovery.progress(root, fingerprint);
    const taskModel = await options.taskModels?.begin(context);
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    const asks = asksFor(options.store);
    let lastDrain = 0;
    try {
      // Round-closing pairs stay in the working history; each request decides whether to send them.
      const messages: ModelMessage[] = normalizeMessages(context.history.map(entry => entry.role === 'user' ? inputMessage(entry.text, entry)
        : storedMessage(entry)));
      messages.push(inputMessage(prompt, context));
      // Request repair may convert unpaired tool records into user messages; approval authorization uses only original user records.
      const humanTexts = context.authorization ?? [...context.history.filter(entry => entry.role === 'user' && inputKind(entry) === 'human').map(entry => entry.text),
        ...(inputKind(context) === 'human' ? [prompt] : [])];
      const userRequests: ModelMessage[] = [...new Set(humanTexts)].slice(-8).map(text => ({role: 'user', text}));
      context = {...context, reviewMessages: () => [...userRequests, ...messages.filter(message => message.role === 'assistant')]};
      let instruction: Omit<AgentRequestBase, 'pool'> & {pool?: readonly ResolvedTool[]} = {system: '', tools: []};
      /** Usage of the latest provider turn; the first assistant message persisted for that turn carries it into the ledger once. */
      let turnUsage: TurnUsage | undefined;
      const persist = async (message: ModelMessage, step?: Step) => {
        const usage = message.role === 'assistant' && !message.contextExcluded ? turnUsage : undefined;
        if (usage) turnUsage = undefined;
        await context.record(message, step, usage); messages.push(message);
      };
      let iteration = 0;
      let recovery = '';
      let recoveringKind: ExecutionRecoveryKind | undefined;
      let adjustments = 0;
      let emptyReplyReminded = false;
      /** A round-memory close without any delivered text gets one static reminder and a fresh request before it fails; plain empty turns use the shared budget in `recoverOutput`. */
      const remindEmptyReply = (): boolean => {
        if (emptyReplyReminded) return false;
        emptyReplyReminded = true;
        recovery = EMPTY_REPLY_REMINDER;
        recoveringKind = 'no_delivery';
        return true;
      };
      /** True once the delivered text is in and the single closing follow-up (same tools, one note) is the next or current request. */
      let closing = false;
      let finalText = '';
      const pacing = new ToolPacing();
      let refusedBatches = 0;
      const directorWaiting = () => context.ownerId === 'logox' && options.store.getSnapshot().activities.some(activity =>
        activity.sessionId === context.sessionId && activity.kind === 'actor' && ['queued', 'running', 'waiting_input'].includes(activity.status));
      const teammatesRunning = () => options.store.getSnapshot().activities.some(activity => activity.sessionId === context.sessionId && activity.kind === 'actor' &&
        activity.ownerId !== context.ownerId && ['queued', 'running', 'waiting_input'].includes(activity.status));
      const wait = new PeerWait({store: options.store, sessionId: context.sessionId, activityId: context.activityId, ownerId: context.ownerId,
        signal: context.signal, hasPendingInbox: () => context.hasPendingInbox?.() ?? false});
      const owedSeen = new Map<string, number>();
      let closeReminders = 0;
      const owesReply = () => closeReminders < ASK_CLOSE_REMINDERS && asks.owed(context.sessionId, context.ownerId).length > 0;
      // An actor about to finish answers what it owes first, then waits for what it is owed; only then may its task end.
      // Owed replies come first so two actors asking each other are told to answer before either can park.
      const holdClose = async (): Promise<boolean> => {
        if (owesReply()) {
          closeReminders++;
          recovery = askOwedAtClose(asks.owed(context.sessionId, context.ownerId));
          recoveringKind = undefined; closing = false; finalText = '';
          context.acceptRoundMemory?.(null);
          return true;
        }
        if (!wait.pending) return false;
        context.report('Waiting', wait.describe());
        await wait.park();
        return true;
      };
      context.acceptRoundMemory?.(null);
      const drainInbox = async (closing = false): Promise<boolean> => {
        lastDrain = Date.now();
        const incoming = await (closing && context.closeInbox ? context.closeInbox() : context.drainInbox?.()) ?? [];
        if (!incoming.length) return false;
        messages.push(...incoming);
        pacing.reset();
        closeReminders = 0;
        const humanInputs = context.humanInputs?.();
        if (humanInputs) userRequests.splice(0, userRequests.length, ...[...new Set(humanInputs)].slice(-8).map(text => ({role: 'user' as const, text})));
        const inboundRecovery = context.inboundRecovery?.();
        if (inboundRecovery) context = {...context, recovery: inboundRecovery};
        context.acceptRoundMemory?.(null);
        closing = false; finalText = '';
        return true;
      };
      const recoverOutput = async (kind: ExecutionRecoveryKind, thinkingId: string): Promise<void> => {
        context.signal.throwIfAborted();
        const decision = await (options.recoverExecution?.(context, kind) ?? localRecovery.execution(root, kind, context.ownerId));
        context.signal.throwIfAborted();
        const note = kind === 'no_delivery' ? 'This turn produced only thinking; narrow the current step and deliver verifiable output first.'
          : kind === 'text_tool_call' ? TEXT_TOOL_CALL_NOTE
          : kind === 'truncated_tools' ? 'Tool arguments were incomplete and this batch was not executed; switch to smaller, complete calls.' : 'Output limit reached; keep the existing content and continue from the breakpoint.';
        options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note}});
        options.executionNotice?.(context, note);
        if (decision !== 'retry') throw new ExecutionRecoveryError(kind, decision);
        context.report(kind === 'no_delivery' ? 'Adjusting' : 'Resuming', note);
        recovery = executionRecoveryInstruction(kind, context.ownerId, adjustments++ > 0);
        recoveringKind = kind;
      };
      const foreignSignatures = new Set<string>();
      // A provider rejecting a request for too many images gets one retry with the older half of the images turned into file paths.
      let imageRetried = false;
      requestLoop: for (;;) {
        context.signal.throwIfAborted();
        await drainInbox();
        const waitNotices = wait.take();
        if (waitNotices.length) {
          pacing.reset();
          closeReminders = 0;
          closing = false; finalText = ''; recovery = ''; recoveringKind = undefined;
          context.acceptRoundMemory?.(null);
        }
        const activeProvider = taskModel?.provider() ?? options.provider();
        const assembly: AgentAssembly = {capabilities: await activeProvider.resolveCapabilities?.(context.signal) ?? activeProvider.capabilities ?? FALLBACK_CAPABILITIES, history: messages};
        instruction = options.requestBase ? await options.requestBase(context, assembly)
          : await agentRequestBase(options.cwd, context.ownerId, options.extraRegistrations ?? options.extraTools, options.resources,
            undefined, true, undefined, undefined, undefined, assembly);
        if (!closing && options.iterations > 0 && iteration >= options.iterations) {
          const outcome = await context.ask({kind: 'question', title: 'Continue this task?', questions: [{
            id: 'continue', header: 'Iterations', question: 'Reached ' + options.iterations + ' model round trips. Continue?',
            options: [{id: 'yes', label: 'Continue', description: 'Add another budget quota of round trips.'}, {id: 'no', label: 'Stop', description: 'Keep current results and end task.'}],
          }]});
          if (outcome.status !== 'answered' || outcome.response.kind !== 'question' ||
            outcome.response.answers.continue?.type !== 'option' || outcome.response.answers.continue.optionId !== 'yes') {
            throw new UserCancelledError();
          }
          iteration = 0;
        }
        // Withdrawn tools stay in the request (the cache prefix starts with the tool list); calls to them are answered with an error instead.
        const withdrawn = pacing.withdrawn && !owesReply();
        const refusal = withdrawn ? TOOLS_WITHDRAWN_RESULT : instruction.refuseTools;
        const definitions = instruction.tools;
        const visionEnabled = typeof options.supportsVision === 'function' ? options.supportsVision() : (options.supportsVision ?? true);
        const appendOnly = assembly.capabilities.appendOnlyHistory === true;
        const appendUpdate = async (value: RuntimeContextMessage) => {
          const update = value.kind.startsWith('environment-') || value.kind === 'capability-change' ? value : {...value, data: {...value.data, activityId: context.activityId}};
          const previousIndex = messages.findLastIndex(message => message.role === 'context' && message.kind === update.kind &&
            message.data?.activityId === update.data?.activityId && (message.data?.slot ?? '') === (update.data?.slot ?? ''));
          const previous = messages[previousIndex];
          // A transient note the model already answered is no longer in its requests, so the same text may be needed again.
          const dropped = !appendOnly && isTransientContext(update) && messages.slice(previousIndex + 1).some(message => message.role === 'assistant');
          if (previous?.role !== 'context' || dropped || previous.text !== update.text || JSON.stringify(previous.data) !== JSON.stringify(update.data)) {
            context.signal.throwIfAborted();
            await persist(update);
            options.contextUpdated?.(context, update);
            return true;
          }
          return false;
        };
        for (const update of 'contextUpdates' in instruction ? instruction.contextUpdates ?? [] : []) await appendUpdate(update);
        if (appendOnly && instruction.snapshot) await appendUpdate(createRuntimeContextMessage('task-state', instruction.snapshot, {slot: 'ensemble'}));
        for (const notice of waitNotices) {
          await appendUpdate(createRuntimeContextMessage('task-state', notice.text, {slot: 'wait-' + notice.id}));
          options.store.message(context.sessionId, context.ownerId, 'notice', notice.text, {activityId: context.activityId});
        }
        for (const ask of asks.owed(context.sessionId, context.ownerId)) {
          const seen = (owedSeen.get(ask.id) ?? 0) + 1;
          owedSeen.set(ask.id, seen);
          if (seen === ASK_WORK_REMINDER_AFTER) await appendUpdate(createRuntimeContextMessage('task-state', askOwedWhileWorking(ask.from, ask.label), {slot: 'owed-' + ask.id}));
        }
        if (recovery) await appendUpdate(createRuntimeContextMessage('recovery', recovery));
        if (closing) await appendUpdate(createRuntimeContextMessage('finalizer', FINISH_ROUND_FOLLOW_UP));
        const base = {system: instruction.system,
          ...(instruction.toolDiscovery ? {toolDiscovery: instruction.toolDiscovery} : {}),
          // Tool fields and validation are unchanged; omits the draft-version URL repeated in every schema.
          tools: definitions.map(tool => {const {$schema: _, ...parameters} = tool.parameters; return {...tool, parameters};})};
        const prepared = await options.context?.prepare(context, base, context.signal);
        if (await drainInbox()) continue requestLoop;
        if (taskModel && prepared && prepared.model.identity !== taskModel.model().identity) {
          throw new ProviderError('Task model and context budget identity mismatch; wire ContextManager.model to TaskModels.model');
        }
        const initialProjection = prepared?.request ?? {...base, messages};
        const snapshot = instruction.snapshot && !appendOnly ? [createRuntimeContextMessage('snapshot', instruction.snapshot, {activityId: context.activityId})] : [];
        // Hiding finished `_FinishRound` pairs and old finalizer notes saves tokens, but on an append-only protocol it is a history edit.
        const projected = {...initialProjection, messages: [...normalizeMessages(appendOnly ? initialProjection.messages : omitInternalToolPairs(withoutAnsweredTransient(initialProjection.messages)))
          .filter(message => appendOnly || message.role !== 'context' || message.kind !== 'finalizer' || closing && message.data?.activityId === context.activityId)
          // Sessions saved before snapshots stopped being stored still hold old copies; removing them is itself a history edit where that matters.
          .filter(message => appendOnly || message.role !== 'context' || message.data?.slot !== 'director-facts'), ...snapshot]};
        // A signature belongs only to the model that produced it; keep the full ledger and tool pairing, and do not replay old signed thinking on a switched request.
        let request: ModelRequest = foreignSignatures.size ? {...projected, supportsVision: visionEnabled, messages: withStageLines(projected.messages).map(message =>
          message.role === 'assistant' && message.signature && foreignSignatures.has(message.signature)
            ? {role: 'assistant' as const, text: message.text, ...(message.toolCalls ? {toolCalls: message.toolCalls} : {})} : message)} : {...projected, supportsVision: visionEnabled, messages: withStageLines(projected.messages)};
        const dumpDir = options.requestDumpDir?.(context);
        request = {...request, cacheKey: promptCacheKey(context.sessionId, context.ownerId),
          cacheRetention: {role: roleCacheRetention(context.ownerId), ...(instruction.cacheRetention ? {actor: instruction.cacheRetention} : {})}, ...(dumpDir ? {dumpDir} : {})};
        if (!closing) iteration++;
        context.report(recoveringKind ? recoveringKind === 'no_delivery' ? 'Adjusting' : 'Resuming' : 'Model processing',
          recoveringKind ? recovery : 'Round trip ' + iteration);
        let emitted = false, textId: string | undefined;
        let thinkingId = steps.thinking();
        // Tool arguments can stream for minutes with no text or reasoning; the running step shows them as drafting (store writes throttled).
        let draftId: string | undefined, drafted: {tool: string; target: string | undefined; chars: number; at: number} | undefined;
        const draft = (delta: Extract<Delta, {kind: 'tool'}>) => {
          const at = Date.now();
          if (drafted && drafted.tool === delta.name && drafted.target === delta.target && delta.chars - drafted.chars < DRAFT_CHARS_STEP && at - drafted.at < DRAFT_MS_STEP) return;
          drafted = {tool: delta.name, target: delta.target, chars: delta.chars, at};
          let id = thinkingId;
          if (steps.get(id).state !== 'running') id = draftId ??= steps.draftStep(); // prose already closed the thinking step
          steps.drafting(id, {tool: delta.name, ...(delta.target ? {target: delta.target} : {}), chars: delta.chars});
        };
        const endDraft = (state: 'completed' | 'failed' | 'cancelled') => {
          if (draftId && steps.get(draftId).state === 'running') steps.finish(draftId, state);
          draftId = undefined; drafted = undefined;
        };
        let turn, usedProvider: Provider | undefined, requestedAt = 0;
        turnUsage = undefined;
        for (let attempt = 0;; attempt++) {
          if (attempt > 0) {
            let changed = await drainInbox();
            if (options.requestBase) {
              const retryProvider = taskModel?.provider() ?? options.provider();
              const refreshed = await options.requestBase(context, {capabilities: await retryProvider.resolveCapabilities?.(context.signal) ?? retryProvider.capabilities ?? FALLBACK_CAPABILITIES, history: messages});
              changed ||= refreshed.system !== instruction.system || JSON.stringify(refreshed.tools) !== JSON.stringify(instruction.tools);
              for (const update of refreshed.contextUpdates ?? []) changed = await appendUpdate(update) || changed;
            }
            if (changed) {
              steps.finish(thinkingId, 'completed'); steps.endGroup('completed');
              continue requestLoop;
            }
          }
          let streamedText = '';
          let streamNarrationExtracted = false;
          try {
            usedProvider = taskModel?.provider() ?? options.provider();
            options.keepAlive?.wake(context);
            requestedAt = Date.now();
            turn = await usedProvider.respond(request, delta => {
              if (delta.kind === 'tool') return draft(delta);
              emitted = true;
              const kind = delta.kind;
              if (closing && kind === 'text') return;
              if (kind === 'text' && steps.get(thinkingId).state === 'running') {
                steps.finish(thinkingId, 'completed'); steps.endGroup('completed'); steps.phase('text');
              }
              if (kind === 'text') {
                streamedText += delta.text;
                if (!streamNarrationExtracted && (streamedText.includes('\n') || streamedText.length >= 40)) {
                  const early = extractNarration(streamedText);
                  if (early) {
                    streamNarrationExtracted = true;
                    options.store.activities.update(context.sessionId, context.activityId, {
                      progress: {label: early.narration},
                    });
                  }
                }
              }
              let id = kind === 'text' ? textId : thinkingId;
              if (!id) {
                id = options.store.message(context.sessionId, context.ownerId, 'assistant', '', {
                  activityId: context.activityId, ...(kind === 'reasoning' ? {kind: 'thinking' as const} : {}),
                });
                if (kind === 'text') textId = id;
              }
              options.store.appendMessage(id, delta.text);
            }, context.signal);
            endDraft('completed');
            options.store.flush();
            imageRetried = false;
            break;
          } catch (error) {
            endDraft(context.signal.aborted ? 'cancelled' : 'failed');
            options.store.flush();
            if (error instanceof ProviderError && error.diagnostic?.issue === 'too_many_images' && !imageRetried && options.context && !context.signal.aborted) {
              imageRetried = true;
              options.context.downgradeImages(context);
              steps.finish(thinkingId, 'failed'); steps.endGroup('failed');
              continue requestLoop;
            }
            const interruption = isProviderInterruption(error);
            const retry = !context.signal.aborted && error instanceof ProviderError && error.retryable && attempt < options.retries &&
              (interruption ? await (options.retryProvider?.(context, error) ?? Promise.resolve(attempt < 2)) : !emitted);
            if (retry && interruption) {
              const snapshot = options.store.getSnapshot();
              const text = snapshot.messages.find(message => message.id === textId)?.text ?? '';
              const reasoning = snapshot.messages.find(message => message.id === thinkingId)?.text;
              const step = steps.finish(thinkingId, 'failed'); steps.endGroup('failed');
              // A failed attempt is kept for history reading only. Retries reuse the original request and never splice partial replies or run half-received tool arguments.
              if (emitted) await context.record({role: 'assistant', text, ...(reasoning ? {reasoning} : {}), contextExcluded: true}, step);
              thinkingId = steps.thinking(); textId = undefined; emitted = false;
              context.report('Network retry', 'Connection interrupted. Retrying (' + (attempt + 1) + '/' + options.retries + ')...');
              const resume = steps.wait(thinkingId, 'Waiting for retry');
              try {await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal: context.signal});} finally {resume();}
              // Aligned with Claude Code: after a long streaming connection is reset by a proxy or intermediate gateway, retries downgrade to non-streaming requests to avoid long-stream timeouts entirely
              request = {...request, stream: false};
              continue;
            }
            if (retry) {
              context.report('Network retry', '[Network] Service unavailable' + (error instanceof ProviderError && error.diagnostic?.status ? ' (HTTP ' + error.diagnostic.status + ')' : '') +
                '. Retrying (' + (attempt + 1) + '/' + options.retries + ')...');
              const resume = steps.wait(thinkingId, 'Waiting for retry');
              try {await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal: context.signal});} finally {resume();}
              continue;
            }
            // Already displayed increments are saved too, so the next round can see output from before the interruption.
            const snapshot = options.store.getSnapshot();
            const text = snapshot.messages.find(message => message.id === textId)?.text ?? '';
            const reasoning = snapshot.messages.find(message => message.id === thinkingId)?.text;
            const step = steps.finish(thinkingId, context.signal.aborted ? 'cancelled' : 'failed');
            // The store keeps the raw `⏵` line for the timeline; the ledger never does.
            const partial = extractNarration(text);
            await persist({role: 'assistant', text: partial ? partial.cleanText : text, ...(partial ? {stage: partial.narration} : {}), ...(reasoning ? {reasoning} : {}), ...(closing ? {memoryOnly: true as const} : {})}, step);
            if (closing && !context.signal.aborted) {
              if (await drainInbox(true)) continue requestLoop;
              context.signal.throwIfAborted();
              outcome = 'completed'; return;
            }
            if (await taskModel?.fallback(error)) {
              for (const message of messages) if (message.role === 'assistant' && message.signature) foreignSignatures.add(message.signature);
              options.context?.meter(context).invalidate();
              recovery = 'The task model changed. Continue from preserved results without replaying completed operations.';
              continue requestLoop;
            }
            if (error instanceof ProviderError) error.context = {...taskModel?.selection(), attempts: attempt + 1};
            throw error;
          }
        }
        // The timeline message keeps the raw `⏵` line: stage.ts reads it to title the next tool group and strips it from prose.
        const storedText = turn.message.text;
        turnUsage = prepared ? options.context?.turnUsage(turn, prepared.model) : undefined;
        if (prepared && usedProvider) void options.keepAlive?.arm(context, {request, provider: usedProvider, model: prepared.model.identity, startedAt: requestedAt, usage: turn.usage});
        const extracted = extractNarration(turn.message.text);
        if (extracted) {
          // The ledger text drops the stage line; the `stage` field keeps it for later audits.
          turn = {...turn, message: {...turn.message, text: extracted.cleanText, stage: extracted.narration}};
          stages.push(extracted.narration);
          if (stages.length > STAGE_HISTORY_LIMIT) stages.splice(0, stages.length - STAGE_HISTORY_LIMIT);
          const next = {label: extracted.narration, stageHistory: [...stages]};
          void context.saveProgress?.(next);
          options.store.activities.update(context.sessionId, context.activityId, {progress: next});
        }
        if (closing) turn = {...turn, message: {...turn.message, memoryOnly: true as const}};
        // A call serialized as plain text executed nothing: it is not a delivery, and the card shows a short note instead of the dump.
        const textCall = turn.stop === 'complete' && !turn.message.toolCalls?.length && !closing && !withdrawn && !!textToolCallName(turn.message.text, definitions);
        if (textCall && textId) options.store.updateMessage(textId, {text: TEXT_TOOL_CALL_NOTE, role: 'notice'});
        if (storedText && !textId && !closing) {
          if (steps.get(thinkingId).state === 'running') steps.finish(thinkingId, 'completed');
          steps.endGroup('completed'); steps.phase('text');
          options.store.message(context.sessionId, context.ownerId, textCall ? 'notice' : 'assistant', textCall ? TEXT_TOOL_CALL_NOTE : storedText, {activityId: context.activityId});
        }
        if (turn.message.reasoning && !options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text) options.store.updateMessage(thinkingId, {text: turn.message.reasoning});
        const thinkingStep = steps.get(thinkingId).state === 'running' ? steps.finish(thinkingId, 'completed') : steps.get(thinkingId);
        const ids = new Set<string>();
        for (const call of turn.message.toolCalls ?? []) {
          if (!call.id || ids.has(call.id)) call.id = randomUUID();
          ids.add(call.id);
        }
        const calls = turn.message.toolCalls ?? [];
        if (closing ? calls.length > 0 : calls.some(call => isFinishRound(call.name))) {
          const truncated = turn.stop !== 'tools' || calls.some(call => {try {JSON.parse(call.arguments); return false;} catch {return true;}});
          const onlyFinalizer = calls.length === 1 && isFinishRound(calls[0]!.name);
          // Arguments are accepted leniently in one place; the call is rewritten to the accepted form so the ledger holds what the runtime used.
          const finishCall = calls.find(call => isFinishRound(call.name));
          const accepted = finishCall && !truncated ? normalizeFinishRound(finishCall.arguments, stages.at(-1) ?? context.taskTitle ?? '') : undefined;
          if (finishCall && accepted) calls[calls.indexOf(finishCall)] = {...finishCall, arguments: JSON.stringify(accepted)};
          if (!closing && turn.message.text.trim()) finalText = turn.message.text;
          const allowed = base.tools.some(tool => isFinishRound(tool.name));
          const valid = allowed && !!accepted && (closing || onlyFinalizer && !!finalText.trim());
          const error = !closing && !onlyFinalizer ? 'Terminal metadata must be the only tool in its batch. No business tools were executed.'
            : truncated ? 'Terminal metadata was truncated or the response did not end with tool calls.'
            : !allowed ? 'Terminal metadata is not available in this request.'
            : !accepted ? 'Round memory needs a non-empty summary.' : 'Deliver the final answer or task report before submitting round memory.';
          const reasoning = turn.message.reasoning || options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text;
          await persist(truncated ? {...turn.message, toolsExcluded: true, ...(reasoning ? {reasoning} : {})} : {...turn.message, ...(reasoning ? {reasoning} : {})}, thinkingStep);
          if (prepared) options.context?.observe(context, request, turn, prepared.model);
          const sent = calls.find(call => isFinishRound(call.name));
          try {
            for (const call of calls) {
              const ok = valid && call === sent;
              await persist({role: 'tool', callId: call.id, name: call.name, text: ok ? '' : closing && call !== sent ? FINISH_ROUND_CLOSING_TOOL_RESULT : error, isError: !ok});
            }
          } catch (error) {
            context.signal.throwIfAborted();
            if (!finalText) throw error;
            if (await drainInbox(true)) continue;
            context.signal.throwIfAborted();
            options.store.message(context.sessionId, context.ownerId, 'notice', 'The response is preserved; round memory could not be recorded.', {activityId: context.activityId});
            outcome = 'completed'; return;
          }
          context.signal.throwIfAborted();
          if ((valid || closing) && await holdClose()) continue requestLoop;
          if (await drainInbox(valid || closing)) continue;
          context.signal.throwIfAborted();
          // The follow-up is asked once: whatever it held besides a usable call, the runtime writes the record and the round ends.
          if (valid) context.acceptRoundMemory?.(sent!.id);
          if (valid || closing) {outcome = 'completed'; return;}
          if (finalText.trim()) {closing = true; recovery = ''; recoveringKind = undefined; continue;}
          // Nothing was ever delivered: the empty-reply recovery applies.
          if (!directorWaiting()) {
            if (remindEmptyReply()) continue requestLoop;
            throw new ExecutionRecoveryError('no_delivery', 'stop');
          }
          outcome = 'completed'; return;
        }
        if (calls.length) {
          const truncated = turn.stop !== 'tools' || calls.some(call => {
            try { JSON.parse(call.arguments); return false; } catch { return true; }
          });
          // A tool that only observes cannot leave partial side effects, so a batch of them keeps its valid calls.
          const readonly = (call: ToolCall) => {
            const c = (canonicalToolName(call.name) ?? call.name).toLowerCase();
            return ['read', 'glob', 'grep'].includes(c) && !options.extraTools?.some(tool => tool.name.toLowerCase() === call.name.toLowerCase());
          };
          const schemaErrors = new Map<string, string>();
          if (!truncated) {
            const current = options.requestBase ? await options.requestBase(context, {capabilities: assembly.capabilities, history: messages}) : instruction;
            for (const call of calls) {
              const canonical = canonicalToolName(call.name);
              const eligible = current.pool?.some(item => item.definition.name.toLowerCase() === (canonical ?? call.name).toLowerCase()) ?? true;
              const callableNow = current.tools.some(tool => tool.name.toLowerCase() === (canonical ?? call.name).toLowerCase());
              if (!eligible || !callableNow) {
                schemaErrors.set(call.id, 'Tool is no longer available for this actor: ' + call.name);
                continue;
              }
              const toolMatch = base.tools.find(tool =>
                tool.name.toLowerCase() === call.name.toLowerCase() ||
                (canonical && canonicalToolName(tool.name) === canonical)
              );
              if (!toolMatch) {
                schemaErrors.set(call.id, 'Unknown tool: ' + call.name + '. Available tools: ' + base.tools.map(t => t.name).join(', '));
                continue;
              }
              const extra = options.extraTools?.find(tool =>
                tool.name.toLowerCase() === call.name.toLowerCase() ||
                (canonical && canonicalToolName(tool.name) === canonical)
              );
              try {
                const args = JSON.parse(call.arguments);
                if (extra) {
                  const check = z.fromJSONSchema(extra.parameters).safeParse(args);
                  if (!check.success) {
                    schemaErrors.set(call.id, check.error.issues.map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') + ' (argument validation failed)');
                    continue;
                  }
                } else {
                  const check = validateToolCall(call);
                  if (!check.valid) {
                    schemaErrors.set(call.id, check.error);
                    continue;
                  }
                }
              } catch (e) {
                schemaErrors.set(call.id, e instanceof Error ? e.message : String(e));
                continue;
              }
            }
          }
          const voidBatch = schemaErrors.size > 0 && calls.some(call => !readonly(call));
          if (truncated) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: 'Tool arguments were incomplete and this batch was not executed; switch to smaller, complete calls.'}});
          else if (schemaErrors.size) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: 'Tool argument validation failed; ' +
            (voidBatch ? 'the whole batch was not executed: ' : 'the other read-only calls ran: ') + [...schemaErrors.values()][0]}});
          const reasoning = turn.message.reasoning || options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text;
          await persist(truncated ? {...turn.message, toolsExcluded: true, ...(reasoning ? {reasoning} : {})} : {...turn.message, ...(reasoning ? {reasoning} : {})}, steps.get(thinkingId));
          if (prepared) options.context?.observe(context, request, truncated ? {...turn, stop: 'other'} : turn, prepared.model);
          const completed = new Set<string>();
          let automaNote: string | undefined;
          const toolIds = new Map(calls.map(call => [call.id, steps.tool(call,
            instruction.pool?.find(item => item.definition.name === (canonicalToolName(call.name) ?? call.name))?.metadata.terminalVisibility)]));
          try {
            const execute = async (call: ToolCall): Promise<ToolResult> => {
              if (refusal && !truncated) return {text: refusal, isError: true, disposition: 'error'};
              if (truncated) return {text: 'This batch of tools was not executed: the response did not end normally or the arguments were incomplete. Reissue complete tool calls.', isError: true};
              const invalid = schemaErrors.get(call.id);
              if (invalid) return {text: 'Parameter validation failed for tool `' + call.name + '`: ' + invalid + (voidBatch
                ? '. To prevent partial side effects, the whole batch was not executed. Fix the arguments and reissue.'
                : '. The other read-only calls in this batch ran; fix the arguments and reissue only this call.'), isError: true, disposition: 'error'};
              if (voidBatch) return {text: 'Parameter validation failed for another tool in the same batch; to prevent partial side effects, this tool was not executed. Fix the arguments and reissue complete calls.', isError: true, disposition: 'error'};
              context.signal.throwIfAborted();
              context.report('Running tool', call.name);
              const canonical = canonicalToolName(call.name);
              const id = toolIds.get(call.id)!;
              const waiting = async <T>(reason: string, operation: () => Promise<T>): Promise<T> => {
                const resume = steps.wait(id, reason); try {return await operation();} finally {resume();}
              };
              const toolContext = {...context, startTool: () => steps.start(id), wait: (reason: string) => steps.wait(id, reason),
                reportSwarm: (swarm: NonNullable<Step['swarm']>) => steps.swarm(id, swarm),
                permission: (input: Parameters<typeof context.permission>[0]) => waiting('Awaiting permission', () => context.permission(input)),
                ...context.askPermission ? {askPermission: (input: Parameters<typeof context.permission>[0]) => waiting('Awaiting permission', () => context.askPermission!(input))} : {},
                ask: (input: Parameters<typeof context.ask>[0]) => waiting('Awaiting answer', () => context.ask(input))};
              if (canonical === 'LoadTools') {
                const result = resolveToolLoad(loadToolsSchema.parse(JSON.parse(call.arguments)), instruction.pool ?? [], extractDiscoveredToolNames(messages));
                return {text: JSON.stringify(result), isError: false, discoveredTools: [...result.loaded, ...result.alreadyLoaded]};
              }
              const matchedExtra = options.extraTools?.find(tool =>
                tool.name.toLowerCase() === call.name.toLowerCase() ||
                (canonical && canonicalToolName(tool.name) === canonical)
              );
              if (matchedExtra && options.executeExtra) {
                if (!approvalHandled.has(call.name) && !approvalHandled.has(matchedExtra.name)) {
                  if (!await options.tools.authorizeExtension(call, toolContext)) return {text: 'Extension tool action was not permitted; find another approach.', isError: true, disposition: 'denied'};
                  toolContext.startTool();
                }
                return options.executeExtra(call, toolContext);
              }
              return options.tools.execute(call, toolContext);
            };
            for (let start = 0; start < calls.length;) {
              let end = start + 1;
              if (!truncated && !voidBatch && readonly(calls[start]!)) while (end < calls.length && readonly(calls[end]!)) end++;
              for (let offset = start; offset < end; offset += concurrency) {
                context.signal.throwIfAborted();
                const group = calls.slice(offset, Math.min(end, offset + concurrency));
                // Wait for all started tools to finish, then save in model order; cancellation will not leave background processes.
                const results = await Promise.allSettled(group.map(async call => {
                  const id = toolIds.get(call.id)!;
                  try {
                    const rawResult = await execute(call);
                    const result = diagnoseToolError(call, rawResult);
                    const sent = (canonicalToolName(call.name) ?? call.name) === 'SendMessage' && !result.isError ? sendMessageSchema.safeParse(JSON.parse(call.arguments)) : undefined;
                    if (sent?.success && sent.data.type === 'reply') asks.answer(context.sessionId, context.ownerId, sent.data.to);
                    if (sent?.success && sent.data.type === 'ask') {
                      asks.open({sessionId: context.sessionId, from: context.ownerId, fromActivityId: context.activityId, to: sent.data.to,
                        label: (sent.data.summary || sent.data.message).replace(/\s+/g, ' ').slice(0, 120)});
                      // The call is done once delivered; "awaiting reply" is a card summary derived from the conversation, not a running step.
                      steps.finish(id, context.signal.aborted ? 'cancelled' : 'completed', call.name + '\n' + result.text);
                      return result;
                    }
                    const note = pacing.observe(call, result, {
                      waiting: directorWaiting() ? 'director' : context.ownerId !== 'logox' && teammatesRunning() ? 'companion' : undefined,
                      automaOffered: instruction.tools.some(tool => tool.name === AUTOMA_TOOL_NAME)});
                    steps.finish(id, context.signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed', call.name + '\n' + result.text,
                      result.isError ? result.disposition ?? 'error' : undefined);
                    if (note) automaNote = note;
                    return result;
                  } catch (error) {
                    const rawErr: ToolResult = {text: context.signal.aborted ? 'Tool cancelled.' : String(error), isError: true};
                    const result = diagnoseToolError(call, rawErr);
                    steps.finish(id, context.signal.aborted ? 'cancelled' : 'failed', call.name + '\n' + (context.signal.aborted ? 'Tool cancelled.' : result.text));
                    throw error;
                  }
                }));
                const finals = group.map((call, index) => {
                  const settled = results[index]!;
                  const settledResult: ToolResult = settled.status === 'fulfilled' ? settled.value : diagnoseToolError(call, {text: context.signal.aborted ? TOOL_CANCELLED_TEXT : String(settled.reason), isError: true});
                  // A deliberate stop says who stopped it; other cancellations keep the plain text.
                  const result: ToolResult = context.signal.aborted && settledResult.isError && settledResult.text === TOOL_CANCELLED_TEXT
                    ? {...settledResult, text: interruptedToolText(context.stopReason?.(), TOOL_CANCELLED_TEXT)} : settledResult;
                  return result;
                });
                // Images get files, oversized results are offloaded, and the turn's total is capped, all decided once here and stored.
                const settledOutputs = await settleToolResults(finals.map((result, index) => ({callId: group[index]!.id, text: result.text, images: result.images})),
                  options.cwd, context.sessionId, context.ownerId);
                for (let index = 0; index < group.length; index++) {
                  const call = group[index]!, result = finals[index]!, output = settledOutputs[index]!;
                  const step = steps.get(toolIds.get(call.id)!);
                  const toolMessage: ModelMessage = {
                    role: 'tool', callId: call.id, name: call.name,
                    text: output.text, isError: result.isError,
                    ...(result.discoveredTools ? {discoveredTools: result.discoveredTools} : {}),
                    ...(output.images ? {images: output.images} : {}),
                  };
                  await persist(toolMessage, step);
                  const fingerprint = !truncated && !schemaErrors.size ? toolProgressFingerprint(call, result) : undefined;
                  if (fingerprint) await observeProgress(fingerprint);
                  completed.add(call.id);
                }
              }
              start = end;
            }
          } finally {
            for (const call of calls) if (!completed.has(call.id)) {
              const step = steps.finish(toolIds.get(call.id)!, 'cancelled', call.name + '\nTool execution was interrupted before a complete result was obtained.');
              await persist({role: 'tool', callId: call.id, name: call.name, text: interruptedToolText(context.stopReason?.(), 'Tool execution was interrupted before a complete result was obtained.'), isError: true}, step);
            }
          }
          // Delivered after the results as a request-only note, so the tool results stay clean in history.
          if (automaNote) await appendUpdate(createRuntimeContextMessage('recovery', automaNote, {slot: 'automa'}));
          if (truncated) await recoverOutput('truncated_tools', thinkingId);
          else {
            recovery = '';
            recoveringKind = undefined;
          }
          // A refused batch is answered once. A second one in a row ends the exchange without another request, so a model that ignores the refusal cannot loop.
          refusedBatches = refusal && !truncated ? refusedBatches + 1 : 0;
          if (refusedBatches >= REFUSED_BATCH_LIMIT) {
            refusedBatches = 0;
            if (withdrawn && wait.pending) {
              context.report('Waiting', wait.describe());
              await wait.park();
              continue requestLoop;
            }
            if (await drainInbox(true)) continue requestLoop;
            context.signal.throwIfAborted();
            if (withdrawn) {outcome = 'completed'; return;}
            throw new ExecutionRecoveryError('no_delivery', 'stop');
          }
          if (pacing.withdrawn && !owesReply()) {
            recovery = context.ownerId === 'logox' ? DIRECTOR_WAIT_INSTRUCTION : COMPANION_WAIT_INSTRUCTION;
            recoveringKind = undefined;
            if (context.ownerId !== 'logox' && !wait.pending) wait.watchAnyTeammate();
          }
          continue;
        }
        if (prepared && !context.signal.aborted) options.context?.observe(context, request, turn, prepared.model);
        if (textCall) {
          // The raw text stays in the ledger for audit and in history so the model can reissue the call; it never becomes the report.
          try {await recoverOutput('text_tool_call', thinkingId);}
          finally {await persist({...turn.message, textToolCall: true as const}, thinkingStep);}
          continue requestLoop;
        }
        if (closing) {
          // The follow-up came back without a call: the delivered text stands and the runtime writes the record.
          await persist(turn.message, thinkingStep);
          context.signal.throwIfAborted();
          if (await holdClose()) continue requestLoop;
          if (await drainInbox(true)) continue;
          context.signal.throwIfAborted();
          outcome = 'completed'; return;
        }
        if (turn.stop === 'complete' && !turn.message.text.trim() && (wait.pending || owesReply())) {
          await persist(turn.message, thinkingStep);
          await holdClose();
          continue requestLoop;
        }
        // A Director with nothing to say while companions run is waiting, not failing: retrying only pushes it back into tool calls.
        if (turn.stop === 'complete' && !turn.message.text.trim() && directorWaiting()) {
          await persist(turn.message, thinkingStep);
          if (await drainInbox(true)) continue requestLoop;
          context.signal.throwIfAborted();
          outcome = 'completed'; return;
        }
        const kind: ExecutionRecoveryKind | undefined = !turn.message.text.trim() && ['complete', 'length'].includes(turn.stop) ? 'no_delivery' : turn.stop === 'length' ? 'truncated_text' : undefined;
        if (kind) {
          try {await recoverOutput(kind, thinkingId);}
          finally {await persist(turn.message, steps.get(thinkingId));}
        } else await persist(turn.message, thinkingStep);
        if (turn.stop === 'complete' && turn.message.text.trim()) {
          const needsMemory = base.tools.some(tool => isFinishRound(tool.name));
          if (await holdClose()) continue requestLoop;
          if (await drainInbox(!needsMemory)) continue requestLoop;
          context.signal.throwIfAborted();
          if (needsMemory) {
            finalText = turn.message.text;
            closing = true; recovery = ''; recoveringKind = undefined;
            continue;
          }
          outcome = 'completed';
          return;
        }
        if (turn.stop === 'other' || turn.stop === 'tools') throw new Error('The model did not finish this turn normally (missing a valid stop reason or tool calls)');
      }
    } finally {
      // Natural end or not, the actors waiting on this one are told to stop waiting, and its own questions lapse.
      asks.endRecipient(context.sessionId, context.ownerId, lastDrain);
      if (context.ownerId !== 'logox') asks.dropAsker(context.activityId);
      steps.close(context.signal.aborted ? 'cancelled' : outcome); await taskModel?.finish(context.signal.aborted ? 'cancelled' : outcome);}
  };
}
