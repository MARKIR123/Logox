import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeMessages, type ModelMessage, type ModelRequest, type ModelTurn, type Provider, type ToolCall, type ToolDefinition} from '../runtime/messages.js';
import {createRuntimeContextMessage, withoutAnsweredTransient} from '../runtime/context-updates.js';
import {FALLBACK_CAPABILITIES} from '../providers/capabilities.js';
import {omitImages} from '../providers/vision-fallback.js';
import {ECHO_REMINDER, ECHO_STOP_ERROR, TEXT_CALL_RECOVERED_NOTE, executionRecoveryInstruction} from '../prompts/runtime/recovery.js';
import {refineTurn} from './turn-refine.js';
import type {ToolResult} from '../tools/types.js';
import {settleToolResults} from './scratchpad.js';
import {LOOP_STREAK, RepeatGuard} from './repeat-guard.js';
import {retryDelay} from './model-turn.js';

/**
 * The worker seam of the kernel: one stateless run with its own system prompt, tool set and permission path, no ledger and no round memory.
 * `createAgent` is bound to a store activity, steps, a journal-backed history and round closure, none of which a worker has, so a worker
 * reuses the kernel's separable parts instead (retry schedule with `retryAfterMs`, request projection rules, oversized-output offload
 * into the worker's own directory, the repeat guard, the truncation instruction) around the same loop shape: request, classify the
 * turn, run the tools in model order, settle their results, append the reminders.
 */
export type WorkerProvider = Pick<Provider, 'respond'> & Partial<Pick<Provider, 'capabilities' | 'resolveCapabilities'>>;

/** The tool that ends a run, with the texts the loop answers it with. */
export interface WorkerTerminal<T> {
  readonly name: string;
  /** Request-only reminder for a turn that called no tool. */
  readonly reminder: string;
  /** The answer to this tool when it arrived in a batch with other calls (those ran; it did not). */
  readonly alone: string;
  /** The tool result stored for an accepted call, so a kept worker's history stays paired. */
  readonly accepted: string;
  /**
   * A complete turn with text and no tool call ends the run with that text as its result. Models end their work with a plain reply by habit;
   * the terminal tool stays the way to hand back structure (and is accepted by name even where the request does not declare it, as in a fork).
   */
  readonly plain?: ((text: string) => T) | undefined;
  settle(call: ToolCall): {readonly ok: true; readonly value: T} | {readonly ok: false; readonly text: string};
}

export interface WorkerRun<T> {
  readonly provider: WorkerProvider;
  readonly model: string;
  /** False: images in tool results become a line of text. Absent counts as yes. */
  readonly vision?: boolean | undefined;
  readonly system: string;
  readonly tools: readonly ToolDefinition[];
  /**
   * A fork: its requests are the dispatcher's own request `frame` (system, tools and every option exactly as sent) followed by `prefix` (the dispatcher's
   * messages and the turn that called it, sent as they are, never projected again) and then the projection of `messages`. `system`, `tools` and `cacheKey`
   * are not used.
   */
  readonly fork?: {readonly frame: Omit<ModelRequest, 'messages'>; readonly prefix: readonly ModelMessage[]} | undefined;
  /** The history; grows in place, so the caller can keep it. */
  readonly messages: ModelMessage[];
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly sessionId: string;
  /** Names the worker's own directory (`tool-results/`, `images/`) under the session scratchpad. */
  readonly workerId: string;
  readonly cacheKey: string;
  /** Provider retries per request; a temporary failure waits at least the cooldown it states. */
  readonly retries: number;
  readonly terminal: WorkerTerminal<T>;
  /** Calls that only observe may run side by side, `concurrency` at a time (`permissions.readonly_concurrency`); absent: strictly in order. */
  readOnly?(call: ToolCall): boolean;
  readonly concurrency?: number | undefined;
  /** Runs one business call (permissions, locks and grants live behind it). */
  executeCall(call: ToolCall): Promise<ToolResult>;
  /** As soon as a turn arrives, before cancellation is checked: the tokens were spent either way. */
  onUsage?(turn: ModelTurn): void;
  /** After each model turn is appended to the history. */
  onTurn?(turn: ModelTurn): void | Promise<void>;
  /** After a call's result was settled (offloaded, imaged) and stored; `text` is what the model sees. */
  onResult?(call: ToolCall, result: ToolResult, text: string): void | Promise<void>;
}

