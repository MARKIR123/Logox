import {spawn, type ChildProcess} from 'node:child_process';
import {appendFileSync, closeSync, mkdirSync, openSync, readSync, fstatSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export interface ProcessResult {code: number; stdout: string; stderr: string; /** Set when the command ran past `autoBackground.afterMs` and was moved to the background: the process is still running as this job. */ background?: BackgroundJob}

/** Moves a foreground command that is still running after `afterMs` to the background in place (`runProcess()` resolves with `background` set). */
export interface AutoBackground {
  readonly afterMs: number;
  adopt(child: ChildProcess, output: string): BackgroundJob;
}

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
  autoBackground?: AutoBackground,
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

    let unregister: (() => void) | undefined;
    if (child.pid && metadata) {
      const execId = metadata.toolId || `${metadata.activityId ?? 'proc'}-${child.pid}`;
      unregister = registerActiveProcess(execId, {
        pid: child.pid,
        activityId: metadata.activityId,
        toolId: metadata.toolId,
        sessionId: metadata.sessionId,
        kill: (msg, by) => stop(new ProcessStoppedError(msg || 'Process killed', by)),
      });
      child.once('close', () => unregister?.());
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const onStdout = (data: string) => {
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
    };
    const onStderr = (data: string) => {stderr = bounded(stderr, data);};
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    const abort = () => stop(new Error('Operation cancelled'));
    // A command that outlives `autoBackground.afterMs` becomes a background job instead of being killed or waited for.
    const promoteAt = autoBackground && autoBackground.afterMs <= timeoutMs ? autoBackground.afterMs : undefined;
    const promote = () => {
      if (!autoBackground || settled || stopped || !child.pid) return;
      settled = true;
      cleanup();
      child.stdout?.off('data', onStdout); child.stderr?.off('data', onStderr);
      unregister?.();
      resolve({code: 0, stdout, stderr, background: autoBackground.adopt(child, stdout + (stderr ? '\n' + stderr : ''))});
    };
    const timer = setTimeout(() => {if (promoteAt !== undefined) promote(); else stop(new Error(`Command timed out after ${timeoutMs}ms`));}, timeoutMs);
    const promoteTimer = promoteAt !== undefined ? setTimeout(promote, promoteAt) : undefined;
    signal.addEventListener('abort', abort, {once: true});

    const cleanup = () => {
      clearTimeout(timer);
      if (promoteTimer) clearTimeout(promoteTimer);
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

/** A command that runs in the background: started with `run_in_background` or moved there when a foreground command ran long. It belongs to its session, not to the activity that started it. */
export interface BackgroundJob {
  readonly id: string;
  readonly pid: number;
  readonly command: string;
  readonly sessionId: string | undefined;
  readonly activityId: string | undefined;
  /** The actor that started the job; the runtime reads it to say who to wake. */
  readonly ownerId: string | undefined;
  readonly callId: string | undefined;
  readonly startedAt: number;
  /** True when a foreground command was moved to the background after running past the threshold. */
  readonly autoBackgrounded: boolean;
  /** Exit code once the process has ended (`null` when it was killed). */
  exitCode: number | null | undefined;
  /** When the process ended. */
  endedAt: number | undefined;
  stopped: boolean;
  /** Whoever killed it (`ShellJob` stop, the user's Stop, session close) already knows: no exit notification. */
  suppressed: boolean;
  /** The exit notification was delivered (or deliberately dropped); it is sent at most once. */
  notified: boolean;
  /** The interactive-prompt notification was sent; it is sent at most once. */
  stalled: boolean;
  /** Output not yet returned to the model, bounded to its most recent bytes. */
  unread: string;
  /** True when older unread output was dropped to stay bounded. */
  dropped: boolean;
  /** The most recent output (bounded), whatever `ShellJob` has already returned: the notification and the jobs page show its last lines. */
  tail: string;
  /** When the output last grew. */
  lastOutputAt: number;
  /** The file holding the job's whole output (its last `LOG_KEEP_BYTES` once it grew past `LOG_MAX_BYTES`). */
  readonly logPath: string | undefined;
  readonly child: ChildProcess;
}

/** What a job tells the runtime: it ended, or it looks stuck at an interactive prompt. */
export interface BackgroundJobEvent {readonly kind: 'exit' | 'stall'; readonly job: BackgroundJob}
export type BackgroundJobListener = (event: BackgroundJobEvent) => void;

export interface JobMetadata {activityId?: string; toolId?: string; sessionId?: string; ownerId?: string; /** Where the job's whole output is written. */ logFile?: string}

const BACKGROUND_OUTPUT_LIMIT = 32_000;
const BACKGROUND_TAIL_LIMIT = 16_000;
const BACKGROUND_SETTLE_MS = 1_000;
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
export const LOG_KEEP_BYTES = 5 * 1024 * 1024;
/** Timings the runtime uses; tests shorten them. `forgetMs` is how long a finished job stays listed and readable. */
export const backgroundTuning = {stallMs: 45_000, stallCheckMs: 5_000, forgetMs: 10 * 60_000};
const backgroundJobs = new Map<string, BackgroundJob>();
const listeners = new Map<string, Set<BackgroundJobListener>>();
const changeListeners = new Set<() => void>();
let backgroundCounter = 0;

function changed(): void {for (const listener of [...changeListeners]) try {listener();} catch {}}
/** Called whenever a job starts, ends or is forgotten (the footer pill and the jobs page refresh). */
export function onBackgroundJobsChanged(listener: () => void): () => void {changeListeners.add(listener); return () => {changeListeners.delete(listener);};}
/** The runtime's receiver for a session's job events; none registered means no delivery (the session is closing or headless). */
export function onBackgroundJobEvent(sessionId: string | undefined, listener: BackgroundJobListener): () => void {
  const key = sessionId ?? '';
  const set = listeners.get(key) ?? new Set<BackgroundJobListener>();
  set.add(listener); listeners.set(key, set);
  return () => {set.delete(listener); if (!set.size) listeners.delete(key);};
}
function emit(kind: BackgroundJobEvent['kind'], job: BackgroundJob): void {
  for (const listener of [...listeners.get(job.sessionId ?? '') ?? []]) try {listener({kind, job});} catch {}
}

function findBackgroundJob(id: string, sessionId?: string): BackgroundJob | undefined {
  if (sessionId !== undefined) return backgroundJobs.get(scopeKey(sessionId, id));
  // Legacy callers without a session still address the job key they were given; a job id is unique case by case.
  return backgroundJobs.get(scopeKey(undefined, id)) ?? [...backgroundJobs.values()].find(job => job.id === id);
}

/** Every job of a session (running and recently finished), oldest first. */
export function listBackgroundJobs(sessionId?: string): readonly BackgroundJob[] {
  return [...backgroundJobs.values()].filter(job => sessionId === undefined || job.sessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt);
}

/** True when the last line of the output looks like a question waiting for the human. */
export function looksInteractive(output: string): boolean {
  const lines = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/).map(line => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last || last.length > 300) return false;
  return /\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\]/i.test(last)
    || /press\s+(?:enter|return|any key)/i.test(last)
    || /\b(?:continue|overwrite|proceed|replace)\s*\?\s*$/i.test(last)
    || /^(?:do you|would you|are you sure|shall i|should i|can i|may i|will you)\b.*\?\s*$/i.test(last);
}

function appendLog(log: {logPath: string | undefined; logBytes: number}, data: string): void {
  if (!log.logPath) return;
  try {
    appendFileSync(log.logPath, data);
    log.logBytes += Buffer.byteLength(data);
    if (log.logBytes > LOG_MAX_BYTES) {
      // Keep the most recent output: rewrite the file with its last LOG_KEEP_BYTES behind a marker line.
      const fd = openSync(log.logPath, 'r');
      let kept: Buffer;
      try {
        const size = fstatSync(fd).size, length = Math.min(size, LOG_KEEP_BYTES);
        kept = Buffer.alloc(length); readSync(fd, kept, 0, length, size - length);
      } finally {closeSync(fd);}
      writeFileSync(log.logPath, Buffer.concat([Buffer.from('[earlier output dropped to keep this log bounded]\n'), kept]));
      log.logBytes = kept.length;
    }
  } catch {}
}

/** Registers a running child as a background job: output collection, the log file, exit and stall detection. */
function adoptBackgroundJob(child: ChildProcess, command: string, metadata: JobMetadata | undefined, initial: string, autoBackgrounded: boolean): BackgroundJob {
  const logPath = metadata?.logFile;
  if (logPath) try {mkdirSync(dirname(logPath), {recursive: true}); writeFileSync(logPath, '');} catch {}
  const now = Date.now();
  const job: BackgroundJob = {id: 'job-' + ++backgroundCounter, pid: child.pid!, command, sessionId: metadata?.sessionId, activityId: metadata?.activityId,
    ownerId: metadata?.ownerId, callId: metadata?.toolId, startedAt: now, autoBackgrounded, exitCode: undefined, endedAt: undefined, stopped: false, suppressed: false,
    notified: false, stalled: false, unread: '', dropped: false, tail: '', lastOutputAt: now, logPath, child};
  const log = {logPath, logBytes: 0};
  backgroundJobs.set(scopeKey(job.sessionId, job.id), job);
  const collect = (data: string) => {
    job.lastOutputAt = Date.now();
    job.unread += data;
    if (job.unread.length > BACKGROUND_OUTPUT_LIMIT) {job.unread = job.unread.slice(-BACKGROUND_OUTPUT_LIMIT); job.dropped = true;}
    job.tail += data;
    if (job.tail.length > BACKGROUND_TAIL_LIMIT) job.tail = job.tail.slice(-BACKGROUND_TAIL_LIMIT);
    appendLog(log, data);
  };
  if (initial) collect(initial);
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', collect); child.stderr?.on('data', collect);
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  let finished = false;
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    if (stallTimer) clearInterval(stallTimer);
    job.exitCode = code; job.endedAt = Date.now();
    setTimeout(() => {if (backgroundJobs.get(scopeKey(job.sessionId, job.id)) === job) {backgroundJobs.delete(scopeKey(job.sessionId, job.id)); changed();}}, backgroundTuning.forgetMs).unref?.();
    if (!job.notified && !job.suppressed) {job.notified = true; emit('exit', job);}
    changed();
  };
  child.once('close', code => finish(code));
  // A grandchild holding the pipes open delays `close`; the process itself has ended.
  child.once('exit', code => {setTimeout(() => finish(code), 1_000).unref?.();});
  stallTimer = setInterval(() => {
    if (finished || job.stalled || job.suppressed || Date.now() - job.lastOutputAt < backgroundTuning.stallMs) return;
    if (!looksInteractive(job.tail)) return;
    job.stalled = true; emit('stall', job);
  }, backgroundTuning.stallCheckMs);
  stallTimer.unref?.();
  changed();
  return job;
}

