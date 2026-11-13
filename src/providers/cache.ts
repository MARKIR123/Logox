import {isDirector} from '../runtime/director-id.js';
import type {ModelSettings} from '../config/config.js';
import type {ModelRequest} from '../runtime/messages.js';

export type CacheRetention = 'short' | 'long';
export const SHORT_CACHE_MS = 5 * 60_000;
export const LONG_CACHE_MS = 60 * 60_000;
const OFFICIAL_ANTHROPIC = /^https:\/\/api\.anthropic\.com(\/|$)/i;

/** The Director waits for dispatched work for long stretches; every other actor runs tight tool loops where a longer lifetime only adds write cost. */
export function roleCacheRetention(ownerId: string): CacheRetention {
  return isDirector(ownerId) ? 'long' : 'short';
}

/**
 * Anthropic lifetime of one request: the actor's `cache_retention`, then the model or provider `cache_retention`, then the role default.
 * One value per request: the API wants longer lifetimes before shorter ones, so every breakpoint carries the same one.
 */
export function anthropicRetention(settings: Pick<ModelSettings, 'cacheRetention'> & {readonly baseUrl?: string | undefined}, request: Pick<ModelRequest, 'cacheRetention'>): CacheRetention {
  // The role default (Director `long`) is a promise only the official endpoint is known to keep. A gateway or proxy that speaks the protocol may
  // ignore `ttl: "1h"` and drop entries after five minutes; believing in an hour there stops the keep-alive and the fold-on-expiry, so every
  // Director wake pays a full uncached prompt. Elsewhere the long lifetime must be asked for explicitly (`cache_retention`, or `cache_ttl_seconds`).
  const role = settings.baseUrl === undefined || OFFICIAL_ANTHROPIC.test(settings.baseUrl) ? request.cacheRetention?.role : undefined;
  return request.cacheRetention?.actor ?? settings.cacheRetention ?? role ?? 'short';
}
/**
 * How long this request's prompt cache entry lives, in milliseconds, or undefined when that is unknown. A `cache_ttl_seconds` the user
 * configured wins (a gateway may keep entries for a different time than it is asked to). Otherwise Anthropic: the lifetime LOGOX itself sets
 * on the request (`anthropicRetention`); every other protocol: unknown, because OpenAI and gateways do not disclose theirs. Callers treat
 * undefined as "never expired".
 */
export function cacheLifetimeMs(settings: Pick<ModelSettings, 'kind' | 'cacheRetention' | 'cacheTtlMs'> & {readonly baseUrl?: string | undefined}, request: Pick<ModelRequest, 'cacheRetention'>): number | undefined {
  if (settings.cacheTtlMs !== undefined) return settings.cacheTtlMs;
  return settings.kind === 'anthropic' ? anthropicRetention(settings, request) === 'long' ? LONG_CACHE_MS : SHORT_CACHE_MS : undefined;
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
