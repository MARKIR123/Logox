import {spawn, type ChildProcess} from 'node:child_process';

export interface ProcessResult {code: number; stdout: string; stderr: string}

/** Kill reason recorded when the user presses `■ Stop` on a running command. */
export const USER_STOP_REASON = 'Stopped by user';
/** Who ended a process on purpose; `system` covers timeouts, steering interrupts and other runtime kills. */
export type StopSource = 'user' | 'director' | 'system';

/** A process ended on purpose (not by itself). Carries what it had printed so the caller can still report it. */
export class ProcessStoppedError extends Error {
  stdout = '';
  stderr = '';
  constructor(readonly reason: string, readonly by: StopSource = 'system') {
    super(reason);
    this.name = 'ProcessStoppedError';
  }
}

export interface ActiveToolExecution {
  pid: number;
  activityId?: string | undefined;
  toolId?: string | undefined;
  sessionId?: string | undefined;
  kill(reason?: string, by?: StopSource): void;
}

/** Execution registry key: the session is part of the identity, so equal call ids in two sessions never collide. */
function scopeKey(sessionId: string | undefined, id: string): string {return (sessionId ?? '') + '\0' + id;}
const activeExecutions = new Map<string, ActiveToolExecution>();

export function registerActiveProcess(id: string, execution: ActiveToolExecution): () => void {
  const key = scopeKey(execution.sessionId, id);
  activeExecutions.set(key, execution);
  return () => {
    if (activeExecutions.get(key) === execution) {
      activeExecutions.delete(key);
    }
  };
}

/** Stops one tool call; with a session id it only ever stops that session's call (never a same-named one elsewhere). */
export function killActiveProcess(id: string, reason = 'Terminated by director', by: StopSource = 'system', sessionId?: string): boolean {
  const execution = activeExecutions.get(scopeKey(sessionId, id));
  if (execution) {
    execution.kill(reason, by);
    activeExecutions.delete(scopeKey(sessionId, id));
    return true;
  }
  if (sessionId !== undefined) return [...backgroundJobs.values()].some(job => job.sessionId === sessionId && (job.callId === id || job.id === id) && stopBackgroundJob(job.id, sessionId) !== undefined);
  return [...backgroundJobs.values()].some(job => (job.callId === id || job.id === id) && stopBackgroundJob(job.id, job.sessionId) !== undefined);
}

export function killActivityProcesses(activityId: string, reason = 'Terminated by director', by: StopSource = 'system', sessionId?: string): number {
  let count = 0;
  for (const [key, exec] of [...activeExecutions.entries()]) {
    if (exec.activityId === activityId && (sessionId === undefined || exec.sessionId === sessionId)) {
      exec.kill(reason, by);
      activeExecutions.delete(key);
      count++;
    }
  }
  return count;
}

export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
  maxOutput = 64_000,
  onLine?: (line: string) => boolean,
  extraEnv?: Record<string, string>,
  metadata?: {activityId?: string; toolId?: string; sessionId?: string},
): Promise<ProcessResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = extraEnv ? {...process.env, ...extraEnv} : process.env;
    const child: ChildProcess = spawn(command, [...args], {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '', lineBuffer = '', stopped: Error | undefined, limited = false;
    let settled = false;

    const bounded = (old: string, next: string) => {
      const combined = old + next;
      return combined.length > maxOutput
        ? combined.slice(0, maxOutput / 2) + '\n...[output truncated]...\n' + combined.slice(-maxOutput / 2)
        : combined;
    };

    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.on('error', () => child.kill());
        killer.once('close', code => {if (code !== 0) child.kill();});
      } else {
        try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}
      }
    };

    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const withOutput = (reason: Error) => {
      if (reason instanceof ProcessStoppedError) {reason.stdout = stdout; reason.stderr = stderr;}
      return reason;
    };

    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = reason;
      kill();
      // Ensure we do not hang indefinitely if grandchildren or orphan processes hold stdio pipes open
      if (!settled) {
        forceTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { child.stdout?.destroy(); } catch {}
            try { child.stderr?.destroy(); } catch {}
            try { child.kill('SIGKILL'); } catch {}
            cleanup();
            reject(withOutput(reason));
          }
        }, 1500);
        forceTimer.unref?.();
      }
    };

    if (child.pid && metadata) {
      const execId = metadata.toolId || `${metadata.activityId ?? 'proc'}-${child.pid}`;
      const unregister = registerActiveProcess(execId, {
        pid: child.pid,
        activityId: metadata.activityId,
        toolId: metadata.toolId,
        sessionId: metadata.sessionId,
        kill: (msg, by) => stop(new ProcessStoppedError(msg || 'Process killed', by)),
      });
      child.once('close', () => unregister());
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (data: string) => {
      if (limited) return;
      stdout = bounded(stdout, data);
      if (!onLine) return;
      lineBuffer += data;
      if (lineBuffer.length > 4 * 1024 * 1024) {
        stop(new Error('Single line in search output exceeded size limit'));
        return;
      }
      let boundary: number;
      while ((boundary = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, boundary);
        lineBuffer = lineBuffer.slice(boundary + 1);
        try {
          if (!onLine(line)) {
            limited = true;
            kill();
            return;
          }
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });

    child.stderr?.on('data', (data: string) => {
      stderr = bounded(stderr, data);
    });

    const abort = () => stop(new Error('Operation cancelled'));
    const timer = setTimeout(() => stop(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
    signal.addEventListener('abort', abort, {once: true});

    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal.removeEventListener('abort', abort);
    };

    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.once('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopped) reject(withOutput(stopped));
      else resolve({code: limited ? 0 : code ?? -1, stdout, stderr});
    });

    if (signal.aborted) abort();
  });
}

