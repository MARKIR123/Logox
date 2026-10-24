import test from 'node:test';
import assert from 'node:assert/strict';
import {themePresets, applyThemePreset, cursorEscapes, applyCursorStyle, type ThemePresetName} from '../src/config/theme-presets.js';
import {palette} from '../src/tui/cards.js';

test('themePresets defines 5 curated themes with valid hex colors', () => {
  const names: ThemePresetName[] = ['Logox Dark', 'Claude Warm', 'Nord Polar', 'Monokai Pro', 'Tokyo Night'];
  for (const name of names) {
    const theme = themePresets[name];
    assert.ok(theme, `Theme ${name} must exist`);
    assert.match(theme.accent, /^#[0-9a-fA-F]{6}$/);
    assert.match(theme.user, /^#[0-9a-fA-F]{6}$/);
  }
});

test('applyThemePreset updates palette colors in real time', () => {
  applyThemePreset('Tokyo Night');
  assert.equal(palette.accent, themePresets['Tokyo Night'].accent);
  assert.equal(palette.user, themePresets['Tokyo Night'].user);
  // Restore default
  applyThemePreset('Logox Dark');
  assert.equal(palette.accent, themePresets['Logox Dark'].accent);
});

test('cursorEscapes provides correct ANSI DECSCUSR sequences', () => {
  assert.equal(cursorEscapes['Block █'], '\x1b[2 q');
  assert.equal(cursorEscapes['Underline _'], '\x1b[4 q');
  assert.equal(cursorEscapes['Bar |'], '\x1b[6 q');
});

test('applyCursorStyle writes escape sequence to stream', () => {
  let output = '';
  const mockStream = {write: (chunk: string) => { output += chunk; return true; }};
  applyCursorStyle('Underline _', mockStream as any);
  assert.equal(output, '\x1b[4 q');
});
