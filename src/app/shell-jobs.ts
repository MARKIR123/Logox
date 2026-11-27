// Background Shell jobs at the session level: routes each job's exit (and interactive-stall) notification, and gives the footer pill and the jobs page
// their plain-data view. The jobs themselves live in `src/tools/process.ts`; they outlive the activity that started them.
import {readFile} from 'node:fs/promises';
import {DIRECTOR_ID} from '../runtime/director-id.js';
import {listBackgroundJobs, onBackgroundJobEvent, onBackgroundJobsChanged, stopBackgroundJob, type BackgroundJob, type BackgroundJobEvent} from '../tools/process.js';
import {jobEndedNotice, jobStalledNotice, type JobNoticeFacts} from '../tools/ShellJobTool/prompt.js';

/** Lines of output a notification carries, and the most characters they may take. */
export const NOTICE_TAIL_LINES = 40;
const NOTICE_TAIL_CHARS = 6000;
const LINE_CHARS = 400;

/** The last `count` non-empty lines of an output, each cut to a bounded length, the whole bounded too. */
export function lastLines(output: string, count = NOTICE_TAIL_LINES, maxChars = NOTICE_TAIL_CHARS): string {
  const lines = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/).map(line => line.trimEnd()).filter(line => line.trim());
  const kept = lines.slice(-count).map(line => line.length > LINE_CHARS ? line.slice(0, LINE_CHARS - 1) + '…' : line);
  let text = kept.join('\n');
  if (text.length > maxChars) text = '…' + text.slice(-(maxChars - 1));
  return text;
}

export type ShellJobState = 'running' | 'exited' | 'failed' | 'stopped';
export interface ShellJobView {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly ownerId: string | undefined;
  /** Display name of the actor that started it. */
  readonly actor: string;
  readonly command: string;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly state: ShellJobState;
  readonly exitCode: number | null | undefined;
  /** The last few lines of its output. */
  readonly tail: string;
  readonly logPath: string | undefined;
  readonly autoBackgrounded: boolean;
}
const VIEW_TAIL_LINES = 6;

export interface ShellJobDeps {
  readonly sessionId: string;
  /** The name an actor id is shown under. */
  nameOf(ownerId: string): string;
  /** Puts text into the activity's running task (false when that task cannot receive it any more). */
  deliverToTask(ownerId: string, activityId: string, text: string, summary: string): Promise<boolean>;
  /** Delivers a runtime notice to the Director, waking it when idle. */
  notifyDirector(text: string, source: string): Promise<void>;
  /** True once the session is closing: nothing is delivered. */
  closed(): boolean;
}

export interface ShellJobs {
  list(): readonly ShellJobView[];
  /** Notified when a job starts, ends or is forgotten. */
  subscribe(listener: () => void): () => void;
  /** Stops a running job on purpose (no exit notification); false when it is not running. */
  stop(id: string): boolean;
  /** The whole logged output of a job (what its log file holds). */
  log(id: string): Promise<string | undefined>;
  /** Number of jobs still running. */
  running(): number;
  /** Stops listening and stops nothing: the session's jobs are killed by the ensemble's close. */
  dispose(): void;
}

function view(job: BackgroundJob, nameOf: (ownerId: string) => string): ShellJobView {
  const state: ShellJobState = job.exitCode === undefined && !job.stopped ? 'running'
    : job.stopped ? 'stopped' : job.exitCode === 0 ? 'exited' : 'failed';
  return {id: job.id, sessionId: job.sessionId, ownerId: job.ownerId, actor: job.ownerId ? nameOf(job.ownerId) : 'unknown', command: job.command, startedAt: job.startedAt,
    endedAt: job.endedAt, state, exitCode: job.exitCode, tail: lastLines(job.tail, VIEW_TAIL_LINES, 1200), logPath: job.logPath, autoBackgrounded: job.autoBackgrounded};
}

/** Routes the notifications of the session's jobs: into the starting actor's task while it is open, else to the Director (never to a companion by itself). */
export function createShellJobs(deps: ShellJobDeps): ShellJobs {
  const factsOf = (job: BackgroundJob, audience: JobNoticeFacts['audience']): JobNoticeFacts => ({id: job.id, command: job.command,
    starter: job.ownerId ? deps.nameOf(job.ownerId) + (job.ownerId === DIRECTOR_ID ? '' : ` (${job.ownerId})`) : 'unknown', runMs: (job.endedAt ?? Date.now()) - job.startedAt,
    exitCode: job.exitCode, tail: lastLines(job.tail), logPath: job.logPath, audience});
  const route = async (event: BackgroundJobEvent): Promise<void> => {
    const {job} = event;
    if (deps.closed()) return;
    const text = (audience: JobNoticeFacts['audience']) => (event.kind === 'exit' ? jobEndedNotice : jobStalledNotice)(factsOf(job, audience));
    const summary = event.kind === 'exit' ? `Background job ${job.id} ended` : `Background job ${job.id} may be waiting for input`;
    try {
      if (job.ownerId && job.activityId && await deps.deliverToTask(job.ownerId, job.activityId, text('owner'), summary)) return;
      if (deps.closed()) return;
      await deps.notifyDirector(text('director'), job.ownerId ?? DIRECTOR_ID);
    } catch {}
  };
  const stopListening = onBackgroundJobEvent(deps.sessionId, event => {void route(event);});
  return {
    list: () => listBackgroundJobs(deps.sessionId).map(job => view(job, deps.nameOf)),
    subscribe: listener => onBackgroundJobsChanged(listener),
    stop: id => {
      const job = listBackgroundJobs(deps.sessionId).find(item => item.id === id);
      if (!job || job.exitCode !== undefined || job.stopped) return false;
      stopBackgroundJob(id, deps.sessionId);
      return true;
    },
    log: async id => {
      const job = listBackgroundJobs(deps.sessionId).find(item => item.id === id);
      if (!job) return undefined;
      if (job.logPath) try {return await readFile(job.logPath, 'utf8');} catch {}
      return job.tail;
    },
    running: () => listBackgroundJobs(deps.sessionId).filter(job => job.exitCode === undefined && !job.stopped).length,
    dispose: stopListening,
  };
}
