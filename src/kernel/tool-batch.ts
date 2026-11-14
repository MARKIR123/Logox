import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {ModelMessage, ModelRequest, ModelTurn, ToolCall} from '../runtime/messages.js';
import type {Step} from '../runtime/contracts.js';
import {validateToolCall, canonicalToolName, type ToolResult} from '../tools/tools.js';
import {extractDiscoveredToolNames, resolveToolLoad} from '../tools/discovery.js';
import {loadToolsSchema} from '../tools/protocol/LoadToolsTool/LoadToolsTool.js';
import {diagnoseToolError} from '../tools/diagnostics.js';
import {toolProgressFingerprint} from './execution-recovery.js';
import {isReadOnlyTool} from '../tools/catalog.js';
import {sendMessageSchema} from '../tools/coordination/SendMessageTool/SendMessageTool.js';
import {AUTOMA_TOOL_NAME} from '../tools/orchestration/AutomaTool/prompt.js';
import {settleToolResults} from './scratchpad.js';
import {TOOL_CANCELLED_TEXT, DIRECTOR_INTERRUPTED_TOOL_TEXT, USER_INTERRUPTED_TOOL_TEXT} from '../prompts/runtime/interruption.js';
import {isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import type {Prepared, ReadyRequest} from './request.js';
import type {AgentRun} from './run.js';

/** The tool result for a call cut off by a stop: names the user or the Director, else the generic fallback. */
export function interruptedToolText(reason: 'user' | 'shutdown' | 'interrupted' | 'director_cancel' | undefined, fallback: string): string {
  return reason === 'user' ? USER_INTERRUPTED_TOOL_TEXT : reason === 'director_cancel' ? DIRECTOR_INTERRUPTED_TOOL_TEXT : fallback;
}

const NOT_EXECUTED_TEXT = 'This batch of tools was not executed: the response did not end normally or the arguments were incomplete. Reissue complete tool calls.';

export interface ToolBatch {
  readonly ready: ReadyRequest;
  readonly prepared: Prepared | undefined;
  readonly request: ModelRequest;
  readonly turn: ModelTurn;
  readonly thinkingId: string;
  readonly truncated: boolean;
}

/** What the loop needs after the batch: the Automa reminder to deliver and whether the batch was answered with the restriction text. */
export interface ToolBatchResult {
  readonly automaNote: string | undefined;
  /** The reminder for a streak of identical calls with unchanged results (`repeat-guard.ts:RepeatGuard.loopNote`). */
  readonly loopNote: string | undefined;
  readonly refused: boolean;
}

/** Gives every call a unique id: a missing or repeated one is replaced. */
export function uniqueCallIds(calls: ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id || ids.has(call.id)) call.id = randomUUID();
    ids.add(call.id);
  }
}

/** A tool that only observes cannot leave partial side effects, so a batch of them keeps its valid calls. */
function observationOnly(run: AgentRun, call: ToolCall): boolean {
  return isReadOnlyTool(call.name) && !run.options.extraTools?.some(tool => tool.name.toLowerCase() === call.name.toLowerCase());
}

