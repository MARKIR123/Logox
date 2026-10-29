import {readFileSync} from 'node:fs';
import {z} from 'zod';

/** Public semantic contract. RGB values belong exclusively to palette/profile data. */
export const themeColorKeys = [
  'bg', 'surface', 'fg', 'muted', 'strong', 'accent', 'system', 'user', 'line',
  'success', 'warning', 'error', 'selectionBg', 'selectionFg',
  'toolExpanded', 'cardBase', 'cardCollapsed', 'cardExpanded',
  'dreamCollapsed', 'dreamExpanded', 'anamnesis', 'dreamText', 'dreamMuted',
  'borderMuted', 'question', 'diffAdded', 'diffAddedBg', 'diffAddedGutter',
  'diffRemoved', 'diffRemovedBg', 'diffRemovedGutter', 'diffContext',
  'checkedFg', 'panelSeparator', 'panelLabel', 'actorPillBg', 'actorPillFg',
  'effortOff', 'effortLow', 'effortMedium', 'effortHigh', 'effortMax', 'effortAuto',
  'permissionDefault', 'permissionAuto', 'permissionCreative', 'directorIntervention',
  'automa', 'oauthBg', 'oauthFg', 'oauthSuccess',
] as const;
export type ThemeColorKey = typeof themeColorKeys[number];
export type ThemePalette = Record<ThemeColorKey, string>;
export type ThemeDefinitions = Partial<Record<ThemeColorKey, string>>;
export type ThemeOverrides = ThemeDefinitions & {dream_collapsed?: string; dream_expanded?: string};
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const themeColorValueSchema = z.string().regex(/^(?:#[0-9a-fA-F]{6}|\$[a-zA-Z][a-zA-Z0-9]*)$/);
const colorKeys = new Set<string>(themeColorKeys);
export function isThemeColorKey(key: string): boolean {
  return colorKeys.has(key) || key === 'dream_collapsed' || key === 'dream_expanded';
}
export function canonicalColorKey(key: string): string {
  return key === 'dream_collapsed' ? 'dreamCollapsed' : key === 'dream_expanded' ? 'dreamExpanded' : key;
}

const root = z.strictObject({colors: z.record(z.string(), themeColorValueSchema)})
  .parse(JSON.parse(readFileSync(new URL('./themes/logox-dark.json', import.meta.url), 'utf8')));
for (const key of Object.keys(root.colors)) {
  if (!colorKeys.has(key)) throw new Error('Unknown default theme color: ' + key);
}
for (const key of themeColorKeys) {
  if (!Object.hasOwn(root.colors, key)) throw new Error('Missing default theme color: ' + key);
}
const defaultDefinitions = Object.freeze(root.colors);

/** Resolve aliases after all overlays: changing one base color updates its dependants. */
export function resolveThemeColors(overrides: ThemeOverrides = {}): ThemePalette {
  const definitions: Record<string, string> = {...defaultDefinitions};
  for (const [key, value] of Object.entries(overrides)) {
    if (isThemeColorKey(key) && value !== undefined) definitions[canonicalColorKey(key)] = themeColorValueSchema.parse(value);
  }
  const resolved: Partial<ThemePalette> = {}, resolving = new Set<string>();
  const resolve = (key: string): string => {
    if (!colorKeys.has(key)) throw new Error('Unknown theme color reference: ' + key);
    const typedKey = key as ThemeColorKey;
    if (resolved[typedKey]) return resolved[typedKey]!;
    if (resolving.has(key)) throw new Error('Circular theme color reference: ' + key);
    resolving.add(key);
    const value = definitions[key]!;
    const color = value.startsWith('$') ? resolve(value.slice(1)) : hexColorSchema.parse(value);
    resolved[typedKey] = color; resolving.delete(key);
    return color;
  };
  for (const key of themeColorKeys) resolve(key);
  return resolved as ThemePalette;
}
export const defaultPalette: Readonly<ThemePalette> = Object.freeze(resolveThemeColors());
/** Stable object identity lets both Ink and non-React renderers read live theme values. */
export const palette: ThemePalette = {...defaultPalette};
let revision = 0;
export function themeRevision(): number {return revision;}
export function applyTheme(overrides?: ThemeOverrides): ThemePalette {
  // Resolve before mutating; invalid overlays cannot leave a half-applied palette.
  Object.assign(palette, resolveThemeColors(overrides));
  revision++;
  return palette;
}