export type WorkerEnd<T> =
  | {readonly kind: 'finished'; readonly value: T; readonly imagesOmitted: boolean; /** Ended by a plain reply (`WorkerTerminal.plain`), not by the terminal tool. */ readonly plain?: true}
  /** Three turns in a row without a tool call or text: a stall rule, not a budget. */
  | {readonly kind: 'stalled'; readonly lastText: string; readonly imagesOmitted: boolean}
  /** The terminal tool was refused `REFUSED_TERMINAL_LIMIT` times in a row; `reason` is the last refusal. */
  | {readonly kind: 'refused'; readonly reason: string; readonly imagesOmitted: boolean};

/** Consecutive refusals of the terminal tool's arguments that end the run, so a model that keeps sending the same bad call cannot loop. */
export const REFUSED_TERMINAL_LIMIT = 2;

const NOT_EXECUTED = 'Not executed: the response was cut off and the arguments may be incomplete. Reissue the call.';

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

async function respondWithRetries(run: WorkerRun<unknown>, request: ModelRequest): Promise<ModelTurn> {
  for (let attempt = 0;; attempt++) {
    run.signal.throwIfAborted();
    try {return await run.provider.respond(request, () => {}, run.signal);}
    catch (error) {
      if (run.signal.aborted || attempt >= run.retries || (error as {retryable?: unknown}).retryable !== true) throw error;
      await delay(retryDelay(error, attempt).ms, undefined, {signal: run.signal});
    }
  }
}

