import type {ThemePalette} from './theme-palette.js';

/**
 * Legibility of a theme as plain numbers: WCAG 2.x contrast ratios of the pairs the interface really draws, and the semantic
 * colours that sit so close in hue that they are easy to mistake for each other. Pure functions of hex strings and a palette;
 * the `/theme` page shows the result next to its live sample.
 */

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = channels(hex).map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio, 1 to 21; symmetric in its arguments. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Hue in degrees [0, 360); `undefined` for greys, whose hue means nothing. */
export function hueOf(hex: string): number | undefined {
  const [red, green, blue] = channels(hex).map(channel => channel / 255) as [number, number, number];
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), chroma = max - min;
  if (chroma < 0.08) return undefined;
  const hue = max === red ? ((green - blue) / chroma) % 6 : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  return (hue * 60 + 360) % 360;
}

/** Shortest angular distance between two hues, 0 to 180. */
export function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

export const TEXT_CONTRAST = 4.5;
export const GRAPHIC_CONTRAST = 3.0;
/** Two semantic colours closer than this many degrees of hue are reported as confusable. */
export const CONFUSABLE_HUE = 20;

export interface LegibilityPair {
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly threshold: number;
  readonly ok: boolean;
}
export interface ConfusablePair {readonly a: string; readonly b: string; readonly distance: number}
export interface LegibilityReport {
  readonly pairs: readonly LegibilityPair[];
  /** Number of pairs below their threshold. */
  readonly failing: number;
  readonly confusable: readonly ConfusablePair[];
  /** `Legible`, or `<n> below threshold`. */
  readonly summary: string;
}

type Tokens = Readonly<Record<string, string>>;
const pairSpecs: readonly (readonly [label: string, foreground: keyof ThemePalette, background: keyof ThemePalette, threshold: number])[] = [
  ['text', 'fg', 'bg', TEXT_CONTRAST],
  ['muted', 'muted', 'bg', TEXT_CONTRAST],
  ['muted on card', 'muted', 'cardExpanded', TEXT_CONTRAST],
  ['text on card', 'fg', 'cardExpanded', TEXT_CONTRAST],
  ['dream text', 'dreamText', 'dreamCollapsed', TEXT_CONTRAST],
  ['dream muted', 'dreamMuted', 'dreamCollapsed', TEXT_CONTRAST],
  ['selection', 'selectionFg', 'selectionBg', TEXT_CONTRAST],
  ['diff +', 'diffAdded', 'diffAddedBg', GRAPHIC_CONTRAST],
  ['diff −', 'diffRemoved', 'diffRemovedBg', GRAPHIC_CONTRAST],
  ['border', 'borderMuted', 'bg', GRAPHIC_CONTRAST],
];
/** The semantic colours that carry meaning by hue alone. */
export const semanticTokens = ['accent', 'user', 'success', 'warning', 'error', 'question', 'link'] as const;

export function legibilityPairs(tokens: Tokens): LegibilityPair[] {
  return pairSpecs.map(([label, foreground, background, threshold]) => {
    const ratio = contrastRatio(tokens[foreground]!, tokens[background]!);
    return {label, foreground: tokens[foreground]!, background: tokens[background]!, ratio, threshold, ok: ratio >= threshold};
  });
}

/** Every pair of the named colours whose hues differ by less than `CONFUSABLE_HUE` degrees, in the order the names are given. */
export function confusablePairs(tokens: Tokens, names: readonly string[] = semanticTokens): ConfusablePair[] {
  const found: ConfusablePair[] = [];
  names.forEach((a, index) => {
    for (const b of names.slice(index + 1)) {
      const hueA = hueOf(tokens[a]!), hueB = hueOf(tokens[b]!);
      if (hueA === undefined || hueB === undefined) continue;
      const distance = hueDistance(hueA, hueB);
      if (distance < CONFUSABLE_HUE) found.push({a, b, distance});
    }
  });
  return found;
}

export function legibilityReport(tokens: Tokens): LegibilityReport {
  const pairs = legibilityPairs(tokens), failing = pairs.filter(pair => !pair.ok).length;
  return {pairs, failing, confusable: confusablePairs(tokens), summary: failing === 0 ? 'Legible' : failing + ' below threshold'};
}
