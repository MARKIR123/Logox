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
  const state = step.state === 'waiting' ? step.waiting ?? '等待中' : step.state === 'queued' ? '排队中' : step.state === 'cancelled' ? '已取消' : '';
  return duration + (state ? ' ' + state : '');
}
