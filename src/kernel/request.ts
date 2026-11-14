import {createHash} from 'node:crypto';
import type {ResolvedTool} from '../tools/catalog.js';
import {normalizeMessages, withoutAnsweredUnexecuted, type ModelRequest, type ToolDefinition} from '../runtime/messages.js';
import {FALLBACK_CAPABILITIES, storesSnapshot} from '../providers/capabilities.js';
import {ProviderError} from '../providers/http.js';
import {roleCacheRetention} from '../providers/cache.js';
import {createRuntimeContextMessage, isTransientContext, withoutAnsweredTransient, type RuntimeContextMessage} from '../runtime/context-updates.js';
import {omitInternalToolPairs} from '../context/round-memory.js';
import {askOwedWhileWorking} from '../prompts/runtime/recovery.js';
import {ENSEMBLE_SNAPSHOT_EMPTY} from '../prompts/runtime/director.js';
import {FINISH_ROUND_FOLLOW_UP} from '../tools/protocol/_FinishRoundTool/prompt.js';
import type {AgentAssembly, AgentRequestBase} from './agent.js';
import type {AgentRun} from './run.js';

/** Model requests an actor may work with an unanswered question before its single working reminder. */
const ASK_WORK_REMINDER_AFTER = 4;

export class UserCancelledError extends Error {
  readonly stopReason = 'user' as const;
  constructor(message = 'Reached this round\'s execution limit; user chose to stop') {
    super(message);
    this.name = 'UserCancelledError';
  }
}

/** One cache route per session and actor, opaque and bounded so no path or name leaves the machine. */
export function promptCacheKey(sessionId: string, ownerId: string): string {
  return 'logox-' + createHash('sha256').update(sessionId + '\0' + ownerId).digest('hex').slice(0, 32);
}

export type RequestInstruction = Omit<AgentRequestBase, 'pool'> & {pool?: readonly ResolvedTool[]};
type ContextManagerPrepare = NonNullable<AgentRun['options']['context']>['prepare'];
export type Prepared = NonNullable<Awaited<ReturnType<ContextManagerPrepare>>>;

export interface ReadyRequest {
  readonly kind: 'ready';
  readonly assembly: AgentAssembly;
  readonly instruction: RequestInstruction;
  /** The tool list exactly as sent (without `$schema`). */
  readonly base: {readonly tools: readonly ToolDefinition[]};
  /** The tools offered in this request. */
  readonly definitions: readonly ToolDefinition[];
  readonly prepared: Prepared | undefined;
  readonly request: ModelRequest;
  readonly appendUpdate: (value: RuntimeContextMessage) => Promise<boolean>;
}

/** Appends a host context message unless the same note is already the latest of its kind and slot. */
export function contextAppender(run: AgentRun, appendOnly: boolean): (value: RuntimeContextMessage) => Promise<boolean> {
  return async value => {
    const {context, messages, options} = run;
    const update = value.kind.startsWith('environment-') || value.kind === 'capability-change' ? value : {...value, data: {...value.data, activityId: context.activityId}};
    const previousIndex = messages.findLastIndex(message => message.role === 'context' && message.kind === update.kind &&
      message.data?.activityId === update.data?.activityId && (message.data?.slot ?? '') === (update.data?.slot ?? ''));
    const previous = messages[previousIndex];
    // A transient note the model already answered is no longer in its requests, so the same text may be needed again.
    const dropped = !appendOnly && isTransientContext(update) && messages.slice(previousIndex + 1).some(message => message.role === 'assistant');
    if (previous?.role !== 'context' || dropped || previous.text !== update.text || JSON.stringify(previous.data) !== JSON.stringify(update.data)) {
      context.signal.throwIfAborted();
      await run.persist(update);
      options.contextUpdated?.(context, update);
      return true;
    }
    return false;
  };
}

/**
 * Builds the next request: instruction, context updates and request-only notes, budgeted projection, stage lines and cache fields.
 * `rebuild` means input arrived meanwhile and the caller must start over.
 */
