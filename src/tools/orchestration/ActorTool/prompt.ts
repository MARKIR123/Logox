export const ACTOR_TOOL_NAME = 'Actor';

export const ACTOR_DESCRIPTION =
  'Dispatch work to persistent ensemble companions (Techne, Kalon, Aletheia or custom actors). Each task has a short `title` and a `prompt` written for a capable colleague who has not seen your conversation: the goal and why it matters, what is already known or ruled out, the names, IDs and formats others rely on, and what is out of scope. `owns` lists the paths the task may change; `acceptance` lists the checks that define done, and comes back to you beside the report. When a task needs another task\'s output, set `after` to that actor id or activity id: the runtime starts it only when that work has ended and hands it the report. Tasks without `after` run in parallel. `resumeTask` continues a failed or interrupted activity.';


/** What the Director needs to know while dispatched work runs; the tool result is the one place that says it. */
const WAITING_CONTRACT = 'They work in the background, and their reports wake you automatically once all of this work has ended, or earlier with an urgent message. Until then you know nothing about their results: do not report, assume or predict them, and do not re-check their files or progress. Do your own independent work, or tell the user in one line what is running and end your reply.';

/** One dispatched task of a receipt. */
export interface DispatchedTask {activityId: string; ownerId: string; title: string; owns: readonly string[]; after: readonly string[]}

/** The receipt of a dispatch: one line per task (activity id, owner, title, `owns`, `after`), the brief-check line when a check ran or was skipped, then the waiting contract and advisory notes. */
export function dispatchedResult(tasks: readonly DispatchedTask[], batchId: string, notes: readonly string[] = [], briefLine?: string): string {
  const targets = [...new Set(tasks.map(task => task.ownerId))].join(', ');
  const lines = tasks.map(task => `- ${task.activityId} ${task.ownerId}: ${task.title}` +
    (task.owns.length ? ` | owns: ${task.owns.join(', ')}` : '') + (task.after.length ? ` | after: ${task.after.join(', ')}` : ''));
  return `Dispatched to ${targets} (Batch ${batchId}):\n${lines.join('\n')}\n${briefLine ? briefLine + '\n' : ''}${WAITING_CONTRACT}` + notes.map(note => '\n' + note).join('');
}

/** One line of the receipt for a task whose companion is still working on an earlier task: it starts when that one ends. */
export const queuedBehindNote = (task: DispatchedTask, ownerName: string, runningTitle: string, runningId: string): string =>
  `Queued: ${task.title} (${task.activityId}) waits behind ${ownerName}'s running task "${runningTitle.replace(/\s+/g, ' ').trim().slice(0, 80)}" (${runningId}); it starts when that ends.`;

/** System prompt of the brief check: a read-only worker on the code model that reads the briefs before any companion starts. */
export const BRIEF_CHECK_SYSTEM_PROMPT = `You check dispatch briefs before work starts in LOGOX. Each companion who receives a brief has not seen the conversation that produced it: the brief, the files it names and the repository are all they will have. Your job is to find what would make a companion build the wrong thing or stop to ask.

Read every brief. Open the files they name when that settles a question. Then report through Finish:
- status "done" when every brief can be acted on as written; summary: one sentence per task saying what that companion will do.
- status "blocked" when something would lead to wrong or wasted work; question: a numbered list, one item per problem, each naming the task and the exact gap: an undefined name or format, two briefs that contradict each other, a file or interface two tasks both expect the other to provide, acceptance that cannot be checked, or a goal stated only by reference to the conversation ("as discussed", "the bug above").

Do not judge the plan's strategy or suggest improvements. Report only gaps that would cause wrong or wasted work.`;

/** Receipt lines and the blocked result of the brief check. */
export const BRIEF_CHECK_CLEAR = 'Brief check: clear.';
export const BRIEF_CHECK_SKIPPED = 'Brief check: skipped.';
export const briefCheckFailed = (reason: string): string => `Brief check: failed (${reason}); dispatched without it.`;
export const briefCheckBlocked = (gaps: string): string =>
  `Brief check found gaps; nothing was dispatched. Fix the briefs and call Actor again, or add "briefCheck": "skip" to dispatch them as they are.\n${gaps}`;

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
