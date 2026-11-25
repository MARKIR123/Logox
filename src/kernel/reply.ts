import type {ModelRequest, ModelTurn, Provider} from '../runtime/messages.js';
import {extractNarration} from '../runtime/narration.js';
import type {Step} from '../runtime/contracts.js';
import {ECHO_REMINDER, ECHO_STOP_ERROR, FINISH_ROUND_NO_TEXT_RESULT, TEXT_CALL_RECOVERED_NOTE, TEXT_TOOL_CALL_NOTE} from '../prompts/runtime/recovery.js';
import {LOOP_STREAK} from './repeat-guard.js';
import {isTextToolCall} from './turn-outcome.js';
import type {ModelTurnResult} from './model-turn.js';
import {createRuntimeContextMessage} from '../runtime/context-updates.js';
import {normalizeFinishRound, readFinishRound} from '../context/round-memory.js';
import {isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {FINISH_ROUND_CLOSING_TOOL_RESULT} from '../tools/protocol/_FinishRoundTool/prompt.js';
import {isDirector} from '../runtime/director-id.js';
import {ExecutionRecoveryError} from './execution-recovery.js';
import {runToolBatch, uniqueCallIds} from './tool-batch.js';
import type {TurnOutcome} from './turn-outcome.js';
import type {ReadyRequest} from './request.js';
import type {AgentRun} from './run.js';

/** Shows a received turn in the timeline and bookkeeping (usage, keep-alive, status line, text-call note), ending its thinking step. Returns the turn as the ledger will hold it. */
export function presentTurn(run: AgentRun, ready: ReadyRequest, got: Extract<ModelTurnResult, {kind: 'turn'}>): {turn: ModelTurn; thinkingStep: Step} {
  const {options, state, steps, narration} = run;
  const {request, thinkingId, textId, usedProvider, requestedAt} = got;
  const {prepared} = ready;
  let turn = got.turn;
  // The timeline message keeps the raw `⏵` line while the reply streams (the activity reads it as that reply's own status line); the ledger text never does.
  let storedText = turn.message.text;
  state.turnMetered(prepared ? options.context?.turnUsage(turn, prepared.model) : undefined);
  if (prepared && usedProvider) void options.keepAlive?.arm(run.context, {request, provider: usedProvider, model: prepared.model.identity, startedAt: requestedAt, usage: turn.usage});
  const extracted = extractNarration(turn.message.text);
  if (extracted) {
    // A reply that is only the status line (no business tool call, no other text; a closing `_FinishRound` does not count as work) is the answer itself:
    // it keeps the line's words as its visible text instead of reading as empty. Otherwise the ledger text drops the line and the `stage` field keeps it for later audits.
    const onlyLine = !extracted.cleanText.trim() && (turn.message.toolCalls ?? []).every(call => isFinishRound(call.name));
    const text = onlyLine ? extracted.narration : extracted.cleanText;
    turn = {...turn, message: {...turn.message, text, stage: extracted.narration}};
    if (onlyLine) {
      storedText = text;
      if (textId) options.store.updateMessage(textId, {text});
    }
    narration.latest = extracted.narration;
    const next = {label: extracted.narration};
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

/** A `_FinishRound` summary at least this long (characters) stands as the report when the model twice closed the round without visible text. */
const SUBSTANTIVE_SUMMARY = 40;

/** A companion's failed close is handed to the Director, who is woken by it; only the Director's own has no one to hand off to. */
const closeDisposition = (ownerId: string): 'handoff' | 'stop' => isDirector(ownerId) ? 'stop' : 'handoff';

/** What the loop does after a reply was handled: send another request, or the activity is complete. */
export type Next = 'again' | 'done';

/** The turn the model returned, with the request and the thinking step it belongs to. */
export interface Reply {
  readonly ready: ReadyRequest;
  readonly request: ModelRequest;
  readonly turn: ModelTurn;
  readonly thinkingId: string;
  readonly thinkingStep: Step;
  /** The provider object that answered this request (a fork sends to the same one). */
  readonly usedProvider: Provider;
}

/** Handles one classified reply. Statement order is part of the contract: ledger writes, store updates and requests happen in this order. */
export async function settleReply(run: AgentRun, kind: TurnOutcome, reply: Reply): Promise<Next> {
  const {options, state, steps, narration, persist, drainInbox, holdClose, recoverOutput, directorWaiting} = run;
  const {ready, request, turn, thinkingId, thinkingStep, usedProvider} = reply;
  const {prepared} = ready;
  const reasoningOf = () => turn.message.reasoning || options.store.getSnapshot().messages.find(message => message.id === thinkingId)?.text;
  const finishAsOutcome = async (): Promise<Next> => {
    if (await holdClose()) return 'again';
    if (await drainInbox(true)) return 'again';
    run.context.signal.throwIfAborted();
    return 'done';
  };
  if (kind.kind !== 'echo') state.echoEnded();
  switch (kind.kind) {
    case 'echo': {
      // Nothing was delivered: the turn is kept (usage, reasoning), its text is already empty, and the model is told once per turn what it did.
      await persist(turn.message, thinkingStep);
      if (state.echoed() >= LOOP_STREAK) {
        if (await drainInbox(true)) return 'again';
        run.context.signal.throwIfAborted();
        throw new Error(ECHO_STOP_ERROR);
      }
      await ready.appendUpdate(createRuntimeContextMessage('reminder', ECHO_REMINDER, {slot: 'echo'}));
      return 'again';
    }
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
      const accepted = finishCall && !truncated ? normalizeFinishRound(finishCall.arguments, narration.latest ?? run.context.taskTitle ?? '') : undefined;
      if (finishCall && accepted) calls[calls.indexOf(finishCall)] = {...finishCall, arguments: JSON.stringify(accepted)};
      if (!closing && turn.message.text.trim()) state.answerDelivered(turn.message.text);
      const allowed = ready.base.tools.some(tool => isFinishRound(tool.name));
      // A reply that is only a `_FinishRound` call with no visible text: one precise nudge, then a substantive summary stands as the delivered report instead of failing finished work.
      let message = turn.message;
      const textless = !!accepted && allowed && !closing && onlyFinalizer && !truncated && !state.finalText.trim() && !message.text.trim() && !directorWaiting();
      const nudged = textless && state.textlessFinish() === 'nudge';
      if (textless && !nudged && accepted.summary.length >= SUBSTANTIVE_SUMMARY) {
        // The report is built from the arguments as written: the token caps shape round memory only (the call keeps the capped form), never the delivered text.
        const written = readFinishRound(finishCall!.arguments, narration.latest ?? run.context.taskTitle ?? '') ?? accepted;
        const report = written.title + '\n\n' + written.summary;
        message = {...message, text: report, synthesizedReport: true as const};
        state.answerDelivered(report);
        options.store.message(run.context.sessionId, run.context.ownerId, 'assistant', report, {activityId: run.context.activityId});
      }
      const valid = allowed && !!accepted && (closing || onlyFinalizer && !!state.finalText.trim());
      const error = !closing && !onlyFinalizer ? 'Terminal metadata must be the only tool in its batch. No business tools were executed.'
        : truncated ? 'Terminal metadata was truncated or the response did not end with tool calls.'
        : !allowed ? 'Terminal metadata is not available in this request.'
        : !accepted ? 'Round memory needs a non-empty summary.' : FINISH_ROUND_NO_TEXT_RESULT;
      const reasoning = reasoningOf();
      await persist(truncated ? {...message, toolsExcluded: true, ...(reasoning ? {reasoning} : {})} : {...message, ...(reasoning ? {reasoning} : {})}, thinkingStep);
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
        if (nudged) return 'again';
        throw new ExecutionRecoveryError('no_delivery', closeDisposition(run.context.ownerId));
      }
      return 'done';
    }
    case 'tools': {
      const {truncated} = kind;
      const result = await runToolBatch(run, {ready, prepared, request, turn, thinkingId, truncated, provider: usedProvider});
      // Delivered after the results as a request-only note, so the tool results stay clean in history.
      if (result.automaNote) await ready.appendUpdate(createRuntimeContextMessage('reminder', result.automaNote, {slot: 'automa'}));
      if (result.loopNote) await ready.appendUpdate(createRuntimeContextMessage('reminder', result.loopNote, {slot: 'loop'}));
      // Once per recovered turn: the call ran, and the model is told how it should have been written.
      if (turn.recovered) await ready.appendUpdate(createRuntimeContextMessage('reminder', TEXT_CALL_RECOVERED_NOTE, {slot: 'text-call'}));
      if (truncated) await recoverOutput('truncated_tools', thinkingId);
      else state.batchRan();
      // A refused batch is answered once. A second one in a row ends the exchange without another request, so a model that ignores the refusal cannot loop.
      if (state.batchSettled(result.refused)) {
        if (await drainInbox(true)) return 'again';
        run.context.signal.throwIfAborted();
        throw new ExecutionRecoveryError('no_delivery', closeDisposition(run.context.ownerId));
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
