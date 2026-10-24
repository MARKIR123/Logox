export const DIRECTOR_FACTS_HEADER = '[Director facts: runtime observations, not task acceptance; labels are self-reported]';
export const DIRECTOR_COORDINATION_WAKE = 'Process pending coordination events for Director-owned work. Human instructions take precedence. Inspect delivered evidence, preserve existing effects and report only supported conclusions; receipt is not acceptance.';
export const DIRECTOR_RESULTS_READY = 'Actor results are available. Check the evidence and continue the original task; execution completion is not acceptance.';
export const DIRECTOR_FAILURE = 'An Actor task ended abnormally. Inspect preserved results before deciding to repair, resume, reassign or take over. Do not replay completed effects or bypass denied permissions.';
export const DIRECTOR_RECOVERY_EXHAUSTED = 'The same failure has exhausted its recovery budget. Briefly report the cause, preserved work and the decision needed from the human. Do not run tools or dispatch more work for this exhausted recovery.';
export const DIRECTOR_EXECUTION_REVIEW = 'Automatic output recovery ended without sufficient delivery. Inspect the recorded work, narrow the remaining step or adjust ownership. Use resumeTask for the original failed activity when continuing; do not create a duplicate goal or replay successful tools.';
export const DIRECTOR_STREAM_REVIEW = 'Output recovery reached its limit. Preserve valid text and tool results; decide from actual evidence. Incomplete tool batches did not execute. Do not repeat the same truncation, increase output allowance or replay completed effects.';
export const DIRECTOR_USER_STOP = 'The human stopped this Actor task. Do not automatically retry, reassign or take over.';
export const DIRECTOR_RESUME_ADVICE = 'Prefer resuming the original Actor activity with resumeTask: ';
export const DIRECTOR_PAUSED_BATCH = 'Dependent work remains paused in batch ';
export const DIRECTOR_PAUSED_BATCH_RULE = '. Use Actor resumeBatch only when safe; do not duplicate queued tasks.';
export function directorResumeAdvice(target: {ownerId: string; activityId: string}): string {
  return DIRECTOR_FAILURE + '\n' + DIRECTOR_RESUME_ADVICE + target.activityId + '\nActor(' +
    JSON.stringify({tasks: [{ownerId: target.ownerId, resumeTask: target.activityId, prompt: 'Continue only the remaining work using preserved results.'}]}) + ')';
}
