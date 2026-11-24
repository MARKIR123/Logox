import {palette} from './theme.js';
import {activeTheme} from '../../config/theme-palette.js';
import {themeBackgroundEnabled, toolTintScale, uiSettings} from '../../config/ui-settings.js';
import {isDirector} from '../../runtime/director-id.js';

/** Background colour painted across the terminal canvas, or `undefined` to leave the terminal transparent. */
export function canvasBg(): string | undefined {
  return themeBackgroundEnabled(activeTheme(), palette.bg) ? palette.bg : undefined;
}

export function windowAccent(ownerId: string, actorColor?: string): string {
  return isDirector(ownerId) ? palette.accent : actorColor ?? palette.accent;
}

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
export function mixHex(fgHex: string, bgHex = palette.cardBase, ratio = 0.22): string {
  const [fr, fg, fb] = parseHex(fgHex), [br, bg, bb] = parseHex(bgHex);
  const channel = (f: number, b: number) => Math.max(0, Math.min(255, Math.round(b + (f - b) * ratio))).toString(16).padStart(2, '0');
  return `#${channel(fr, br)}${channel(fg, bg)}${channel(fb, bb)}`;
}

/** Share of the speaker color the quiet `│ ` rail keeps; the rest mixes into the background. */
export const QUIET_RAIL = 0.55;
export const quietRail = (color: string): string => mixHex(color, palette.bg, QUIET_RAIL);
/** Faint text: muted mixed toward the background (line numbers, durations, overflow hints). */
export const faintColor = (): string => mixHex(palette.muted, palette.bg, 0.6);
/** The border of a task-sidebar card at rest: the owner colour mixed toward the background (hover lifts it to the full owner colour). */
export const frameColor = (color: string): string => /^#[\da-f]{6}$/i.test(color) ? mixHex(color, palette.bg, 0.5) : color;
/** Mix share of the owner color per nesting depth: depth 1 is a block on the surface, deeper blocks step up so a child stays distinguishable from its parent. */
export const TINT_STEPS: readonly number[] = [0.06, 0.11, 0.16];
/** Expanded-card tint: the owning actor color mixed into the background by nesting depth (1 = outermost open card); background color only ever means "expanded". */
/** `Tool card tint` in /settings scales the steps: none keeps the surface colour, subtle halves them, standard is the stock tint. */
export const expandedTint = (ownerColor: string, depth = 1): string =>
  mixHex(ownerColor, palette.bg, TINT_STEPS[Math.min(Math.max(1, depth), TINT_STEPS.length) - 1]! * toolTintScale[uiSettings().toolTint]);
