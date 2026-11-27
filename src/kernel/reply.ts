import type {ModelRequest, ModelTurn, Provider} from '../runtime/messages.js';
import {extractNarration} from '../runtime/narration.js';
import type {Step} from '../runtime/contracts.js';
import {ECHO_REMINDER, ECHO_STOP_ERROR, SYNOPSIS_CLOSING_TOOL_RESULT, TEXT_CALL_RECOVERED_NOTE, TEXT_TOOL_CALL_NOTE} from '../prompts/runtime/recovery.js';
import {LOOP_STREAK} from './repeat-guard.js';
import {isTextToolCall} from './turn-outcome.js';
import type {ModelTurnResult} from './model-turn.js';
import {createRuntimeContextMessage} from '../runtime/context-updates.js';
import {parseSynopsis, synopsisBlock} from '../context/synopsis.js';
import {isDirector} from '../runtime/director-id.js';
import {ExecutionRecoveryError} from './execution-recovery.js';
import {runToolBatch, uniqueCallIds} from './tool-batch.js';
import type {TurnOutcome} from './turn-outcome.js';
import type {ReadyRequest} from './request.js';
import type {AgentRun} from './run.js';

/** Shows a received turn in the timeline and bookkeeping (usage, keep-alive, status line, text-call note), ending its thinking step. Returns the turn as the ledger will hold it. */
export function presentTurn(run: AgentRun, ready: ReadyRequest, got: Extract<ModelTurnResult, {kind: 'turn'}>): {turn: ModelTurn; thinkingStep: Step} {
  const {options, state, steps} = run;
  const {request, thinkingId, textId, usedProvider, requestedAt} = got;
  const {prepared} = ready;
  let turn = got.turn;
  // The timeline message keeps the raw `⏵` line while the reply streams (the activity reads it as that reply's own status line); the ledger text never does.
  let storedText = turn.message.text;
  state.turnMetered(prepared ? options.context?.turnUsage(turn, prepared.model) : undefined);
  if (prepared && usedProvider) void options.keepAlive?.arm(run.context, {request, provider: usedProvider, model: prepared.model.identity, startedAt: requestedAt, usage: turn.usage, reply: turn.message});
  const extracted = extractNarration(turn.message.text);
  if (extracted) {
    // A reply that is only the status line (no tool call, no other text but a synopsis) is the answer itself: it keeps the line's words as its
    // visible text, with the synopsis after them, instead of reading as empty. Otherwise the ledger text drops the line and the `stage` field keeps it.
    const onlyLine = !parseSynopsis(extracted.cleanText).answer.trim() && !turn.message.toolCalls?.length;
    const text = onlyLine ? extracted.narration + (extracted.cleanText.trim() ? '\n\n' + extracted.cleanText.trim() : '') : extracted.cleanText;
    turn = {...turn, message: {...turn.message, text, stage: extracted.narration}};
    if (onlyLine) {
      storedText = text;
      if (textId) options.store.updateMessage(textId, {text});
    }
    const next = {label: extracted.narration};
    void run.context.saveProgress?.(next);
    options.store.activities.update(run.context.sessionId, run.context.activityId, {progress: next});
  }
  if (state.closing) {
    turn = {...turn, message: {...turn.message, memoryOnly: true as const}};
    // The follow-up's synopsis folds under the answer like one written in place; anything else it repeated is never shown.
    const {synopsis} = parseSynopsis(turn.message.text);
    if (synopsis) options.store.message(run.context.sessionId, run.context.ownerId, 'assistant', synopsisBlock(synopsis), {activityId: run.context.activityId});
  }
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
  const {options, state, steps, persist, drainInbox, holdClose, recoverOutput} = run;
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
    case 'closing_with_calls': {
      // The closing follow-up asks only for a synopsis: its calls are answered unexecuted and the round ends with what was delivered.
      // Cut-off calls never reach a later request (`toolsExcluded`), as in a truncated batch.
      const reasoning = reasoningOf();
      await persist({...turn.message, ...(kind.truncated ? {toolsExcluded: true as const} : {}), ...(reasoning ? {reasoning} : {})}, thinkingStep);
      if (prepared) options.context?.observe(run.context, request, turn, prepared.model);
      for (const call of turn.message.toolCalls ?? []) await persist({role: 'tool', callId: call.id, name: call.name, text: SYNOPSIS_CLOSING_TOOL_RESULT, isError: true});
      run.context.signal.throwIfAborted();
      return finishAsOutcome();
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
    case 'closing_reply':
      // The follow-up's reply holds the synopsis, or it does not and the runtime writes the record; the delivered text stands either way.
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
      // A reply that closes the round without ending in a synopsis gets one follow-up asking only for it; whatever that brings, the round then ends.
      const needsSynopsis = run.effect() === 'closes' && !parseSynopsis(turn.message.text).synopsis;
      if (await holdClose()) return 'again';
      if (await drainInbox(!needsSynopsis)) return 'again';
      run.context.signal.throwIfAborted();
      if (needsSynopsis) {state.synopsisRequested(); return 'again';}
      return 'done';
    }
    case 'abnormal_stop':
      await persist(turn.message, thinkingStep);
      throw new Error('The model did not finish this turn normally (missing a valid stop reason or tool calls)');
  }
}
