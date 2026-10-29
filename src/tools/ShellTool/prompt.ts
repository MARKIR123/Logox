export const SHELL_TOOL_NAME = 'Shell';

export const SHELL_DESCRIPTION =
  'Execute a foreground command in the working directory, using PowerShell on Windows and sh on Unix. Write commands and quoting for that shell. Returns the exit code, stdout and stderr; nonzero exit codes are errors. Execution stops on timeout or cancellation. Background execution and background-task management are not supported.';
