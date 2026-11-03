import {palette} from './theme.js';

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
/** Expanded-card tint: the owning actor color mixed ~7% into the background; background color only ever means "expanded". */
export const expandedTint = (ownerColor: string): string => mixHex(ownerColor, palette.bg, 0.07);
