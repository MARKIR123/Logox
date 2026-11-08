import type {CacheProfile, ModelRequest, ModelTurn, Provider} from '../runtime/messages.js';
import {costOf} from '../context/cost.js';

/** Stop warming this long after the actor went idle. */
export const MAX_WARM_MS = 60 * 60_000;
/** Fire only when skipping the warm-up would cost at least this much more (price currency units) than the warm-up itself. */
export const MIN_WARM_SAVINGS = 0.05;
const WARM_TIMEOUT_MS = 60_000;

export interface KeepAliveWho {readonly sessionId: string; readonly ownerId: string; readonly activityId: string; readonly rootActivityId?: string | undefined}
export interface KeepAliveTarget {
  /** The last real request of the actor, exactly as sent. */
  readonly request: ModelRequest;
  readonly provider: Provider;
  /** Model identity as used in usage records. */
  readonly model: string;
  /** When that request started: provider cache lifetimes are measured from request start. */
  readonly startedAt: number;
  readonly usage: ModelTurn['usage'];
}
export interface CacheKeeperOptions {
  enabled(): boolean;
  /** True only while the actor is certain to make another request without human input. */
  certain(who: KeepAliveWho): boolean;
  pricing: Parameters<typeof costOf>[1];
  /** Records the usage of one warm-up (category `keepalive`). */
  charge(who: KeepAliveWho, usage: NonNullable<ModelTurn['usage']>, model: string): void;
}
/** `ttl * 0.9`, or `ttl - 10s` when that is smaller (pi's `getCacheWarmingDelayMs`); undefined when the lifetime is too short to warm. */
export function warmDelayMs(ttlMs: number): number | undefined {
  return ttlMs <= 10_000 ? undefined : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}
/**
 * What one warm-up saves: the extra cost of a cache miss (write instead of read over the whole prompt) minus the cost of the warm-up
 * (reading the prompt and one output token). Undefined when the model has no complete price, so unknown prices never warm.
 */
export function warmSavings(tokens: number, model: string, pricing: CacheKeeperOptions['pricing']): number | undefined {
  const base = {id: 'warm', category: 'keepalive' as const, model, input: tokens, cacheRead: 0, cacheWrite: 0};
  const write = costOf([{...base, output: 0, cacheWrite: tokens}], pricing), read = costOf([{...base, output: 0, cacheRead: tokens}], pricing);
  const warm = costOf([{...base, output: 1, cacheRead: tokens}], pricing);
  if (!write || !read || !warm || write.partial || read.partial || warm.partial) return undefined;
  return write.amount - read.amount - warm.amount;
}

interface Entry {generation: number; timer?: ReturnType<typeof setTimeout>; abort?: AbortController | undefined}
/**
 * Keeps the short prompt cache of an idle actor alive by replaying its last request with `maxTokens: 1` (pi's cache warmer). The caller
 * decides when an actor is certain to wake again (`certain`); a new real request of the actor (`wake`) always ends the warming. Warm-up
 * requests never touch history; their usage goes to `charge`.
 */
export class CacheKeeper {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly options: CacheKeeperOptions) {}
  private static key(who: KeepAliveWho): string {return who.sessionId + '\n' + who.ownerId;}
  /** The actor makes a real request now (or is gone): stop warming and abort a warm-up in flight. */
  wake(who: KeepAliveWho): void {
    const entry = this.entries.get(CacheKeeper.key(who));
    if (!entry) return;
    entry.generation++;
    clearTimeout(entry.timer); entry.abort?.abort();
    this.entries.delete(CacheKeeper.key(who));
  }
  dispose(): void {
    for (const entry of this.entries.values()) {entry.generation++; clearTimeout(entry.timer); entry.abort?.abort();}
    this.entries.clear();
  }
  active(who: KeepAliveWho): boolean {return this.entries.has(CacheKeeper.key(who));}
  /** An actor finished a real request: remember it and, if its cache is worth keeping, schedule the first warm-up. */
  async arm(who: KeepAliveWho, target: KeepAliveTarget): Promise<void> {
    this.wake(who);
    const tokens = target.usage?.input ?? 0;
    // Nothing was cached (prompt below the minimum, or caching off): there is nothing to keep.
    if (!this.options.enabled() || tokens <= 0 || (target.usage?.cacheRead ?? 0) + (target.usage?.cacheWrite ?? 0) <= 0) return;
    const entry: Entry = {generation: 0};
    this.entries.set(CacheKeeper.key(who), entry);
    let profile: CacheProfile | undefined;
    try {profile = await target.provider.cacheProfile?.(target.request, AbortSignal.timeout(10_000));} catch {profile = undefined;}
    // A longer cache already outlives the whole warming window, and a request that cannot be replayed cheaply is never warmed.
    if (entry.generation !== 0 || !profile?.replayable || profile.ttlMs >= MAX_WARM_MS || warmDelayMs(profile.ttlMs) === undefined) {
      if (entry.generation === 0) this.entries.delete(CacheKeeper.key(who));
      return;
    }
    this.schedule(who, entry, target, profile.ttlMs, tokens, Date.now());
  }
  private stop(who: KeepAliveWho, entry: Entry): void {
    if (this.entries.get(CacheKeeper.key(who)) === entry) this.entries.delete(CacheKeeper.key(who));
  }
  private schedule(who: KeepAliveWho, entry: Entry, target: KeepAliveTarget, ttlMs: number, tokens: number, since: number): void {
    const generation = entry.generation;
    const fireAt = target.startedAt + warmDelayMs(ttlMs)!;
    if (fireAt - since > MAX_WARM_MS) return this.stop(who, entry);
    entry.timer = setTimeout(() => {void this.fire(who, entry, generation, target, ttlMs, tokens, since);}, Math.max(0, fireAt - Date.now()));
    entry.timer.unref?.();
  }
  private async fire(who: KeepAliveWho, entry: Entry, generation: number, target: KeepAliveTarget, ttlMs: number, tokens: number, since: number): Promise<void> {
    if (entry.generation !== generation) return;
    const now = Date.now();
    // Late timers (sleep, suspended process) mean the entry may already be gone: warming then only pays for a rewrite.
    if (now - since >= MAX_WARM_MS || now >= target.startedAt + ttlMs || !this.options.enabled() || !this.options.certain(who)) return this.stop(who, entry);
    const savings = warmSavings(tokens, target.model, this.options.pricing);
    if (savings === undefined || savings < MIN_WARM_SAVINGS) return this.stop(who, entry);
    const controller = new AbortController();
    entry.abort = controller;
    const startedAt = now;
    let turn: ModelTurn;
    try {
      turn = await target.provider.respond({...target.request, maxTokens: 1, stream: false, purpose: 'keepalive'}, () => {},
        AbortSignal.any([controller.signal, AbortSignal.timeout(WARM_TIMEOUT_MS)]));
    } catch {return this.stop(who, entry);}
    entry.abort = undefined;
    if (turn.usage) try {this.options.charge(who, turn.usage, target.model);} catch {}
    if (entry.generation !== generation) return;
    const next = turn.usage?.input ?? 0;
    if (next <= 0 || (turn.usage?.cacheRead ?? 0) <= 0) return this.stop(who, entry);
    this.schedule(who, entry, {...target, startedAt, usage: turn.usage}, ttlMs, next, since);
  }
}
