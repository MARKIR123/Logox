import test from 'node:test';
import assert from 'node:assert/strict';
import {saveConfigToggles} from '../src/application-commands.js';
import {palette} from '../src/tui/cards.js';
import {themePresets} from '../src/config/theme-presets.js';

test('saveConfigToggles applies theme preset and motion in real time', async () => {
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
  assert.equal(palette.accent, themePresets['Claude Warm'].accent);
  assert.equal(savedMotion, false);
  assert.ok(written.includes('\x1b[2 q'), 'Block cursor escape code emitted');

  // Restore Logox Dark
  await saveConfigToggles([
    {id: 'theme', value: 'Logox Dark', enabled: true},
    {id: 'cursor', value: 'Block █', enabled: true},
    {id: 'motion', enabled: true},
  ], {saveMotion: async () => {}, stdout: mockStdout as any});
  assert.equal(palette.accent, themePresets['Logox Dark'].accent);
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
