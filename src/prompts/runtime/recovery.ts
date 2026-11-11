export type ExecutionRecoveryKind = 'no_delivery' | 'truncated_text' | 'truncated_tools' | 'text_tool_call';

/** Card step note and timeline text for a turn whose tool call came out as plain text. */
export const TEXT_TOOL_CALL_NOTE = 'Tool call came out as text and was not executed.';

export interface FailedToolReport {
  readonly name: string;
  readonly error: string;
}

/** Sent when a waiting Director's observation tools are withdrawn; it can only close the round now. */
export const DIRECTOR_WAIT_INSTRUCTION = 'You kept re-checking while companions are running, so your work tools are withdrawn for this round. Reply with one short line saying what you are waiting for and end the round. This does not stop the companions: their reports wake you automatically and your tools return then.';

/** Sent when a polling companion's tools are withdrawn; its task stays open and resumes when something changes. */
export const COMPANION_WAIT_INSTRUCTION = 'You kept re-checking while teammates are running, so your work tools are withdrawn for now. Reply with one short line saying what you are waiting for and end the round. Your task stays open: you resume with your tools as soon as a teammate finishes or a message reaches you.';

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

/** Sent once per run when the model returns only thinking or an empty reply, before the runtime counts it as a failure. */
export const EMPTY_REPLY_REMINDER = 'Your previous reply was empty. Continue the task: call a tool or give your answer.';

/** Request-only note sent once per run after a long streak of read-only results. */
export const AUTOMA_STREAK_NOTE = 'That is several read-only calls in a row. If more are coming and you only need the conclusion, hand the rest to `Automa` so the raw output stays out of your context. If you must understand this material yourself, carry on.';

/** Cross-tool output recovery instructions appended only on retry. */
export function executionRecoveryInstruction(kind: ExecutionRecoveryKind, ownerId: string, adjustment = false): string {
  const next = kind === 'no_delivery'
    ? adjustment && ownerId === 'logox'
      ? 'Pivot the action plan: narrow the current phase or delegate explicit smaller steps to a suitable actor. Deliver concrete artifacts or complete tool calls first.'
      : EMPTY_REPLY_REMINDER + ' Narrow to the minimum deliverable step, avoid drafting full files in thoughts, and immediately call tools to persist artifacts.'
    : kind === 'text_tool_call'
      ? 'Your previous reply wrote a tool call as plain text, so nothing was executed and it was not delivered. Issue it again as a real tool call.'
    : kind === 'truncated_tools'
      ? 'Previous tool arguments were truncated; the entire batch was not executed. Issue smaller, complete tool calls without replaying completed tools.'
      : 'Previous output reached token limits. Continue the current step from the break point using existing text; do not replan or regenerate delivered content.';
  return next;
}

/** Result for a tool call made while the caller's tools are withdrawn; the call is not executed. */
export const TOOLS_WITHDRAWN_RESULT = 'Your tools are withdrawn until a teammate finishes or a message arrives, so this call was not executed. Reply with one short line saying what you are waiting for.';