/** Runs the loop until the terminal tool is accepted or the worker stalls; cancellation and provider failures throw. */
export async function runWorker<T>(run: WorkerRun<T>): Promise<WorkerEnd<T>> {
  const {messages, terminal} = run;
  const repeat = new RepeatGuard(run.cwd);
  const note = (text: string, slot: string) => messages.push(createRuntimeContextMessage('reminder', text, {slot, activityId: run.workerId}));
  let imagesOmitted = false, silent = 0, echoes = 0, truncatedBefore = false, refusals = 0;
  for (let turnNumber = 1;; turnNumber++) {
    run.signal.throwIfAborted();
    const capabilities = await run.provider.resolveCapabilities?.(run.signal) ?? run.provider.capabilities ?? FALLBACK_CAPABILITIES;
    const projected = normalizeMessages(capabilities.appendOnlyHistory === true ? messages : withoutAnsweredTransient(messages));
    const blind = run.vision === false ? omitImages(projected, run.model, 'worker') : undefined;
    if (blind?.omitted) imagesOmitted = true;
    const request: ModelRequest = run.fork ? {...run.fork.frame, messages: [...run.fork.prefix, ...blind?.messages ?? projected]}
      : {system: run.system, messages: blind?.messages ?? projected,
        tools: run.tools.map(tool => {const {$schema: _schema, ...parameters} = tool.parameters; return {...tool, parameters};}),
        supportsVision: run.vision !== false, cacheKey: run.cacheKey, cacheRetention: {role: 'short'}};
    const answered = await respondWithRetries(run, request);
    run.onUsage?.(answered);
    // The same step as an actor's turn: a call written as text becomes a real one, repeated runtime text leaves the reply.
    const turn = refineTurn(answered, request);
    run.signal.throwIfAborted();
    // A call id is unique in the history: a missing or repeated one (models reuse "call_1") is replaced, as actors' calls are.
    const seen = new Set(messages.flatMap(message => message.role === 'assistant' ? (message.toolCalls ?? []).map(call => call.id) : []));
    for (const call of turn.message.toolCalls ?? []) {
      if (!call.id || seen.has(call.id)) call.id = randomUUID();
      seen.add(call.id);
    }
    messages.push(turn.message);
    await run.onTurn?.(turn);
    const calls = turn.message.toolCalls ?? [];
    if (!calls.length) {
      // A complete plain reply is the result.
      if (terminal.plain && turn.stop !== 'length' && !turn.echo && turn.message.text.trim()) return {kind: 'finished', value: terminal.plain(turn.message.text.trim()), imagesOmitted, plain: true};
      // A turn with neither a tool call nor a usable reply leaves the job open; only a streak of them is a stall.
      echoes = turn.echo ? echoes + 1 : 0;
      if (++silent >= LOOP_STREAK) return {kind: 'stalled', lastText: echoes >= LOOP_STREAK ? ECHO_STOP_ERROR : turn.message.text.trim(), imagesOmitted};
      note(turn.echo ? ECHO_REMINDER : terminal.reminder, turn.echo ? 'echo' : 'no-tool');
      continue;
    }
    silent = 0; echoes = 0;
    const truncated = turn.stop === 'length';
    const closing = truncated ? undefined : calls.find(call => call.name === terminal.name);
    const business = calls.filter(call => call !== closing);
    const results: ToolResult[] = [];
    // Model-chosen call ids repeat across turns and workers, and they name offloaded output files.
    const scope = (call: ToolCall): ToolCall => ({...call, id: safeId(`${run.workerId}-${turnNumber}-${call.id}`)});
    if (truncated) for (const _call of business) results.push({text: NOT_EXECUTED, isError: true});
    else {
      // As in an actor's turn: a run of read-only calls goes in parallel groups of `concurrency`, everything else keeps the model's order.
      const width = Math.max(1, run.concurrency ?? 1);
      for (let start = 0; start < business.length;) {
        let end = start + 1;
        const reading = width > 1 && run.readOnly?.(business[start]!) === true;
        if (reading) while (end < business.length && run.readOnly!(business[end]!)) end++;
        for (let offset = start; offset < end; offset += reading ? width : 1) {
          run.signal.throwIfAborted();
          const group = business.slice(offset, reading ? Math.min(end, offset + width) : offset + 1);
          // Every started call finishes before the turn goes on, so a cancellation leaves nothing running.
          const settledGroup = await Promise.allSettled(group.map(call => run.executeCall(scope(call))));
          for (const outcome of settledGroup) if (outcome.status === 'rejected') throw outcome.reason;
          for (const outcome of settledGroup) results.push((outcome as PromiseFulfilledResult<ToolResult>).value);
        }
        start = end;
      }
    }
    const settled = await settleToolResults(business.map((call, index) => ({callId: safeId(`${run.workerId}-${turnNumber}-${call.id}`), text: results[index]!.text, images: results[index]!.images, tool: call.name, arguments: call.arguments})),
      run.cwd, run.sessionId, run.workerId);
    let loopNote: string | undefined;
    for (const [index, call] of business.entries()) {
      const result = results[index]!, output = settled[index]!;
      let text = output.text;
      if (!truncated) {
        const unchanged = repeat.readNote(call, result);
        if (unchanged) text += '\n' + unchanged;
        loopNote = repeat.loopNote(call, result, false) ?? loopNote;
      }
      messages.push({role: 'tool', callId: call.id, name: call.name, text, isError: Boolean(result.isError), ...(output.images ? {images: output.images} : {}), ...(truncated ? {unexecuted: true as const} : {})});
      await run.onResult?.(call, result, text);
    }
    if (truncated) {
      for (const call of calls.filter(item => item.name === terminal.name)) messages.push({role: 'tool', callId: call.id, name: call.name, text: NOT_EXECUTED, isError: true, unexecuted: true});
      note(executionRecoveryInstruction('truncated_tools', run.workerId, truncatedBefore), 'truncated');
      truncatedBefore = true;
    } else if (closing) {
      const decision = business.length ? {ok: false as const, text: terminal.alone} : terminal.settle(closing);
      if (decision.ok) {
        messages.push({role: 'tool', callId: closing.id, name: closing.name, text: terminal.accepted, isError: false});
        return {kind: 'finished', value: decision.value, imagesOmitted};
      }
      messages.push({role: 'tool', callId: closing.id, name: closing.name, text: decision.text, isError: true});
      // Only a refused argument counts toward the limit: a call that merely came with others is answered with its fix and is no repeat.
      if (!business.length && ++refusals >= REFUSED_TERMINAL_LIMIT) return {kind: 'refused', reason: decision.text, imagesOmitted};
    }
    if (!closing || business.length) refusals = 0;
    if (loopNote) note(loopNote, 'loop');
    if (turn.recovered) note(TEXT_CALL_RECOVERED_NOTE, 'text-call');
  }
}