export async function prepareRequest(run: AgentRun, buildInstruction: (assembly: AgentAssembly) => Promise<RequestInstruction>,
  waitNotices: readonly {readonly id: string; readonly text: string}[]): Promise<ReadyRequest | {readonly kind: 'rebuild'}> {
  const {options, state, messages, taskModel} = run;
  const context = run.context;
  const activeProvider = taskModel?.provider() ?? options.provider();
  const assembly: AgentAssembly = {capabilities: await activeProvider.resolveCapabilities?.(context.signal) ?? activeProvider.capabilities ?? FALLBACK_CAPABILITIES, history: messages};
  const instruction = await buildInstruction(assembly);
  if (state.iterationsSpent(options.iterations)) {
    const outcome = await context.ask({kind: 'question', title: 'Continue this task?', questions: [{
      id: 'continue', header: 'Iterations', question: 'Reached ' + options.iterations + ' model round trips. Continue?',
      options: [{id: 'yes', label: 'Continue', description: 'Add another budget quota of round trips.'}, {id: 'no', label: 'Stop', description: 'Keep current results and end task.'}],
    }]});
    if (outcome.status !== 'answered' || outcome.response.kind !== 'question' ||
      outcome.response.answers.continue?.type !== 'option' || outcome.response.answers.continue.optionId !== 'yes') {
      throw new UserCancelledError();
    }
    state.iterationsExtended();
  }
  // Refused tools stay in the request (the cache prefix starts with the tool list); calls to them are answered with an error instead.
  const definitions = instruction.tools;
  const visionEnabled = typeof options.supportsVision === 'function' ? options.supportsVision() : (options.supportsVision ?? true);
  const appendOnly = assembly.capabilities.appendOnlyHistory === true;
  const appendUpdate = contextAppender(run, appendOnly);
  for (const update of 'contextUpdates' in instruction ? instruction.contextUpdates ?? [] : []) await appendUpdate(update);
  // Where the API binds thinking to history (`appendOnlyHistory`) or caches only the previous request as a whole (`conversationCache`), the snapshot is a stored record
  // appended when its (stable) text changes, so consecutive requests stay pure appends; elsewhere it rides last on one request and is never stored.
  const storedSnapshot = storesSnapshot(assembly.capabilities);
  if (storedSnapshot) {
    const lastEnsemble = messages.findLast(message => message.role === 'context' && message.kind === 'task-state' && message.data?.slot === 'ensemble');
    const text = instruction.snapshot || (lastEnsemble && lastEnsemble.text !== ENSEMBLE_SNAPSHOT_EMPTY ? ENSEMBLE_SNAPSHOT_EMPTY : '');
    if (text) await appendUpdate(createRuntimeContextMessage('task-state', text, {slot: 'ensemble'}));
  }
  for (const notice of waitNotices) {
    await appendUpdate(createRuntimeContextMessage('task-state', notice.text, {slot: 'wait-' + notice.id}));
    options.store.message(context.sessionId, context.ownerId, 'notice', notice.text, {activityId: context.activityId});
  }
  for (const ask of run.asks.owed(context.sessionId, context.ownerId)) {
    if (state.owedSeen(ask.id) === ASK_WORK_REMINDER_AFTER) await appendUpdate(createRuntimeContextMessage('reminder', askOwedWhileWorking(ask.from, ask.label), {slot: 'owed-' + ask.id}));
  }
  if (state.recovery) await appendUpdate(createRuntimeContextMessage('reminder', state.recovery));
  if (state.closing) await appendUpdate(createRuntimeContextMessage('finalizer', FINISH_ROUND_FOLLOW_UP));
  const base = {system: instruction.system,
    ...(instruction.toolDiscovery ? {toolDiscovery: instruction.toolDiscovery} : {}),
    // Tool fields and validation are unchanged; omits the draft-version URL repeated in every schema.
    tools: definitions.map(tool => {const {$schema: _, ...parameters} = tool.parameters; return {...tool, parameters};})};
  const prepared = await options.context?.prepare(context, base, context.signal, false, undefined, appendOnly);
  if (await run.drainInbox()) return {kind: 'rebuild'};
  if (taskModel && prepared && prepared.model.identity !== taskModel.model().identity) {
    throw new ProviderError('Task model and context budget identity mismatch; wire ContextManager.model to TaskModels.model');
  }
  const initialProjection = prepared?.request ?? {...base, messages};
  // A transient last message only re-bills that final block on providers with automatic prefix caching; the stored prefix stays byte-identical.
  const snapshot = instruction.snapshot && !storedSnapshot ? [createRuntimeContextMessage('snapshot', instruction.snapshot, {activityId: context.activityId})] : [];
  // Hiding finished `_FinishRound` pairs, answered reminders, answered never-executed turns and old finalizer notes saves tokens, but on an append-only protocol it is a history edit.
  const projected = {...initialProjection, messages: [...normalizeMessages(appendOnly ? initialProjection.messages : omitInternalToolPairs(withoutAnsweredUnexecuted(withoutAnsweredTransient(initialProjection.messages))))
    .filter(message => appendOnly || message.role !== 'context' || message.kind !== 'finalizer' || state.closing && message.data?.activityId === context.activityId)
    // Sessions saved before snapshots stopped being stored still hold old copies; removing them is itself a history edit where that matters.
    .filter(message => appendOnly || message.role !== 'context' || message.data?.slot !== 'director-facts'), ...snapshot]};
  // A signature belongs only to the model that produced it; keep the full ledger and tool pairing, and do not replay old signed thinking on a switched request.
  let request: ModelRequest = state.foreignSignatures.size ? {...projected, supportsVision: visionEnabled, messages: projected.messages.map(message =>
    message.role === 'assistant' && message.signature && state.foreignSignatures.has(message.signature)
      ? {role: 'assistant' as const, text: message.text, ...(message.toolCalls ? {toolCalls: message.toolCalls} : {})} : message)} : {...projected, supportsVision: visionEnabled, messages: projected.messages};
  const dumpDir = options.requestDumpDir?.(context);
  const fingerprintFile = options.requestFingerprintFile?.(context);
  request = {...request, cacheKey: promptCacheKey(context.sessionId, context.ownerId),
    cacheRetention: {role: roleCacheRetention(context.ownerId), ...(instruction.cacheRetention ? {actor: instruction.cacheRetention} : {})}, ...(dumpDir ? {dumpDir} : {}),
    ...(fingerprintFile ? {fingerprint: {file: fingerprintFile, ownerId: context.ownerId, activityId: context.activityId, purpose: 'task'}} : {})};
  return {kind: 'ready', assembly, instruction, base, definitions, prepared, request, appendUpdate};
}
