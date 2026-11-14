import {Resources, type SkillVisibility} from '../resources/manager.js';
import type {ActorExecutor} from '../actors/ensemble.js';
import {builtinActors} from '../actors/builtins.js';
import type {RuntimeStore} from '../runtime/store.js';
import {normalizeMessages, type ModelMessage, type ModelRequest, type Provider, type ProviderCapabilities, type ToolCall, type ToolDefinition} from '../runtime/messages.js';
import {FALLBACK_CAPABILITIES} from '../providers/capabilities.js';
import {buildToolExposure, extractDiscoveredToolNames, retainDiscoveryPairs, planToolCatalog, resolveExposureProtocol} from '../tools/discovery.js';
import type {ProviderError} from '../providers/http.js';
import {Tools, type ToolResult} from '../tools/tools.js';
import {ToolRegistry} from '../tools/registry.js';
import type {ToolRegistration, ResolvedTool} from '../tools/catalog.js';

import type {ContextManager} from '../context/manager.js';
import {inputKind, inputMessage} from '../runtime/provenance.js';
import {Steps} from '../runtime/steps.js';
import type {TaskModels} from '../actors/task-models.js';
import {ActorRecovery} from '../actors/recovery.js';
import {ExecutionRecoveryError, executionRecoveryInstruction, type ExecutionRecoveryKind} from './execution-recovery.js';
import {ToolPacing} from './tool-pacing.js';
import {RepeatGuard} from './repeat-guard.js';
import {PeerWait} from './peer-wait.js';
import {asksFor} from '../runtime/asks.js';
import {roundEffect} from '../runtime/round-scope.js';
import {TEXT_TOOL_CALL_NOTE, askOwedAtClose} from '../prompts/runtime/recovery.js';
import {storedMessage} from '../store/journal.js';
import type {RuntimeContextMessage} from '../runtime/context-updates.js';
import {composeBaseSystemPrompt} from '../prompts/index.js';
import type {CacheKeeper} from './cache-keepalive.js';
import {isDirector} from './director.js';
import {RoundState} from './round-state.js';
import {classifyTurn} from './turn-outcome.js';
import {prepareRequest, type RequestInstruction} from './request.js';
import {requestTurn} from './model-turn.js';
import {presentTurn, settleReply} from './reply.js';
import type {AgentRun} from './run.js';

export {UserCancelledError, promptCacheKey} from './request.js';
export {interruptedToolText} from './tool-batch.js';

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
  /** File that receives the always-on request fingerprint lines of one actor (`kernel.request_fingerprints`); undefined when off. */
  requestFingerprintFile?(context: Parameters<ActorExecutor<string>>[1]): string | undefined;
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


