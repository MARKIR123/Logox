import {Ajv, type ValidateFunction} from 'ajv';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {z} from 'zod';
import type {ActorContext} from '../actors/ensemble.js';
import type {ToolCall, ToolDefinition} from '../runtime/messages.js';
import type {ToolResult} from '../tools/tools.js';
import type {McpServerConfig} from './config.js';
import {McpClient} from './mcp-client.js';

const argsSchema = z.discriminatedUnion('action', [
  z.strictObject({server: z.string().min(1), action: z.literal('list')}),
  z.strictObject({server: z.string().min(1), action: z.literal('call'), tool: z.string().min(1), arguments: z.record(z.string(), z.json())}),
]);
const mcpParametersSchema = z.strictObject({
  server: z.string().min(1).describe('The MCP server name (e.g. "playwright")'),
  action: z.enum(['list', 'call']).describe('Action to take: "list" to list available tools, or "call" to invoke a tool'),
  tool: z.string().min(1).optional().describe('Name of the MCP tool to call (when action is "call")'),
  arguments: z.record(z.string(), z.any()).optional().describe('Arguments dictionary for the tool (when action is "call")'),
});
const remoteToolSchema = z.object({name: z.string().min(1).max(256), description: z.string().max(10_000).optional(),
  inputSchema: z.record(z.string(), z.json())});
