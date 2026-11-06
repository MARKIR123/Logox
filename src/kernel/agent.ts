import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Resources, type SkillVisibility} from '../resources/manager.js';
import type {ActorExecutor} from '../actors/ensemble.js';
import {builtinActors} from '../actors/builtins.js';
import type {RuntimeStore} from '../runtime/store.js';
import {normalizeMessages, type ModelMessage, type ModelRequest, type Provider, type ProviderCapabilities, type ToolCall, type ToolDefinition} from '../runtime/messages.js';
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
import type {Step} from '../runtime/contracts.js';
import type {TaskModels} from '../actors/task-models.js';
import {TaskProgress, taskProgressTool} from '../runtime/task-progress.js';
import {ActorRecovery} from '../actors/recovery.js';
import {ExecutionRecoveryError, executionRecoveryInstruction, toolProgressFingerprint, type ExecutionRecoveryKind} from './execution-recovery.js';
import {ToolPacing} from './tool-pacing.js';
import {PeerWait} from './peer-wait.js';
import {asksFor} from '../runtime/asks.js';
import {sendMessageSchema} from '../tools/coordination/SendMessageTool/SendMessageTool.js';
import {ASK_SENT_NOTE, ASK_SENT_NOTE_DIRECTOR, COMPANION_WAIT_INSTRUCTION, DIRECTOR_WAIT_INSTRUCTION, askOwedAtClose, askOwedWhileWorking} from '../prompts/runtime/recovery.js';
import {AUTOMA_TOOL_NAME} from '../tools/orchestration/AutomaTool/prompt.js';
import {storedMessage} from '../store/journal.js';
import {createRuntimeContextMessage, type RuntimeContextMessage} from '../runtime/context-updates.js';
import {composeBaseSystemPrompt, toolErrorRecoveryInstruction} from '../prompts/index.js';
import {maybePersistLargeOutput} from './scratchpad.js';
import {DIRECTOR_INTERRUPTED_TOOL_TEXT, TOOL_CANCELLED_TEXT, USER_INTERRUPTED_TOOL_TEXT} from '../prompts/runtime/interruption.js';
import {omitInternalToolPairs} from '../context/round-memory.js';
import {clampText} from '../context/contracts.js';
import {finishRoundTool, isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {FINISH_ROUND_REPAIR, FINISH_ROUND_MISSING_TEXT} from '../tools/protocol/_FinishRoundTool/prompt.js';
import {extractNarration, stripNarration} from '../runtime/narration.js';

/** The tool result for a call cut off by a stop: names the user or the Director, else the generic fallback. */
export function interruptedToolText(reason: 'user' | 'shutdown' | 'interrupted' | 'director_cancel' | undefined, fallback: string): string {
  return reason === 'user' ? USER_INTERRUPTED_TOOL_TEXT : reason === 'director_cancel' ? DIRECTOR_INTERRUPTED_TOOL_TEXT : fallback;
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
  /** The ensemble as it is right now: sent last on this request only, so earlier states never pile up in context. */
  snapshot?: string;
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
/** Times a finishing actor is told to answer before it may finish anyway; the asker is then told it ended without replying. */
const ASK_CLOSE_REMINDERS = 2;
/** Model requests an actor may work with an unanswered question before its single working reminder. */
const ASK_WORK_REMINDER_AFTER = 4;

export function createAgent(options: AgentOptions): ActorExecutor<string> {
  const localRecoveries = new Map<string, ActorRecovery>();
  const approvalHandled = new Set(options.extraApprovalHandled ?? []);
  for (const name of approvalHandled) if (!options.executeExtra || !options.extraTools?.some(tool => tool.name === name)) throw new Error('Approval handoff must point to an assembled extension: ' + name);
  const concurrency = options.readonlyConcurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Read-only concurrency must be 1-8');
  return async (prompt, context) => {
    if (context.coordinationWake && context.hasPendingInbox?.() === false) return;
    const progress = new TaskProgress(options.store, context);
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
      const persist = async (message: ModelMessage, step?: Step) => {await context.record(message, step); messages.push(message);};
      let iteration = 0;
      let recovery = '';
      let recoveringKind: ExecutionRecoveryKind | undefined;
      let adjustments = 0;
      let memoryRepair = false;
      let finalText = '';
      const correctionCalls = new Set<string>();
      const pacing = new ToolPacing();
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
          recoveringKind = undefined; memoryRepair = false; finalText = '';
          correctionCalls.clear();
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
        memoryRepair = false; finalText = ''; correctionCalls.clear();
        return true;
      };
      const recoverOutput = async (kind: ExecutionRecoveryKind, thinkingId: string): Promise<void> => {
        context.signal.throwIfAborted();
        const decision = await (options.recoverExecution?.(context, kind) ?? localRecovery.execution(root, kind, context.ownerId));
        context.signal.throwIfAborted();
        const note = kind === 'no_delivery' ? 'This turn produced only thinking; narrow the current step and deliver verifiable output first.'
          : kind === 'truncated_tools' ? 'Tool arguments were incomplete and this batch was not executed; switch to smaller, complete calls.' : 'Output limit reached; keep the existing content and continue from the breakpoint.';
        options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note}});
        options.executionNotice?.(context, note);
        if (decision !== 'retry') throw new ExecutionRecoveryError(kind, decision);
        context.report(kind === 'no_delivery' ? 'Adjusting' : 'Resuming', note);
        recovery = executionRecoveryInstruction(kind, context.ownerId, adjustments++ > 0);
        recoveringKind = kind;
      };
      const foreignSignatures = new Set<string>();
      requestLoop: for (;;) {
        context.signal.throwIfAborted();
        await drainInbox();
        const waitNotices = wait.take();
        if (waitNotices.length) {
          pacing.reset();
          closeReminders = 0;
          memoryRepair = false; finalText = ''; recovery = ''; recoveringKind = undefined;
          correctionCalls.clear();
          context.acceptRoundMemory?.(null);
        }
        const activeProvider = taskModel?.provider() ?? options.provider();
        const assembly: AgentAssembly = {capabilities: await activeProvider.resolveCapabilities?.(context.signal) ?? activeProvider.capabilities ?? FALLBACK_CAPABILITIES, history: messages};
        instruction = options.requestBase ? await options.requestBase(context, assembly)
          : await agentRequestBase(options.cwd, context.ownerId, options.extraRegistrations ?? options.extraTools, options.resources,
            undefined, true, undefined, undefined, undefined, assembly);
        if (!memoryRepair && options.iterations > 0 && iteration >= options.iterations) {
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
        const closingOnly = memoryRepair || pacing.withdrawn && !owesReply();
        const definitions = closingOnly ? [finishRoundTool] : instruction.tools;
        const visionEnabled = typeof options.supportsVision === 'function' ? options.supportsVision() : (options.supportsVision ?? true);
        const appendUpdate = async (value: RuntimeContextMessage) => {
          const update = value.kind.startsWith('environment-') || value.kind === 'capability-change' ? value : {...value, data: {...value.data, activityId: context.activityId}};
          const previous = messages.findLast(message => message.role === 'context' && message.kind === update.kind &&
            message.data?.activityId === update.data?.activityId && (message.data?.slot ?? '') === (update.data?.slot ?? ''));
          if (previous?.role !== 'context' || previous.text !== update.text || JSON.stringify(previous.data) !== JSON.stringify(update.data)) {
            context.signal.throwIfAborted();
            await persist(update);
            options.contextUpdated?.(context, update);
            return true;
          }
          return false;
        };
        for (const update of 'contextUpdates' in instruction ? instruction.contextUpdates ?? [] : []) await appendUpdate(update);
        const appendOnly = assembly.capabilities.appendOnlyHistory === true;
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
        const activityState = progress.instruction();
        if (activityState) await appendUpdate(createRuntimeContextMessage('task-state', activityState, {slot: 'activity-label'}));
        if (recovery) await appendUpdate(createRuntimeContextMessage('recovery', recovery));
        if (memoryRepair) await appendUpdate(createRuntimeContextMessage('finalizer', finalText ? FINISH_ROUND_REPAIR : FINISH_ROUND_MISSING_TEXT));
        const base = {system: instruction.system,
          ...(!closingOnly && instruction.toolDiscovery ? {toolDiscovery: instruction.toolDiscovery} : {}),
          // Tool fields and validation are unchanged; omits the draft-version URL repeated in every schema.
          tools: definitions.map(tool => {const {$schema: _, ...parameters} = tool.parameters; return {...tool, parameters};})};
        const prepared = await options.context?.prepare(context, base, context.signal, false, correctionCalls);
        if (await drainInbox()) continue requestLoop;
        if (taskModel && prepared && prepared.model.identity !== taskModel.model().identity) {
          throw new ProviderError('Task model and context budget identity mismatch; wire ContextManager.model to TaskModels.model');
        }
        const initialProjection = prepared?.request ?? {...base, messages};
        const snapshot = instruction.snapshot && !appendOnly ? [createRuntimeContextMessage('snapshot', instruction.snapshot, {activityId: context.activityId})] : [];
        // Hiding finished `_FinishRound` pairs and old finalizer notes saves tokens, but on an append-only protocol it is a history edit.
        const projected = {...initialProjection, messages: [...normalizeMessages(appendOnly ? initialProjection.messages : omitInternalToolPairs(initialProjection.messages, correctionCalls))
          .filter(message => appendOnly || message.role !== 'context' || message.kind !== 'finalizer' || memoryRepair && message.data?.activityId === context.activityId)
          // Sessions saved before snapshots stopped being stored still hold old copies; removing them is itself a history edit where that matters.
          .filter(message => appendOnly || message.role !== 'context' || message.data?.slot !== 'director-facts'), ...snapshot]};
        // A signature belongs only to the model that produced it; keep the full ledger and tool pairing, and do not replay old signed thinking on a switched request.
        let request: ModelRequest = foreignSignatures.size ? {...projected, supportsVision: visionEnabled, messages: projected.messages.map(message =>
          message.role === 'assistant' && message.signature && foreignSignatures.has(message.signature)
            ? {role: 'assistant' as const, text: message.text, ...(message.toolCalls ? {toolCalls: message.toolCalls} : {})} : message)} : {...projected, supportsVision: visionEnabled};
        if (!memoryRepair) iteration++;
        const metadataOnly = memoryRepair && !!finalText;
        context.report(recoveringKind ? recoveringKind === 'no_delivery' ? 'Adjusting' : 'Resuming' : 'Model processing',
          recoveringKind ? recovery : 'Round trip ' + iteration);
        let emitted = false, textId: string | undefined;
        let thinkingId = steps.thinking();
        let turn;
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
            turn = await (taskModel?.provider() ?? options.provider()).respond(request, delta => {
              emitted = true;
              const kind = delta.kind;
              if (metadataOnly && kind === 'text') return;
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
            options.store.flush();
            break;
          } catch (error) {
            options.store.flush();
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
              context.report('Network retry', 'Temporary connection failure; retrying (' + (attempt + 1) + ')...');
              const resume = steps.wait(thinkingId, 'Waiting for retry');
              try {await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal: context.signal});} finally {resume();}
              continue;
            }
            // Already displayed increments are saved too, so the next round can see output from before the interruption.
            const snapshot = options.store.getSnapshot();
            const text = snapshot.messages.find(message => message.id === textId)?.text ?? '';
            const reasoning = snapshot.messages.find(message => message.id === thinkingId)?.text;
            const step = steps.finish(thinkingId, context.signal.aborted ? 'cancelled' : 'failed');
            await persist({role: 'assistant', text, ...(reasoning ? {reasoning} : {}), ...(metadataOnly ? {memoryOnly: true as const} : {})}, step);
            if (memoryRepair && finalText && !context.signal.aborted) {
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
            throw error;
          }
        }
        // The timeline message keeps the raw `⏵` line: stage.ts reads it to title the next tool group and strips it from prose.
        const storedText = turn.message.text;
        const extracted = extractNarration(turn.message.text);
        if (extracted) {
          turn = {...turn, message: {...turn.message, text: extracted.cleanText}};
          void context.saveProgress?.({label: extracted.narration});
          options.store.activities.update(context.sessionId, context.activityId, {
            progress: {label: extracted.narration},
          });
        }
        if (metadataOnly) turn = {...turn, message: {...turn.message, memoryOnly: true as const}};
        if (storedText && !textId && !metadataOnly) {
          if (steps.get(thinkingId).state === 'running') steps.finish(thinkingId, 'completed');
          steps.endGroup('completed'); steps.phase('text');
          options.store.message(context.sessionId, context.ownerId, 'assistant', storedText, {activityId: context.activityId});
        }
        if (turn.message.reasoning && !options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text) options.store.updateMessage(thinkingId, {text: turn.message.reasoning});
        const thinkingStep = steps.get(thinkingId).state === 'running' ? steps.finish(thinkingId, 'completed') : steps.get(thinkingId);
        const ids = new Set<string>();
        for (const call of turn.message.toolCalls ?? []) {
          if (!call.id || ids.has(call.id)) call.id = randomUUID();
          ids.add(call.id);
        }
        const calls = turn.message.toolCalls ?? [];
        if (calls.some(call => isFinishRound(call.name)) || closingOnly && calls.length) {
          const truncated = turn.stop !== 'tools' || calls.some(call => {try {JSON.parse(call.arguments); return false;} catch {return true;}});
          const onlyFinalizer = calls.length === 1 && isFinishRound(calls[0]!.name);
          if (onlyFinalizer && !truncated) {
            try {
              const rawArgs: unknown = JSON.parse(calls[0]!.arguments);
              if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
                const obj = rawArgs as Record<string, unknown>;
                let clamped = false;
                if (typeof obj.title === 'string' && obj.title.trim().length > 120) {
                  obj.title = clampText(obj.title, 120); clamped = true;
                }
                if (typeof obj.outcome === 'string' && obj.outcome.trim().length > 600) {
                  obj.outcome = clampText(obj.outcome, 600); clamped = true;
                }
                if (typeof obj.verification === 'string' && obj.verification.trim().length > 240) {
                  obj.verification = clampText(obj.verification, 240); clamped = true;
                }
                if (Array.isArray(obj.carry_forward)) {
                  const nextCarry = obj.carry_forward.slice(0, 8).map(item =>
                    typeof item === 'string' && item.trim().length > 240 ? (clamped = true, clampText(item, 240)) : item
                  );
                  if (obj.carry_forward.length > 8) clamped = true;
                  if (clamped) obj.carry_forward = nextCarry;
                }
                if (clamped) calls[0] = {...calls[0]!, arguments: JSON.stringify(obj)};
              }
            } catch {}
          }
          const check = onlyFinalizer && !truncated ? validateToolCall(calls[0]!) : undefined;
          if (!metadataOnly && turn.message.text.trim()) finalText = turn.message.text;
          const allowed = base.tools.some(tool => isFinishRound(tool.name));
          const valid = allowed && onlyFinalizer && !truncated && check?.valid && !!finalText.trim();
          const error = !onlyFinalizer ? 'Terminal metadata must be the only tool in its batch. No business tools were executed.'
            : truncated ? 'Terminal metadata was truncated or the response did not end with tool calls.'
            : !allowed ? 'Terminal metadata is not available in this request.'
            : check && !check.valid ? check.error : 'Deliver the final answer or task report before submitting round memory.';
          const reasoning = turn.message.reasoning || options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text;
          await persist(truncated ? {...turn.message, toolsExcluded: true, ...(reasoning ? {reasoning} : {})} : {...turn.message, ...(reasoning ? {reasoning} : {})}, thinkingStep);
          if (prepared) options.context?.observe(context, request, turn, prepared.model);
          correctionCalls.clear();
          try {
            for (const call of calls) {
              await persist({role: 'tool', callId: call.id, name: call.name, text: valid ? '' : error, isError: !valid});
              if (!valid && !truncated && isFinishRound(call.name)) correctionCalls.add(call.id);
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
          if ((valid || closingOnly) && await holdClose()) continue requestLoop;
          if (await drainInbox(valid || memoryRepair)) continue;
          context.signal.throwIfAborted();
          if (valid) {context.acceptRoundMemory?.(calls[0]!.id); outcome = 'completed'; return;}
          if (memoryRepair) {
            if (!finalText && !directorWaiting()) throw new ExecutionRecoveryError('no_delivery', 'stop');
            outcome = 'completed'; return;
          }
          memoryRepair = true;
          continue;
        }
        if (calls.length) {
          const truncated = turn.stop !== 'tools' || calls.some(call => {
            try { JSON.parse(call.arguments); return false; } catch { return true; }
          });
          let schemaError: {callId: string; name: string; error: string} | undefined;
          if (!truncated) {
            const current = options.requestBase ? await options.requestBase(context, {capabilities: assembly.capabilities, history: messages}) : instruction;
            for (const call of calls) {
              const canonical = canonicalToolName(call.name);
              const eligible = current.pool?.some(item => item.definition.name.toLowerCase() === (canonical ?? call.name).toLowerCase()) ?? true;
              const callableNow = current.tools.some(tool => tool.name.toLowerCase() === (canonical ?? call.name).toLowerCase());
              if (!eligible || !callableNow) {
                schemaError = {callId: call.id, name: call.name, error: 'Tool is no longer available for this actor: ' + call.name};
                break;
              }
              const toolMatch = base.tools.find(tool =>
                tool.name.toLowerCase() === call.name.toLowerCase() ||
                (canonical && canonicalToolName(tool.name) === canonical)
              );
              if (!toolMatch) {
                schemaError = {callId: call.id, name: call.name, error: 'Unknown tool: ' + call.name + '. Available tools: ' + base.tools.map(t => t.name).join(', ')};
                break;
              }
              const extra = (call.name.toLowerCase() === taskProgressTool.name.toLowerCase() || canonical === 'UpdateTaskProgress')
                ? taskProgressTool
                : options.extraTools?.find(tool =>
                    tool.name.toLowerCase() === call.name.toLowerCase() ||
                    (canonical && canonicalToolName(tool.name) === canonical)
                  );
              try {
                const args = JSON.parse(call.arguments);
                if (extra) {
                  const check = z.fromJSONSchema(extra.parameters).safeParse(args);
                  if (!check.success) {
                    schemaError = {callId: call.id, name: call.name, error: check.error.issues.map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') + ' (argument validation failed)'};
                    break;
                  }
                } else {
                  const check = validateToolCall(call);
                  if (!check.valid) {
                    schemaError = {callId: call.id, name: call.name, error: check.error};
                    break;
                  }
                }
              } catch (e) {
                schemaError = {callId: call.id, name: call.name, error: e instanceof Error ? e.message : String(e)};
                break;
              }
            }
          }
          if (truncated) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: 'Tool arguments were incomplete and this batch was not executed; switch to smaller, complete calls.'}});
          else if (schemaError) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: 'Tool argument validation failed; the whole batch was not executed: ' + schemaError.error}});
          const reasoning = turn.message.reasoning || options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text;
          await persist(truncated ? {...turn.message, toolsExcluded: true, ...(reasoning ? {reasoning} : {})} : {...turn.message, ...(reasoning ? {reasoning} : {})}, steps.get(thinkingId));
          if (prepared) options.context?.observe(context, request, truncated ? {...turn, stop: 'other'} : turn, prepared.model);
          const completed = new Set<string>();
          const failedTools: {name: string; error: string}[] = [];
          const toolIds = new Map(calls.map(call => [call.id, steps.tool(call,
            instruction.pool?.find(item => item.definition.name === (canonicalToolName(call.name) ?? call.name))?.metadata.terminalVisibility)]));
          try {
            const execute = async (call: ToolCall): Promise<ToolResult> => {
              if (truncated) return {text: 'This batch of tools was not executed: the response did not end normally or the arguments were incomplete. Reissue complete tool calls.', isError: true};
              if (schemaError) {
                if (call.id === schemaError.callId) {
                  return {text: 'Parameter validation failed for tool `' + call.name + '`: ' + schemaError.error + '. To prevent partial side effects, the whole batch was not executed. Fix the arguments and reissue.', isError: true, disposition: 'error'};
                }
                return {text: 'Parameter validation failed for another tool in the same batch; to prevent partial side effects, this tool was not executed. Fix the arguments and reissue complete calls.', isError: true, disposition: 'error'};
              }
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
              if (call.name === taskProgressTool.name || canonical === 'UpdateTaskProgress') {
                toolContext.startTool();
                return progress.update(JSON.parse(call.arguments));
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
              const readonly = (call: ToolCall) => {
                const c = (canonicalToolName(call.name) ?? call.name).toLowerCase();
                return ['read', 'glob', 'grep'].includes(c) && !options.extraTools?.some(tool => tool.name.toLowerCase() === call.name.toLowerCase());
              };
              let end = start + 1;
              if (!truncated && !schemaError && readonly(calls[start]!)) while (end < calls.length && readonly(calls[end]!)) end++;
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
                      return {...result, text: result.text + '\n\n' + (context.ownerId === 'logox' ? ASK_SENT_NOTE_DIRECTOR : ASK_SENT_NOTE)};
                    }
                    const note = pacing.observe(call, result, {
                      waiting: directorWaiting() ? 'director' : context.ownerId !== 'logox' && teammatesRunning() ? 'companion' : undefined,
                      automaOffered: instruction.tools.some(tool => tool.name === AUTOMA_TOOL_NAME)});
                    steps.finish(id, context.signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed', call.name + '\n' + result.text,
                      result.isError ? result.disposition ?? 'error' : undefined);
                    return note ? {...result, text: result.text + '\n\n' + note} : result;
                  } catch (error) {
                    const rawErr: ToolResult = {text: context.signal.aborted ? 'Tool cancelled.' : String(error), isError: true};
                    const result = diagnoseToolError(call, rawErr);
                    steps.finish(id, context.signal.aborted ? 'cancelled' : 'failed', call.name + '\n' + (context.signal.aborted ? 'Tool cancelled.' : result.text));
                    throw error;
                  }
                }));
                for (let index = 0; index < group.length; index++) {
                  const call = group[index]!, settled = results[index]!;
                  const settledResult: ToolResult = settled.status === 'fulfilled' ? settled.value : diagnoseToolError(call, {text: context.signal.aborted ? TOOL_CANCELLED_TEXT : String(settled.reason), isError: true});
                  // A deliberate stop says who stopped it; other cancellations keep the plain text.
                  const result: ToolResult = context.signal.aborted && settledResult.isError && settledResult.text === TOOL_CANCELLED_TEXT
                    ? {...settledResult, text: interruptedToolText(context.stopReason?.(), TOOL_CANCELLED_TEXT)} : settledResult;
                  const persistedText = await maybePersistLargeOutput(result.text, options.cwd, call.id, context.sessionId, context.ownerId);
                  const step = steps.get(toolIds.get(call.id)!);
                  const toolMessage: ModelMessage = {
                    role: 'tool', callId: call.id, name: call.name,
                    text: persistedText, isError: result.isError,
                    ...(result.discoveredTools ? {discoveredTools: result.discoveredTools} : {}),
                    ...(result.images ? {images: [...result.images]} : {}),
                  };
                  await persist(toolMessage, step);
                  const fingerprint = !truncated && !schemaError ? toolProgressFingerprint(call, result) : undefined;
                  if (fingerprint) await observeProgress(fingerprint);
                  if (result.isError) failedTools.push({name: call.name, error: result.text});
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
          if (truncated) await recoverOutput('truncated_tools', thinkingId);
          else if (schemaError) {
            recovery = toolErrorRecoveryInstruction([{name: schemaError.name, error: schemaError.error}]);
            recoveringKind = undefined;
          } else if (failedTools.length > 0) {
            recovery = toolErrorRecoveryInstruction(failedTools);
            recoveringKind = undefined;
          } else {
            recovery = '';
            recoveringKind = undefined;
          }
          if (pacing.withdrawn && !owesReply()) {
            recovery = context.ownerId === 'logox' ? DIRECTOR_WAIT_INSTRUCTION : COMPANION_WAIT_INSTRUCTION;
            recoveringKind = undefined;
            if (context.ownerId !== 'logox' && !wait.pending) wait.watchAnyTeammate();
          }
          continue;
        }
        if (prepared && !context.signal.aborted) options.context?.observe(context, request, turn, prepared.model);
        if (memoryRepair) {
          await persist(turn.message, thinkingStep);
          context.signal.throwIfAborted();
          if (await holdClose()) continue requestLoop;
          if (await drainInbox(true)) continue;
          context.signal.throwIfAborted();
          if (!finalText && !directorWaiting()) throw new ExecutionRecoveryError('no_delivery', 'stop');
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
            memoryRepair = true;
            correctionCalls.clear();
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
