export const SHELL_JOB_TOOL_NAME = 'ShellJob';

export const SHELL_JOB_DESCRIPTION =
  'Read or stop a background job started with Shell run_in_background. Returns the job status and the output produced since your last read (older output beyond 32 KB is dropped). Set stop: true to kill the job and its child processes and receive its remaining output. Jobs end with the task that started them.';

export function shellJobUnknownText(id: string): string {
  return `No background job "${id}". It may have ended with its task, or the id is wrong; start a new one with Shell run_in_background if you still need it.`;
}
