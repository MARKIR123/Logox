import type {CacheProfile, ModelRequest, ModelTurn, Provider} from '../runtime/messages.js';
import {costOf} from '../context/cost.js';
import {LONG_CACHE_MS} from '../providers/cache.js';

/** Fire only when skipping the warm-up would cost at least this much more (price currency units) than the warm-up itself. */
export const MIN_WARM_SAVINGS = 0.05;
/** A human wait warms only while the cache would otherwise die at least this share of its lifetime before the away budget ends (the slack `warmDelayMs` already leaves). */
export const AWAY_TAIL_RATIO = 0.1;
const WARM_TIMEOUT_MS = 60_000;

export interface KeepAliveWho {readonly sessionId: string; readonly ownerId: string; readonly activityId: string; readonly rootActivityId?: string | undefined}
type KeepAliveActor = Pick<KeepAliveWho, 'sessionId' | 'ownerId'>;
/** Why an idle actor will wake: `peer` (another actor or job is certain to wake it) or `human` (the Director awaits the human with nothing else open). */
export type KeepAliveReason = 'peer' | 'human';
/** Read-only view of one idle stretch for the UI. */
export interface KeepAliveState {
  readonly reason: KeepAliveReason;
  /** When the next warm-up is due; absent while one is in flight. */
  readonly nextWarmAt?: number;
  /** End of the away budget; only for `human`. */
  readonly until?: number;
  /** Cost of the warm-ups of this stretch so far (price currency units). */
  readonly spent: number;
}
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
  /** Why the actor is certain to make another request, or false: a peer wait is certain to end, a human wait is not. Evaluated when a warm-up is due and when the UI reads `state()`. */
  certain(who: KeepAliveWho): KeepAliveReason | false;
  /** Milliseconds the cache is kept alive for a returning human after the last real request; 0 never warms for the human. */
  awayMs(): number;
  pricing: Parameters<typeof costOf>[1];
  /** Records the usage of one warm-up (category `keepalive`). */
  charge(who: KeepAliveWho, usage: NonNullable<ModelTurn['usage']>, model: string): void;
}
/** `ttl * 0.9`, or `ttl - 10s` when that is smaller (pi's `getCacheWarmingDelayMs`); undefined when the lifetime is too short to warm. */
export function warmDelayMs(ttlMs: number): number | undefined {
  return ttlMs <= 10_000 ? undefined : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}
/**
 * The two prices of keeping a prompt: `warm` (reading it back plus one output token) and `miss` (the extra cost of a cache miss, writing the whole
 * prompt instead of reading it; a long lifetime writes at the 1-hour price, see `src/context/AGENTS.md`). Undefined when the model has no complete
 * price, so unknown prices never warm.
 */
export function warmCosts(tokens: number, model: string, pricing: CacheKeeperOptions['pricing'], long = false): {warm: number; miss: number} | undefined {
  const base = {id: 'warm', category: 'keepalive' as const, model, input: tokens, cacheRead: 0, cacheWrite: 0};
  const write = costOf([{...base, output: 0, cacheWrite: tokens, ...(long ? {cacheWrite1h: tokens} : {})}], pricing), read = costOf([{...base, output: 0, cacheRead: tokens}], pricing);
  const warm = costOf([{...base, output: 1, cacheRead: tokens}], pricing);
  if (!write || !read || !warm || write.partial || read.partial || warm.partial) return undefined;
  return {warm: warm.amount, miss: write.amount - read.amount};
}
/** What one warm-up saves when the cache would otherwise miss: `miss - warm`. Undefined without a complete price. */
export function warmSavings(tokens: number, model: string, pricing: CacheKeeperOptions['pricing'], long = false): number | undefined {
  const costs = warmCosts(tokens, model, pricing, long);
  return costs && costs.miss - costs.warm;
}

interface Entry {
  generation: number; timer?: ReturnType<typeof setTimeout>; abort?: AbortController | undefined;
  readonly who: KeepAliveWho;
  ttlMs: number;
  /** When the human wait began: the end of the last real request. */
  readonly idleSince: number;
  /** Start of the latest request (real or warm-up) that refreshed the cache. */
  startedAt: number;
  /** Cost of the warm-ups of this idle stretch. */
  spent: number;
  fireAt?: number | undefined;
}
/**
 * Keeps the prompt cache of an idle actor alive by replaying its last request with `maxTokens: 1` (pi's cache warmer). The caller decides why an
 * actor will wake again (`certain`); a new real request of the actor (`wake`) always ends the warming. Warm-up requests never touch history; their
 * usage goes to `charge`.
 *
 * - Peer wait: no time cap; the idle stretch stops when its cumulative warm-up cost would exceed one cache miss.
 * - Human wait: only within the away budget (`awayMs`), and only while the cache would otherwise expire before the budget ends; the cumulative cost stop applies too.
 */
