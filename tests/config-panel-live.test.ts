import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {palette} from '../src/tui/appearance/theme.js';
import {applyThemePreset, applyCursorStyle, loadThemePresets, resolveTheme} from '../src/config/theme-presets.js';

test('theme presets apply to the live palette and revert to the default', async t => {
  const home = mkdtempSync(join(tmpdir(), 'logox-test-themes-'));
  t.after(() => {
    loadThemePresets(join(home, 'empty'));
    rmSync(home, {recursive: true, force: true});
  });
  loadThemePresets(home);
  applyThemePreset('Claude Warm');
  assert.equal(palette.user, resolveTheme('claude-warm')?.colors.user);
  applyThemePreset('Logox Dark');
  assert.equal(palette.accent, '#7DA1DE');
});

test('cursor styles write their DECSCUSR escape codes', () => {
  let written = '';
  const stdout = {write: (data: string) => {written += data;}};
  applyCursorStyle('Block █', stdout);
  assert.equal(written, '\x1b[2 q');
  written = '';
  applyCursorStyle('Underline _', stdout);
  assert.equal(written, '\x1b[4 q');
  written = '';
  applyCursorStyle('Bar |', stdout);
  assert.equal(written, '\x1b[6 q');
});
