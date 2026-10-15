import {spawn} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {hookEvents, type HookEvent, type HooksConfig} from './config.js';
import {terminate} from './process.js';

export interface HookResult {event: HookEvent; ok: boolean; code: number; output: string; reason: string}
interface HookCommand {event: HookEvent; command: string; args: readonly string[]; direct: boolean; tool?: string | undefined}
export class Hooks {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly results: HookResult[] = [];
  private readonly commands: HookCommand[];
  private initialized = false;
  constructor(readonly cwd: string, readonly config: HooksConfig, private readonly diagnose: (text: string) => void = () => {},
    private readonly home = homedir()) {
    this.commands = config.entries.map(entry => ({...entry, direct: entry.args.length > 0}));
  }
  async initialize(): Promise<void> {
    if (!this.config.enabled || this.initialized) return;
    this.initialized = true;
    const seen = new Set<string>();
    for (const directory of [join(this.cwd, '.logox', 'hooks'), join(this.cwd, '.logox-ts', 'hooks'), join(this.home, '.logox', 'hooks'), join(this.home, '.logox-ts', 'hooks')]) {
      for (const event of hookEvents) for (const extension of ['', '.sh', '.py', '.ps1', '.cmd', '.bat', '.mjs', '.js']) {
        const path = join(directory, event + extension);
        try {
          if (!(await lstat(path)).isFile()) continue;
          const canonical = await realpath(path), identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
          if (canonical.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy')) break;
          if (!seen.has(identity)) {
            seen.add(identity);
            const interpreter = extension === '.ps1' ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', canonical]
              : ['.js', '.mjs'].includes(extension) ? [process.execPath, canonical]
                : extension === '.py' ? ['python', canonical] : extension === '.sh' ? ['sh', canonical]
                  : ['.cmd', '.bat'].includes(extension) ? ['cmd.exe', '/d', '/s', '/c', '"' + canonical + '"'] : [canonical];
            this.commands.push({event, command: interpreter[0]!, args: interpreter.slice(1), direct: true});
          }
          break;
        } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.diagnose('观察 hook 文件无法读取：' + path);}
      }
    }
  }
  history(): readonly HookResult[] {return this.results.map(item => ({...item}));}
  emit(event: HookEvent, payload: Readonly<Record<string, string | number | boolean>>): void {
    if (!this.config.enabled || this.controller.signal.aborted) return;
    if (this.pending.size >= 64) {this.diagnose('观察 hook 队列已满，跳过事件：' + event); return;}
    const operation = this.run(event, payload).catch(() => {this.diagnose('观察 hook 执行失败：' + event);});
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }
  private async run(event: HookEvent, payload: Readonly<Record<string, string | number | boolean>>) {
    for (const entry of this.commands) {
      if (entry.event !== event || (entry.tool && entry.tool !== payload.tool) || this.controller.signal.aborted) continue;
      const result = await new Promise<HookResult>(resolve => {
        const command = entry.direct ? entry.command : process.platform === 'win32' ? 'powershell.exe' : 'sh';
        const args = entry.direct ? [...entry.args] : process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-Command', entry.command] : ['-c', entry.command];
        const child = spawn(command, args, {cwd: this.cwd, windowsHide: true, detached: process.platform !== 'win32',
          env: {...process.env, LOGOX_EVENT: event, LOGOX_CWD: this.cwd}, stdio: ['pipe', 'pipe', 'pipe']});
        let output = '', reason = '', finished = false;
        const append = (data: string) => {output = (output + data).slice(0, 8192);};
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', append); child.stderr.on('data', append);
        const stop = (why: string) => {reason = why; void terminate(child);};
        const abort = () => stop('已取消');
        const timer = setTimeout(() => stop('超时'), this.config.timeout_s * 1000);
        this.controller.signal.addEventListener('abort', abort, {once: true});
        const finish = (code: number) => {
          if (finished) return; finished = true;
          clearTimeout(timer); this.controller.signal.removeEventListener('abort', abort);
          resolve({event, ok: code === 0 && !reason, code, output, reason});
        };
        child.once('error', () => {reason = '启动失败'; finish(-1);});
        child.once('close', code => finish(code ?? -1));
        child.stdin.on('error', () => {reason ||= 'stdin 关闭';});
        child.stdin.end(JSON.stringify({event, ...payload}) + '\n');
        if (this.controller.signal.aborted) abort();
      });
      this.results.push(result); if (this.results.length > 64) this.results.shift();
      if (!result.ok) this.diagnose('观察 hook ' + event + ' 失败：' + (result.reason || '退出码 ' + result.code));
    }
  }
  async drain(): Promise<void> {await Promise.all([...this.pending]);}
  async close(): Promise<void> {this.controller.abort(); await this.drain();}
}
