// Compatibility facade. Theme resolution is renderer-independent and color values are data.
// Actor identities/card surfaces remain owned by their profiles, not the system theme.
export {
  palette, applyTheme, isThemeColorKey,
  type ThemePalette, type ThemeOverrides,
} from '../../config/theme-palette.js';