type RemoteTool = z.infer<typeof remoteToolSchema> & {validator?: ValidateFunction};
const listSchema = z.object({tools: z.array(remoteToolSchema).max(256), nextCursor: z.string().max(1024).optional()});
const imageSchema = z.object({data: z.string().min(1), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])});
const resultSchema = z.object({isError: z.boolean().optional(), content: z.array(z.object({
  type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional(),
})).max(256), structuredContent: z.record(z.string(), z.json()).optional()});
const MCP_INVALID_TEXT = 'Invalid MCP parameters or response content';
/** Underlying cause of a schema failure: up to three issues as path: message. */
export function zodCause(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map(issue => (issue.path.length ? issue.path.join('.') : '(root)') + ': ' + issue.message);
  return issues.join('; ') + (error.issues.length > 3 ? ' (+' + (error.issues.length - 3) + ' more)' : '');
}
/** Collapses runs of identical consecutive non-blank lines into one line plus " (×N)"; conservative: only runs of 3 or more. */
export function collapseRepeatedLines(text: string): string {
  const lines = text.split('\n'), out: string[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    if (j - i >= 3 && lines[i]!.trim()) out.push(lines[i] + ' (×' + (j - i) + ')');
    else out.push(...lines.slice(i, j));
    i = j;
  }
  return out.join('\n');
}
export interface ExtensionApprovalRequest {
  readonly source: 'mcp'; readonly server: string; readonly tool: string; readonly callId: string;
  readonly action?: 'list' | 'call';
  readonly arguments: Record<string, z.infer<ReturnType<typeof z.json>>>;
  readonly inputSchema: Record<string, z.infer<ReturnType<typeof z.json>>>;
}
export type ExtensionApproval = (request: ExtensionApprovalRequest, context: ActorContext) => Promise<boolean>;
/** Single approval entry point; once the caller injects a policy, context.permission is no longer called. */
export const askExtensionPermission: ExtensionApproval = (request, context) => request.action === 'list' ? Promise.resolve(true) : context.permission({
  kind: 'permission', title: 'Allow this MCP tool call?', tool: 'mcp:' + request.server + ':' + request.tool,
  arguments: request.arguments, reason: 'Remote tools may modify files or access external services.',
});
export class Mcp {
  private readonly clients = new Map<string, McpClient>();
  private readonly catalogs = new Map<string, RemoteTool[]>();
  constructor(readonly cwd: string, readonly servers: Readonly<Record<string, McpServerConfig>>,
    private readonly approve: ExtensionApproval = askExtensionPermission) {
    for (const [name, config] of Object.entries(servers)) if (config.enabled) this.clients.set(name, new McpClient(config, cwd));
  }
  definitions(): readonly ToolDefinition[] {
    return this.clients.size ? [{name: 'mcp', description: 'Call MCP tools. First list a server, then call a listed tool with arguments matching its full schema. Calls require permission. Browser interactions and screenshots use the local playwright server; returned images are delivered directly to your visual input. Servers: ' +
      Object.keys(this.servers).filter(name => this.clients.has(name)).join(', '), parameters: z.toJSONSchema(mcpParametersSchema)}] : [];
  }
  status() {
    return Object.keys(this.servers).filter(name => this.clients.has(name)).map(name => ({name, state: this.clients.get(name)!.status()}));
  }
  private clientFor(server: string, ownerId?: string): McpClient | undefined {
    const base = this.clients.get(server);
    if (!base) return undefined;
    if (!ownerId || ownerId === 'logox') return base;
    const key = `${server}:${ownerId}`;
    let scoped = this.clients.get(key);
    if (!scoped) {
      const config = this.servers[server];
      if (!config) return base;
      scoped = new McpClient(config, this.cwd);
      this.clients.set(key, scoped);
    }
    return scoped;
  }
  private async list(server: string, client: McpClient, signal: AbortSignal) {
    const tools: RemoteTool[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 16; page++) {
      const response = listSchema.parse(await client.request('tools/list', cursor ? {cursor} : {}, signal));
      tools.push(...response.tools);
      if (tools.length > 256 || new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('MCP tool catalog too large or has duplicate names');
      if (!response.nextCursor) {this.catalogs.set(server, tools); return tools;}
      if (cursors.has(response.nextCursor)) throw new Error('Duplicate MCP pagination cursor');
      cursor = response.nextCursor; cursors.add(cursor);
    }
    throw new Error('MCP pagination exceeds 16 pages');
  }
  async execute(call: ToolCall, context: ActorContext): Promise<ToolResult> {
    try {
      context.signal.throwIfAborted();
      if (call.name !== 'mcp') throw new Error('Unknown extension tool');
      const args = argsSchema.parse(JSON.parse(call.arguments));
      const client = this.clientFor(args.server, context.ownerId);
      if (!client) throw new Error('MCP server does not exist or is disabled');
      if (args.action === 'list') {
        context.startTool?.();
        if (!await this.approve({source: 'mcp', action: 'list', server: args.server, tool: 'list', callId: call.id,
          arguments: {}, inputSchema: {type: 'object'}}, context)) return {text: 'MCP catalog read was not permitted.', isError: true, disposition: 'denied'};
        context.signal.throwIfAborted();
        // Refresh on every explicit list so server changes are never hidden behind the cache.
        const latest = await this.list(args.server, client, context.signal);
        return {text: JSON.stringify(latest.map(tool => ({name: tool.name, description: tool.description?.slice(0, 500) ?? '',
          parameters: tool.inputSchema.properties ?? {}, required: tool.inputSchema.required ?? []}))).slice(0, 64_000), isError: false};
      }
      const tools = client.status() === 'connected' ? this.catalogs.get(args.server) ?? await this.list(args.server, client, context.signal)
        : await this.list(args.server, client, context.signal);
      const tool = tools.find(item => item.name === args.tool);
      if (!tool) throw new Error('MCP tool is not in the catalog; run list first');
      const dialect = tool.inputSchema.$schema;
      if (dialect !== undefined && dialect !== 'http://json-schema.org/draft-07/schema#' && dialect !== 'https://json-schema.org/draft/2020-12/schema') {
        throw new Error('This JSON Schema dialect is not supported yet');
      }
      if (!tool.validator) {
        // Register each schema's $id independently; a catalog refresh replaces the objects and their validators.
        const compiler = dialect === 'https://json-schema.org/draft/2020-12/schema'
          ? new Ajv2020({strict: false, allErrors: false, useDefaults: true})
          : new Ajv({strict: false, allErrors: false, useDefaults: true});
        formats.default(compiler);
        tool.validator = compiler.compile(tool.inputSchema);
      }
      const validator = tool.validator;
      if (!validator(args.arguments)) throw new Error('MCP arguments do not satisfy the full schema: ' + JSON.stringify(validator.errors));
      const allowed = await this.approve({source: 'mcp', action: 'call', server: args.server, tool: args.tool, callId: call.id,
        arguments: args.arguments, inputSchema: tool.inputSchema}, context);
      context.signal.throwIfAborted();
      if (!allowed) return {text: 'The user denied this MCP call.', isError: true, disposition: 'denied'};
      context.startTool?.();
      const result = resultSchema.parse(await client.request('tools/call', {name: args.tool, arguments: args.arguments}, context.signal));
      const images = result.content.filter(block => block.type === 'image').map(block => imageSchema.parse(block));
      const text = collapseRepeatedLines(result.content.map(block => block.type === 'text' ? block.text ?? ''
        : block.type === 'image' ? '[Image: ' + block.mimeType + ']' : '[' + block.type + ' content]').join('\n')) +
        (result.structuredContent ? '\n' + JSON.stringify(result.structuredContent) : '');
      return {text: text.length > 64_000 ? text.slice(0, 64_000) + '\n[MCP output truncated]' : text,
        isError: result.isError ?? false, ...(images.length ? {images} : {})};
    } catch (error) {
      return {text: error instanceof z.ZodError ? MCP_INVALID_TEXT + ': ' + zodCause(error) : error instanceof Error ? error.message : 'MCP execution failed', isError: true};
    }
  }
  async close(): Promise<void> {await Promise.all([...this.clients.values()].map(client => client.close())); this.catalogs.clear();}
}
