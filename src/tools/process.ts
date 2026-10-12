import {spawn} from 'node:child_process';

export interface ProcessResult {code: number; stdout: string; stderr: string}
export function runProcess(command: string, args: readonly string[], cwd: string, signal: AbortSignal,
  timeoutMs = 60_000, maxOutput = 64_000, onLine?: (line: string) => boolean): Promise<ProcessResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {cwd, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', lineBuffer = '', stopped: Error | undefined, limited = false;
    const bounded = (old: string, next: string) => {
      const combined = old + next;
      return combined.length > maxOutput ? combined.slice(0, maxOutput / 2) + '\n…输出截断…\n' + combined.slice(-maxOutput / 2) : combined;
    };
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.on('error', () => child.kill());
      } else {try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
    };
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = reason; kill();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if (limited) return;
      stdout = bounded(stdout, data);
      if (!onLine) return;
      lineBuffer += data;
      if (lineBuffer.length > 4 * 1024 * 1024) {stop(new Error('搜索结果单行超过大小限制')); return;}
      let boundary: number;
      while ((boundary = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, boundary);
        lineBuffer = lineBuffer.slice(boundary + 1);
        try {if (!onLine(line)) {limited = true; kill(); return;}}
        catch (error) {stop(error instanceof Error ? error : new Error(String(error))); return;}
      }
    });
    child.stderr.on('data', (data: string) => {stderr = bounded(stderr, data);});
    const abort = () => stop(new Error('操作已取消'));
    const timer = setTimeout(() => stop(new Error('命令执行超时')), timeoutMs);
    signal.addEventListener('abort', abort, {once: true});
    const cleanup = () => {clearTimeout(timer); signal.removeEventListener('abort', abort);};
    child.once('error', error => {cleanup(); reject(error);});
    child.once('close', code => {
      cleanup();
      if (stopped) reject(stopped);
      else resolve({code: limited ? 0 : code ?? -1, stdout, stderr});
    });
    if (signal.aborted) abort();
  });
}
