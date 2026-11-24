/**
 * Hover fades of the sidebar's "showcase" controls (header tabs, `×`, `+`, the toggle icon, team-stage actor cards): each control eases its hover level over
 * `FADE_MS` (`glowStep` of `timeline/timeline-overlay.ts`; without motion the level jumps). `FadeSet` keeps the levels of many keyed controls for the sidebar host;
 * `useHoverFade` is the component-local version for one control outside the plane (the footer toggle). Frequently clicked controls (timeline cards, list rows,
 * the feed) stay instant on purpose.
 */
import {useEffect, useRef, useState} from 'react';
import {mixHex} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import {glowStep, type GlowState} from '../timeline/timeline-overlay.js';

export const FADE_TICK_MS = 40;
/** `from` moved toward `to` by `level` 0..1. */
export const lerpColor = (from: string, to: string, level: number): string => level <= 0 ? from : level >= 1 ? to : mixHex(to, from, level);

/** The focus chrome eases a little slower than a hover (the composer's `COMPOSER_FADE_MS`). */
export const FOCUS_FADE_MS = 220;
/** The dim end of a focus fade: the colour mixed most of the way into the background (the composer's `fadedColor`, the rails' quiet level). */
export const dimmed = (color: string): string => mixHex(color, palette.bg, 0.55);

export class FadeSet {
  private states = new Map<string, GlowState>();
  private levels = new Map<string, number>();
  /** Moves every known control one step toward hovered (`hovered` keys) or rest; true while any still moves. */
  step(hovered: readonly string[], now: number, motion: boolean): boolean {
    let busy = false;
    const nextStates = new Map<string, GlowState>(), nextLevels = new Map<string, number>();
    for (const key of new Set([...this.states.keys(), ...hovered])) {
      const step = glowStep(this.states.get(key), hovered.includes(key), now, motion, key === 'focus' ? FOCUS_FADE_MS : undefined);
      busy ||= step.busy;
      if (step.level > 0 || step.busy) {nextStates.set(key, step.state); nextLevels.set(key, step.level);}
    }
    this.states = nextStates; this.levels = nextLevels;
    return busy;
  }
  level = (key: string): number => this.levels.get(key) ?? 0;
  /** Changes whenever a painted level changes (paint caches key on it). */
  signature(): string {return [...this.levels].map(([key, level]) => key + ':' + level.toFixed(2)).join('|');}
}

/** The eased hover level of one control, re-rendering only its own component while the fade runs. */
export function useHoverFade(hovered: boolean, motion: boolean): number {
  const state = useRef<GlowState | undefined>(undefined);
  const [, tick] = useState(0);
  const step = glowStep(state.current, hovered, Date.now(), motion);
  state.current = step.state;
  useEffect(() => {
    if (!step.busy) return;
    const timer = setTimeout(() => tick(count => count + 1), FADE_TICK_MS);
    return () => clearTimeout(timer);
  });
  return step.level;
}
