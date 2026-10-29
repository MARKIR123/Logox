import {z} from 'zod';
import type {ToolCall, ToolDefinition, ProviderCapabilities} from '../../runtime/messages.js';
import {runtimeContextText, type RuntimeContextMessage} from '../../runtime/context-updates.js';
import {LOAD_TOOLS_DESCRIPTION} from '../../tools/protocol/LoadToolsTool/prompt.js';

// https://developers.openai.com/api/docs/guides/tools-tool-search (client execution)
export function encodeOpenAIToolSearch(parameters: Record<string, unknown>): Record<string, unknown> {
  return {type: 'tool_search', execution: 'client', description: LOAD_TOOLS_DESCRIPTION, parameters};
}
const searchCallSchema = z.object({type: z.literal('tool_search_call'), execution: z.literal('client'),
  call_id: z.string().min(1), arguments: z.unknown()});
export function decodeOpenAIToolSearchCall(item: Record<string, unknown>): ToolCall | undefined {
  if (item.type !== 'tool_search_call') return undefined;
  const parsed = searchCallSchema.safeParse(item);
  if (!parsed.success || !Object.hasOwn(item, 'arguments')) throw new Error('Invalid client tool_search_call: execution, call_id and arguments are required.');
  return {id: parsed.data.call_id, name: 'LoadTools', kind: 'tool-search',
    arguments: typeof parsed.data.arguments === 'string' ? parsed.data.arguments : JSON.stringify(parsed.data.arguments) ?? ''};
}
export function encodeOpenAIFunction(tool: ToolDefinition): Record<string, unknown> {
  return {type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
    ...(tool.deferLoading ? {defer_loading: true} : {})};
}
export function encodeOpenAIToolSearchResult(callId: string, names: readonly string[], definitions: readonly ToolDefinition[]): Record<string, unknown> {
  if (!callId) throw new Error('Client tool search output requires its original call_id.');
  const selected = new Set(names);
  return {type: 'tool_search_output', execution: 'client', call_id: callId, status: 'completed',
    tools: definitions.filter(tool => selected.has(tool.name)).map(({deferLoading: _, ...tool}) => encodeOpenAIFunction(tool))};
}
export function encodeRuntimeContext(message: RuntimeContextMessage, capabilities: ProviderCapabilities): readonly Record<string, unknown>[] {
  if (message.kind === 'environment-baseline' || message.kind === 'capability-change' && message.data?.baseline === true) return [];
  return [{role: capabilities.runtimeInstructions === 'meta-user' ? 'user' : capabilities.runtimeInstructions, content: runtimeContextText(message)}];
}
