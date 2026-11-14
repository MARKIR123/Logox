import {PROMPT_CACHE_BOUNDARY} from '../prompts/boundary.js';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {ModelSettings} from '../config/config.js';
import type {Delta, ModelMessage, ModelRequest, ModelTurn, Provider, ProviderCapabilities, ToolCall, ToolDefinition} from '../runtime/messages.js';
import {runtimeContextText} from '../runtime/context-updates.js';
import {resolveProviderCapabilities} from './capabilities.js';
import {encodeAnthropicTools, encodeAnthropicContext} from './disclosure/anthropic.js';
import {anthropicRetention, cacheControl, cacheLifetimeMs, openAiRetentionFields, SHORT_CACHE_MS, type CacheRetention} from './cache.js';
import {dumpRequestBody} from './dump.js';
import {beginFingerprint, fingerprintBlocks, shortHash} from './fingerprint.js';
import {decodeOpenAIToolSearchCall, encodeOpenAIToolSearch, encodeOpenAIFunction, encodeOpenAIToolSearchResult, encodeRuntimeContext} from './disclosure/openai.js';
import {FALLBACK_CAPABILITIES} from './capabilities.js';

function decodeSearchCall(item: Record<string, unknown>): ToolCall | undefined {
  try {return decodeOpenAIToolSearchCall(item);}
  catch (error) {throw new ProviderError(error instanceof Error ? error.message : 'Invalid client tool-search call.');}
}

type WireMessage = Exclude<ModelMessage, {role: 'context'}>;
function portableMessages(messages: readonly ModelMessage[]): WireMessage[] {
  return messages.flatMap<WireMessage>(message => message.role !== 'context' ? [message] :
    message.kind === 'environment-baseline' || message.kind === 'capability-change' && message.data?.baseline === true ? [] : [{role: 'user', text: runtimeContextText(message)}]);
}

export type ProviderErrorCategory = 'model_missing' | 'authentication' | 'quota' | 'temporary' | 'capacity' | 'protocol';
type ProtocolIssue = 'empty_assistant' | 'tool_pairing' | 'reasoning' | 'invalid_field' | 'too_many_images';
export interface ProviderDiagnostic {
  status?: number; code?: string; phase?: 'connection' | 'stream'; parameter?: string; issue?: ProtocolIssue;
  retryAfterMs?: number; elapsedMs?: number; progressIdleMs?: number; transportIdleMs?: number; receivedBytes?: number;
  /** Public request id from the response headers, and a sanitized, truncated excerpt of the error body (see `publicSnippet`). */
  requestId?: string; snippet?: string;
}
/** Where and how often a failure happened; stamped by the agent loop when the error is finally rethrown. */
export interface ProviderFailureContext {provider?: string; model?: string; attempts?: number}
export class ProviderError extends Error {
  context?: ProviderFailureContext;
  constructor(message: string, readonly retryable = false,
    readonly category: ProviderErrorCategory = retryable ? 'temporary' : 'protocol',
    readonly diagnostic?: ProviderDiagnostic) {super(message);}
}
const rateLimitCodes = ['rate_limit_error', 'overloaded_error'];
/** True for HTTP 429/529 and `rate_limit_error` / `overloaded_error` payloads, including errors raised mid-stream (status 200). */
export function isRateLimitFailure(error: unknown): error is ProviderError {
  const diagnostic = error instanceof ProviderError ? error.diagnostic : undefined;
  return !!diagnostic && (diagnostic.status === 429 || diagnostic.status === 529 || rateLimitCodes.includes(diagnostic.code ?? ''));
}
/** Parses a `Retry-After` header (delta-seconds or HTTP-date) to milliseconds; undefined when absent or malformed. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
export function providerTimeout(): ProviderError {
  return new ProviderError('Model request timed out', true, 'temporary', {status: 408, code: 'idle_timeout'});
}
export function isProviderTimeout(error: unknown): boolean {
  return error instanceof ProviderError && error.category === 'temporary' &&
    (error.diagnostic?.code === 'idle_timeout' || error.message === 'Model request timed out');
}
/** Any temporary provider failure (timeouts, dropped connections, HTTP 408/429/5xx/529); authentication, quota and missing-model errors are never outages. */
export function isProviderOutage(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.category === 'temporary';
}
const SNIPPET_LIMIT = 500;
/** One-line excerpt of a provider error body that is safe to persist: markup, keys, tokens, key-like query values and long opaque strings are removed. */
export function publicSnippet(text: string | undefined): string | undefined {
  const clean = (text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/g, '[redacted]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[a-z])[-_][\w-]{8,}/gi, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',&]{4,}/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|api_key|access_token|sig|signature)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
  return clean ? clean.slice(0, SNIPPET_LIMIT) : undefined;
}
/**
 * Multi-line failure text: the short title first, then `Provider · Model · HTTP <status> · <n> attempts`, then the sanitized body excerpt.
 * Non-provider errors keep their message as the single line.
 */
