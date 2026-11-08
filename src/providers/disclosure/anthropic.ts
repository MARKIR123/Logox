import type {ToolDefinition} from '../../runtime/messages.js';
import {cacheControl, type CacheRetention} from '../cache.js';
import {runtimeContextText, type RuntimeContextMessage} from '../../runtime/context-updates.js';

export function encodeAnthropicTools(tools: readonly ToolDefinition[], caching: boolean, retention: CacheRetention = 'short'): readonly Record<string, unknown>[] {
  const lastEager = tools.findLastIndex(tool => !tool.deferLoading);
  return tools.map((tool, index) => ({name: tool.name, description: tool.description, input_schema: tool.parameters,
    ...(tool.deferLoading ? {defer_loading: true} : {}),
    ...(caching && index === lastEager ? {cache_control: cacheControl(retention)} : {})}));
}
export function encodeAnthropicContext(message: RuntimeContextMessage): readonly Record<string, unknown>[] {
  if (message.kind === 'environment-baseline' || message.kind === 'capability-change' && message.data?.baseline === true) return [];
  return [{type: 'text', text: runtimeContextText(message)}];
}
