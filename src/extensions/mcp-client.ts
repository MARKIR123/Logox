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
    if (!this.child || this.failure) throw this.failure ?? new Error('MCP not connected');
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('MCP request exceeds 1 MiB');
    this.child.stdin.write(serialized + '\n', error => {if (error) void this.fail(new Error('MCP stdin write failed'));});
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
    if (this.failure || this.closed) throw this.failure ?? new Error('MCP closed');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const stop = (error: Error) => {
        // Cancel the remote call and reclaim the connection; do not assume the remote implements cancellation.
        try {this.send({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: id, reason: error.message}});} catch {}
        void this.fail(error).then(() => finish(error));
      };
      const abort = () => stop(new Error('MCP operation cancelled'));
      const timer = setTimeout(() => stop(new Error('MCP operation timed out')), timeoutMs);
      signal.addEventListener('abort', abort, {once: true});
      this.pending.set(id, {resolve: value => finish(undefined, value), reject: error => finish(error)});
      try {this.send({jsonrpc: '2.0', id, method, params});} catch (error) {finish(error instanceof Error ? error : new Error('MCP write failed'));}
      if (signal.aborted) abort();
    });
  }
  private async connect(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) throw new Error('MCP closed');
    if (this.ready) return;
    if (!this.connecting) {
      this.connecting = this.start(signal);
      void this.connecting.finally(() => {this.connecting = undefined;}).catch(() => {});
    }
    const abort = () => {void this.fail(new Error('MCP connection cancelled'));};
    signal.addEventListener('abort', abort, {once: true});
    try {await this.connecting; signal.throwIfAborted();}
    finally {signal.removeEventListener('abort', abort);}
  }
  private async start(signal: AbortSignal) {
    if (this.closed) throw new Error('MCP closed');
    if (!this.config.enabled) throw new Error('MCP server disabled');
    if (this.config.transport !== 'stdio') throw new Error('Only MCP stdio is supported for now');
    if (this.ready) return;
    await this.shuttingDown;
    signal.throwIfAborted();
    if (this.closed) throw new Error('MCP closed');
    this.shuttingDown = undefined; this.failure = undefined;
    const child = spawn(this.config.command, this.config.args, {cwd: this.cwd, env: {...process.env, ...this.config.env},
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) {void this.fail(new Error('MCP response exceeds 16 MiB')); return;}
        if (!line.trim()) continue;
        try {
          const message = messageSchema.parse(JSON.parse(line));
          if (message.method) {
            if (message.id !== undefined) this.send({jsonrpc: '2.0', id: message.id,
              ...(message.method === 'ping' ? {result: {}} : {error: {code: -32601, message: 'Client does not support this method'}})});
          } else {
            if (message.id === undefined || (Object.hasOwn(message, 'result') === !!message.error)) throw new Error('Invalid RPC response');
            const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
            if (!pending) throw new Error('Invalid MCP response ID');
            if (message.error) pending.reject(new Error('MCP server returned an error: ' + message.error.code));
            else pending.resolve(message.result);
          }
        } catch {void this.fail(new Error('MCP returned a malformed message')); return;}
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) void this.fail(new Error('MCP response exceeds 16 MiB'));
    });
    child.stderr.resume(); // Drain without echoing, so service logs cannot leak credentials.
    child.stdin.on('error', () => {void this.fail(new Error('MCP stdin closed'));});
    child.once('error', () => {void this.fail(new Error('MCP server failed to start'));});
    child.once('close', () => {void this.fail(new Error('MCP server exited'));});
    try {
      const result = await this.rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: {name: 'logox', version: '0.0.0'}}, signal, this.config.startup_timeout_s * 1000);
      const initialized = z.object({protocolVersion: z.enum(['2024-11-05', '2025-03-26', '2025-06-18']),
        capabilities: z.object({tools: z.object({}).optional()}), serverInfo: z.object({name: z.string(), version: z.string()})}).parse(result);
      if (!initialized.capabilities.tools) throw new Error('MCP server did not declare the tools capability');
      this.send({jsonrpc: '2.0', method: 'notifications/initialized'}); this.ready = true;
    } catch (error) {await this.fail(error instanceof Error ? error : new Error('MCP initialization failed')); throw error;}
  }
  async request(method: 'tools/list' | 'tools/call', params: unknown, signal: AbortSignal): Promise<unknown> {
    try {await this.connect(signal); return await this.rpc(method, params, signal, this.config.timeout * 1000);}
    finally {if (this.failure) await this.shuttingDown;}
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.fail(new Error('MCP closed'));
    await this.connecting?.catch(() => {});
  }
}
