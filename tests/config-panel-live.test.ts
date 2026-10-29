import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveConfigToggles} from '../src/application-commands.js';
import {palette} from '../src/tui/appearance/theme.js';
import {loadThemePresets, resolveTheme} from '../src/config/theme-presets.js';

test('saveConfigToggles applies theme preset and motion in real time', async t => {
  const home = mkdtempSync(join(tmpdir(), 'logox-test-themes-'));
  t.after(() => {
    loadThemePresets(join(home, 'empty'));
    rmSync(home, {recursive: true, force: true});
  });
  loadThemePresets(home);
  const items = [
    {id: 'theme', value: 'Claude Warm', enabled: true},
    {id: 'cursor', value: 'Block █', enabled: true},
    {id: 'motion', enabled: false},
  ];
  let savedMotion: boolean | undefined;
  let written = '';
  const mockStdout = {write: (data: string) => { written += data; }};

  const result = await saveConfigToggles(items, {
    saveMotion: async m => { savedMotion = m; },
    stdout: mockStdout as any,
  });

  assert.equal(result.message, 'Settings saved.');
  assert.equal(palette.user, resolveTheme('claude-warm')?.colors.user);
  assert.equal(savedMotion, false);
  assert.ok(written.includes('\x1b[2 q'), 'Block cursor escape code emitted');

  // Restore Logox Dark
  await saveConfigToggles([
    {id: 'theme', value: 'Logox Dark', enabled: true},
    {id: 'cursor', value: 'Block █', enabled: true},
    {id: 'motion', enabled: true},
  ], {saveMotion: async () => {}, stdout: mockStdout as any});
  assert.equal(palette.accent, '#7DA1DE');
});

test('saveConfigToggles supports changing cursor to Underline and Bar', async () => {
  let written = '';
  const mockStdout = {write: (data: string) => { written += data; }};

  await saveConfigToggles([
    {id: 'cursor', value: 'Underline _', enabled: true},
  ], {saveMotion: async () => {}, stdout: mockStdout as any});
  assert.equal(written, '\x1b[4 q');

  written = '';
  await saveConfigToggles([
    {id: 'cursor', value: 'Bar |', enabled: true},
  ], {saveMotion: async () => {}, stdout: mockStdout as any});
  assert.equal(written, '\x1b[6 q');

  // Restore block
  await saveConfigToggles([
    {id: 'cursor', value: 'Block █', enabled: true},
  ], {saveMotion: async () => {}, stdout: mockStdout as any});
});
