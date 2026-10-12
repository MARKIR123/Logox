import {z} from 'zod';
import type {ModelSettings} from '../config/config.js';
import type {Delta, ModelMessage, ModelRequest, ModelTurn, Provider, ToolCall} from '../runtime/messages.js';

export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) {super(message);}
}
type ObjectValue = Record<string, unknown>;
const usageSchema = z.object({
  input_tokens: z.number().optional(), output_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional(),
  prompt_tokens_details: z.object({cached_tokens: z.number().optional()}).optional(),
});
const deltaSchema = z.object({
  type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(),
  signature: z.string().optional(), partial_json: z.string().optional(), stop_reason: z.string().nullable().optional(),
});
const eventSchema = z.object({
  type: z.string().optional(), index: z.number().int().nonnegative().optional(),
  error: z.unknown().optional(), usage: usageSchema.nullable().optional(),
  message: z.object({usage: usageSchema.optional()}).optional(), delta: deltaSchema.optional(),
  content_block: z.object({
    type: z.string(), id: z.string().optional(), name: z.string().optional(),
    text: z.string().optional(), thinking: z.string().optional(), signature: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(), id: z.string().optional(),
        function: z.object({name: z.string().optional(), arguments: z.string().optional()}).optional(),
      })).optional(),
    }).optional(),
  })).optional(),
});
type StreamEvent = z.infer<typeof eventSchema>;
export function openaiMessages(messages: readonly ModelMessage[], requiresReasoningContent = false): ObjectValue[] {
  return messages.map(message => {
    if (message.role === 'tool') return {role: 'tool', tool_call_id: message.callId, content: message.text};
    if (message.role === 'user') return {role: 'user', content: message.text};
    return {role: 'assistant', content: message.text || null,
      ...(message.reasoning || requiresReasoningContent ? {reasoning_content: message.reasoning ?? ''} : {}),
      ...(message.toolCalls?.length ? {tool_calls: message.toolCalls.map(call => ({
        id: call.id, type: 'function', function: {name: call.name, arguments: call.arguments},
      }))} : {})};
  });
}
export function anthropicMessages(messages: readonly ModelMessage[]): ObjectValue[] {
  const result: {role: string; content: ObjectValue[]}[] = [];
  for (const message of messages) {
    const role = message.role === 'tool' ? 'user' : message.role;
    const content: ObjectValue[] = [];
    if (message.role === 'tool') content.push({type: 'tool_result', tool_use_id: message.callId, content: message.text, is_error: message.isError});
    else if (message.role === 'assistant') {
      if (message.reasoning && message.signature) content.push({type: 'thinking', thinking: message.reasoning, signature: message.signature});
      if (message.text) content.push({type: 'text', text: message.text});
      for (const call of message.toolCalls ?? []) {
        let input: unknown;
        try {input = JSON.parse(call.arguments);} catch {input = {};}
        content.push({type: 'tool_use', id: call.id, name: call.name, input});
      }
    } else content.push({type: 'text', text: message.text});
    if (!content.length) continue;
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({role, content});
  }
  return result;
}
async function* events(response: Response): AsyncGenerator<StreamEvent> {
  if (!response.body) throw new ProviderError('模型没有返回响应内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer = (buffer + decoder.decode(chunk.value, {stream: !chunk.done})).replace(/\r\n/g, '\n');
      if (buffer.length > 4 * 1024 * 1024) throw new ProviderError('模型事件超过大小限制');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try {yield eventSchema.parse(JSON.parse(data));} catch {throw new ProviderError('模型流事件格式无效');}
      }
      if (chunk.done) {
        if (buffer.trim()) throw new ProviderError('模型事件未完整结束');
        return;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('模型流连接中断', true);
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
export function createProvider(settings: ModelSettings, fetcher: typeof fetch = fetch): Provider {
  return {async respond(request, onDelta, signal) {
    if (!settings.model) throw new ProviderError('尚未配置模型；使用 /model 名称或 --model 名称');
    const native = settings.kind === 'anthropic';
    const url = settings.baseUrl.replace(/\/$/, '') + (native ? '/messages' : '/chat/completions');
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (native) {
      headers['anthropic-version'] = '2023-06-01';
      if (settings.key) headers['x-api-key'] = settings.key;
    } else if (settings.key) headers.authorization = 'Bearer ' + settings.key;
    const tools = request.tools.map(tool => native
      ? {name: tool.name, description: tool.description, input_schema: tool.parameters}
      : {type: 'function', function: tool});
    const maxTokens = Math.min(settings.maxTokens, request.maxTokens ?? Infinity);
    const body = native
      ? {model: settings.model, max_tokens: maxTokens, temperature: settings.temperature, stream: true,
        system: request.system, messages: anthropicMessages(request.messages), tools, ...(request.thinking === false ? {thinking: {type: 'disabled'}} : {})}
      : {model: settings.model, max_tokens: maxTokens, temperature: settings.temperature, stream: true,
        messages: [{role: 'system', content: request.system}, ...openaiMessages(request.messages, settings.thinkingControl)], tools,
        stream_options: {include_usage: true}, ...(request.thinking === false && settings.thinkingControl ? {thinking: {type: 'disabled'}} : {})};
    const timed = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);
    let response: Response;
    try {response = await fetcher(url, {method: 'POST', headers, body: JSON.stringify(body), signal: timed, redirect: 'error'});}
    catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw new ProviderError(timed.aborted ? '模型请求超时' : '模型连接失败', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError('模型请求失败（HTTP ' + response.status + '）', [408, 429, 500, 502, 503, 504].includes(response.status));
    }
    let text = '', reasoning = '', signature = '';
    let stop: ModelTurn['stop'] = 'other';
    let usage: ModelTurn['usage'];
    const calls = new Map<number, ToolCall>();
    const append = (kind: Delta['kind'], value: unknown) => {
      if (typeof value !== 'string' || !value) return;
      if (kind === 'text') text += value; else reasoning += value;
      onDelta({kind, text: value});
    };
    try {
      for await (const event of events(response)) {
        signal.throwIfAborted();
        if (calls.size > 128) throw new ProviderError('单次工具调用数量超过限制');
        if (native) {
          if (event.type === 'error') throw new ProviderError('模型流报告错误');
          if (event.type === 'message_start') {
            const value = event.message?.usage;
            usage = {input: (value?.input_tokens ?? 0) + (value?.cache_read_input_tokens ?? 0) + (value?.cache_creation_input_tokens ?? 0),
              output: 0, ...(value?.cache_read_input_tokens !== undefined ? {cacheRead: value.cache_read_input_tokens} : {}),
              ...(value?.cache_creation_input_tokens !== undefined ? {cacheWrite: value.cache_creation_input_tokens} : {})};
          }
          if (event.type === 'content_block_start') {
            const block = event.content_block;
            if (block?.type === 'tool_use' && event.index !== undefined) calls.set(event.index, {id: block.id ?? '', name: block.name ?? '', arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : ''});
            else if (block?.type === 'text') append('text', block.text);
            else if (block?.type === 'thinking') {append('reasoning', block.thinking); signature = block.signature ?? '';}
          }
          if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'text_delta') append('text', delta.text);
            if (delta?.type === 'thinking_delta') append('reasoning', delta.thinking);
            if (delta?.type === 'signature_delta') signature += delta.signature ?? '';
            if (delta?.type === 'input_json_delta') {
              const call = event.index === undefined ? undefined : calls.get(event.index);
              if (call) call.arguments += delta.partial_json ?? '';
            }
          }
          if (event.type === 'message_delta') {
            const reason = event.delta?.stop_reason;
            stop = reason === 'tool_use' ? 'tools' : reason === 'max_tokens' ? 'length'
              : ['end_turn', 'stop_sequence'].includes(reason ?? '') ? 'complete' : 'other';
            if (usage && typeof event.usage?.output_tokens === 'number') usage.output = event.usage.output_tokens;
          }
        } else {
          if (event.error) throw new ProviderError('模型流报告错误');
          const choice = event.choices?.[0];
          const delta = choice?.delta;
          append('text', delta?.content);
          append('reasoning', delta?.reasoning_content || delta?.reasoning);
          for (const item of delta?.tool_calls ?? []) {
            const call = calls.get(item.index) ?? {id: '', name: '', arguments: ''};
            if (item.id) call.id += item.id;
            if (item.function?.name) call.name += item.function.name;
            if (item.function?.arguments) call.arguments += item.function.arguments;
            calls.set(item.index, call);
          }
          if (choice?.finish_reason) stop = choice.finish_reason === 'tool_calls' ? 'tools'
            : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'stop' ? 'complete' : 'other';
          if (event.usage) usage = {input: event.usage.prompt_tokens ?? 0, output: event.usage.completion_tokens ?? 0, ...(event.usage.prompt_tokens_details?.cached_tokens !== undefined ? {cacheRead: event.usage.prompt_tokens_details.cached_tokens} : {})};
        }
      }
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (timed.aborted) throw new ProviderError('模型请求超时', true);
      throw error;
    }
    const toolCalls = [...calls.values()];
    return {message: {role: 'assistant', text, ...(reasoning ? {reasoning} : {}),
      ...(signature ? {signature} : {}), ...(toolCalls.length ? {toolCalls} : {})}, stop,
      ...(usage ? {usage} : {})};
  }};
}
