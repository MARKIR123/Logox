/** Marker text appended to a ledger after the user stopped a whole run (Esc / Ctrl+C). */
export const USER_INTERRUPT_MARKER = '[Interrupted by user]\nThe user stopped your previous run before it finished. Tool calls that were still unfinished have no complete result; the round record lists the unfinished items. Read the user\'s next message first: if it gives new instructions, follow them. Otherwise re-check the current state and ask before resuming the interrupted work.';

/** Tool result for a call that was cut off because the user interrupted the run. */
export const USER_INTERRUPTED_TOOL_TEXT = 'The user interrupted this run before the tool finished; it has no complete result.';

/** Tool result for a call that was cut off because the Director stopped the actor. */
export const DIRECTOR_INTERRUPTED_TOOL_TEXT = 'The Director stopped this run before the tool finished; it has no complete result.';

/** Marker appended to an actor ledger after the Director stopped its run; the Director's reason is data. */
export function directorStopMarker(reason: string): string {
  return `[Stopped by Director]\nThe Director stopped your previous run before it finished. Reason given by the Director: ${reason}\nTool calls that were still unfinished have no complete result; the round record lists the unfinished items. Do not resume the stopped work on your own: read the Director's next message first and follow it.`;
}

/** Fallback when the Director gave no reason. */
export const DIRECTOR_STOP_DEFAULT_REASON = 'No reason given.';

/** Round-record labels for a run that ended by a deliberate stop. */
export const USER_INTERRUPT_LABEL = 'Interrupted by user';
export const DIRECTOR_STOP_LABEL = 'Stopped by Director';

/** Plain tool result when a run is cancelled for a reason other than a deliberate stop. */
export const TOOL_CANCELLED_TEXT = 'Tool cancelled.';