export class CacheKeeper {
  private readonly entries = new Map<string, Entry>();
  /** Start of the latest request that refreshed each actor's cache, whether or not it is warmed. */
  private readonly touched = new Map<string, number>();
  /** Set by the host: called whenever `state()` or `touchedAt()` may have changed. */
  onChange: (() => void) | undefined;
  constructor(private readonly options: CacheKeeperOptions) {}
  private static key(who: KeepAliveActor): string {return who.sessionId + '\n' + who.ownerId;}
  /** The actor makes a real request now (or is gone): stop warming and abort a warm-up in flight. */
  wake(who: KeepAliveActor): void {
    const entry = this.entries.get(CacheKeeper.key(who));
    if (!entry) return;
    entry.generation++;
    clearTimeout(entry.timer); entry.abort?.abort();
    this.entries.delete(CacheKeeper.key(who));
    this.onChange?.();
  }
  dispose(): void {
    for (const entry of this.entries.values()) {entry.generation++; clearTimeout(entry.timer); entry.abort?.abort();}
    this.entries.clear(); this.touched.clear();
  }
  active(who: KeepAliveActor): boolean {return this.entries.has(CacheKeeper.key(who));}
  /** When the latest request that refreshed the actor's cache started (a real request or a warm-up); undefined before the first one. */
  touchedAt(who: KeepAliveActor): number | undefined {return this.touched.get(CacheKeeper.key(who));}
  /** The warming of the actor's current idle stretch, or undefined when nothing is (or will be) warmed. */
  state(who: KeepAliveActor, now = Date.now()): KeepAliveState | undefined {
    const entry = this.entries.get(CacheKeeper.key(who));
    if (!entry || entry.ttlMs <= 0 || !this.options.enabled()) return undefined;
    const reason = this.reasonFor(entry);
    if (!reason) return undefined;
    const until = reason === 'human' ? entry.idleSince + this.options.awayMs() : undefined;
    if (until !== undefined && (now >= until || !this.needsWarm(entry, until))) return undefined;
    return {reason, spent: entry.spent, ...(entry.fireAt !== undefined ? {nextWarmAt: entry.fireAt} : {}), ...(until !== undefined ? {until} : {})};
  }
  private reasonFor(entry: Entry): KeepAliveReason | false {
    const reason = this.options.certain(entry.who);
    return reason === 'human' && this.options.awayMs() <= 0 ? false : reason;
  }
  /** A human wait needs a warm-up only while the cache would expire clearly before the away budget ends. */
  private needsWarm(entry: Entry, until: number): boolean {return until - (entry.startedAt + entry.ttlMs) >= entry.ttlMs * AWAY_TAIL_RATIO;}
  /** An actor finished a real request: remember it and, if its cache is worth keeping, schedule the first warm-up. */
  async arm(who: KeepAliveWho, target: KeepAliveTarget): Promise<void> {
    this.wake(who);
    this.touched.set(CacheKeeper.key(who), target.startedAt);
    this.onChange?.();
    const tokens = target.usage?.input ?? 0;
    // Nothing was cached (prompt below the minimum, or caching off): there is nothing to keep.
    if (!this.options.enabled() || tokens <= 0 || (target.usage?.cacheRead ?? 0) + (target.usage?.cacheWrite ?? 0) <= 0) return;
    // Registered before the profile arrives so a `wake` meanwhile cancels this arming.
    const entry: Entry = {generation: 0, who, ttlMs: 0, idleSince: Date.now(), startedAt: target.startedAt, spent: 0};
    this.entries.set(CacheKeeper.key(who), entry);
    let profile: CacheProfile | undefined;
    try {profile = await target.provider.cacheProfile?.(target.request, AbortSignal.timeout(10_000));} catch {profile = undefined;}
    // A request that cannot be replayed cheaply is never warmed.
    if (entry.generation !== 0 || !profile?.replayable || warmDelayMs(profile.ttlMs) === undefined) {
      if (entry.generation === 0) this.entries.delete(CacheKeeper.key(who));
      return;
    }
    entry.ttlMs = profile.ttlMs;
    this.schedule(who, entry, target);
  }
  private stop(who: KeepAliveWho, entry: Entry): void {
    if (this.entries.get(CacheKeeper.key(who)) === entry) {this.entries.delete(CacheKeeper.key(who)); this.onChange?.();}
  }
  private schedule(who: KeepAliveWho, entry: Entry, target: KeepAliveTarget): void {
    const generation = entry.generation;
    entry.startedAt = target.startedAt;
    entry.fireAt = target.startedAt + warmDelayMs(entry.ttlMs)!;
    entry.timer = setTimeout(() => {void this.fire(who, entry, generation, target);}, Math.max(0, entry.fireAt - Date.now()));
    entry.timer.unref?.();
    this.onChange?.();
  }
  private async fire(who: KeepAliveWho, entry: Entry, generation: number, target: KeepAliveTarget): Promise<void> {
    if (entry.generation !== generation) return;
    const now = Date.now(), tokens = target.usage?.input ?? 0;
    entry.fireAt = undefined;
    const reason = this.options.enabled() ? this.reasonFor(entry) : false;
    // Late timers (sleep, suspended process) mean the entry may already be gone: warming then only pays for a rewrite.
    if (!reason || now >= target.startedAt + entry.ttlMs) return this.stop(who, entry);
    if (reason === 'human') {
      const until = entry.idleSince + this.options.awayMs();
      if (now >= until || !this.needsWarm(entry, until)) return this.stop(who, entry);
    }
    // One cache miss is the most the whole stretch may spend: a 5-minute cache pays for about a dozen warm-ups, a 1-hour cache for about twenty.
    const costs = warmCosts(tokens, target.model, this.options.pricing, entry.ttlMs >= LONG_CACHE_MS);
    if (!costs || costs.miss - costs.warm < MIN_WARM_SAVINGS || entry.spent + costs.warm > costs.miss) return this.stop(who, entry);
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
    entry.spent += costs.warm;
    if ((turn.usage?.input ?? 0) <= 0 || (turn.usage?.cacheRead ?? 0) <= 0) return this.stop(who, entry);
    this.touched.set(CacheKeeper.key(who), startedAt);
    this.schedule(who, entry, {...target, startedAt, usage: turn.usage});
  }
}
