import type {Step} from '../../runtime/contracts.js';
import {stepElapsed} from '../../runtime/steps.js';

const dots = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function thinkingDuration(step: Step, now: number): string {
  const seconds = stepElapsed(step, now) / 1000;
  return ['completed', 'failed', 'cancelled'].includes(step.state) ? Math.round(seconds) + 's' : (seconds.toFixed(1) + 's').padEnd(7).slice(0, 7);
}
export function stepIcon(step: Step, now: number, motion: boolean, frames?: readonly string[]): string {
  const activeFrames = frames && frames.length ? frames : dots;
  const interval = activeFrames.length <= 8 ? 200 : 130;
  return step.state === 'running' && motion ? activeFrames[Math.floor(now / interval) % activeFrames.length]! : step.state === 'running' ? '·' : step.state === 'waiting' ? '○' : step.state === 'queued' ? '◦' : '▮';
}
export function stepStatus(step: Step, now: number): string {
  const seconds = stepElapsed(step, now) / 1000;
  const duration = (seconds < 60 ? seconds.toFixed(1) + 's' : Math.floor(seconds / 60) + 'm' + String(Math.floor(seconds % 60)).padStart(2, '0') + 's').padStart(7).slice(-7);
  const state = step.state === 'waiting' ? step.waiting ?? 'Waiting' : step.state === 'queued' ? 'Queued' : step.state === 'cancelled' ? 'Cancelled' : '';
  return duration + (state ? ' ' + state : '');
}

/** Width of the live elapsed slot on swarm job rows; the slot is padded so the row never changes length. */
export const SWARM_TIME_WIDTH = 6;
export function swarmElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return (s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm' + String(Math.floor(s % 60)).padStart(2, '0') + 's').padEnd(SWARM_TIME_WIDTH).slice(0, SWARM_TIME_WIDTH);
}

/** A card subtitle's clock stays blank until the work has run this long, so quick calls do not flash a time. */
export const SUBTITLE_CLOCK_AFTER_MS = 1000;
/** ` · ` plus the padded elapsed slot: the live clock after a card subtitle never changes the row's length. */
export const SUBTITLE_CLOCK_WIDTH = 3 + SWARM_TIME_WIDTH;
export function subtitleClock(ms: number): string {
  return ms < SUBTITLE_CLOCK_AFTER_MS ? ' '.repeat(SUBTITLE_CLOCK_WIDTH) : ' · ' + swarmElapsed(ms);
}
