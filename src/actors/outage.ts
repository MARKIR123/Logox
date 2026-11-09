/** Wake delays while a provider is down: 30 s, 2 min, then 5 min repeatedly. */
export const OUTAGE_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000];
export function outageDelayText(milliseconds: number): string {
  return milliseconds < 60_000 ? Math.round(milliseconds / 1000) + 's' : Math.round(milliseconds / 60_000) + 'm';
}
/**
 * Holds Director wake-ups while a provider outage lasts. `arm()` schedules the next wake (one timer at a time, increasing delays),
 * `reset()` forgets the outage once a wake succeeded or a human wrote, and `close()` drops the timer.
 */
export class OutageBackoff {
  private level = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly fire: () => void, private readonly announce: (text: string, first: boolean) => void,
    private readonly delays: readonly number[] = OUTAGE_DELAYS_MS) {}
  /** True while a wake is scheduled; immediate wakes must wait for it. */
  get waiting(): boolean {return this.timer !== undefined;}
  arm(provider: string): void {
    if (this.timer) return;
    const delay = this.delays[Math.min(this.level, this.delays.length - 1)]!;
    const first = this.level === 0;
    this.level++;
    this.timer = setTimeout(() => {this.timer = undefined; this.fire();}, delay);
    this.timer.unref?.();
    this.announce('[Network] Waiting for ' + provider + ' · retry in ' + outageDelayText(delay), first);
  }
  reset(): void {clearTimeout(this.timer); this.timer = undefined; this.level = 0;}
  close(): void {this.reset();}
}
