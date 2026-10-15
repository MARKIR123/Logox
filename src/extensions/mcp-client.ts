import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {z} from 'zod';
import type {McpServerConfig} from './config.js';
import {terminate} from './process.js';

const messageSchema = z.object({jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(), result: z.unknown().optional(),
  error: z.object({code: z.number(), message: z.string()}).optional()});
interface Pending {resolve(value: unknown): void; reject(reason: Error): void}
export class McpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private connecting: Promise<void> | undefined;
  private shuttingDown: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private ready = false;
  private failure: Error | undefined;
  constructor(readonly config: McpServerConfig, readonly cwd: string) {}
  status(): 'closed' | 'connected' | 'connecting' | 'stopped' | 'failed' {
    return this.closed ? 'closed' : this.failure ? 'failed' : this.ready ? 'connected' : this.connecting ? 'connecting' : 'stopped';
  }
  private send(value: unknown) {
    if (!this.child || this.failure) throw this.failure ?? new Error('MCP 未连接');
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('MCP 请求超过 1 MiB');
    this.child.stdin.write(serialized + '\n', error => {if (error) void this.fail(new Error('MCP stdin 写入失败'));});
  }
  private fail(error: Error): Promise<void> {
    this.failure ??= error; this.ready = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const child = this.child;
    if (!this.shuttingDown) this.shuttingDown = child ? terminate(child).finally(() => {this.child = undefined;}) : Promise.resolve();
    return this.shuttingDown;
  }
  private rpc(method: string, params: unknown, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failure || this.closed) throw this.failure ?? new Error('MCP 已关闭');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const stop = (error: Error) => {
        // 取消远端调用并回收连接，不假设远端一定实现 cancellation。
        try {this.send({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: id, reason: error.message}});} catch {}
        void this.fail(error).then(() => finish(error));
      };
      const abort = () => stop(new Error('MCP 操作已取消'));
      const timer = setTimeout(() => stop(new Error('MCP 操作超时')), timeoutMs);
      signal.addEventListener('abort', abort, {once: true});
      this.pending.set(id, {resolve: value => finish(undefined, value), reject: error => finish(error)});
      try {this.send({jsonrpc: '2.0', id, method, params});} catch (error) {finish(error instanceof Error ? error : new Error('MCP 写入失败'));}
      if (signal.aborted) abort();
    });
  }
  private async connect(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) throw new Error('MCP 已关闭');
    if (this.ready) return;
    if (!this.connecting) {
      this.connecting = this.start(signal);
      void this.connecting.finally(() => {this.connecting = undefined;}).catch(() => {});
    }
    const abort = () => {void this.fail(new Error('MCP 连接已取消'));};
    signal.addEventListener('abort', abort, {once: true});
    try {await this.connecting; signal.throwIfAborted();}
    finally {signal.removeEventListener('abort', abort);}
  }
  private async start(signal: AbortSignal) {
    if (this.closed) throw new Error('MCP 已关闭');
    if (!this.config.enabled) throw new Error('MCP 服务已禁用');
    if (this.config.transport !== 'stdio') throw new Error('本轮只支持 MCP stdio');
    if (this.ready) return;
    await this.shuttingDown;
    signal.throwIfAborted();
    if (this.closed) throw new Error('MCP 已关闭');
    this.shuttingDown = undefined; this.failure = undefined;
    const child = spawn(this.config.command, this.config.args, {cwd: this.cwd, env: {...process.env, ...this.config.env},
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {void this.fail(new Error('MCP 消息超过 1 MiB')); return;}
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = messageSchema.parse(JSON.parse(line));
          if (message.method) {
            if (message.id !== undefined) this.send({jsonrpc: '2.0', id: message.id,
              ...(message.method === 'ping' ? {result: {}} : {error: {code: -32601, message: '客户端不支持此方法'}})});
          } else {
            if (message.id === undefined || (Object.hasOwn(message, 'result') === !!message.error)) throw new Error('无效 RPC 响应');
            const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
            if (!pending) throw new Error('MCP 响应 ID 无效');
            if (message.error) pending.reject(new Error('MCP 服务返回错误：' + message.error.code));
            else pending.resolve(message.result);
          }
        } catch {void this.fail(new Error('MCP 返回坏消息')); return;}
      }
    });
    child.stderr.resume(); // 消耗但不回显，避免服务日志泄漏凭据。
    child.stdin.on('error', () => {void this.fail(new Error('MCP stdin 关闭'));});
    child.once('error', () => {void this.fail(new Error('MCP 服务启动失败'));});
    child.once('close', () => {void this.fail(new Error('MCP 服务已退出'));});
    try {
      const result = await this.rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: {name: 'logox-ts', version: '0.0.0'}}, signal, this.config.startup_timeout_s * 1000);
      const initialized = z.object({protocolVersion: z.enum(['2024-11-05', '2025-03-26', '2025-06-18']),
        capabilities: z.object({tools: z.object({}).optional()}), serverInfo: z.object({name: z.string(), version: z.string()})}).parse(result);
      if (!initialized.capabilities.tools) throw new Error('MCP 服务未声明 tools 能力');
      this.send({jsonrpc: '2.0', method: 'notifications/initialized'}); this.ready = true;
    } catch (error) {await this.fail(error instanceof Error ? error : new Error('MCP 初始化失败')); throw error;}
  }
  async request(method: 'tools/list' | 'tools/call', params: unknown, signal: AbortSignal): Promise<unknown> {
    try {await this.connect(signal); return await this.rpc(method, params, signal, this.config.timeout * 1000);}
    finally {if (this.failure) await this.shuttingDown;}
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.fail(new Error('MCP 已关闭'));
    await this.connecting?.catch(() => {});
  }
}
