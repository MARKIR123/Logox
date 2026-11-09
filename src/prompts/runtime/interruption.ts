/** Marker text appended to a ledger after the user stopped a whole run (Esc / Ctrl+C). */
export const USER_INTERRUPT_MARKER = '[Interrupted by user]\nThe user stopped your previous run before it finished. Read the user\'s next message first: if it gives new instructions, follow them. Otherwise re-check the current state and ask before resuming the interrupted work.';

/** Marker text when the user stopped this run while the named companions kept working (the names are data). */
export function userInterruptMarkerWithWorking(names: readonly string[]): string {
  return USER_INTERRUPT_MARKER + `\nCompanions you dispatched are still working and were not stopped: ${names.join(', ')}. The user's next message may redirect them or ask you to cancel them (CancelActor).`;
}

/** Prefix on a human message that reached the model between steps of a run it was already executing (the message follows). */
export const USER_STEER_NOTICE = '[The user sent this while you were working. Take it into account now; it may change your direction.]';

export const steeredModelText = (text: string): string => USER_STEER_NOTICE + '\n' + text;
/** The human's own words from a steered ledger entry (the notice is model-facing only). */
export const steeredText = (text: string): string => text.startsWith(USER_STEER_NOTICE + '\n') ? text.slice(USER_STEER_NOTICE.length + 1) : text;

/** Tool result for a call that was cut off because the user interrupted the run. */
export const USER_INTERRUPTED_TOOL_TEXT = 'The user interrupted this run before the tool finished; it has no complete result.';

/** Tool result for a call that was cut off because the Director stopped the actor. */
export const DIRECTOR_INTERRUPTED_TOOL_TEXT = 'The Director stopped this run before the tool finished; it has no complete result.';

/** Marker appended to an actor ledger after the Director stopped its run; the Director's reason is data. */
export function directorStopMarker(reason: string): string {
  return `[Stopped by Director]\nThe Director stopped your previous run before it finished. Reason given by the Director: ${reason}\nDo not resume the stopped work on your own: read the Director's next message first and follow it.`;
}

/** Fallback when the Director gave no reason. */
export const DIRECTOR_STOP_DEFAULT_REASON = 'No reason given.';

/** Round-record labels for a run that ended by a deliberate stop. */
export const USER_INTERRUPT_LABEL = 'Interrupted by user';
export const DIRECTOR_STOP_LABEL = 'Stopped by Director';

/** Plain tool result when a run is cancelled for a reason other than a deliberate stop. */
export const TOOL_CANCELLED_TEXT = 'Tool cancelled.';
