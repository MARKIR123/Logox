import type {ModelRequest, ModelTurn} from '../runtime/messages.js';
import {extractNarration} from '../runtime/narration.js';
import {STAGE_HISTORY_LIMIT, type Step} from '../runtime/contracts.js';
import {TEXT_TOOL_CALL_NOTE} from '../prompts/runtime/recovery.js';
import {isTextToolCall} from './turn-outcome.js';
import type {ModelTurnResult} from './model-turn.js';
import {createRuntimeContextMessage} from '../runtime/context-updates.js';
import {normalizeFinishRound} from '../context/round-memory.js';
import {isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {FINISH_ROUND_CLOSING_TOOL_RESULT} from '../tools/protocol/_FinishRoundTool/prompt.js';
import {ExecutionRecoveryError} from './execution-recovery.js';
import {runToolBatch, uniqueCallIds} from './tool-batch.js';
import type {TurnOutcome} from './turn-outcome.js';
import type {ReadyRequest} from './request.js';
import type {AgentRun} from './run.js';

/** Shows a received turn in the timeline and bookkeeping (usage, keep-alive, stage line, text-call note), ending its thinking step. Returns the turn as the ledger will hold it. */
export function presentTurn(run: AgentRun, ready: ReadyRequest, got: Extract<ModelTurnResult, {kind: 'turn'}>): {turn: ModelTurn; thinkingStep: Step} {
  const {options, state, steps, stages} = run;
  const {request, thinkingId, textId, usedProvider, requestedAt} = got;
  const {prepared} = ready;
  let turn = got.turn;
  // The timeline message keeps the raw `⏵` line: stage.ts reads it to title the next tool group and strips it from prose.
  const storedText = turn.message.text;
  state.turnMetered(prepared ? options.context?.turnUsage(turn, prepared.model) : undefined);
  if (prepared && usedProvider) void options.keepAlive?.arm(run.context, {request, provider: usedProvider, model: prepared.model.identity, startedAt: requestedAt, usage: turn.usage});
  const extracted = extractNarration(turn.message.text);
  if (extracted) {
    // The ledger text drops the stage line; the `stage` field keeps it for later audits.
    turn = {...turn, message: {...turn.message, text: extracted.cleanText, stage: extracted.narration}};
    stages.push(extracted.narration);
    if (stages.length > STAGE_HISTORY_LIMIT) stages.splice(0, stages.length - STAGE_HISTORY_LIMIT);
    const next = {label: extracted.narration, stageHistory: [...stages]};
    void run.context.saveProgress?.(next);
    options.store.activities.update(run.context.sessionId, run.context.activityId, {progress: next});
  }
  if (state.closing) turn = {...turn, message: {...turn.message, memoryOnly: true as const}};
  // A call serialized as plain text executed nothing: it is not a delivery, and the card shows a short note instead of the dump.
  const textCall = isTextToolCall(turn, state.closing, ready.definitions);
  if (textCall && textId) options.store.updateMessage(textId, {text: TEXT_TOOL_CALL_NOTE, role: 'notice'});
  if (storedText && !textId && !state.closing) {
    if (steps.get(thinkingId).state === 'running') steps.finish(thinkingId, 'completed');
    steps.endGroup('completed'); steps.phase('text');
    options.store.message(run.context.sessionId, run.context.ownerId, textCall ? 'notice' : 'assistant', textCall ? TEXT_TOOL_CALL_NOTE : storedText, {activityId: run.context.activityId});
  }
  if (turn.message.reasoning && !options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text) options.store.updateMessage(thinkingId, {text: turn.message.reasoning});
  const thinkingStep = steps.get(thinkingId).state === 'running' ? steps.finish(thinkingId, 'completed') : steps.get(thinkingId);
  uniqueCallIds(turn.message.toolCalls ?? []);
  return {turn, thinkingStep};
}

/** What the loop does after a reply was handled: send another request, or the activity is complete. */
export type Next = 'again' | 'done';

/** The turn the model returned, with the request and the thinking step it belongs to. */
export interface Reply {
  readonly ready: ReadyRequest;
  readonly request: ModelRequest;
  readonly turn: ModelTurn;
  readonly thinkingId: string;
  readonly thinkingStep: Step;
}

/** Handles one classified reply. Statement order is part of the contract: ledger writes, store updates and requests happen in this order. */
export async function settleReply(run: AgentRun, kind: TurnOutcome, reply: Reply): Promise<Next> {
  const {options, state, steps, stages, persist, drainInbox, holdClose, recoverOutput, directorWaiting} = run;
  const {ready, request, turn, thinkingId, thinkingStep} = reply;
  const {prepared} = ready;
  const reasoningOf = () => turn.message.reasoning || options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text;
  const finishAsOutcome = async (): Promise<Next> => {
    if (await holdClose()) return 'again';
    if (await drainInbox(true)) return 'again';
    run.context.signal.throwIfAborted();
    return 'done';
  };
  switch (kind.kind) {
    case 'finish_round_outside_round': {
      // Where this activity does not close a round, round memory is not asked for and a `_FinishRound` call is answered normally and otherwise ignored.
      const calls = turn.message.toolCalls ?? [];
      const reasoning = reasoningOf();
      await persist({...turn.message, ...(reasoning ? {reasoning} : {})}, thinkingStep);
      if (prepared) options.context?.observe(run.context, request, turn, prepared.model);
      for (const call of calls) await persist({role: 'tool', callId: call.id, name: call.name, text: '', isError: false});
      run.context.signal.throwIfAborted();
      return finishAsOutcome();
    }
    case 'finish_round': {
      const calls = turn.message.toolCalls ?? [];
      const {closing} = state;
      const {truncated} = kind;
      const onlyFinalizer = kind.only;
      // Arguments are accepted leniently in one place; the call is rewritten to the accepted form so the ledger holds what the runtime used.
      const finishCall = calls.find(call => isFinishRound(call.name));
      const accepted = finishCall && !truncated ? normalizeFinishRound(finishCall.arguments, stages.at(-1) ?? run.context.taskTitle ?? '') : undefined;
      if (finishCall && accepted) calls[calls.indexOf(finishCall)] = {...finishCall, arguments: JSON.stringify(accepted)};
      if (!closing && turn.message.text.trim()) state.answerDelivered(turn.message.text);
      const allowed = ready.base.tools.some(tool => isFinishRound(tool.name));
      const valid = allowed && !!accepted && (closing || onlyFinalizer && !!state.finalText.trim());
      const error = !closing && !onlyFinalizer ? 'Terminal metadata must be the only tool in its batch. No business tools were executed.'
        : truncated ? 'Terminal metadata was truncated or the response did not end with tool calls.'
        : !allowed ? 'Terminal metadata is not available in this request.'
        : !accepted ? 'Round memory needs a non-empty summary.' : 'Deliver the final answer or task report before submitting round memory.';
      const reasoning = reasoningOf();
      await persist(truncated ? {...turn.message, toolsExcluded: true, ...(reasoning ? {reasoning} : {})} : {...turn.message, ...(reasoning ? {reasoning} : {})}, thinkingStep);
      if (prepared) options.context?.observe(run.context, request, turn, prepared.model);
      const sent = calls.find(call => isFinishRound(call.name));
      try {
        for (const call of calls) {
          const ok = valid && call === sent;
          await persist({role: 'tool', callId: call.id, name: call.name, text: ok ? '' : closing && call !== sent ? FINISH_ROUND_CLOSING_TOOL_RESULT : error, isError: !ok});
        }
      } catch (error) {
        run.context.signal.throwIfAborted();
        if (!state.finalText) throw error;
        if (await drainInbox(true)) return 'again';
        run.context.signal.throwIfAborted();
        options.store.message(run.context.sessionId, run.context.ownerId, 'notice', 'The response is preserved; round memory could not be recorded.', {activityId: run.context.activityId});
        return 'done';
      }
      run.context.signal.throwIfAborted();
      if ((valid || closing) && await holdClose()) return 'again';
      if (await drainInbox(valid || closing)) return 'again';
      run.context.signal.throwIfAborted();
      // The follow-up is asked once: whatever it held besides a usable call, the runtime writes the record and the round ends.
      if (valid) run.context.acceptRoundMemory?.(sent!.id);
      if (valid || closing) return 'done';
      if (state.finalText.trim()) {state.closingCallRequested(); return 'again';}
      // Nothing was ever delivered: the empty-reply recovery applies.
      if (!directorWaiting()) {
        if (state.emptyReplyReminder()) return 'again';
        throw new ExecutionRecoveryError('no_delivery', 'stop');
      }
      return 'done';
    }
    case 'tools': {
      const {truncated} = kind;
      const result = await runToolBatch(run, {ready, prepared, request, turn, thinkingId, truncated});
      // Delivered after the results as a request-only note, so the tool results stay clean in history.
      if (result.automaNote) await ready.appendUpdate(createRuntimeContextMessage('reminder', result.automaNote, {slot: 'automa'}));
      if (truncated) await recoverOutput('truncated_tools', thinkingId);
      else state.batchRan();
      // A refused batch is answered once. A second one in a row ends the exchange without another request, so a model that ignores the refusal cannot loop.
      if (state.batchSettled(result.refused)) {
        if (await drainInbox(true)) return 'again';
        run.context.signal.throwIfAborted();
        throw new ExecutionRecoveryError('no_delivery', 'stop');
      }
      return 'again';
    }
    case 'text_tool_call':
      // The raw text stays in the ledger for audit and in history so the model can reissue the call; it never becomes the report.
      try {await recoverOutput('text_tool_call', thinkingId);}
      finally {await persist({...turn.message, textToolCall: true as const}, thinkingStep);}
      return 'again';
    case 'closing_without_call':
      // The follow-up came back without a call: the delivered text stands and the runtime writes the record.
      await persist(turn.message, thinkingStep);
      run.context.signal.throwIfAborted();
      return finishAsOutcome();
    case 'empty_awaiting_peer':
      await persist(turn.message, thinkingStep);
      await holdClose();
      return 'again';
    case 'empty_director_waiting':
      // A Director with nothing to say while companions run is waiting, not failing: retrying only pushes it back into tool calls.
      await persist(turn.message, thinkingStep);
      if (await drainInbox(true)) return 'again';
      run.context.signal.throwIfAborted();
      return 'done';
    case 'no_delivery':
    case 'truncated_text':
      try {await recoverOutput(kind.kind, thinkingId);}
      finally {await persist(turn.message, steps.get(thinkingId));}
      return 'again';
    case 'delivered': {
      await persist(turn.message, thinkingStep);
      const needsMemory = ready.base.tools.some(tool => isFinishRound(tool.name)) && run.effect() === 'closes';
      if (await holdClose()) return 'again';
      if (await drainInbox(!needsMemory)) return 'again';
      run.context.signal.throwIfAborted();
      if (needsMemory) {
        state.answerDelivered(turn.message.text);
        state.closingCallRequested();
        return 'again';
      }
      return 'done';
    }
    case 'abnormal_stop':
      await persist(turn.message, thinkingStep);
      throw new Error('The model did not finish this turn normally (missing a valid stop reason or tool calls)');
  }
}
