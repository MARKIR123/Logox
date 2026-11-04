export const SHELL_TOOL_NAME = 'Shell';

export const SHELL_DESCRIPTION =
  'Execute a foreground command in the working directory, using PowerShell on Windows and sh on Unix. Write commands and quoting for that shell. Returns the exit code, stdout and stderr; nonzero exit codes are errors. Execution stops on timeout or cancellation. Background execution and background-task management are not supported.';

/** Opening of the result when the user pressed Stop on a running command; the partial output follows it. */
export const SHELL_STOPPED_BY_USER = 'Stopped by user.\nThe user stopped this command while it was running; partial output is below.\nDo not rerun it on your own. Continue with what you have, or ask the user if you need the full run.';

/** Opening of the result when the Director stopped a command; the Director's reason is data. */
export function shellStoppedByDirector(reason: string): string {
  return `Stopped by Director.\nThe Director stopped this command while it was running. Reason given: ${reason}\nPartial output is below. Do not rerun it on your own; continue with what you have, or ask the Director.`;
}

/** Line that replaces the exit code when a run was cut short. */
export const SHELL_CUT_SHORT_LINE = 'Exit code: none (run cut short before it finished)';
