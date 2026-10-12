import {z} from 'zod';

export const toolCallSchema = z.object({id: z.string(), name: z.string(), arguments: z.string()});
export type ToolCall = z.infer<typeof toolCallSchema>;
export const modelMessageSchema = z.discriminatedUnion('role', [
  z.object({role: z.literal('user'), text: z.string()}),
  z.object({role: z.literal('assistant'), text: z.string(), reasoning: z.string().optional(),
    signature: z.string().optional(), toolCalls: z.array(toolCallSchema).optional()}),
  z.object({role: z.literal('tool'), text: z.string(), callId: z.string(), name: z.string(), isError: z.boolean()}),
]);
export type ModelMessage = z.infer<typeof modelMessageSchema>;
export interface ToolDefinition {name: string; description: string; parameters: Record<string, unknown>}
export interface ModelRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  maxTokens?: number;
  thinking?: false;
}
export interface ModelTurn {
  message: Extract<ModelMessage, {role: 'assistant'}>;
  stop: 'complete' | 'tools' | 'length' | 'other';
  usage?: {input: number; output: number; cacheRead?: number; cacheWrite?: number};
}
export type Delta = {kind: 'text' | 'reasoning'; text: string};
export interface Provider {
  respond(request: ModelRequest, onDelta: (delta: Delta) => void, signal: AbortSignal): Promise<ModelTurn>;
}
/** 为中断的批次补齐结果；恢复时只记录失败，不重放文件或命令副作用。 */
export function repairToolResults(messages: readonly ModelMessage[]): Extract<ModelMessage, {role: 'tool'}>[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pending.set(call.id, call);
    if (message.role === 'tool') pending.delete(message.callId);
  }
  return [...pending.values()].map(call => ({role: 'tool', callId: call.id, name: call.name,
    text: '上次执行已中断，此工具没有完整结果。请重新核对状态后决定下一步。', isError: true}));
}
