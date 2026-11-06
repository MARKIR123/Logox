import {spawn} from 'node:child_process';
import type {GitStatus} from '../runtime/stage-status.js';

/** Parses `git status --porcelain=v2 --branch`; undefined for output without a branch header. */
export function parseGitStatus(output: string): GitStatus | undefined {
  let branch: string | undefined, oid = '', ahead = 0, behind = 0, dirty = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim();
    else if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/u.exec(line);
      if (match) {ahead = Number(match[1]); behind = Number(match[2]);}
    } else if (/^[12u?] /u.test(line)) dirty++;
  }
  if (!branch) return undefined;
  if (branch === '(detached)') branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'detached';
  return {branch, dirty, ahead, behind};
}
/** Resolves only after the git process has exited, so closing the application never leaves a child holding the directory. */
const run = (cwd: string, signal?: AbortSignal): Promise<string | undefined> => new Promise(resolve => {
  let output = '', failed = false;
  try {
    const child = spawn('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
    const stop = () => {child.kill();};
    const timer = setTimeout(stop, 5000);
    signal?.addEventListener('abort', stop, {once: true});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {if (output.length < 4 * 1024 * 1024) output += chunk;});
    child.on('error', () => {failed = true;});
    child.on('close', code => {clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(failed || code !== 0 || signal?.aborted ? undefined : output);});
    if (signal?.aborted) stop();
  } catch {resolve(undefined);}
});

/**
 * Cached repository summary for the status bar. `get()` is synchronous; `refresh()` reruns git (coalesced) and notifies
 * only when the value changed. `touch()` is the cheap hook for file-change events: it schedules one trailing refresh.
 */
export class GitStatusSource {
  private value: GitStatus | undefined;
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private closed = false;
  private current: Promise<void> | undefined;
  private readonly controller = new AbortController();
  constructor(private readonly cwd: string, private readonly changed: () => void,
    private readonly read: (cwd: string, signal: AbortSignal) => Promise<string | undefined> = run) {}
  get(): GitStatus | undefined {return this.value;}
  start(intervalMs = 30_000): void {
    void this.refresh();
    this.interval = setInterval(() => void this.refresh(), intervalMs);
    this.interval.unref();
  }
  touch(delayMs = 4000): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {this.timer = undefined; void this.refresh();}, delayMs);
    this.timer.unref();
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.running) {this.again = true; return;}
    this.running = true;
    const work = (async () => {
      try {
        const output = await this.read(this.cwd, this.controller.signal);
        const next = output === undefined ? undefined : parseGitStatus(output);
        if (!this.closed && JSON.stringify(next) !== JSON.stringify(this.value)) {this.value = next; this.changed();}
      } finally {
        this.running = false;
        if (this.again && !this.closed) {this.again = false; void this.refresh();}
      }
    })();
    this.current = work;
    await work;
  }
  /** Stops timers and any running git process, and resolves once that process has exited. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.interval); clearTimeout(this.timer);
    this.controller.abort();
    await this.current?.catch(() => {});
  }
}
