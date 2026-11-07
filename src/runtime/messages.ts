import {z} from 'zod';
import {runtimeContextMessageSchema} from './context-updates.js';

export const imageBlockSchema = z.strictObject({data: z.string(), mimeType: z.string()});
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export const toolCallSchema = z.object({id: z.string(), name: z.string(), arguments: z.string(), kind: z.literal('tool-search').optional()});
export type ToolCall = z.infer<typeof toolCallSchema>;
export const modelMessageSchema = z.discriminatedUnion('role', [
  runtimeContextMessageSchema,
  z.object({role: z.literal('user'), text: z.string(), images: z.array(imageBlockSchema).optional()}),
  z.object({role: z.literal('assistant'), text: z.string(), reasoning: z.string().optional(),
    contextExcluded: z.literal(true).optional(),
    toolsExcluded: z.literal(true).optional(),
    memoryOnly: z.literal(true).optional(),
    /** The `⏵` stage this turn declared (observability only; the text keeps no stage line). */
    stage: z.string().optional(),
    signature: z.string().optional(), toolCalls: z.array(toolCallSchema).optional()}),
  z.object({role: z.literal('tool'), text: z.string(), callId: z.string(), name: z.string(), isError: z.boolean(),
    discoveredTools: z.array(z.string()).readonly().optional(), images: z.array(imageBlockSchema).optional()}),
]);
export type ModelMessage = z.infer<typeof modelMessageSchema>;
export type ToolDiscoveryProtocol = 'none' | 'anthropic' | 'openai-responses';
export interface ToolDefinition {name: string; description: string; parameters: Record<string, unknown>; deferLoading?: true}
export interface ProviderCapabilities {
  toolDiscovery: ToolDiscoveryProtocol;
  runtimeInstructions: 'meta-user' | 'system' | 'developer';
  caching: 'none' | 'anthropic' | 'automatic';
  /** The API binds replayed thinking to the exact earlier messages, so nothing sent before may be removed. */
  appendOnlyHistory?: boolean;
}
export interface ModelRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  toolDiscovery?: Exclude<ToolDiscoveryProtocol, 'none'>;
  maxTokens?: number;
  thinking?: false;
  supportsVision?: boolean;
  stream?: boolean;
}
export interface ModelTurn {
  message: Extract<ModelMessage, {role: 'assistant'}>;
  stop: 'complete' | 'tools' | 'length' | 'other';
  usage?: {input: number; output: number; cacheRead?: number; cacheWrite?: number};
}
export type Delta = {kind: 'text' | 'reasoning'; text: string};
export interface Provider {
  readonly capabilities?: ProviderCapabilities;
  resolveCapabilities?(signal: AbortSignal): Promise<ProviderCapabilities>;
  respond(request: ModelRequest, onDelta: (delta: Delta) => void, signal: AbortSignal): Promise<ModelTurn>;
}
/** Repairs the request view only; the raw ledger and already-executed tools are unchanged. */
export function normalizeMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const output: ModelMessage[] = [], pending = new Map<string, ToolCall>(), excludedCalls = new Set<string>();
  const unpaired: ModelMessage[] = [];
  const closeBatch = () => {
    for (const call of pending.values()) output.push({role: 'tool', callId: call.id, name: call.name,
      text: 'The previous run was interrupted and this tool has no complete result. Re-check the current state before deciding the next step.', isError: true});
    pending.clear();
    output.push(...unpaired); unpaired.length = 0;
  };
  for (const message of messages) {
    if (message.role === 'assistant' && message.contextExcluded) continue;
    if (message.role === 'assistant' && message.toolsExcluded) {
      closeBatch();
      for (const call of message.toolCalls ?? []) excludedCalls.add(call.id);
      if (message.text.trim()) output.push({role: 'assistant', text: message.text,
        ...(message.reasoning ? {reasoning: message.reasoning} : {}), ...(message.signature ? {signature: message.signature} : {})});
      continue;
    }
    if (message.role === 'tool') {
      if (excludedCalls.has(message.callId)) continue;
      if (pending.delete(message.callId)) output.push(message);
      else unpaired.push({role: 'user', text: '[Unpaired tool record, for reference only; does not mean it was re-executed]\n' + message.name + '\n' + message.text});
      continue;
    }
    closeBatch();
    // Records left by an interrupted thinking phase stay readable in the UI but must not be replayed as empty assistant messages.
    if (message.role === 'assistant' && !message.text && !message.toolCalls?.length) continue;
    output.push(message);
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) {excludedCalls.delete(call.id); pending.set(call.id, call);}
  }
  closeBatch();
  return output;
}
/** Fill in results for an interrupted batch; recovery records only the failure and never replays file or command side effects. */
export function repairToolResults(messages: readonly ModelMessage[]): Extract<ModelMessage, {role: 'tool'}>[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pending.set(call.id, call);
    if (message.role === 'tool') pending.delete(message.callId);
  }
  return [...pending.values()].map(call => ({role: 'tool', callId: call.id, name: call.name,
    text: 'The previous run was interrupted and this tool has no complete result. Re-check the current state before deciding the next step.', isError: true}));
}
