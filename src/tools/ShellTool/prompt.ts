export const SHELL_TOOL_NAME = 'Shell';

export const SHELL_DESCRIPTION =
  'Execute a foreground command in the working directory, using PowerShell on Windows and sh on Unix. Write commands and quoting for that shell; on Windows PowerShell, inline node -e code with template literals, backticks or ${} gets mangled, so write multi-line or templated scripts to a scratchpad file and run it. Returns the exit code, stdout and stderr; nonzero exit codes are errors. Execution stops on timeout or cancellation. For a server, watcher or other command that does not exit, set run_in_background: true: it starts detached, returns at once with a job id, pid and the first output, and keeps running until you stop it with ShellJob or your task ends (start it in the task that needs it). Never start such a command in the foreground: it blocks until the timeout.';

/** Opening of the result when the user pressed Stop on a running command; the partial output follows it. */
export const SHELL_STOPPED_BY_USER = 'Stopped by user.\nThe user stopped this command while it was running; partial output is below.\nDo not rerun it on your own. Continue with what you have, or ask the user if you need the full run.';

/** Opening of the result when the Director stopped a command; the Director's reason is data. */
export function shellStoppedByDirector(reason: string): string {
  return `Stopped by Director.\nThe Director stopped this command while it was running. Reason given: ${reason}\nPartial output is below. Do not rerun it on your own; continue with what you have, or ask the Director.`;
}

/** Line that replaces the exit code when a run was cut short. */
export const SHELL_CUT_SHORT_LINE = 'Exit code: none (run cut short before it finished)';

/** Result of a command started with `run_in_background`: the id to pass to ShellJob, plus whatever it printed while starting. */
export function backgroundStartedText(job: {id: string; pid: number; exitCode: number | null | undefined}, initial: string): string {
  const state = job.exitCode === undefined ? 'running in the background' : `already exited with code ${job.exitCode}`;
  return `Background job ${job.id} (pid ${job.pid}) ${state}.
Read later output or stop it with ShellJob({id: "${job.id}"}); it also ends with this task.

Initial output:
${initial || '(none yet)'}`;
}
