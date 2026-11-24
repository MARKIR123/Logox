import {isDirector} from '../../runtime/director-id.js';
export type ExecutionRecoveryKind = 'no_delivery' | 'truncated_text' | 'truncated_tools' | 'text_tool_call';

/** Card step note and timeline text for a turn whose tool call came out as plain text. */
export const TEXT_TOOL_CALL_NOTE = 'Tool call came out as text and was not executed.';

export interface FailedToolReport {
  readonly name: string;
  readonly error: string;
}

/** Sent to the asker chosen to break a cycle of actors waiting on each other. */
export const ASK_DEADLOCK_RELEASED = 'You and the teammate you asked are waiting on each other, so your question was closed to break the deadlock. Do not wait for that answer. Answer what you have been asked with type "reply", stating what you assumed, then continue.';

export function askRecipientEnded(recipient: string): string {
  return `${recipient} ended its work without replying to your question, so stop waiting for it and continue. Check what they left, or ask Director if you still need the answer.`;
}

/** One reminder while the actor is still working: it may not be able to answer yet. */
export function askOwedWhileWorking(asker: string, label: string): string {
  return `You still owe ${asker} a reply: "${label}". If you cannot answer yet, carry on; send SendMessage type "reply" once you can, and before you finish.`;
}

/** Sent when an actor tries to finish with questions unanswered. */
export function askOwedAtClose(asks: readonly {readonly from: string; readonly label: string}[]): string {
  const list = asks.map(ask => `${ask.from} ("${ask.label}")`).join('; ');
  return `Do not finish yet: you have not answered ${list}. Send SendMessage type "reply" to each with your answer, or with what stopped you from answering, then finish.`;
}

/** Request-only note after a reply whose text held a tool call that the runtime ran as a real call (`src/kernel/text-recovery.ts`). */
export const TEXT_CALL_RECOVERED_NOTE = 'Your last reply wrote a tool call as text; it was run as a real call. Use the structured tool-call format.';
/** Request-only note after a reply that only repeated text the runtime inserted (`src/kernel/echo-guard.ts`). */
export const ECHO_REMINDER = 'Your last reply only repeated text the runtime inserted. Continue the task: call a tool, or give your actual reply.';
/** The error that ends a step after the model repeated runtime text three times in a row. */
export const ECHO_STOP_ERROR = 'The model kept repeating runtime text instead of replying.';

/** Sent once per run when the model returns only thinking or an empty reply, before the runtime counts it as a failure. */
export const EMPTY_REPLY_REMINDER = 'Your previous reply was empty. Continue the task: call a tool or give your answer.';

/** Request-only note after a reply that closed the round with `_FinishRound` but carried no visible text (the reply was not empty: it held a tool call). */
export const FINISH_ROUND_NO_TEXT_NUDGE = 'Your reply had no visible text. Write the report or answer in the text channel in the same reply as _FinishRound.';
/** Tool result for a `_FinishRound` call that came without any delivered text. */
export const FINISH_ROUND_NO_TEXT_RESULT = 'Deliver the final answer or task report as visible text in the same reply before submitting round memory.';

/** Request-only note sent once per run after a long streak of read-only results. */
export const AUTOMA_STREAK_NOTE = 'That is several read-only calls in a row. If more are coming and you only need the conclusion, hand the rest to `Automa` so the raw output stays out of your context. If you must understand this material yourself, carry on.';

/** Request-only note, once per streak, when the same call returned the same result several times in a row. */
export function repeatedCallNote(tool: string, count: number): string {
  return `You called ${tool} ${count} times in a row with identical arguments and got the same result. Do not repeat it: change the arguments, use another tool, or report what you have.`;
}

/** A tool call cut off by the output limit is lost whole: it cannot be continued, only redone smaller. */
const TRUNCATED_TOOLS_INSTRUCTION = 'Your reply hit the output token limit while it was writing tool calls, so the cut-off call was lost and the entire batch was not executed. Do not continue it from where it stopped. Redo it in smaller pieces without replaying completed tools: for a large new file, write a short runnable skeleton first and fill it in with several smaller Edit calls.';
/** A reply with no usable tool call that ended at the output limit: a lost call is redone smaller, plain text resumes where it stopped. */
const TRUNCATED_TEXT_INSTRUCTION = 'Your previous reply hit the output token limit and was cut off. A tool call that was still being written was lost and not executed: do not continue it from where it stopped; redo it in smaller pieces (a short runnable skeleton, then several smaller Edit calls). If it was plain text, resume that text where it stopped without replanning or repeating delivered content.';

/** Cross-tool output recovery instructions appended only on retry. */
export function executionRecoveryInstruction(kind: ExecutionRecoveryKind, ownerId: string, adjustment = false): string {
  const next = kind === 'no_delivery'
    ? adjustment && isDirector(ownerId)
      ? 'Pivot the action plan: narrow the current phase or delegate explicit smaller steps to a suitable actor. Deliver concrete artifacts or complete tool calls first.'
      : EMPTY_REPLY_REMINDER + ' Narrow to the minimum deliverable step, avoid drafting full files in thoughts, and immediately call tools to persist artifacts.'
    : kind === 'text_tool_call'
      ? 'Your previous reply wrote a tool call as plain text, so nothing was executed and it was not delivered. Issue it again as a real tool call.'
    : kind === 'truncated_tools'
      ? TRUNCATED_TOOLS_INSTRUCTION
      : TRUNCATED_TEXT_INSTRUCTION;
  return next;
}
