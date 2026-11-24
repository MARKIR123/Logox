// The composer's chrome (the two rules and the prompt marker) fades to a muted tone when the composer loses the keyboard (a card, a prompt,
// the sidebar, a page) or the terminal window loses focus, and wakes up to its full colour when it regains it. The typed text never fades.
// Each piece owns its own fade state and ticks only itself while the fade runs, so a transition re-renders just these rows, not `App`.
import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Box, Text} from 'ink';
import {mixHex} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import {subscribeTerminalFocus, terminalFocus} from '../terminal/focus.js';
import {glowStep, type GlowState} from '../timeline/timeline-overlay.js';

/** Fade length: a little slower than a hover so it reads as waking up. */
export const COMPOSER_FADE_MS = 220;
const TICK_MS = 40;

/** The dim end of the fade: the active colour mixed most of the way into the background. */
export const fadedColor = (color: string, level: number): string => mixHex(color, mixHex(color, palette.bg, 0.4), level);

/** Eased level 0 (dim) to 1 (active) following `active` and the terminal's own focus (no report counts as focused); immediate without motion. */
export function useComposerFade(active: boolean, motion: boolean): number {
  const windowFocused = useSyncExternalStore(subscribeTerminalFocus, () => terminalFocus() !== false);
  const wanted = active && windowFocused;
  const state = useRef<GlowState | undefined>(undefined);
  if (!state.current) state.current = {from: wanted ? 1 : 0, to: wanted ? 1 : 0, since: -Infinity};
  const [, tick] = useState(0);
  const step = glowStep(state.current, wanted, Date.now(), motion, COMPOSER_FADE_MS);
  state.current = step.state;
  useEffect(() => {
    if (!step.busy) return;
    const timer = setTimeout(() => tick(count => count + 1), TICK_MS);
    return () => clearTimeout(timer);
  });
  return step.level;
}

/** One hairline above or below the composer. */
export function ComposerRule({color, width, active, motion}: {color: string; width: number; active: boolean; motion: boolean}) {
  const level = useComposerFade(active, motion);
  return <Box height={1} flexShrink={0}><Text color={fadedColor(color, level)} wrap="truncate">{'─'.repeat(width)}</Text></Box>;
}
