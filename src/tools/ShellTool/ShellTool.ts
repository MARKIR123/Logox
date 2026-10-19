import {dirname, join, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import type {ToolResult} from '../types.js';
import {runProcess} from '../process.js';

import {existsSync} from 'node:fs';

const distBin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const srcBin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'tools', 'bin');
const toolsBinDir = existsSync(distBin) ? distBin : srcBin;

export const shellSchema = z.strictObject({
  command: z.string().min(1),
  description: z.string().optional().describe('Clear, concise description of what this command does in active voice (5-10 words)'),
  timeout: z.preprocess(
    val => typeof val === 'number' && val > 600 ? Math.round(val / 1000) : val,
    z.number().int().min(1).max(600).default(60),
  ),
});

export type ShellArgs = z.infer<typeof shellSchema>;

export async function executeShell(
  args: ShellArgs,
  cwd: string,
  signal: AbortSignal = new AbortController().signal,
  metadata?: {activityId?: string; toolId?: string},
): Promise<ToolResult> {
  let command = args.command;
  // Guard against Chromium virtual-time-budget=0 deadlock
  if (/--virtual-time-budget[=\s]+0\b/.test(command)) {
    command = command.replace(/--virtual-time-budget[=\s]+0\b/g, '--virtual-time-budget=100');
  }

  const extraEnv: Record<string, string> = {
    PATH: toolsBinDir + delimiter + (process.env.PATH || ''),
  };

  const timeoutSec = typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : 60;

  const result = await runProcess(
    process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command],
    cwd,
    signal,
    timeoutSec * 1000,
    64_000,
    undefined,
    extraEnv,
    metadata,
  );

  return {
    text: '退出码：' + result.code + ' (Exit code: ' + result.code + ')\n' + result.stdout + (result.stderr ? '\nStderr:\n' + result.stderr : ''),
    isError: result.code !== 0,
  };
}
