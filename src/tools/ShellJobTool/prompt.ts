export const SHELL_JOB_TOOL_NAME = 'ShellJob';

export const SHELL_JOB_DESCRIPTION =
  'Read or stop a background job started with Shell run_in_background. Returns the job status and the output produced since your last read (older output beyond 32 KB is dropped). Set stop: true to kill the job and its child processes and receive its remaining output (a stop you make sends no notification). Jobs belong to the session, not to a task: they keep running after the task that started them ends, and you are notified when one ends, so do not poll or sleep to wait for it.';

export function shellJobUnknownText(id: string): string {
  return `No background job "${id}". It may have been forgotten some time after it ended, or the id is wrong; start a new one with Shell run_in_background if you still need it.`;
}

/** Longest command text a job notification quotes. */
const COMMAND_SHOWN = 160;
const shortCommand = (command: string): string => {const line = command.replace(/\s+/g, ' ').trim(); return line.length > COMMAND_SHOWN ? line.slice(0, COMMAND_SHOWN - 1) + '…' : line;};
export function jobDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's' : Math.floor(seconds / 3600) + 'h ' + Math.floor(seconds % 3600 / 60) + 'm';
}

export interface JobNoticeFacts {
  readonly id: string;
  readonly command: string;
  /** Display name of the actor that started the job. */
  readonly starter: string;
  readonly runMs: number;
  /** Exit code, or null when the job was killed. */
  readonly exitCode: number | null | undefined;
  /** The last lines of its output, already bounded. */
  readonly tail: string;
  readonly logPath: string | undefined;
  /** `owner`: the actor that started the job, still in its task. `director`: the task that started it has ended. */
  readonly audience: 'owner' | 'director';
}

const logLine = (logPath: string | undefined): string => logPath ? `Full output: ${logPath} (read it with Read).` : 'No log file was written.';
const closing = (facts: JobNoticeFacts, ended: boolean): string => facts.audience === 'owner'
  ? ended ? 'Continue your task with this result.' : 'Act on this before using the job further.'
  : `The task that started it has ended. ${ended ? 'Decide who analyses the result, or whether it needs no action.' : 'Decide what to do with the job.'}`;

/** The runtime notice delivered once when a background job ends. */
export function jobEndedNotice(facts: JobNoticeFacts): string {
  const state = facts.exitCode === undefined || facts.exitCode === null ? 'stopped (killed)' : facts.exitCode === 0 ? 'exited with code 0' : `failed with exit code ${facts.exitCode}`;
  return `[Background job ${facts.id} ${state}]
Command: ${shortCommand(facts.command)}
Started by: ${facts.starter}
Run time: ${jobDuration(facts.runMs)}
${logLine(facts.logPath)}
Last output:
${facts.tail || '(no output)'}
${closing(facts, true)}`;
}

/** The runtime notice delivered once when a running job has printed nothing for a while and its last line looks like a question. */
export function jobStalledNotice(facts: JobNoticeFacts): string {
  return `[Background job ${facts.id} is probably waiting for input]
Command: ${shortCommand(facts.command)}
Started by: ${facts.starter}
Run time so far: ${jobDuration(facts.runMs)}
${logLine(facts.logPath)}
Its output has stopped and the last line looks like an interactive prompt:
${facts.tail || '(no output)'}
A background job cannot answer a prompt. Stop it with ShellJob({id: "${facts.id}", stop: true}) and run it again with piped input or a non-interactive flag. If it is only slow and no prompt is pending, leave it running.
${closing(facts, false)}`;
}
