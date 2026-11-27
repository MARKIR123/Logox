// The `/jobs` page (also what a click on the footer's `⧗ N jobs` pill opens): the session's background Shell jobs as a picker. Rows are the running jobs
// first, then the ones that ended; Enter shows the job's whole log as a result page, Ctrl+X (the footer label, or a click on it) stops a running job. The list
// follows the jobs while it is open.
import type {PickerItem} from '../runtime/command-surface.js';
import type {ShellJobs, ShellJobView} from '../app/shell-jobs.js';
import {jobDuration} from '../tools/ShellJobTool/prompt.js';
import type {CommandSurfaces} from './surfaces.js';

export const JOBS_TITLE = 'Background jobs';
export const NO_JOBS_TEXT = 'No background jobs. Shell commands that run longer than the auto-background threshold, and run_in_background jobs, are listed here.';
const COMMAND_CELLS = 100;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number): string => text.length > max ? text.slice(0, max - 1) + '…' : text;
/** `running 12m 4s`, `exited 0 · 3s`, `failed (1) · 3s`, `stopped · 3s`. */
export function jobState(job: ShellJobView, now: number): string {
  const ran = jobDuration((job.endedAt ?? now) - job.startedAt);
  if (job.state === 'running') return 'running ' + ran;
  if (job.state === 'stopped') return 'stopped · ' + ran;
  return (job.state === 'exited' ? 'exited 0' : 'failed (' + (job.exitCode ?? '?') + ')') + ' · ' + ran;
}
const lastLine = (tail: string): string => oneLine(tail.split('\n').filter(line => line.trim()).at(-1) ?? '');

/** Rows of the page: running jobs (newest first), then ended ones (newest first). */
export function jobItems(jobs: readonly ShellJobView[], now = Date.now()): PickerItem[] {
  const order = (job: ShellJobView) => job.state === 'running' ? 0 : 1;
  return [...jobs].sort((a, b) => order(a) - order(b) || b.startedAt - a.startedAt).map(job => {
    const last = lastLine(job.tail);
    return {id: job.id, label: job.actor + ' · ' + job.id, description: jobState(job, now), deletable: job.state === 'running',
      detail: cut(oneLine(job.command), COMMAND_CELLS) + (last ? ' · ' + cut(last, 60) : '')};
  });
}

export function createJobsCommand(deps: {surfaces: CommandSurfaces; shellJobs: ShellJobs}) {
  const {surfaces, shellJobs} = deps;
  let following: (() => void) | undefined;
  const open = async (): Promise<void> => {
    const current = surfaces.getSnapshot();
    if (current?.kind === 'picker' && current.title === JOBS_TITLE) return;
    if (current) surfaces.close();
    // The page follows the jobs while it is open, and lets go when something else has replaced it.
    following?.();
    const stop = following = shellJobs.subscribe(() => {if (!surfaces.setPickerItems(JOBS_TITLE, jobItems(shellJobs.list()))) {stop(); if (following === stop) following = undefined;}});
    await surfaces.openPicker({title: JOBS_TITLE, description: 'Enter shows the full log · Esc back', current: '', items: jobItems(shellJobs.list()), emptyText: NO_JOBS_TEXT},
      async () => ({items: jobItems(shellJobs.list())}),
      async id => {
        const job = shellJobs.list().find(item => item.id === id);
        if (!job) throw new Error('That job is no longer listed.');
        const log = await shellJobs.log(id);
        const header = [job.command, jobState(job, Date.now()), job.logPath ? 'Log file: ' + job.logPath : 'No log file was written.', ''].join('\n');
        surfaces.close();
        surfaces.openResult('Job ' + job.id + ' · ' + job.actor, header + (log?.trim() ? log : '(no output)'));
        return {};
      },
        {deleteLabel: 'Stop job', onDelete: id => {if (!shellJobs.stop(id)) throw new Error('That job is not running.');}});
  };
  return {open};
}
