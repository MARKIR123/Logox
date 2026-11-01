import {setTimeout as delay} from 'node:timers/promises';

/**
 * Poll `read` until `predicate(value)` holds. Fails with the last observed value after `timeoutMs`.
 * Use this instead of fixed sleeps for any async UI or state assertion.
 */
export async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean,
  options: {timeoutMs?: number; intervalMs?: number; label?: string} = {}): Promise<T> {
  const {timeoutMs = 8000, intervalMs = 15, label = 'condition'} = options;
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!predicate(last)) {
    if (Date.now() >= deadline) {
      const shown = typeof last === 'string' ? last.slice(-600) : JSON.stringify(last);
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}\nlast observed: ${shown}`);
    }
    await delay(intervalMs);
    last = await read();
  }
  return last;
}
