import {isRateLimitFailure} from './http.js';

export interface RequestGateOptions {
  /** In-flight ceiling and starting limit. */
  maxConcurrency?: number;
  /** First cooldown after a rate-limit failure without `Retry-After`; doubles per consecutive failure. */
  baseCooldownMs?: number;
  /** Cap for the exponential cooldown. */
  maxCooldownMs?: number;
  /** Cap for a server-provided `Retry-After`. */
  retryAfterCapMs?: number;
}

export const defaultMaxConcurrency = 16;

interface Waiter {
  start: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/**
 * Per-endpoint AIMD concurrency gate. Rate-limit failures (HTTP 429/529, `rate_limit_error`, `overloaded_error`)
 * halve the limit and hold new starts for a cooldown; `limit` consecutive successes add one slot back.
 * The gate never retries: callers own retry budgeting and their retries pass through the gate again.
 */
export class RequestGate {
  private readonly max: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly retryAfterCapMs: number;
  private current: number;
  private running = 0;
  private successes = 0;
  /** Incremented per reduction; a failure only reduces when its request started in the current epoch. */
  private epoch = 0;
  private nextCooldownMs: number;
  private cooldownUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly queue: Waiter[] = [];

  constructor(options: RequestGateOptions = {}) {
    this.max = Math.max(1, options.maxConcurrency ?? defaultMaxConcurrency);
    this.baseCooldownMs = options.baseCooldownMs ?? 1000;
    this.maxCooldownMs = options.maxCooldownMs ?? 30_000;
    this.retryAfterCapMs = options.retryAfterCapMs ?? 60_000;
    this.current = this.max;
    this.nextCooldownMs = this.baseCooldownMs;
  }

  /** Current concurrency limit. */
  get limit(): number {return this.current;}
  /** Requests currently holding a slot. */
  get inFlight(): number {return this.running;}
  /** Requests waiting for a slot. */
  get queued(): number {return this.queue.length;}
  /** Milliseconds until new starts are allowed again; 0 when not cooling down. */
  get cooldownRemainingMs(): number {return Math.max(0, this.cooldownUntil - Date.now());}

  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {reject(signal.reason); return;}
      const waiter: Waiter = {
        signal, reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
          this.schedule();
        },
        start: () => {
          signal.removeEventListener('abort', waiter.onAbort);
          this.running++;
          const startedEpoch = this.epoch;
          void this.execute(operation, startedEpoch).then(resolve, reject);
        },
      };
      signal.addEventListener('abort', waiter.onAbort, {once: true});
      this.queue.push(waiter);
      this.schedule();
    });
  }

  private async execute<T>(operation: () => Promise<T>, startedEpoch: number): Promise<T> {
    try {
      const value = await operation();
      this.succeeded();
      return value;
    } catch (error) {
      if (isRateLimitFailure(error)) this.rateLimited(error.diagnostic?.retryAfterMs, startedEpoch);
      throw error;
    } finally {
      this.running--;
      this.schedule();
    }
  }

  private succeeded(): void {
    this.nextCooldownMs = this.baseCooldownMs;
    if (++this.successes >= this.current && this.current < this.max) {
      this.current++;
      this.successes = 0;
    }
  }

  private rateLimited(retryAfterMs: number | undefined, startedEpoch: number): void {
    const hold = retryAfterMs !== undefined ? Math.min(Math.max(0, retryAfterMs), this.retryAfterCapMs) : undefined;
    if (startedEpoch === this.epoch) {
      this.epoch++;
      this.current = Math.max(1, Math.floor(this.current / 2));
      this.successes = 0;
      const cooldown = hold ?? this.nextCooldownMs;
      if (hold === undefined) this.nextCooldownMs = Math.min(this.nextCooldownMs * 2, this.maxCooldownMs);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldown);
    } else if (hold !== undefined) {
      // Same congestion event already reduced the limit; only honor a longer server hint.
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + hold);
    }
  }

  /** Starts as many waiters as the limit and cooldown allow; arms one unref'd timer while cooling down. */
  private schedule(): void {
    if (this.timer) {clearTimeout(this.timer); this.timer = undefined;}
    if (!this.queue.length) return;
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {this.timer = undefined; this.schedule();}, wait);
      this.timer.unref();
      return;
    }
    while (this.queue.length && this.running < this.current) this.queue.shift()!.start();
  }
}
