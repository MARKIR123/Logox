import {applyTheme, type palette} from '../tui/cards.js';
import type {ThemeConfig} from './config.js';

export type ThemePresetName = 'Logox Dark' | 'Claude Warm' | 'Nord Polar' | 'Monokai Pro' | 'Tokyo Night';
export type CursorStyleName = 'Block █' | 'Underline _' | 'Bar |';

export const themePresets: Record<ThemePresetName, ThemeConfig> = {
  'Logox Dark': {
    user: '#5282b5',
    accent: '#d97757',
    dream_collapsed: '#c4cbd2',
    dream_expanded: '#dce2e8',
  },
  'Claude Warm': {
    user: '#e5b567',
    accent: '#d97757',
    dream_collapsed: '#e0d8cf',
    dream_expanded: '#f3ede7',
  },
  'Nord Polar': {
    user: '#81a1c1',
    accent: '#88c0d0',
    dream_collapsed: '#d8dee9',
    dream_expanded: '#eceff4',
  },
  'Monokai Pro': {
    user: '#a9dc76',
    accent: '#ffd866',
    dream_collapsed: '#727072',
    dream_expanded: '#fcfcfa',
  },
  'Tokyo Night': {
    user: '#7aa2f7',
    accent: '#f7768e',
    dream_collapsed: '#565f89',
    dream_expanded: '#c0caf5',
  },
};

export const cursorEscapes: Record<CursorStyleName, string> = {
  'Block █': '\x1b[2 q',
  'Underline _': '\x1b[4 q',
  'Bar |': '\x1b[6 q',
};

export function applyThemePreset(name: ThemePresetName): typeof palette {
  const theme = themePresets[name];
  if (!theme) return applyTheme();
  return applyTheme(theme);
}

export function applyCursorStyle(name: CursorStyleName, stream: {write(data: string): void} = process.stdout): void {
  const esc = cursorEscapes[name];
  if (esc && stream && typeof stream.write === 'function') {
    stream.write(esc);
  }
}
