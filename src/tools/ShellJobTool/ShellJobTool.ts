import {z} from 'zod';
import type {ToolResult} from '../types.js';
import {stopBackgroundJob, takeBackgroundOutput} from '../process.js';
import {shellJobUnknownText} from './prompt.js';

export const shellJobSchema = z.strictObject({
  id: z.string().min(1).describe('The job id returned by Shell run_in_background, such as "job-1"'),
  stop: z.boolean().optional().describe('Kill the job and its child processes, then return the output it still held'),
});

export type ShellJobArgs = z.infer<typeof shellJobSchema>;

export async function executeShellJob(args: ShellJobArgs): Promise<ToolResult> {
  if (args.stop && !stopBackgroundJob(args.id)) return {text: shellJobUnknownText(args.id), isError: true};
  if (args.stop) await new Promise(settle => setTimeout(settle, 150));
  const taken = takeBackgroundOutput(args.id);
  if (!taken) return {text: shellJobUnknownText(args.id), isError: true};
  const {job, output, dropped} = taken;
  const state = job.exitCode === undefined
    ? job.stopped ? 'stopping' : 'running'
    : job.stopped ? 'stopped' : `exited with code ${job.exitCode}`;
  const seconds = Math.round((Date.now() - job.startedAt) / 1000);
  return {text: `Job ${job.id} (pid ${job.pid}) ${state}, started ${seconds}s ago.\n${dropped ? '[Older output dropped]\n' : ''}${output || '(no new output)'}`, isError: false};
}

export const metadata: import('../metadata.js').ToolMetadataInput = {name: 'ShellJob', category: 'core', roles: 'all', terminalVisibility: 'card', description: 'Read output of or stop a background Shell job'};
