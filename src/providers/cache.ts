import type {ModelSettings} from '../config/config.js';
import type {ModelRequest} from '../runtime/messages.js';

export type CacheRetention = 'short' | 'long';
export const SHORT_CACHE_MS = 5 * 60_000;
export const LONG_CACHE_MS = 60 * 60_000;

/** The Director waits for dispatched work for long stretches; every other actor runs tight tool loops where a longer lifetime only adds write cost. */
export function roleCacheRetention(ownerId: string): CacheRetention {
  return ownerId === 'logox' ? 'long' : 'short';
}

/**
 * Anthropic lifetime of one request: the actor's `cache_retention`, then the model or provider `cache_retention`, then the role default.
 * One value per request: the API wants longer lifetimes before shorter ones, so every breakpoint carries the same one.
 */
export function anthropicRetention(settings: Pick<ModelSettings, 'cacheRetention'>, request: Pick<ModelRequest, 'cacheRetention'>): CacheRetention {
  return request.cacheRetention?.actor ?? settings.cacheRetention ?? request.cacheRetention?.role ?? 'short';
}
/** Omitting `ttl` keeps the default 5 minutes; `"1h"` costs 2x on writes instead of 1.25x. */
export function cacheControl(retention: CacheRetention): {type: 'ephemeral'; ttl?: '1h'} {
  return retention === 'long' ? {type: 'ephemeral', ttl: '1h'} : {type: 'ephemeral'};
}

/**
 * OpenAI retention fields, sent only when `cache_retention = "long"` is set on the provider or model; never from the role default or an actor.
 * Source (checked 2026-11-08): https://developers.openai.com/api/docs/guides/prompt-caching
 * - GPT-5.6 and later: `prompt_cache_options: {ttl: "12h"}` on Responses (default 30m; the 12h write costs 2.5x).
 * - Earlier models: `prompt_cache_retention: "24h"` (no extra write fee). Chat Completions acceptance is undocumented, so the older field rides both.
 * Other model names (gateways that opted in to `prompt_cache_key`) get nothing.
 */
export function openAiRetentionFields(settings: Pick<ModelSettings, 'cacheRetention' | 'model'>, responses: boolean): Record<string, unknown> {
  if (settings.cacheRetention !== 'long') return {};
  const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec(settings.model);
  if (!match) return {};
  const major = Number(match[1]), minor = Number(match[2] ?? 0);
  if (major > 5 || major === 5 && minor >= 6) return responses ? {prompt_cache_options: {ttl: '12h'}} : {};
  return {prompt_cache_retention: '24h'};
}
