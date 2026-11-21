import {palette} from './theme.js';
import {toolTintScale, uiSettings} from '../../config/ui-settings.js';
import {isDirector} from '../../runtime/director-id.js';

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
/**
 * The background of a task-sidebar card cell: at rest a faint share of the foreground mixed into the background, hovered and selected a deeper share of the
 * accent. Only the resting tint follows `Tool card tint` (none = no fill); a hover or selection always shows. Derived from palette tokens only, so every theme
 * works; a palette that is not 6-digit hex (nothing to mix) gets no tint.
 */
export const CARD_TINT = {rest: 0.07, hover: 0.15, selected: 0.22} as const;
export function cardTint(state: keyof typeof CARD_TINT): string | undefined {
  const hex = /^#[\da-f]{6}$/i;
  if (!hex.test(palette.bg) || !hex.test(palette.fg) || !hex.test(palette.accent)) return undefined;
  if (state === 'rest') {
    const scale = toolTintScale[uiSettings().toolTint];
    return scale > 0 ? mixHex(palette.fg, palette.bg, CARD_TINT.rest * scale) : undefined;
  }
  return mixHex(palette.accent, palette.bg, CARD_TINT[state]);
}
/** The owner colour of a card's left bar, lifted toward the strong text colour while hovered. */
export const brightBar = (color: string): string => /^#[\da-f]{6}$/i.test(color) && /^#[\da-f]{6}$/i.test(palette.strong) ? mixHex(palette.strong, color, 0.4) : color;
/** Mix share of the owner color per nesting depth: depth 1 is a block on the surface, deeper blocks step up so a child stays distinguishable from its parent. */
export const TINT_STEPS: readonly number[] = [0.06, 0.11, 0.16];
/** Expanded-card tint: the owning actor color mixed into the background by nesting depth (1 = outermost open card); background color only ever means "expanded". */
/** `Tool card tint` in /settings scales the steps: none keeps the surface colour, subtle halves them, standard is the stock tint. */
export const expandedTint = (ownerColor: string, depth = 1): string =>
  mixHex(ownerColor, palette.bg, TINT_STEPS[Math.min(Math.max(1, depth), TINT_STEPS.length) - 1]! * toolTintScale[uiSettings().toolTint]);
