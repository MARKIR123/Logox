import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {applyTheme, isThemeColorKey, canonicalColorKey, resolveThemeColors, themeColorValueSchema, type ThemeOverrides, type ThemePalette} from './theme-palette.js';

/**
 * Theme palettes are data, not code: shipped JSON lives in `src/config/themes/`
 * and users overlay their own files from `~/.logox/themes/`.
 */
export const DEFAULT_THEME = 'logox-dark';

const themeFileSchema = z.strictObject({
  base: z.string().min(1).optional(),
  colors: z.record(z.string(), themeColorValueSchema).default({}),
});

export interface ThemeFile {
  readonly name: string;
  readonly base?: string;
  readonly colors: Readonly<Record<string, string>>;
}

export interface ThemeIssue {readonly file: string; readonly message: string;}

export type CursorStyleName = 'Block █' | 'Underline _' | 'Bar |';

const issues: ThemeIssue[] = [];

/** Bad user theme files never abort startup; this reports what was skipped. */
export function themeIssues(): readonly ThemeIssue[] {
  return issues;
}

const builtinDir = () => fileURLToPath(new URL('./themes/', import.meta.url));

let registry: Map<string, ThemeFile> | undefined;

/** Keep old selections/bases working without publishing a duplicate built-in preset. */
function lookupTheme(themes: ReadonlyMap<string, ThemeFile>, name: string): ThemeFile | undefined {
  const normalized = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return themes.get(name) ?? themes.get(normalized)
    ?? (normalized === 'mist-dark' ? themes.get(DEFAULT_THEME) : undefined);
}

function readDirectory(dir: string, strict: boolean): Map<string, ThemeFile> {
  const themes = new Map<string, ThemeFile>();
  if (!existsSync(dir)) return themes;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(dir, entry.name), name = entry.name.slice(0, -'.json'.length);
    try {
      const parsed = themeFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      const colors: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.colors)) {
        if (!isThemeColorKey(key)) {
          issues.push({file: path, message: 'unknown color key: ' + key});
          continue;
        }
        colors[canonicalColorKey(key)] = value;
      }
      themes.set(name, {name, ...(parsed.base ? {base: parsed.base} : {}), colors});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (strict) throw new Error('Invalid built-in theme ' + path + ': ' + message);
      issues.push({file: path, message});
    }
  }
  return themes;
}

/**
 * Ship order: the shipped themes first (alphabetical), then the default theme a
 * user file may override. Re-reading is cheap and keeps the registry honest.
 */
export function loadThemePresets(home: string = homedir()): readonly ThemeFile[] {
  issues.length = 0;
  const builtins = readDirectory(builtinDir(), true);
  for (const theme of builtins.values()) resolveThemeColors(flatten(theme, builtins));
  const users = readDirectory(join(home, '.logox', 'themes'), false);
  const themes = new Map([...builtins, ...users]);
  // Validate parents first, including user overrides reached through shipped bases.
  // A child must see a parent's shipped fallback, not be discarded for its bad override.
  const ordered: string[] = [], visited = new Set<string>();
  const orderParentsFirst = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    // A removed legacy-name override reveals the canonical default, whose own
    // user override must be validated before any descendant sees that fallback.
    const fallback = lookupTheme(builtins, name);
    for (const base of [themes.get(name)?.base, fallback?.base, fallback && fallback.name !== name ? fallback.name : undefined]) {
      const parent = base ? lookupTheme(themes, base) : undefined;
      if (parent) orderParentsFirst(parent.name);
    }
    if (users.has(name)) ordered.push(name);
  };
  for (const name of users.keys()) orderParentsFirst(name);
  for (let pass = 0; pass <= users.size; pass++) {
    let changed = false;
    for (const name of ordered) {
      const theme = themes.get(name);
      if (!theme || theme === builtins.get(name)) continue;
      try {resolveThemeColors(flatten(theme, themes));}
      catch (error) {
        issues.push({file: join(home, '.logox', 'themes', name + '.json'), message: error instanceof Error ? error.message : 'Invalid theme references'});
        const builtin = builtins.get(name);
        if (builtin) themes.set(name, builtin); else themes.delete(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  registry = themes;
  const names = [...themes.keys()].sort((a, b) => a === DEFAULT_THEME ? -1 : b === DEFAULT_THEME ? 1 : a.localeCompare(b));
  return names.map(name => themes.get(name)!);
}

export function listThemes(): readonly ThemeFile[] {
  return registry ? [...registry.values()].sort((a, b) => a.name === DEFAULT_THEME ? -1 : b.name === DEFAULT_THEME ? 1 : a.name.localeCompare(b.name)) : loadThemePresets();
}

/**
 * Resolve a selection to a theme file. Persisted preferences may still carry an
 * older display name or the retired `mist-dark` preset. Real user files win over aliases.
 */
export function resolveTheme(name: string): ThemeFile | undefined {
  if (!registry) loadThemePresets();
  return lookupTheme(registry!, name);
}

/** `base` chains are flattened root-first so a file only lists its own deltas. */
function flatten(theme: ThemeFile, themes = registry!): ThemeOverrides {
  const chain: ThemeFile[] = [], seen = new Set<string>();
  let current: ThemeFile | undefined = theme;
  while (current) {
    if (seen.has(current.name)) throw new Error('Circular theme inheritance: ' + current.name);
    if (chain.length >= 16) throw new Error('Theme inheritance exceeds 16 levels: ' + theme.name);
    seen.add(current.name); chain.unshift(current);
    if (!current.base) break;
    const base: string = current.base;
    current = lookupTheme(themes, base);
    if (!current) throw new Error('Unknown base theme: ' + base);
  }
  const merged: Record<string, string> = {};
  for (const item of chain) Object.assign(merged, item.colors);
  return merged as ThemeOverrides;
}

export function applyThemePreset(name: string): ThemePalette {
  const theme = resolveTheme(name);
  return theme ? applyTheme(flatten(theme)) : applyTheme();
}

export const cursorEscapes: Record<CursorStyleName, string> = {
  'Block █': '\x1b[2 q',
  'Underline _': '\x1b[4 q',
  'Bar |': '\x1b[6 q',
};

export function applyCursorStyle(name: CursorStyleName, stream: {write(data: string): void} = process.stdout): void {
  const esc = cursorEscapes[name];
  if (esc && stream && typeof stream.write === 'function') {
    stream.write(esc);
  }
}