export function createAgent(options: AgentOptions): ActorExecutor<string> {
  const localRecoveries = new Map<string, ActorRecovery>();
  const approvalHandled = new Set(options.extraApprovalHandled ?? []);
  for (const name of approvalHandled) if (!options.executeExtra || !options.extraTools?.some(tool => tool.name === name)) throw new Error('Approval handoff must point to an assembled extension: ' + name);
  const concurrency = options.readonlyConcurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Read-only concurrency must be 1-8');
  return async (prompt, context) => {
    if (context.coordinationWake && context.hasPendingInbox?.() === false) return;
    const narration: {latest?: string | undefined} = {latest: context.progress && 'label' in context.progress ? context.progress.label : undefined};
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
      const state = new RoundState();
      const directorWaiting = () => isDirector(run.context.ownerId) && options.store.getSnapshot().activities.some(activity =>
        activity.sessionId === run.context.sessionId && activity.kind === 'actor' && ['queued', 'running', 'waiting_input'].includes(activity.status));
      const wait = new PeerWait({store: options.store, sessionId: context.sessionId, activityId: context.activityId, ownerId: context.ownerId,
        signal: context.signal, hasPendingInbox: () => run.context.hasPendingInbox?.() ?? false});
      const run: AgentRun = {
        options, messages, steps, state, narration, asks, wait, taskModel, approvalHandled, concurrency, pacing: new ToolPacing(), repeat: new RepeatGuard(options.cwd),
        context: {...context, reviewMessages: () => [...userRequests, ...messages.filter(message => message.role === 'assistant')]},
        persist: async (message, step) => {
          const usage = state.takeUsage(message);
          await run.context.record(message, step, usage); messages.push(message);
        },
        observeProgress,
        directorWaiting,
        /** What ending this activity means for the round: it closes it, leaves it open (Director with dispatched work still open) or is no round (a teammate's message woke an idle actor). */
        effect: () => roundEffect(options.store.getSnapshot().activities, run.context.sessionId, run.context.ownerId, inputKind(run.context)),
        drainInbox: async (closing = false) => {
          lastDrain = Date.now();
          const incoming = await (closing && run.context.closeInbox ? run.context.closeInbox() : run.context.drainInbox?.()) ?? [];
          if (!incoming.length) return false;
          messages.push(...incoming);
          const humanInputs = run.context.humanInputs?.();
          if (humanInputs) userRequests.splice(0, userRequests.length, ...[...new Set(humanInputs)].slice(-8).map(text => ({role: 'user' as const, text})));
          const inboundRecovery = run.context.inboundRecovery?.();
          if (inboundRecovery) run.context = {...run.context, recovery: inboundRecovery};
          run.context.acceptRoundMemory?.(null);
          state.newInput();
          return true;
        },
        owesReply: () => state.mayRemindOwed && asks.owed(run.context.sessionId, run.context.ownerId).length > 0,
        // An actor about to finish answers what it owes first, then waits for what it is owed; only then may its task end.
        // Owed replies come first so two actors asking each other are told to answer before either can park.
        holdClose: async () => {
          if (run.owesReply()) {
            state.replyOwed(askOwedAtClose(asks.owed(run.context.sessionId, run.context.ownerId)));
            run.context.acceptRoundMemory?.(null);
            return true;
          }
          if (!wait.pending) return false;
          run.context.report('Waiting', wait.describe());
          await wait.park();
          return true;
        },
        recoverOutput: async (kind, thinkingId) => {
          const context = run.context;
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
          state.recovering(kind, repeated => executionRecoveryInstruction(kind, context.ownerId, repeated));
        },
      };
      run.context.acceptRoundMemory?.(null);
      const buildInstruction = (assembly: AgentAssembly): Promise<RequestInstruction> => options.requestBase ? options.requestBase(run.context, assembly)
        : agentRequestBase(options.cwd, run.context.ownerId, options.extraRegistrations ?? options.extraTools, options.resources,
          undefined, true, undefined, undefined, undefined, assembly);

      for (;;) {
        run.context.signal.throwIfAborted();
        await run.drainInbox();
        const waitNotices = wait.take();
        if (waitNotices.length) {
          state.waitEnded();
          run.context.acceptRoundMemory?.(null);
        }
        const ready = await prepareRequest(run, buildInstruction, waitNotices);
        if (ready.kind === 'rebuild') continue;
        state.requestSent();
        run.context.report(state.recoveringKind ? state.recoveringKind === 'no_delivery' ? 'Adjusting' : 'Resuming' : 'Model processing',
          state.recoveringKind ? state.recovery : 'Round trip ' + state.iteration);
        const got = await requestTurn(run, ready);
        if (got.kind === 'rebuild') continue;
        if (got.kind === 'finished') {outcome = 'completed'; return;}
        const {turn, thinkingStep} = presentTurn(run, ready, got);
        const {request, thinkingId} = got;
        const {prepared} = ready;
        // Where this activity does not close a round, round memory is not asked for and a `_FinishRound` call is answered normally and otherwise ignored.
        const closes = state.closing || run.effect() === 'closes';
        const kind = classifyTurn(turn, {closing: state.closing, closes, peerPending: wait.pending || run.owesReply(), directorWaiting: directorWaiting(), offered: ready.definitions});
        if (kind.kind !== 'finish_round_outside_round' && kind.kind !== 'finish_round' && kind.kind !== 'tools' && prepared && !run.context.signal.aborted) {
          options.context?.observe(run.context, request, turn, prepared.model);
        }
        if (await settleReply(run, kind, {ready, request, turn, thinkingId, thinkingStep}) === 'done') {outcome = 'completed'; return;}
      }
    } finally {
      // Natural end or not, the actors waiting on this one are told to stop waiting, and its own questions lapse.
      asks.endRecipient(context.sessionId, context.ownerId, lastDrain);
      if (!isDirector(context.ownerId)) asks.dropAsker(context.activityId);
      steps.close(context.signal.aborted ? 'cancelled' : outcome); await taskModel?.finish(context.signal.aborted ? 'cancelled' : outcome);}
  };
}

