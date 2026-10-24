import {z} from 'zod';
import type {ToolResult} from '../types.js';
import {runProcess} from '../process.js';

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
    timeout: z.number().int().min(1).max(600_000).optional().describe('Optional timeout in milliseconds (max 600000). Defaults to 120000.'),
  }),
);

export type ShellArgs = z.infer<typeof shellSchema>;

const DEFAULT_TIMEOUT_MS = 120_000;

export async function executeShell(
  args: ShellArgs,
  cwd: string,
  signal: AbortSignal = new AbortController().signal,
  metadata?: {activityId?: string; toolId?: string},
): Promise<ToolResult> {
  const command = args.command;

  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

  const result = await runProcess(
    process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command],
    cwd,
    signal,
    timeoutMs,
    64_000,
    undefined,
    undefined,
    metadata,
  );

  return {
    text: 'Exit code: ' + result.code + '\n' + result.stdout + (result.stderr ? '\nStderr:\n' + result.stderr : ''),
    isError: result.code !== 0,
  };
}
