export type ExecutionRecoveryKind = 'no_delivery' | 'truncated_text' | 'truncated_tools';

export interface FailedToolReport {
  readonly name: string;
  readonly error: string;
}

/** Appended to a repeated Read, Glob or Grep result while the Director has companions running. */
export const DIRECTOR_REPEAT_NOTE = '[Runtime] Same result as your earlier identical call. Companions are still running. Their reports wake you automatically, even after your round has ended, so checking files or status tells you nothing they will not report. If you have no independent work, reply with one short line and end your round.';

/** Appended to a companion's repeated Read, Glob or Grep result while teammates are running. */
export const COMPANION_REPEAT_NOTE = '[Runtime] Same result as your earlier identical call, and teammates are still running. Do not poll. If you depend on a teammate, SendMessage them with type "ask" and carry on with other work. If you keep repeating this call, the runtime takes your tools away until a teammate finishes.';

/** Sent when a waiting Director's observation tools are withdrawn; it can only close the round now. */
export const DIRECTOR_WAIT_INSTRUCTION = 'You kept re-checking while companions are running, so your work tools are withdrawn for this round. Reply with one short line saying what you are waiting for and end the round. This does not stop the companions: their reports wake you automatically and your tools return then.';

/** Sent when a polling companion's tools are withdrawn; its task stays open and resumes when something changes. */
export const COMPANION_WAIT_INSTRUCTION = 'You kept re-checking while teammates are running, so your work tools are withdrawn for now. Reply with one short line saying what you are waiting for and end the round. Your task stays open: you resume with your tools as soon as a teammate finishes or a message reaches you.';

/** Appended to the result of a sent question. */
export const ASK_SENT_NOTE = '[Runtime] Your question is open. Keep working on whatever does not depend on it. Your task cannot finish until the reply arrives: if nothing else is left, end your round as usual and you resume when it comes.';
export const ASK_SENT_NOTE_DIRECTOR = '[Runtime] Your question is open. The reply wakes you, so you can end your round.';

/** Sent to the asker chosen to break a cycle of actors waiting on each other. */
export const ASK_DEADLOCK_RELEASED = '[Runtime] You and the teammate you asked are waiting on each other, so your question was closed to break the deadlock. Do not wait for that answer. Answer what you have been asked with type "reply", stating what you assumed, then continue.';

export function askRecipientEnded(recipient: string): string {
  return `[Runtime] ${recipient} ended its work without replying to your question, so stop waiting for it and continue. Check what they left, or ask Director if you still need the answer.`;
}

/** One reminder while the actor is still working: it may not be able to answer yet. */
export function askOwedWhileWorking(asker: string, label: string): string {
  return `[Runtime] You still owe ${asker} a reply: "${label}". If you cannot answer yet, carry on; send SendMessage type "reply" once you can, and before you finish.`;
}

/** Sent when an actor tries to finish with questions unanswered. */
export function askOwedAtClose(asks: readonly {readonly from: string; readonly label: string}[]): string {
  const list = asks.map(ask => `${ask.from} ("${ask.label}")`).join('; ');
  return `Do not finish yet: you have not answered ${list}. Send SendMessage type "reply" to each with your answer, or with what stopped you from answering, then finish.`;
}

/** Sent once per run when the model returns only thinking or an empty reply, before the runtime counts it as a failure. */
export const EMPTY_REPLY_REMINDER = 'Your previous reply was empty. Continue the task: call a tool or give your answer.';

/** Appended once per run to a long streak of read-only results. */
export const AUTOMA_STREAK_NOTE = '[Runtime] That is several read-only calls in a row. If more are coming and you only need the conclusion, hand the rest to `Automa` so the raw output stays out of your context. If you must understand this material yourself, carry on.';

/** Guidance appended to the next request when a tool execution or argument validation failed. */
export function toolErrorRecoveryInstruction(failedTools: readonly FailedToolReport[]): string {
  const details = failedTools.map(t => `${t.name} (${t.error.replace(/\s+/g, ' ').trim().slice(0, 140)})`).join('; ');
  return `Previous tool call failed: ${details}.
Diagnose the root cause from the error output before acting.
- Do NOT repeat the exact same call with identical arguments without checking state.
- If a file read or edit failed (e.g. string not found, ambiguous match), use Read to verify current lines and exact content.
- If a command or path failed, check the working directory and verify paths with Glob.
- If arguments failed validation, adjust your call to match the tool schema.`;
}

/** Cross-tool output recovery instructions appended only on retry. */
export function executionRecoveryInstruction(kind: ExecutionRecoveryKind, ownerId: string, adjustment = false): string {
  const next = kind === 'no_delivery'
    ? adjustment && ownerId === 'logox'
      ? 'Pivot the action plan: narrow the current phase or delegate explicit smaller steps to a suitable actor. Deliver concrete artifacts or complete tool calls first.'
      : EMPTY_REPLY_REMINDER + ' Narrow to the minimum deliverable step, avoid drafting full files in thoughts, and immediately call tools to persist artifacts.'
    : kind === 'truncated_tools'
      ? 'Previous tool arguments were truncated; the entire batch was not executed. Issue smaller, complete tool calls without replaying completed tools.'
      : 'Previous output reached token limits. Continue the current step from the break point using existing text; do not replan or regenerate delivered content.';
  return next + ' Adhere to confirmed goals, active stage, and completed tool results. Do not bypass approval denials or change model effort tiers.';
}
