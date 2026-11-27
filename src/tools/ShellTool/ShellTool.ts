import {z} from 'zod';
import type {ToolResult} from '../types.js';
import {ProcessStoppedError, autoBackgroundJob, runProcess, startBackgroundProcess, type JobMetadata, type StopSource} from '../process.js';
import {SHELL_CUT_SHORT_LINE, SHELL_STOPPED_BY_USER, autoBackgroundedText, backgroundStartedText, shellStoppedByDirector} from './prompt.js';

export const shellSchema = z.preprocess(
  // Legacy callers used seconds; values <= 600 are treated as seconds and converted to milliseconds.
  value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const result = {...(value as Record<string, unknown>)};
    if (typeof result.timeout === 'number' && result.timeout <= 600) result.timeout = Math.round(result.timeout * 1000);
    return result;
  },
  z.strictObject({
    command: z.string().min(1).describe('The command to execute'),
    description: z.string().optional().describe('Clear, concise description of what this command does in active voice (5-10 words)'),
    timeout: z.number().int().min(1).max(600_000).optional().describe('Optional timeout. For legacy compatibility, positive values up to 600 are interpreted as seconds; values above 600 are milliseconds, up to 600000. Omission uses 120000 milliseconds. A command still running after the auto-background threshold (120 s by default) moves to the background instead of being killed, even with a longer timeout; background jobs have no timeout. Ignored with run_in_background.'),
    run_in_background: z.boolean().optional().describe('Start the command detached and return immediately with its job id and initial output, for servers and watchers. Read later output or stop it with ShellJob.'),
  }),
);

export type ShellArgs = z.infer<typeof shellSchema>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** The result of a command stopped while the workspace audit ran, before it started: worded like any stopped command, with no output. */
export function stoppedBeforeStart(by: StopSource, reason: string): ToolResult {
  if (by === 'system') return {text: reason, isError: true};
  return {text: (by === 'user' ? SHELL_STOPPED_BY_USER : shellStoppedByDirector(reason)) + '\n\n' + SHELL_CUT_SHORT_LINE + '\n', isError: true};
}

/** A command that only waits (`sleep`, `Start-Sleep`) is never moved to the background: it obeys its timeout. */
export const isSleep = (command: string): boolean => /^\s*(?:&\s*)?['"]?(?:sleep|start-sleep)(?![\w-])/i.test(command);

export async function executeShell(
  args: ShellArgs,
  cwd: string,
  signal: AbortSignal = new AbortController().signal,
  metadata?: JobMetadata,
  /** Milliseconds a foreground command may run before it moves to the background in place; 0 never. */
  autoBackgroundMs = 0,
): Promise<ToolResult> {
  const command = args.command;

  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;
  const executable = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];

  if (args.run_in_background) {
    signal.throwIfAborted();
    const job = await startBackgroundProcess(executable, shellArgs, cwd, metadata);
    const initial = job.unread;
    job.unread = ''; job.dropped = false;
    return {text: backgroundStartedText(job, initial), isError: job.exitCode !== undefined && job.exitCode !== 0};
  }

  let result;
  try {result = await runProcess(
    executable,
    shellArgs,
    cwd,
    signal,
    timeoutMs,
    64_000,
    undefined,
    undefined,
    metadata,
    autoBackgroundMs > 0 && !isSleep(command) ? autoBackgroundJob(command, metadata, autoBackgroundMs) : undefined,
  );} catch (error) {
    // A deliberate stop keeps the partial output; every other failure keeps its own text.
    if (!(error instanceof ProcessStoppedError) || error.by === 'system') throw error;
    const opening = error.by === 'user' ? SHELL_STOPPED_BY_USER : shellStoppedByDirector(error.reason);
    const stderr = error.stderr ? '\nStderr:\n' + error.stderr : '';
    return {text: opening + '\n\n' + SHELL_CUT_SHORT_LINE + '\n' + error.stdout + stderr, isError: true};
  }

  if (result.background) return {text: autoBackgroundedText(result.background, Math.round(autoBackgroundMs / 1000), result.stdout + (result.stderr ? '\nStderr:\n' + result.stderr : '')), isError: false};
  return {
    text: 'Exit code: ' + result.code + '\n' + result.stdout + (result.stderr ? '\nStderr:\n' + result.stderr : ''),
    isError: result.code !== 0,
  };
}

export const metadata: import('../metadata.js').ToolMetadataInput = {name: 'Shell', category: 'core', roles: 'all', terminalVisibility: 'card', description: 'Execute shell commands with timeout and permission controls'};