export function formatFailureDetail(error: unknown, fallback: ProviderFailureContext = {}): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ProviderError)) return message;
  const context = {...fallback, ...error.context}, diagnostic = error.diagnostic;
  const facts = [context.provider, context.model, diagnostic?.status !== undefined ? 'HTTP ' + diagnostic.status : undefined,
    diagnostic?.code && diagnostic.code !== 'idle_timeout' ? diagnostic.code : undefined,
    diagnostic?.requestId ? 'request ' + diagnostic.requestId : undefined,
    context.attempts ? context.attempts + (context.attempts === 1 ? ' attempt' : ' attempts') : undefined].filter(Boolean);
  return [message, facts.join(' · '), diagnostic?.snippet].filter(Boolean).join('\n');
}
export function isProviderInterruption(error: unknown): boolean {
  return isProviderTimeout(error) || error instanceof ProviderError && error.category === 'temporary' &&
    (error.diagnostic?.phase === 'connection' || error.diagnostic?.phase === 'stream');
}
const transportReasons: Record<string, string> = {
  UND_ERR_SOCKET: 'Connection closed', ECONNRESET: 'Connection reset', EPIPE: 'Connection broken',
  ENOTFOUND: 'Host not found', EAI_AGAIN: 'Host lookup failed temporarily', ECONNREFUSED: 'Connection refused',
  ETIMEDOUT: 'Connection timed out', UND_ERR_CONNECT_TIMEOUT: 'Connect timed out',
  UND_ERR_HEADERS_TIMEOUT: 'Response headers timed out', UND_ERR_BODY_TIMEOUT: 'Response body timed out',
};
/** fetch wraps the transport reason in cause; keep only the public code so error echoes never carry request data. */
function transportFailure(error: unknown, phase: 'connection' | 'stream', status?: number): ProviderError {
  let code: string | undefined;
  for (let depth = 0; depth < 6; depth++) {
    const parsed = z.object({code: z.unknown().optional(), cause: z.unknown().optional()}).safeParse(error);
    if (!parsed.success) break;
    if (typeof parsed.data.code === 'string' && Object.hasOwn(transportReasons, parsed.data.code)) {
      code = parsed.data.code; break;
    }
    error = parsed.data.cause;
  }
  const title = phase === 'stream' ? '[Network] Stream interrupted' : '[Network] Connection failed';
  return new ProviderError(title + ': ' + (code ? transportReasons[code] + ' (' + code + ')' : 'no recognizable error code'),
    true, 'temporary', {phase, ...(status !== undefined ? {status} : {}), ...(code ? {code} : {})});
}
function idleDeadline(signal: AbortSignal, milliseconds: number) {
  const controller = new AbortController();
  const startedAt = performance.now();
  let lastProgressAt = startedAt, lastDataAt: number | undefined, receivedBytes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const progress = () => {
    lastProgressAt = performance.now();
    clearTimeout(timer);
    if (!controller.signal.aborted && !signal.aborted) timer = setTimeout(() => controller.abort(), milliseconds).unref();
  };
  progress();
  return {signal: AbortSignal.any([signal, controller.signal]), progress,
    received(length: number) {lastDataAt = performance.now(); receivedBytes += length;},
    observation() {
      const now = performance.now();
      return {elapsedMs: Math.floor(now - startedAt), progressIdleMs: Math.floor(now - lastProgressAt), receivedBytes,
        ...(lastDataAt !== undefined ? {transportIdleMs: Math.floor(now - lastDataAt)} : {})};
    }, close: () => clearTimeout(timer)};
}
/** Known public errors keep API wording; unknown echoes use structured diagnostics and never carry the whole response body. */
export function providerFailure(status: number, payload?: unknown, retryAfterMs?: number, response?: {requestId?: string; body?: string}): ProviderError {
  const parsed = z.object({error: z.object({code: z.string().optional(), type: z.string().optional(),
    message: z.string().optional(), param: z.string().nullable().optional()}).optional()}).safeParse(payload);
  const code = parsed.success ? parsed.data.error?.code ?? parsed.data.error?.type : undefined;
  const snippet = publicSnippet(parsed.success && parsed.data.error?.message ? parsed.data.error.message : response?.body);
  const evidence = {...(response?.requestId ? {requestId: response.requestId} : {}), ...(snippet ? {snippet} : {})};
  if (status === 401 || status === 403) return new ProviderError('Model authentication or permission unavailable', false, 'authentication');
  if (status === 402 || ['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'credit_balance_exhausted'].includes(code ?? '')) {
    const message = parsed.success ? parsed.data.error?.message?.trim() ?? '' : '';
    // Keep only fully matched public balance hints so error bodies never carry request data or credentials.
    const reason = /^(?:Insufficient Balance|Insufficient credits|Insufficient quota|余额不足|额度不足)[.!。]?$/i.test(message)
      ? message + ' (insufficient balance)' : 'Insufficient balance or quota';
    return new ProviderError('Model request failed (HTTP ' + status + '): ' + reason + '. Top up to continue, or use /model to switch models.',
      false, 'quota', {status});
  }
  if (['authentication_error', 'permission_error'].includes(code ?? '')) return new ProviderError('Model authentication or permission unavailable', false, 'authentication');
  if (['model_not_found', 'model_not_exist', 'model_not_available'].includes(code ?? '')) return new ProviderError('Selected model does not exist or is unavailable', false, 'model_missing');
  const rateLimited = status === 429 || status === 529 || rateLimitCodes.includes(code ?? '');
  if (rateLimited) {
    return new ProviderError('Model service temporarily unavailable', true, 'temporary', {status,
      ...(code && rateLimitCodes.includes(code) ? {code} : {}), ...(retryAfterMs !== undefined ? {retryAfterMs} : {}), ...evidence});
  }
  if ([408, 500, 502, 503, 504].includes(status)) return new ProviderError('Model service temporarily unavailable', true, 'temporary', {status, ...evidence});
  const error = parsed.success ? parsed.data.error : undefined, text = error?.message ?? '';
  const issue: ProtocolIssue | undefined = /reasoning_content/i.test(text) ? 'reasoning'
    : /too many (?:images|media)|(?:images?|media).{0,60}(?:exceed|too many|maximum|at most|limit)|(?:exceed|maximum|more than|at most).{0,60}images?/i.test(text) ? 'too_many_images'
    : /tool_call_id|tool_use_id|tool_calls.*(?:follow|response|match)|tool.*(?:preceding|correspond)/i.test(text) ? 'tool_pairing'
    : /assistant.*(?:content|empty)|content.*tool_calls/i.test(text) ? 'empty_assistant'
    : ['invalid_request_error', 'invalid_parameter', 'invalid_json', 'invalid_message'].includes(code ?? '') ? 'invalid_field' : undefined;
  const descriptions: Record<ProtocolIssue, string> = {
    reasoning: 'Thinking field does not meet API requirements', tool_pairing: 'Tool calls and results are not paired correctly',
    empty_assistant: 'Assistant message is empty or malformed', invalid_field: 'Request field or message format is invalid',
    too_many_images: 'Request carries more images than the model accepts',
  };
  const parameter = error?.param && /^(?:messages|tools)(?:\[\d{1,6}\]|\.\d{1,6})?(?:\.(?:content|role|reasoning_content|tool_calls|tool_call_id|function|arguments|parameters|name))*$/.test(error.param) ? error.param : undefined;
  const safeCode = ['invalid_request_error', 'invalid_parameter', 'invalid_json', 'invalid_message'].includes(code ?? '') ? code : undefined;
  return new ProviderError('Model request failed (HTTP ' + status + ')' + (issue ? ': ' + descriptions[issue] : '') +
    (parameter ? '; field: ' + parameter : ''), false, 'protocol',
    {status, ...(safeCode ? {code: safeCode} : {}), ...(parameter ? {parameter} : {}), ...(issue ? {issue} : {}), ...(response?.requestId ? {requestId: response.requestId} : {})});
}
/** Parsed JSON error body (when it is JSON) plus the raw text, capped; the text feeds `publicSnippet` for non-JSON gateways. */
async function errorBody(response: Response): Promise<{payload?: unknown; text?: string}> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = []; let size = 0, oversized = false;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > 16384) {oversized = true; break;}
    }
  } catch {/* keep what arrived */}
  finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  const text = Buffer.concat(chunks).toString('utf8');
  if (oversized) return {text: text.slice(0, 2048)};
  try {return {payload: JSON.parse(text) as unknown, text: text.slice(0, 2048)};}
  catch {return text ? {text: text.slice(0, 2048)} : {};}
}
function responseRequestId(response: Response): string | undefined {
  for (const name of ['x-request-id', 'request-id', 'anthropic-request-id', 'x-amzn-requestid', 'cf-ray']) {
    const value = response.headers.get(name)?.trim();
    if (value && /^[\w.:-]{1,80}$/.test(value)) return value;
  }
  return undefined;
}
type ObjectValue = Record<string, unknown>;
const usageSchema = z.object({
  input_tokens: z.number().optional(), output_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(),
  prompt_cache_hit_tokens: z.number().optional(), cached_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional(),
  cache_creation: z.object({ephemeral_1h_input_tokens: z.number().optional()}).passthrough().optional(),
  input_tokens_details: z.object({cached_tokens: z.number().optional()}).optional(),
  prompt_tokens_details: z.object({cached_tokens: z.number().optional()}).optional(),
});
const deltaSchema = z.object({
  type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(),
  signature: z.string().optional(), partial_json: z.string().optional(), stop_reason: z.string().nullable().optional(),
});
const eventSchema = z.object({
  type: z.string().optional(), index: z.number().int().nonnegative().optional(),
  error: z.unknown().optional(), usage: usageSchema.nullable().optional(),
  message: z.object({usage: usageSchema.optional()}).optional(), delta: z.union([deltaSchema, z.string()]).optional(),
  output_index: z.number().int().nonnegative().optional(),
  arguments: z.string().optional(),
  item: z.object({
    type: z.string().optional(), id: z.string().optional(), call_id: z.unknown().optional(),
    name: z.string().optional(), arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  }).passthrough().optional(),
  response: z.object({
    id: z.string().optional(), status: z.string().optional(),
    usage: usageSchema.nullable().optional(),
  }).passthrough().optional(),
  content_block: z.object({
    type: z.string(), id: z.string().optional(), name: z.string().optional(),
    text: z.string().optional(), thinking: z.string().optional(), signature: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    delta: z.object({
      content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(), thinking: z.string().nullable().optional(),
      reasoning_details: z.array(z.object({text: z.string().nullish(), summary: z.string().nullish()}).passthrough()).nullish(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(), id: z.string().optional(),
        function: z.object({name: z.string().optional(), arguments: z.string().optional()}).optional(),
      })).optional(),
    }).optional(),
  })).optional(),
}).passthrough();
type StreamEvent = z.infer<typeof eventSchema>;
/** Heartbeats and empty frames are not model progress; text, thinking, tool arguments and protocol terminators all refresh the deadline. */
function hasProgress(event: StreamEvent): boolean {
  if (['message_start', 'content_block_start', 'content_block_stop', 'message_stop'].includes(event.type ?? '')) return true;
  if (event.type?.startsWith('response.')) return true;
  if (typeof event.delta === 'string' && event.delta) return true;
  if (typeof event.delta === 'object' && event.delta && (event.delta.text || event.delta.thinking || event.delta.signature || event.delta.partial_json || event.delta.stop_reason)) return true;
  if (event.usage && Object.values(event.usage).some(value => typeof value === 'number')) return true;
  return event.choices?.some(choice => !!choice.finish_reason || !!choice.delta &&
    (!!choice.delta.content || !!choice.delta.reasoning_content || !!choice.delta.reasoning || !!choice.delta.thinking || !!choice.delta.reasoning_details?.length ||
      !!choice.delta.tool_calls?.some(call => !!call.id || !!call.function?.name || !!call.function?.arguments))) ?? false;
}
export function responsesInput(input: readonly ModelMessage[], supportsVision = false,
  discovery?: {tools: readonly ToolDefinition[]; capabilities: ProviderCapabilities}): ObjectValue[] {
  const messages = input;
  const result: ObjectValue[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === 'context') {
      result.push(...encodeRuntimeContext(message, discovery?.capabilities ?? FALLBACK_CAPABILITIES));
    } else if (message.role === 'user') {
      if (supportsVision && message.images?.length) {
        result.push({
          role: 'user',
          content: [
            {type: 'input_text', text: message.text},
            ...message.images.map(img => ({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            })),
          ],
        });
      } else {
        result.push({role: 'user', content: message.text});
      }
    } else if (message.role === 'assistant') {
      if (message.text) {
        result.push({role: 'assistant', content: message.text});
      }
      for (const call of message.toolCalls ?? []) {
        if (discovery && call.name === 'LoadTools') {
          let arguments_: unknown;
          try {arguments_ = JSON.parse(call.arguments);} catch {arguments_ = call.arguments;}
          result.push({type: 'tool_search_call', execution: 'client', call_id: call.id, status: 'completed', arguments: arguments_});
        } else result.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    } else if (message.role === 'tool') {
      if (discovery && message.name === 'LoadTools') {
        result.push(encodeOpenAIToolSearchResult(message.callId, message.isError ? [] : message.discoveredTools ?? [], discovery.tools));
      } else result.push({
        type: 'function_call_output',
        call_id: message.callId,
        output: message.text,
      });
    }
  }
  return result;
}
/** Readable text of a Responses `reasoning` item: summary parts first, then raw reasoning content parts. */
function reasoningItemText(item: Record<string, unknown>): string {
  const parts = (value: unknown) => (Array.isArray(value) ? value : []).map(part =>
    typeof part === 'string' ? part : part && typeof part === 'object' && typeof (part as {text?: unknown}).text === 'string' ? (part as {text: string}).text : '').filter(Boolean);
  const summary = parts(item.summary);
  return (summary.length ? summary : parts(item.content)).join('\n\n');
}

