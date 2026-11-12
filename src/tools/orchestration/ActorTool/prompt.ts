export const ACTOR_TOOL_NAME = 'Actor';

export const ACTOR_DESCRIPTION =
  'Dispatch work to persistent ensemble companions (Techne, Kalon, Aletheia or custom actors). Each task has a short `title` and a `prompt` written for a capable colleague who has not seen your conversation: the goal and why it matters, what is already known or ruled out, the names, IDs and formats others rely on, and what is out of scope. `owns` lists the paths the task may change; `acceptance` lists the checks that define done, and comes back to you beside the report. When a task needs another task\'s output, set `after` to that actor id or activity id: the runtime starts it only when that work has ended and hands it the report. Tasks without `after` run in parallel. `resumeTask` continues a failed or interrupted activity.';


/** What the Director needs to know while dispatched work runs; the tool result is the one place that says it. */
const WAITING_CONTRACT = 'They work in the background, and their reports wake you automatically once all of this work has ended, or earlier with an urgent message. Until then you know nothing about their results: do not report, assume or predict them, and do not re-check their files or progress. Do your own independent work, or tell the user in one line what is running and end your reply.';

export function dispatchedResult(targets: string, batchId: string, notes: readonly string[] = []): string {
  return `Dispatched to ${targets} (Batch ${batchId}). ${WAITING_CONTRACT}` + notes.map(note => '\n' + note).join('');
}

/** Dispatch-time notes: advisory only, appended to the result of a dispatch that already succeeded. */
export const overlapNote = (a: string, b: string, path: string): string =>
  `Note: ${a} and ${b} both own ${path} and run in parallel. File locks keep the edits safe; set \`after\` or split the paths if one must build on the other.`;
export const missingOwnsNote = (actor: string): string =>
  `Note: ${actor} has no \`owns\`, so teammates are not told which files it is changing.`;
export const missingAcceptanceNote = (actor: string): string =>
  `Note: ${actor} has no \`acceptance\`, so its report comes back without checks to read it against.`;

/** A paused batch was released: its tasks are queued again (a task whose blocker a restart interrupted is cancelled instead). */
export function resumedBatchResult(batchId: string): string {
  return `Resumed batch ${batchId}: its paused tasks are queued again. ${WAITING_CONTRACT.replace(/^They work/, 'They start and work')}`;
}

/** `resumeBatch` named a batch whose resumed tasks have all ended, so nothing was started. */
export function endedBatchResult(batchId: string): string {
  return `Batch ${batchId} has already ended, so nothing was resumed and nothing is running for it.`;
}
