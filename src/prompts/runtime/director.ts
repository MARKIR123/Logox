export const DIRECTOR_FACTS_HEADER = '[Ensemble snapshot: who is doing what right now, not task acceptance; subtitles are self-reported. Use ListActors for detail and ReadActor to see what an actor actually did.]';
/** Opens every ledger entry that wakes or reaches the Director from coordination, so it is never read as the human speaking. */
export const DIRECTOR_AUTOMATED_EVENT = "[Automated event, not a message from the human. It confirms and approves nothing on the human's behalf.]";
export function automatedEvent(text: string): string {return DIRECTOR_AUTOMATED_EVENT + '\n' + text;}
export const DIRECTOR_COORDINATION_WAKE = 'Process the coordination events below for Director-owned work. Human instructions take precedence. Decide from the delivered evidence and keep effects that already happened; receiving a report is not accepting it.';
export const DIRECTOR_RESULTS_READY = 'Actor results are available (one or more reports, each in its own event below and followed by the runtime record of what that actor changed and ran). Read each account against its record, check what the two leave doubtful, and continue the original task.';
/** One line of the facts snapshot while reports are held back: who has reported, who is still working, and whether the rest waits for the human. */
export function reportProgress(reported: readonly string[], running: readonly string[], total: number, waitsForHuman: boolean): string {
  return 'Reported ' + reported.length + '/' + total + (running.length ? '; still running: ' + running.join(', ') : '') +
    (waitsForHuman ? '; held until the human speaks again' : '');
}
export const DIRECTOR_FAILURE = 'An Actor task ended abnormally. Inspect what it left before deciding to repair, resume, reassign or take over. Denied permissions stay denied.';
export const DIRECTOR_RECOVERY_EXHAUSTED = 'The same failure has exhausted its recovery budget. Briefly report the cause, preserved work and the decision needed from the human. Do not run tools or dispatch more work for this exhausted recovery.';
export const DIRECTOR_EXECUTION_REVIEW = 'The actor delivered nothing and automatic recovery gave up. Inspect the recorded work, then narrow the remaining step or change its owner. To continue, use resumeTask on the original activity instead of dispatching the goal again.';
export const DIRECTOR_STREAM_REVIEW = 'The actor output was cut off repeatedly and recovery gave up. Its complete text and tool results are valid; tool batches that were cut off did not run. Continue with smaller steps instead of the same long output.';
export const DIRECTOR_USER_STOP = 'The human stopped this Actor task. Do not automatically retry, reassign or take over.';
export const DIRECTOR_RESUME_ADVICE = 'Prefer resuming the original Actor activity with resumeTask: ';
export const DIRECTOR_PAUSED_BATCH = 'Dependent work remains paused in batch ';
export const DIRECTOR_PAUSED_BATCHES = 'Earlier dependent tasks are still paused. Decide based on the new user instructions first; to resume, use Actor({resumeBatch: "<batch id>"}) to restore the existing queue instead of dispatching again. Batches: ';
/** Appended to a restored batch that waits for work a restart interrupted. */
export const DIRECTOR_RESTART_BLOCKERS = ' (waits for work a restart interrupted; resume that first with resumeTask, or its dependents are cancelled when the batch resumes: ';
export function pausedBatchesHint(batches: ReadonlyArray<{id: string; interrupted: readonly string[]}>): string {
  return DIRECTOR_PAUSED_BATCHES + batches.map(batch => batch.id + (batch.interrupted.length ? DIRECTOR_RESTART_BLOCKERS + batch.interrupted.join(', ') + ')' : '')).join(', ');
}
export const DIRECTOR_PAUSED_BATCH_RULE = '. Use Actor resumeBatch only when safe; do not duplicate queued tasks.';
export function directorResumeAdvice(target: {ownerId: string; activityId: string}): string {
  return DIRECTOR_FAILURE + '\n' + DIRECTOR_RESUME_ADVICE + target.activityId + '\nActor(' +
    JSON.stringify({tasks: [{ownerId: target.ownerId, resumeTask: target.activityId, prompt: 'Continue only the remaining work using preserved results.'}]}) + ')';
}
/** Replaces `DIRECTOR_RECOVERY_EXHAUSTED` in a deferred failure once the human has written again. */
export const DIRECTOR_RECOVERY_LIFTED = 'This failure had exhausted its automatic recovery budget; the human has written since, so the budget is reset and the human message takes precedence. Follow it, and resume or reassign work only as it directs.';

/** Labels of the runtime record appended to a report or failure for Director-dispatched work; the runtime writes it from the ledger, never the actor. */
export const RUNTIME_RECORD_LABELS = Object.freeze({
  header: (actor: string) => `[Runtime record of this activity: recorded by the runtime, not written by ${actor}]`,
  changed: 'Changed: ',
  none: 'none',
  outside: 'Outside owns: ',
  commands: 'Commands: ',
  closedBy: 'Round closed by: ',
  acceptance: 'Acceptance, as you wrote it:',
});