/** Availability and argument checks for a complete batch; the message per call id is the reason it cannot run. */
async function validateBatch(run: AgentRun, ready: ReadyRequest, calls: readonly ToolCall[]): Promise<Map<string, string>> {
  const {options} = run;
  const schemaErrors = new Map<string, string>();
  const current = options.requestBase ? await options.requestBase(run.context, {capabilities: ready.assembly.capabilities, history: run.messages}) : ready.instruction;
  for (const call of calls) {
    if (isFinishRound(call.name)) continue; // answered with a normal result when it runs
    const canonical = canonicalToolName(call.name);
    const eligible = current.pool?.some(item => item.definition.name.toLowerCase() === (canonical ?? call.name).toLowerCase()) ?? true;
    const callableNow = current.tools.some(tool => tool.name.toLowerCase() === (canonical ?? call.name).toLowerCase());
    if (!eligible || !callableNow) {
      schemaErrors.set(call.id, 'Tool is no longer available for this actor: ' + call.name);
      continue;
    }
    const toolMatch = ready.base.tools.find(tool =>
      tool.name.toLowerCase() === call.name.toLowerCase() ||
      (canonical && canonicalToolName(tool.name) === canonical)
    );
    if (!toolMatch) {
      schemaErrors.set(call.id, 'Unknown tool: ' + call.name + '. Available tools: ' + ready.base.tools.map(t => t.name).join(', '));
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
  return schemaErrors;
}

/**
 * Validates and runs one business tool batch, then stores the results in model order.
 * A truncated batch executes nothing; a batch with an invalid call is void unless every call only observes; a restricted request answers every call with its restriction.
 * Calls still without a result when the batch ends early are completed as interrupted.
 */
export async function runToolBatch(run: AgentRun, batch: ToolBatch): Promise<ToolBatchResult> {
  const {options, steps} = run;
  const {ready, prepared, request, turn, thinkingId, truncated} = batch;
  const {instruction} = ready;
  const refusal = instruction.refuseTools;
  const calls = turn.message.toolCalls ?? [];
  const schemaErrors = !truncated ? await validateBatch(run, ready, calls) : new Map<string, string>();
  const voidBatch = schemaErrors.size > 0 && calls.some(call => !observationOnly(run, call));
  if (truncated) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: 'Tool arguments were incomplete and this batch was not executed; switch to smaller, complete calls.'}});
  else if (schemaErrors.size) options.store.updateMessage(thinkingId, {step: {...steps.get(thinkingId), note: 'Tool argument validation failed; ' +
    (voidBatch ? 'the whole batch was not executed: ' : 'the other read-only calls ran: ') + [...schemaErrors.values()][0]}});
  const reasoning = turn.message.reasoning || options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text;
  await run.persist(truncated ? {...turn.message, toolsExcluded: true, ...(reasoning ? {reasoning} : {})} : {...turn.message, ...(reasoning ? {reasoning} : {})}, steps.get(thinkingId));
  if (prepared) options.context?.observe(run.context, request, truncated ? {...turn, stop: 'other'} : turn, prepared.model);
  // The same conditions `execute` below answers with an error before running anything; marks the stored result for the request projection.
  const neverRan = (call: ToolCall) => isFinishRound(call.name) ? truncated || voidBatch
    : truncated || !!refusal || schemaErrors.has(call.id) || voidBatch;
  const completed = new Set<string>();
  let automaNote: string | undefined, loopNote: string | undefined;
  const toolIds = new Map(calls.map(call => [call.id, steps.tool(call,
    instruction.pool?.find(item => item.definition.name === (canonicalToolName(call.name) ?? call.name))?.metadata.terminalVisibility)]));
  try {
    const execute = async (call: ToolCall): Promise<ToolResult> => {
      const context = run.context;
      if (isFinishRound(call.name) && !truncated) return {text: '', isError: false};
      if (refusal && !truncated) return {text: refusal, isError: true, disposition: 'error'};
      if (truncated) return {text: NOT_EXECUTED_TEXT, isError: true};
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
        const result = resolveToolLoad(loadToolsSchema.parse(JSON.parse(call.arguments)), instruction.pool ?? [], extractDiscoveredToolNames(run.messages));
        return {text: JSON.stringify(result), isError: false, discoveredTools: [...result.loaded, ...result.alreadyLoaded]};
      }
      const matchedExtra = options.extraTools?.find(tool =>
        tool.name.toLowerCase() === call.name.toLowerCase() ||
        (canonical && canonicalToolName(tool.name) === canonical)
      );
      if (matchedExtra && options.executeExtra) {
        if (!run.approvalHandled.has(call.name) && !run.approvalHandled.has(matchedExtra.name)) {
          if (!await options.tools.authorizeExtension(call, toolContext)) return {text: 'Extension tool action was not permitted; find another approach.', isError: true, disposition: 'denied'};
          toolContext.startTool();
        }
        return options.executeExtra(call, toolContext);
      }
      return options.tools.execute(call, toolContext);
    };
    for (let start = 0; start < calls.length;) {
      let end = start + 1;
      if (!truncated && !voidBatch && observationOnly(run, calls[start]!)) while (end < calls.length && observationOnly(run, calls[end]!)) end++;
      for (let offset = start; offset < end; offset += run.concurrency) {
        run.context.signal.throwIfAborted();
        const group = calls.slice(offset, Math.min(end, offset + run.concurrency));
        // Wait for all started tools to finish, then save in model order; cancellation will not leave background processes.
        const results = await Promise.allSettled(group.map(async call => {
          const context = run.context;
          const id = toolIds.get(call.id)!;
          try {
            const rawResult = await execute(call);
            const result = diagnoseToolError(call, rawResult);
            const sent = (canonicalToolName(call.name) ?? call.name) === 'SendMessage' && !result.isError ? sendMessageSchema.safeParse(JSON.parse(call.arguments)) : undefined;
            if (sent?.success && sent.data.type === 'reply') run.asks.answer(context.sessionId, context.ownerId, sent.data.to);
            if (sent?.success && sent.data.type === 'ask') {
              run.asks.open({sessionId: context.sessionId, from: context.ownerId, fromActivityId: context.activityId, to: sent.data.to,
                label: (sent.data.summary || sent.data.message).replace(/\s+/g, ' ').slice(0, 120)});
              // The call is done once delivered; "awaiting reply" is a card summary derived from the conversation, not a running step.
              steps.finish(id, context.signal.aborted ? 'cancelled' : 'completed', call.name + '\n' + result.text);
              return result;
            }
            const note = run.pacing.observe(call, result, {
              directorWaiting: run.directorWaiting(),
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
          const settledResult: ToolResult = settled.status === 'fulfilled' ? settled.value : diagnoseToolError(call, {text: run.context.signal.aborted ? TOOL_CANCELLED_TEXT : String(settled.reason), isError: true});
          // A deliberate stop says who stopped it; other cancellations keep the plain text.
          const result: ToolResult = run.context.signal.aborted && settledResult.isError && settledResult.text === TOOL_CANCELLED_TEXT
            ? {...settledResult, text: interruptedToolText(run.context.stopReason?.(), TOOL_CANCELLED_TEXT)} : settledResult;
          return result;
        });
        // Images get files, oversized results are offloaded, and the turn's total is capped, all decided once here and stored.
        const settledOutputs = await settleToolResults(finals.map((result, index) => ({callId: group[index]!.id, text: result.text, images: result.images,
          tool: canonicalToolName(group[index]!.name) ?? group[index]!.name, arguments: group[index]!.arguments})),
          options.cwd, run.context.sessionId, run.context.ownerId);
        for (let index = 0; index < group.length; index++) {
          const call = group[index]!, result = finals[index]!, output = settledOutputs[index]!;
          const step = steps.get(toolIds.get(call.id)!);
          // Observed in model order on the undecorated result: a fact about this read goes into its result, a streak of identical calls into one reminder.
          let text = output.text;
          if (!neverRan(call)) {
            const unchanged = run.repeat.readNote(call, result);
            if (unchanged) text += '\n' + unchanged;
            const looping = run.repeat.loopNote(call, result, run.directorWaiting());
            if (looping) loopNote = looping;
          }
          const toolMessage: ModelMessage = {
            role: 'tool', callId: call.id, name: call.name,
            text, isError: result.isError,
            ...(result.discoveredTools ? {discoveredTools: result.discoveredTools} : {}),
            ...(output.images ? {images: output.images} : {}),
            ...(neverRan(call) ? {unexecuted: true as const} : {}),
          };
          await run.persist(toolMessage, step);
          const fingerprint = !truncated && !schemaErrors.size ? toolProgressFingerprint(call, result) : undefined;
          if (fingerprint) await run.observeProgress(fingerprint);
          completed.add(call.id);
        }
      }
      start = end;
    }
  } finally {
    for (const call of calls) if (!completed.has(call.id)) {
      const step = steps.finish(toolIds.get(call.id)!, 'cancelled', call.name + '\nTool execution was interrupted before a complete result was obtained.');
      await run.persist({role: 'tool', callId: call.id, name: call.name, text: interruptedToolText(run.context.stopReason?.(), 'Tool execution was interrupted before a complete result was obtained.'), isError: true}, step);
    }
  }
  return {automaNote, loopNote, refused: !!refusal && !truncated};
}
