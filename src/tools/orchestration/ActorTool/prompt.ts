export const ACTOR_TOOL_NAME = 'Actor';

export const ACTOR_DESCRIPTION =
  'Dispatch new substantive tasks to persistent ensemble companions (Techne, Kalon, Aletheia, or custom actors). Provide a concise `title` (3-8 words) and a natural colleague briefing `prompt`. Optional brief fields keep a handoff precise: `deliverables`, `owns` (paths it may change; others get a coordination note when they edit them), `interfaces` (the shared contract: names, IDs, sizes, APIs), `acceptance` (what defines done) and `verified` (what is already checked, for verification tasks). Split work by artifact ownership with one integrator, each task with its own `owns`. When one task needs the output of another, set `after` to the actor id or activity id of that task: the runtime holds it until that task completes and delivers its report with the brief, so it never polls or guesses. Independent tasks run in parallel. Tasks dispatch immediately, run asynchronously, and their reports wake you automatically. Use `resumeTask` to resume an interrupted or failed activity.';


/** What the Director needs to know while dispatched work runs; the tool result is the one place that says it. */
const WAITING_CONTRACT = 'They work in the background, and their reports wake you automatically once all of this work has ended, or earlier with an urgent message. Until then you know nothing about their results: do not report, assume or predict them, and do not re-check their files or progress. Do your own independent work, or tell the user in one line what is running and end your reply.';

export function dispatchedResult(targets: string, batchId: string): string {
  return `Dispatched to ${targets} (Batch ${batchId}). ${WAITING_CONTRACT}`;
}

/** A paused batch was released: its tasks are queued again (a task whose blocker a restart interrupted is cancelled instead). */
export function resumedBatchResult(batchId: string): string {
  return `Resumed batch ${batchId}: its paused tasks are queued again. ${WAITING_CONTRACT.replace(/^They work/, 'They start and work')}`;
}

/** `resumeBatch` named a batch whose resumed tasks have all ended, so nothing was started. */
export function endedBatchResult(batchId: string): string {
  return `Batch ${batchId} has already ended, so nothing was resumed and nothing is running for it.`;
}
