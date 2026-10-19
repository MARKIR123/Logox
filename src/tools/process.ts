import {spawn, type ChildProcess} from 'node:child_process';

export interface ProcessResult {code: number; stdout: string; stderr: string}

export interface ActiveToolExecution {
  pid: number;
  activityId?: string | undefined;
  toolId?: string | undefined;
  kill(reason?: string): void;
}

const activeExecutions = new Map<string, ActiveToolExecution>();

export function registerActiveProcess(id: string, execution: ActiveToolExecution): () => void {
  activeExecutions.set(id, execution);
  return () => {
    if (activeExecutions.get(id) === execution) {
      activeExecutions.delete(id);
    }
  };
}

export function killActiveProcess(id: string, reason = 'Terminated by director'): boolean {
  const execution = activeExecutions.get(id);
  if (!execution) return false;
  execution.kill(reason);
  activeExecutions.delete(id);
  return true;
}

export function killActivityProcesses(activityId: string, reason = 'Terminated by director'): number {
  let count = 0;
  for (const [id, exec] of [...activeExecutions.entries()]) {
    if (exec.activityId === activityId) {
      exec.kill(reason);
      activeExecutions.delete(id);
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
  metadata?: {activityId?: string; toolId?: string},
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
            reject(reason);
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
        kill: (msg) => stop(new Error(msg || 'Process killed')),
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

    const abort = () => stop(new Error('操作已取消 (Operation cancelled)'));
    const timer = setTimeout(() => stop(new Error(`命令执行超时 (Command timed out after ${timeoutMs}ms)`)), timeoutMs);
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
      if (stopped) reject(stopped);
      else resolve({code: limited ? 0 : code ?? -1, stdout, stderr});
    });

    if (signal.aborted) abort();
  });
}