/** The hook `runProcess()` uses to move a long foreground command into the background in place. */
export function autoBackgroundJob(command: string, metadata: JobMetadata | undefined, afterMs: number): AutoBackground {
  return {afterMs, adopt: (child, output) => adoptBackgroundJob(child, command, metadata, output, true)};
}

export function startBackgroundProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  metadata?: JobMetadata,
  settleMs = BACKGROUND_SETTLE_MS,
): Promise<BackgroundJob> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {cwd, env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    let started = false;
    child.once('error', error => {if (!started) reject(error);});
    if (!child.pid) return;
    started = true;
    const job = adoptBackgroundJob(child, args[args.length - 1] ?? command, metadata, '', false);
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

function stopJob(job: BackgroundJob): boolean {
  if (job.exitCode !== undefined || job.stopped) return false;
  job.stopped = true; job.suppressed = true; killTree(job.child);
  changed();
  return true;
}

/** Kills one background job of this session on purpose (a `ShellJob` stop or a Stop of its call): no exit notification, the job stays listed so its remaining output can still be read. */
export function stopBackgroundJob(id: string, sessionId?: string): BackgroundJob | undefined {
  const job = findBackgroundJob(id, sessionId);
  if (!job) return undefined;
  stopJob(job);
  return job;
}

/**
 * Kills running background jobs on purpose, with no exit notification (the user stopped that work, or the session is closing): those of one activity,
 * those of one session, or every job. Finished jobs stay listed for `backgroundTuning.forgetMs`. A job otherwise outlives the activity that started it.
 */
export function killBackgroundJobs(activityId?: string, sessionId?: string): number {
  let count = 0;
  for (const job of [...backgroundJobs.values()]) {
    if (activityId !== undefined && job.activityId !== activityId) continue;
    if (sessionId !== undefined && job.sessionId !== sessionId) continue;
    if (stopJob(job)) count++;
  }
  return count;
}
