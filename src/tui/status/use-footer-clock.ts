import {useEffect} from 'react';

/**
 * The footer's one live clock: while `active`, calls `tick(Date.now())` once per wall-clock second (aligned to the second, like the side column's
 * elapsed clocks in `terminal/terminal-plane.ts`), so every countdown in the status line shares a single timer. Idle when nothing counts down,
 * and silent under the test runner like the actor pills.
 */
export function useFooterClock(active: boolean, tick: (now: number) => void): void {
  useEffect(() => {
    if (!active || process.execArgv.some(arg => arg.startsWith('--test'))) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      timer = setTimeout(() => {tick(Date.now()); next();}, 1010 - (Date.now() % 1000));
      timer.unref?.();
    };
    tick(Date.now()); next();
    return () => clearTimeout(timer);
  }, [active, tick]);
}