/** Gateways (OpenRouter style) return reasoning as `reasoning_details: [{text|summary}]`. */
function chatReasoningDetails(details: unknown): string {
  if (!Array.isArray(details)) return '';
  return details.map(part => part && typeof part === 'object' ? (part as {text?: unknown; summary?: unknown}).text ?? (part as {summary?: unknown}).summary : '')
    .filter((value): value is string => typeof value === 'string' && !!value).join('');
}

/**
 * `replayReasoning = false` drops stored thinking from assistant turns: OpenAI-style streams carry no signature, so gateways that
 * mislabel answer text as `reasoning_content` would otherwise be shown their own mistake as history. `requiresReasoningContent` still forces the field.
 */
export function openaiMessages(input: readonly ModelMessage[], requiresReasoningContent = false, supportsVision = false, replayReasoning = true): ObjectValue[] {
  const messages = portableMessages(input);

  return messages.map(message => {
    if (message.role === 'tool') {
      if (supportsVision && message.images?.length) {
        return {
          role: 'tool',
          tool_call_id: message.callId,
          content: [
            {type: 'text', text: message.text},
            ...message.images.map(img => ({type: 'image_url', image_url: {url: `data:${img.mimeType};base64,${img.data}`}})),
          ],
        };
      }
      return {role: 'tool', tool_call_id: message.callId, content: message.text};
    }
    if (message.role === 'user') {
      if (supportsVision && message.images?.length) {
        return {
          role: 'user',
          content: [
            {type: 'text', text: message.text},
            ...message.images.map(img => ({type: 'image_url', image_url: {url: `data:${img.mimeType};base64,${img.data}`}})),
          ],
        };
      }
      return {role: 'user', content: message.text};
    }
    return {role: 'assistant', content: message.text || null,
      ...(requiresReasoningContent || replayReasoning && message.reasoning ? {reasoning_content: replayReasoning ? message.reasoning ?? '' : ''} : {}),
      ...(message.toolCalls?.length ? {tool_calls: message.toolCalls.map(call => ({
        id: call.id, type: 'function', function: {name: call.name, arguments: call.arguments},
      }))} : {})};
  });
}
/** The system prompt as one text, for protocols with no cache markers. */
export function systemText(system: string): string {
  return system.replace('\n\n' + PROMPT_CACHE_BOUNDARY + '\n\n', '\n\n').replace(PROMPT_CACHE_BOUNDARY, '');
}
/** One cache marker on each part: a change below the boundary keeps the fixed part cached. With tools and the message marker this uses all four allowed. */
export function anthropicSystem(system: string, retention: CacheRetention = 'short'): readonly ObjectValue[] {
  return system.split('\n\n' + PROMPT_CACHE_BOUNDARY + '\n\n').filter(text => text.trim())
    .map(text => ({type: 'text', text, cache_control: cacheControl(retention)}));
}
export function anthropicMessages(input: readonly ModelMessage[], referenceNames?: ReadonlySet<string>, caching = false, retention: CacheRetention = 'short'): ObjectValue[] {
  const messages = input.flatMap<WireMessage>(message => message.role !== 'context' ? [message] : encodeAnthropicContext(message)
    .map(block => ({role: 'user', text: String(block.text)})));

  const result: {role: string; content: ObjectValue[]}[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const role = message.role === 'tool' ? 'user' : message.role;
    const content: ObjectValue[] = [];
    if (message.role === 'tool') {
      const references = !message.isError ? message.discoveredTools?.filter(name => !referenceNames || referenceNames.has(name)) : [];
      if (message.name === 'LoadTools' && references?.length) {
        content.push({type: 'tool_result', tool_use_id: message.callId, content: [
          {type: 'text', text: message.text}, ...references.map(name => ({type: 'tool_reference', tool_name: name})),
        ], is_error: false});
      } else if (message.images?.length) {
        const blocks: ObjectValue[] = [{type: 'text', text: message.text}];
        for (const img of message.images) {
          blocks.push({type: 'image', source: {type: 'base64', media_type: img.mimeType, data: img.data}});
        }
        content.push({type: 'tool_result', tool_use_id: message.callId, content: blocks, is_error: message.isError});
      } else {
        content.push({type: 'tool_result', tool_use_id: message.callId, content: message.text, is_error: message.isError});
      }
    } else if (message.role === 'assistant') {
      if (message.reasoning && message.signature) content.push({type: 'thinking', thinking: message.reasoning, signature: message.signature});
      if (message.text) content.push({type: 'text', text: message.text});
      for (const call of message.toolCalls ?? []) {
        let input: unknown;
        try {input = JSON.parse(call.arguments);} catch {input = {};}
        content.push({type: 'tool_use', id: call.id, name: call.name, input});
      }
    } else {
      if (message.images?.length) {
        content.push({type: 'text', text: message.text});
        for (const img of message.images) {
          content.push({type: 'image', source: {type: 'base64', media_type: img.mimeType, data: img.data}});
        }
      } else {
        content.push({type: 'text', text: message.text});
      }
    }
    if (!content.length) continue;
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({role, content});
  }
  if (caching) {
    const boundary = result.at(-1)?.content.findLast(block => block.type !== 'thinking');
    if (boundary) boundary.cache_control = cacheControl(retention);
  }
  return result;
}
/** Part of the cache writes stored with the 1-hour lifetime: `usage.cache_creation.ephemeral_1h_input_tokens`. */
function oneHourWrites(usage: unknown): {cacheWrite1h?: number} {
  const creation = usage && typeof usage === 'object' ? (usage as {cache_creation?: unknown}).cache_creation : undefined;
  const value = creation && typeof creation === 'object' ? (creation as {ephemeral_1h_input_tokens?: unknown}).ephemeral_1h_input_tokens : undefined;
  return typeof value === 'number' && value > 0 ? {cacheWrite1h: value} : {};
}
async function* events(response: Response, received: (length: number) => void): AsyncGenerator<StreamEvent> {
  if (!response.body) throw new ProviderError('Model returned no response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value?.length) received(chunk.value.length);
      buffer = (buffer + decoder.decode(chunk.value, {stream: !chunk.done})).replace(/\r\n/g, '\n');
      if (buffer.length > 4 * 1024 * 1024) throw new ProviderError('Model event exceeds the size limit');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try {yield eventSchema.parse(JSON.parse(data));} catch {throw new ProviderError('Model stream event format is invalid');}
      }
      if (chunk.done) {
        if (buffer.trim()) throw new ProviderError('Model event did not end cleanly');
        return;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw transportFailure(error, 'stream', response.status);
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
export function createProvider(settings: ModelSettings, fetcher: typeof fetch = fetch): Provider {
  const capabilities = resolveProviderCapabilities(settings);
  return {capabilities, async cacheProfile(request) {
    if (settings.kind !== 'anthropic' || capabilities.caching !== 'anthropic') return undefined;
    // Budget thinking derives `budget_tokens` from `max_tokens`, so a `maxTokens: 1` replay would change the thinking configuration and the cache key.
    const effort = request.thinking === false ? 'off' : settings.thinkingEffort ?? 'auto';
    return {ttlMs: cacheLifetimeMs(settings, request) ?? SHORT_CACHE_MS, replayable: !(settings.thinkingProtocol === 'anthropic-budget' && effort !== 'off')};
  }, async respond(request, onDelta, signal) {
    if (!settings.model) throw new ProviderError('No model configured; use /model <name> or --model <name>');
    const native = settings.kind === 'anthropic';
    const oauthResponses = settings.baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1' &&
      (settings.key.startsWith('eyJ') || settings.key.startsWith('oauth-'));
    const officialOpenAI = settings.baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1';
    const isResponsesApi = !native && (oauthResponses || settings.api === 'responses' || capabilities.toolDiscovery === 'openai-responses');
    const url = settings.baseUrl.replace(/\/$/, '') + (native ? '/messages' : isResponsesApi ? '/responses' : '/chat/completions');
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (native) {
      headers['anthropic-version'] = '2023-06-01';
      if (settings.key) headers['x-api-key'] = settings.key;
    } else if (settings.key) {
      headers.authorization = 'Bearer ' + settings.key;
      if (isResponsesApi) headers.accept = 'text/event-stream';
    }
    if (request.toolDiscovery && request.toolDiscovery !== capabilities.toolDiscovery) throw new ProviderError('Tool discovery does not match the active provider protocol.');
    if (native && request.toolDiscovery === 'anthropic') headers['anthropic-beta'] = 'advanced-tool-use-2025-11-20';
    const caching = capabilities.caching === 'anthropic';
    const retention = anthropicRetention(settings, request);
    const tools = native ? encodeAnthropicTools(request.tools, caching, retention) : request.tools.map(tool => isResponsesApi
        ? request.toolDiscovery === 'openai-responses' && tool.name === 'LoadTools' ? encodeOpenAIToolSearch(tool.parameters) : encodeOpenAIFunction(tool)
        : {type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters}});
    const maxTokens = Math.min(settings.maxTokens, request.maxTokens ?? Infinity);
    const effort = request.thinking === false ? 'off' : settings.thinkingEffort ?? 'auto';
    const protocol = settings.thinkingProtocol;
    const thinking: ObjectValue = {};
    if (protocol) {
      if (effort !== 'auto' && request.thinking !== false && !settings.thinkingLevels?.includes(effort)) throw new ProviderError('Model does not support the current thinking level');
      if (protocol === 'anthropic-budget') {
        if (effort === 'off') thinking.thinking = {type: 'disabled'};
        else {
          const budget = Math.min(({low: 1024, medium: 4096, high: 8192, auto: 8192, max: 16384} as Record<string, number>)[effort] ?? 4096, maxTokens - 1);
          if (budget < 1024) throw new ProviderError('Thinking mode needs an output budget of at least 1025 tokens; raise max_tokens or turn thinking off');
          thinking.thinking = {type: 'enabled', budget_tokens: budget};
        }
      } else if (protocol === 'anthropic-adaptive') {
        thinking.thinking = {type: effort === 'off' ? 'disabled' : 'adaptive'};
        if (effort !== 'off' && effort !== 'auto') thinking.output_config = {effort};
      } else if (protocol === 'deepseek') {
        thinking.thinking = {type: effort === 'off' ? 'disabled' : 'enabled'};
        if (effort !== 'off' && effort !== 'auto') thinking.reasoning_effort = effort === 'max' ? 'high' : effort;
      } else {
        if (effort === 'off') thinking.reasoning_effort = 'none';
        else if (effort !== 'auto') thinking.reasoning_effort = effort === 'max' ? 'high' : effort;
      }
    } else if (request.thinking === false && (native || settings.thinkingControl)) thinking.thinking = {type: 'disabled'};
    const supportsVision = request.supportsVision ?? true;
    const plainSystem = systemText(request.system);
    const isStream = oauthResponses ? true : request.stream !== false;
    const chosenModel = settings.model;
    // Routes requests of one session and actor to the same cache; sent only where the provider is known to accept it.
    const cacheKey = !native && capabilities.caching === 'openai-key' && request.cacheKey ? {prompt_cache_key: request.cacheKey} : {};
    // Account route only. The open-source `@oh-my-pi/pi-ai` ChatGPT transport documents that the backend derives prompt-cache affinity from
    // session headers (codex-rs `responses_session_id`), so each session and actor presents its opaque cache key there too.
    // UNVERIFIED against the live service; an endpoint that ignores the headers is unaffected. Never dumped or fingerprinted.
    if (oauthResponses && request.cacheKey) {
      headers.session_id = request.cacheKey;
      headers.conversation_id = request.cacheKey;
    }
    const body = native
      ? {model: chosenModel, max_tokens: maxTokens, ...(thinking.thinking && effort !== 'off' ? {} : {temperature: settings.temperature}),
        ...(isStream ? {stream: true} : {}),
        system: caching ? anthropicSystem(request.system, retention) : plainSystem,
        messages: anthropicMessages(request.messages, new Set(request.tools.filter(tool => tool.deferLoading).map(tool => tool.name)), caching, retention), tools, ...thinking}
      : isResponsesApi
        ? {
            model: chosenModel,
            store: false,
            stream: isStream,
            ...(!oauthResponses ? {max_output_tokens: maxTokens} : {}),
            ...cacheKey, ...openAiRetentionFields(settings, true),
            instructions: plainSystem,
            input: responsesInput(request.messages, supportsVision,
              request.toolDiscovery === 'openai-responses' ? {tools: request.tools, capabilities} : undefined),
            ...(tools.length ? {tools} : {}),
            ...(effort !== 'off' ? {reasoning: {effort: effort === 'auto' ? 'medium' : effort === 'max' ? 'high' : effort,
              ...(officialOpenAI ? {summary: 'auto'} : {})}} : {}),
          }
        : {model: chosenModel, max_tokens: maxTokens, temperature: settings.temperature, ...cacheKey, ...openAiRetentionFields(settings, false),
          ...(isStream ? {stream: true, stream_options: {include_usage: true}} : {}),
          messages: [{role: 'system', content: request.system}, ...openaiMessages(request.messages, settings.thinkingControl, supportsVision, settings.thinkingProtocol !== 'reasoning-effort')], tools,
          ...thinking};
    signal.throwIfAborted();
    const deadline = idleDeadline(signal, settings.timeoutMs), timed = deadline.signal;
    let fingerprint: ReturnType<typeof beginFingerprint> | undefined;
    try {
      let response: Response;
      try {
        const payload = JSON.stringify(body);
        if (request.dumpDir) dumpRequestBody(request.dumpDir, payload, request.purpose);
        if (request.fingerprint) {
          const target = request.fingerprint;
          // Built after the request has left (see `appendFingerprint`); everything it reads is already final.
          fingerprint = beginFingerprint(target, (id, time) => {
            const wire = body as Record<string, unknown>;
            const toolsJson = JSON.stringify(wire.tools ?? []);
            const replayChat = settings.thinkingProtocol !== 'reasoning-effort';
            const references = new Set(request.tools.filter(tool => tool.deferLoading).map(tool => tool.name));
            const discovery = request.toolDiscovery === 'openai-responses' ? {tools: request.tools, capabilities} : undefined;
            const encode = (message: ModelMessage): unknown => native ? anthropicMessages([message], references, false, retention)
              : isResponsesApi ? responsesInput([message], supportsVision, discovery)
              : openaiMessages([message], settings.thinkingControl, supportsVision, replayChat);
            const blocks = fingerprintBlocks(request.messages,
              [native ? 'a' : isResponsesApi ? 'r' : 'c', supportsVision, replayChat, settings.thinkingControl === true, native || discovery ? shortHash(toolsJson) : ''].join('|'),
              encode, message => native ? message.role === 'assistant' && !!message.signature : !isResponsesApi && replayChat);
            const system = native && caching ? (wire.system as unknown[]).map(block => JSON.stringify(block))
              : [JSON.stringify(isResponsesApi ? wire.instructions : native ? wire.system : (wire.messages as unknown[])[0])];
            const budget = (thinking.thinking as {budget_tokens?: unknown} | undefined)?.budget_tokens;
            const openAiRetention = native ? {} : openAiRetentionFields(settings, isResponsesApi);
            return {id, time, target, purpose: request.purpose ?? target.purpose ?? 'task', model: chosenModel,
              host: (() => {try {return new URL(url).host;} catch {return '';}})(),
              protocol: native ? 'anthropic' : isResponsesApi ? 'responses' : 'chat', toolsJson, systemBlocks: system, systemText: plainSystem, blocks,
              fields: {maxTokens, thinking: [protocol ?? 'none', effort, typeof budget === 'number' ? 'b' + budget : ''].filter(Boolean).join(':'),
                retention: native && caching ? anthropicRetention(settings, request) : Object.keys(openAiRetention).length ? JSON.stringify(openAiRetention) : 'none',
                ttlMs: cacheLifetimeMs(settings, request) ?? null, cacheKey: 'prompt_cache_key' in wire, stream: isStream,
                discovery: request.toolDiscovery ?? 'none'}};
          });
        }
        response = await fetcher(url, {method: 'POST', headers, body: payload, signal: timed, redirect: 'error'});
      }
      catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        throw timed.aborted ? providerTimeout() : transportFailure(error, 'connection');
      }
      if (!response.ok) {
        const body = await errorBody(response);
        signal.throwIfAborted();
        if (timed.aborted) throw providerTimeout();
        const requestId = responseRequestId(response);
        throw providerFailure(response.status, body.payload, parseRetryAfter(response.headers.get('retry-after')),
          {...(requestId ? {requestId} : {}), ...(body.text ? {body: body.text} : {})});
      }
      let text = '', reasoning = '', signature = '';
      let stop: ModelTurn['stop'] = 'other';
      let usage: ModelTurn['usage'];
      const calls = new Map<number, ToolCall>();
      let pendingBreak = false;
      const streamedReasoning = new Set<number>();
      const append = (kind: 'text' | 'reasoning', value: unknown) => {
        if (typeof value !== 'string' || !value) return;
        if (kind === 'text') text += value; else reasoning += value;
        onDelta({kind, text: value});
      };
      /** Tool-argument streaming is invisible in text/reasoning; report the call's accumulated size and file target so the UI can show progress. */
      const drafting = (call: ToolCall) => {
        if (!call.name) return;
        const target = partialTarget(call.arguments);
        onDelta({kind: 'tool', name: call.name, chars: call.arguments.length, ...(target ? {target} : {})});
      };
      const contentType = response.headers.get('content-type') || '';
      if (!isStream && !contentType.includes('text/event-stream')) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw transportFailure(error, 'stream', response.status);
        }
        const parsedRecord = z.record(z.string(), z.unknown()).safeParse(payload);
        if (!parsedRecord.success) {
          throw new ProviderError('Model returned an invalid non-streaming response', true, 'temporary', {status: response.status});
        }
        const parsed = parsedRecord.data;
        if (native) {
          const content = Array.isArray(parsed.content) ? parsed.content as Array<Record<string, unknown>> : [];
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') append('text', block.text);
            else if (block.type === 'thinking' && typeof block.thinking === 'string') {
              append('reasoning', block.thinking);
              if (typeof block.signature === 'string') signature = block.signature;
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              calls.set(calls.size, {
                id: typeof block.id === 'string' ? block.id : randomUUID(),
                name: block.name,
                arguments: block.input && typeof block.input === 'object' ? JSON.stringify(block.input) : '',
              });
            }
          }
          const reason = typeof parsed.stop_reason === 'string' ? parsed.stop_reason : undefined;
          stop = reason === 'tool_use' ? 'tools' : reason === 'max_tokens' ? 'length'
            : ['end_turn', 'stop_sequence'].includes(reason ?? '') ? 'complete' : 'other';
          if (parsed.usage && typeof parsed.usage === 'object') {
            const u = parsed.usage as Record<string, number>;
            usage = {input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0,
              ...(u.cache_read_input_tokens !== undefined ? {cacheRead: u.cache_read_input_tokens} : {}),
              ...(u.cache_creation_input_tokens !== undefined ? {cacheWrite: u.cache_creation_input_tokens} : {}), ...oneHourWrites(parsed.usage)};
          }
        } else if (isResponsesApi) {
          const output = Array.isArray(parsed.output) ? parsed.output : [];
          for (const value of output) {
            const item = z.record(z.string(), z.unknown()).safeParse(value);
            if (!item.success) continue;
            const search = decodeSearchCall(item.data);
            if (search) calls.set(calls.size, search);
            else if (item.data.type === 'reasoning') {
              const text = reasoningItemText(item.data);
              if (text) append('reasoning', (reasoning ? '\n\n' : '') + text);
            } else if (item.data.type === 'function_call') {
              if (typeof item.data.call_id !== 'string' || !item.data.call_id) throw new ProviderError('Function call requires call_id.');
              calls.set(calls.size, {id: item.data.call_id, name: String(item.data.name ?? ''), arguments: String(item.data.arguments ?? '')});
            } else if (item.data.type === 'message' && Array.isArray(item.data.content)) {
              for (const block of item.data.content) if (block && typeof block === 'object' && block.type === 'output_text') append('text', block.text);
            }
          }
          stop = parsed.status === 'incomplete' ? 'length' : parsed.status === 'completed' ? calls.size ? 'tools' : 'complete' : 'other';
          const parsedUsage = usageSchema.safeParse(parsed.usage);
          if (parsedUsage.success) {
            const value = parsedUsage.data;
            usage = {input: value.input_tokens ?? 0, output: value.output_tokens ?? 0,
              ...(value.input_tokens_details?.cached_tokens !== undefined ? {cacheRead: value.input_tokens_details.cached_tokens} : {})};
          }
        } else {
          const choices = Array.isArray(parsed.choices) ? parsed.choices as Array<Record<string, unknown>> : [];
          const first = choices[0];
          const msg = first?.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : undefined;
          if (msg) {
            if (typeof msg.content === 'string') append('text', msg.content);
            const r = [msg.reasoning_content, msg.reasoning, msg.thinking].find(value => typeof value === 'string' && value);
            if (typeof r === 'string') append('reasoning', r);
            else if (Array.isArray(msg.reasoning_details)) append('reasoning', chatReasoningDetails(msg.reasoning_details));
            if (Array.isArray(msg.tool_calls)) {
              for (let i = 0; i < msg.tool_calls.length; i++) {
                const tc = msg.tool_calls[i] as {id?: string; function?: {name?: string; arguments?: string}};
                calls.set(i, {
                  id: tc.id || randomUUID(),
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                });
              }
            }
          }
          const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason.toLowerCase() : undefined;
          stop = (finishReason === 'tool_calls' || finishReason === 'function_call' || calls.size > 0) ? 'tools'
            : (finishReason === 'length' || finishReason === 'max_tokens') ? 'length'
            : ['stop', 'end_turn', 'stop_sequence', 'eos', 'done'].includes(finishReason ?? '') ? 'complete' : 'other';
          if (parsed.usage && typeof parsed.usage === 'object') {
            const u = parsed.usage as Record<string, number>;
            usage = {input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0};
          }
        }
      } else {
        try {
          for await (const event of events(response, deadline.received)) {
          timed.throwIfAborted();
          if (hasProgress(event)) deadline.progress();
          if (calls.size > 128) throw new ProviderError('Too many tool calls in a single response');
          if (isResponsesApi) {
            if (event.type === 'error' || event.error) throw providerFailure(200, {error: event.error ?? event});
            if (event.type === 'response.output_text.delta') {
              if (typeof event.delta === 'string') append('text', event.delta);
            } else if (event.type === 'response.reasoning.delta' || event.type === 'response.reasoning_text.delta' ||
              event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_summary.delta') {
              if (typeof event.delta === 'string' && event.delta) {
                if (pendingBreak && reasoning) append('reasoning', '\n\n');
                pendingBreak = false;
                append('reasoning', event.delta);
                streamedReasoning.add(event.output_index ?? 0);
              }
            } else if (event.type === 'response.reasoning_summary_part.added') {
              pendingBreak = streamedReasoning.has(event.output_index ?? 0);
            } else if (event.type === 'response.function_call_arguments.delta') {
              const idx = event.output_index ?? 0;
              const call = calls.get(idx) ?? {id: '', name: '', arguments: ''};
              if (typeof event.delta === 'string') call.arguments += event.delta;
              calls.set(idx, call);
              if (typeof event.delta === 'string' && event.delta) drafting(call);
            } else if (event.type === 'response.output_item.added') {
              if (event.item?.type === 'tool_search_call') {
                const idx = event.output_index ?? calls.size;
                calls.set(idx, {id: typeof event.item.call_id === 'string' ? event.item.call_id : '', name: 'LoadTools', kind: 'tool-search', arguments: ''});
              } else if (event.item?.type === 'function_call') {
                const idx = event.output_index ?? calls.size;
                const call = calls.get(idx) ?? {id: '', name: '', arguments: ''};
                if (typeof event.item.call_id === 'string') call.id = event.item.call_id;
                if (event.item.name) call.name = event.item.name;
                calls.set(idx, call);
              }
            } else if (event.type === 'response.output_item.done') {
              if (event.item?.type === 'reasoning') {
                if (!streamedReasoning.has(event.output_index ?? 0)) {
                  const text = reasoningItemText(event.item);
                  if (text) append('reasoning', (reasoning ? '\n\n' : '') + text);
                }
              } else if (event.item?.type === 'tool_search_call') {
                const call = decodeSearchCall(event.item);
                if (call) calls.set(event.output_index ?? calls.size, call);
              } else if (event.item?.type === 'function_call') {
                const idx = event.output_index ?? 0;
                const call = calls.get(idx) ?? {id: '', name: '', arguments: ''};
                if (typeof event.item.call_id === 'string') call.id = event.item.call_id;
                if (event.item.name) call.name = event.item.name;
                if (typeof event.item.arguments === 'string') call.arguments = event.item.arguments;
                calls.set(idx, call);
              }
            } else if (event.type === 'response.incomplete') {
              stop = 'length';
            } else if (event.type === 'response.completed') {
              stop = event.response?.status === 'incomplete' ? 'length' : calls.size > 0 ? 'tools' : 'complete';
              if (event.response?.usage) {
                usage = {
                  input: event.response.usage.input_tokens ?? 0,
                  output: event.response.usage.output_tokens ?? 0,
                  ...(event.response.usage.input_tokens_details?.cached_tokens !== undefined ? {cacheRead: event.response.usage.input_tokens_details.cached_tokens} : {}),
                };
              }
            }
          } else if (native) {
            if (event.type === 'error') throw providerFailure(200, {error: event.error});
            if (event.type === 'message_start') {
              const value = event.message?.usage;
              usage = {input: (value?.input_tokens ?? 0) + (value?.cache_read_input_tokens ?? 0) + (value?.cache_creation_input_tokens ?? 0),
                output: 0, ...(value?.cache_read_input_tokens !== undefined ? {cacheRead: value.cache_read_input_tokens} : {}),
                ...(value?.cache_creation_input_tokens !== undefined ? {cacheWrite: value.cache_creation_input_tokens} : {}), ...oneHourWrites(value)};
            }
            if (event.type === 'content_block_start') {
              const block = event.content_block;
              if (block?.type === 'tool_use' && event.index !== undefined) calls.set(event.index, {id: block.id ?? '', name: block.name ?? '', arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : ''});
              else if (block?.type === 'text') append('text', block.text);
              else if (block?.type === 'thinking') {append('reasoning', block.thinking); signature = block.signature ?? '';}
            }
            if (event.type === 'content_block_delta') {
              const delta = typeof event.delta === 'object' && event.delta ? event.delta : undefined;
              if (delta?.type === 'text_delta') append('text', delta.text);
              if (delta?.type === 'thinking_delta') append('reasoning', delta.thinking);
              if (delta?.type === 'signature_delta') signature += delta.signature ?? '';
              if (delta?.type === 'input_json_delta') {
                const call = event.index === undefined ? undefined : calls.get(event.index);
                if (call) {
                  call.arguments += delta.partial_json ?? '';
                  if (delta.partial_json) drafting(call);
                }
              }
            }
            if (event.type === 'message_delta') {
              const delta = typeof event.delta === 'object' && event.delta ? event.delta : undefined;
              const reason = delta?.stop_reason;
              stop = reason === 'tool_use' ? 'tools' : reason === 'max_tokens' ? 'length'
                : ['end_turn', 'stop_sequence'].includes(reason ?? '') ? 'complete' : 'other';
              if (usage && typeof event.usage?.output_tokens === 'number') usage.output = event.usage.output_tokens;
            }
          } else {
            if (event.error) throw providerFailure(200, {error: event.error});
            const choice = event.choices?.[0];
            const delta = choice?.delta;
            append('text', delta?.content);
            append('reasoning', delta?.reasoning_content || delta?.reasoning || delta?.thinking || chatReasoningDetails(delta?.reasoning_details));
            for (const item of delta?.tool_calls ?? []) {
              const call = calls.get(item.index) ?? {id: '', name: '', arguments: ''};
              if (item.id) call.id += item.id;
              if (item.function?.name) call.name += item.function.name;
              if (item.function?.arguments) call.arguments += item.function.arguments;
              calls.set(item.index, call);
              if (item.function?.arguments) drafting(call);
            }
            if (choice?.finish_reason) {
              const fr = choice.finish_reason.toLowerCase();
              stop = (fr === 'tool_calls' || fr === 'function_call') ? 'tools'
                : (fr === 'length' || fr === 'max_tokens') ? 'length'
                : ['stop', 'end_turn', 'stop_sequence', 'eos', 'done'].includes(fr) ? 'complete' : 'other';
            }
            if (event.usage) {
              const cached = event.usage.prompt_tokens_details?.cached_tokens ?? event.usage.prompt_cache_hit_tokens ?? event.usage.cached_tokens;
              usage = {input: event.usage.prompt_tokens ?? 0, output: event.usage.completion_tokens ?? 0, ...(cached !== undefined ? {cacheRead: cached} : {})};
            }
          }
        }
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (timed.aborted) throw providerTimeout();
        throw error;
      }
    }
      const toolCalls = [...calls.values()];
      if (toolCalls.some(call => call.kind === 'tool-search') && (toolCalls.some(call => call.kind === 'tool-search' && (!call.id || !call.arguments)) ||
        new Set(toolCalls.map(call => call.id)).size !== toolCalls.length)) throw new ProviderError('Client tool search requires a completed item with a unique original call_id.');
      fingerprint?.settle(usage ? {usage} : {});
      return {message: {role: 'assistant', text, ...(reasoning ? {reasoning} : {}),
        ...(signature ? {signature} : {}), ...(toolCalls.length ? {toolCalls} : {})}, stop,
        ...(usage ? {usage} : {})};
    } catch (error) {
      fingerprint?.settle({error: signal.aborted ? 'aborted' : error instanceof ProviderError ? error.category : 'error'});
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof ProviderError && (error.diagnostic?.phase || isProviderTimeout(error))) {
        const observed = deadline.observation();
        const seconds = (ms: number) => (ms / 1000).toFixed(1) + 's';
        const detail = 'Transport: elapsed ' + seconds(observed.elapsedMs) + '; idle since progress ' + seconds(observed.progressIdleMs) +
          '; ' + (observed.transportIdleMs === undefined ? 'no data received' : 'idle since data ' + seconds(observed.transportIdleMs)) +
          '; ' + observed.receivedBytes + ' bytes received.';
        throw new ProviderError(error.message + '\n' + detail, error.retryable, error.category, {...error.diagnostic, ...observed});
      }
      throw error;
    } finally {deadline.close();}
  }};
}

/** The `file_path` or `path` string of a possibly incomplete JSON arguments string, once it has fully arrived. */
export function partialTarget(partial: string): string | undefined {
  const match = /"(?:file_path|path)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(partial);
  if (!match) return undefined;
  try {const value: unknown = JSON.parse(match[1]!); return typeof value === 'string' && value ? value : undefined;} catch {return undefined;}
}
