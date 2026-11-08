import {z} from 'zod';
import {runtimeContextMessageSchema} from './context-updates.js';

/** `path` is the file the image lives in on disk (decided when the image enters history); it is never sent to a provider. */
export const imageBlockSchema = z.strictObject({data: z.string(), mimeType: z.string(), path: z.string().optional()});
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
/**
 * Provider-reported usage of one model turn, stored on the ledger entry of that turn's assistant message (never on the message
 * itself, so request digests stay unchanged). `input` includes cache tokens, as providers report it. `cost` is in `currency`
 * and present only when a price was known when the turn was recorded.
 */
export const turnUsageSchema = z.strictObject({
  input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative(),
  cacheWrite1h: z.number().finite().nonnegative().optional(),
  provider: z.string(), model: z.string(),
  cost: z.number().finite().nonnegative().optional(), currency: z.string().optional(),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;
export type ToolDiscoveryProtocol = 'none' | 'anthropic' | 'openai-responses';
export interface ToolDefinition {name: string; description: string; parameters: Record<string, unknown>; deferLoading?: true}
export interface ProviderCapabilities {
  toolDiscovery: ToolDiscoveryProtocol;
  runtimeInstructions: 'meta-user' | 'system' | 'developer';
  caching: 'none' | 'anthropic' | 'automatic' | 'openai-key';
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
  /** Stable per session and actor; sent as `prompt_cache_key` where the provider's `caching` capability is `openai-key`. */
  cacheKey?: string;
  /** Anthropic-style cache lifetime: the actor's own `cache_retention` (`actor`) beats the model's setting, which beats the role default (`role`). */
  cacheRetention?: {actor?: 'short' | 'long'; role: 'short' | 'long'};
  /** Cache keep-alive replay: never stored in history; only labels the request dump. */
  purpose?: 'keepalive';
  /** Directory that receives the serialized request body when `LOGOX_DUMP_REQUESTS=1`. */
  dumpDir?: string;
}
export interface ModelTurn {
  message: Extract<ModelMessage, {role: 'assistant'}>;
  stop: 'complete' | 'tools' | 'length' | 'other';
  /** `cacheWrite1h` is the part of `cacheWrite` stored with the 1-hour lifetime, when the provider reports it. */
  usage?: {input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number | undefined};
}
export type Delta = {kind: 'text' | 'reasoning'; text: string};
export interface Provider {
  readonly capabilities?: ProviderCapabilities;
  resolveCapabilities?(signal: AbortSignal): Promise<ProviderCapabilities>;
  respond(request: ModelRequest, onDelta: (delta: Delta) => void, signal: AbortSignal): Promise<ModelTurn>;
  /** What a cache keep-alive needs to know about this exact request; undefined when its cache needs none or cannot be replayed cheaply. */
  cacheProfile?(request: ModelRequest, signal: AbortSignal): Promise<CacheProfile | undefined>;
}
export interface CacheProfile {
  /** Lifetime of the entry the request wrote or read. */
  ttlMs: number;
  /** Same body with `maxTokens: 1` keeps the cached prefix and its thinking configuration. */
  replayable: boolean;
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
