/**
 * A first-in-first-out counting semaphore whose limit is read at every release and acquisition, so a configuration change applies to
 * the next start. A waiter leaves the queue when its signal aborts.
 */
export class Semaphore {
  private held = 0;
  private readonly queue: {readonly start: () => void; readonly signal: AbortSignal | undefined}[] = [];
  constructor(private readonly limit: () => number) {}

  /** Slots in use. */
  get running(): number {return this.held;}
  /** Callers waiting for a slot. */
  get waiting(): number {return this.queue.length;}

  /** Resolves with the function that gives the slot back (idempotent). Rejects with the signal's reason when it aborts while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {reject(signal.reason); return;}
      const waiter = {signal, start: () => {
        signal?.removeEventListener('abort', onAbort);
        this.held++;
        let released = false;
        resolve(() => {if (!released) {released = true; this.held--; this.drain();}});
      }};
      const onAbort = () => {
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, {once: true});
      this.queue.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length && this.held < Math.max(1, this.limit())) this.queue.shift()!.start();
  }
}
