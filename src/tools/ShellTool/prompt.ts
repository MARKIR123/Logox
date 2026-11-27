export const SHELL_TOOL_NAME = 'Shell';

export const SHELL_DESCRIPTION =
  'Execute a foreground command in the working directory, using PowerShell on Windows and sh on Unix. Write commands and quoting for that shell; on Windows PowerShell, inline node -e code with template literals, backticks or ${} gets mangled, so write multi-line or templated scripts to a scratchpad file and run it. Returns the exit code, stdout and stderr; nonzero exit codes are errors. Execution stops on timeout or cancellation. For a server, watcher, training run or any other long or non-exiting command, set run_in_background: true: it starts detached, returns at once with a job id, pid and the first output, and keeps running after your task ends until it exits or you stop it with ShellJob. You are notified when a background job ends (exit code, last output lines, log path), so never poll it and never sleep to wait for it: do other useful work, or end your turn. A foreground command still running after the auto-background threshold (120 seconds by default, even when your timeout is longer) moves to the background by itself and returns the same way; `sleep` commands are exempt and obey the timeout. Background jobs have no timeout and are not audited for changed files.';

/** Opening of the result when the user pressed Stop on a running command; the partial output follows it. */
export const SHELL_STOPPED_BY_USER = 'Stopped by user.\nThe user stopped this command while it was running; partial output is below.\nDo not rerun it on your own. Continue with what you have, or ask the user if you need the full run.';

/** Opening of the result when the Director stopped a command; the Director's reason is data. */
export function shellStoppedByDirector(reason: string): string {
  return `Stopped by Director.\nThe Director stopped this command while it was running. Reason given: ${reason}\nPartial output is below. Do not rerun it on your own; continue with what you have, or ask the Director.`;
}

/** Line that replaces the exit code when a run was cut short. */
export const SHELL_CUT_SHORT_LINE = 'Exit code: none (run cut short before it finished)';

/** Result of a command started with `run_in_background`: the id to pass to ShellJob, plus whatever it printed while starting. */
export function backgroundStartedText(job: {id: string; pid: number; exitCode: number | null | undefined; logPath?: string | undefined}, initial: string): string {
  const state = job.exitCode === undefined ? 'running in the background' : `already exited with code ${job.exitCode}`;
  return `Background job ${job.id} (pid ${job.pid}) ${state}.
You will be notified when it ends; do not poll or sleep. Read later output or stop it with ShellJob({id: "${job.id}"}).${job.logPath ? `
Full output is written to ${job.logPath}.` : ''}

Initial output:
${initial || '(none yet)'}`;
}

/** Result of a foreground command that ran past the auto-background threshold: it keeps running as a job and the caller gets what it printed so far. */
export function autoBackgroundedText(job: {id: string; pid: number; logPath?: string | undefined}, seconds: number, output: string): string {
  return `Still running after ${seconds}s, so it moved to background job ${job.id} (pid ${job.pid}). You will be notified when it ends; do not poll or sleep. Read output or stop it with ShellJob({id: "${job.id}"}). The job has no timeout and its file changes are not audited.${job.logPath ? `
Full output is written to ${job.logPath}.` : ''}

Output so far:
${output || '(none yet)'}`;
}

/** Files shown in the changed-files line of a Shell result before the rest is counted. */
export const SHELL_CHANGED_SHOWN = 8;
/** Appended to a foreground Shell result when the command changed workspace files (`workspace-diff.ts`). */
export const shellChangedFilesLine = (files: readonly string[]): string =>
  'Files changed: ' + files.slice(0, SHELL_CHANGED_SHOWN).join(', ') + (files.length > SHELL_CHANGED_SHOWN ? ` (+${files.length - SHELL_CHANGED_SHOWN} more)` : '');