/** Kills a process and everything it started. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    killer.on('error', () => child.kill());
    killer.once('close', code => {if (code !== 0) child.kill();});
  } else {
    try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}
  }
}

/** A command started with `run_in_background`: it outlives the Shell call and ends with its activity, on `ShellJob` stop, or at shutdown. */
export interface BackgroundJob {
  readonly id: string;
  readonly pid: number;
  readonly command: string;
  readonly sessionId: string | undefined;
  readonly activityId: string | undefined;
  readonly callId: string | undefined;
  readonly startedAt: number;
  /** Exit code once the process has ended (`null` when it was killed). */
  exitCode: number | null | undefined;
  stopped: boolean;
  /** Output not yet returned to the model, bounded to its most recent bytes. */
  unread: string;
  /** True when older unread output was dropped to stay bounded. */
  dropped: boolean;
  readonly child: ChildProcess;
}

const BACKGROUND_OUTPUT_LIMIT = 32_000;
const BACKGROUND_SETTLE_MS = 1_000;
const backgroundJobs = new Map<string, BackgroundJob>();
let backgroundCounter = 0;

function findBackgroundJob(id: string, sessionId?: string): BackgroundJob | undefined {
  if (sessionId !== undefined) return backgroundJobs.get(scopeKey(sessionId, id));
  // Legacy callers without a session still address the job key they were given; a job id is unique case by case.
  return backgroundJobs.get(scopeKey(undefined, id)) ?? [...backgroundJobs.values()].find(job => job.id === id);
}

export function startBackgroundProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  metadata?: {activityId?: string; toolId?: string; sessionId?: string},
  settleMs = BACKGROUND_SETTLE_MS,
): Promise<BackgroundJob> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {cwd, env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    let started = false;
    child.once('error', error => {if (!started) reject(error);});
    if (!child.pid) return;
    started = true;
    const job: BackgroundJob = {id: 'job-' + ++backgroundCounter, pid: child.pid, command: args[args.length - 1] ?? command,
      sessionId: metadata?.sessionId, activityId: metadata?.activityId, callId: metadata?.toolId, startedAt: Date.now(), exitCode: undefined, stopped: false, unread: '', dropped: false, child};
    backgroundJobs.set(scopeKey(job.sessionId, job.id), job);
    const collect = (data: string) => {
      job.unread += data;
      if (job.unread.length > BACKGROUND_OUTPUT_LIMIT) {job.unread = job.unread.slice(-BACKGROUND_OUTPUT_LIMIT); job.dropped = true;}
    };
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    child.once('close', code => {job.exitCode = code;});
    // Initial output: wait briefly for startup lines or an early exit, then hand control back.
    const timer = setTimeout(() => resolve(job), settleMs);
    timer.unref?.();
    child.once('close', () => {clearTimeout(timer); resolve(job);});
  });
}

/** Returns the output produced since the last read and clears it. */
export function takeBackgroundOutput(id: string, sessionId?: string): {job: BackgroundJob; output: string; dropped: boolean} | undefined {
  const job = findBackgroundJob(id, sessionId);
  if (!job) return undefined;
  const output = job.unread, dropped = job.dropped;
  job.unread = ''; job.dropped = false;
  return {job, output, dropped};
}

/** Kills one background job of this session, keeping it listed so its remaining output can still be read. */
export function stopBackgroundJob(id: string, sessionId?: string): BackgroundJob | undefined {
  const job = findBackgroundJob(id, sessionId);
  if (!job) return undefined;
  if (job.exitCode === undefined && !job.stopped) {job.stopped = true; killTree(job.child);}
  return job;
}

/** Kills the background jobs a finished activity started and forgets every job it owned; with a session, only that session's jobs. */
export function killBackgroundJobs(activityId?: string, sessionId?: string): number {
  let count = 0;
  for (const [key, job] of [...backgroundJobs.entries()]) {
    if (activityId !== undefined && job.activityId !== activityId) continue;
    if (sessionId !== undefined && job.sessionId !== sessionId) continue;
    if (job.exitCode === undefined && !job.stopped) {job.stopped = true; killTree(job.child); count++;}
    if (job.exitCode !== undefined || job.stopped) setTimeout(() => backgroundJobs.delete(key), 60_000).unref?.();
  }
  return count;
}
