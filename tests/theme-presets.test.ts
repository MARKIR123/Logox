import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyThemePreset, cursorEscapes, applyCursorStyle, DEFAULT_THEME, listThemes, loadThemePresets, resolveTheme, themeIssues} from '../src/config/theme-presets.js';
import {applyTheme, defaultPalette, palette, resolveThemeColors, themeColorKeys} from '../src/config/theme-palette.js';

// Captured from the old logox-dark root plus the complete mist-dark overlay before migration.
// This is a fixed appearance/alias contract, not an expectation derived from current shipped data.
const mergedDefinitions = {
  bg: '#1C2330', surface: '#242B3A', fg: '#E8E6E0', muted: '#8D95A6', strong: '#ffffff',
  accent: '#7DA1DE', system: '$muted', user: '#D77757', line: '#333B4A',
  success: '#7ee7c4', warning: '#e5b567', error: '#DA8A93', selectionBg: '#3B4A66', selectionFg: '$fg',
  toolExpanded: '$surface', cardBase: '#242B3A', cardCollapsed: '#242B3A', cardExpanded: '#2C3548',
  dreamCollapsed: '#C9D3E4', dreamExpanded: '#E4EAF5', anamnesis: '#C9D7F2', dreamText: '#22262E', dreamMuted: '#55606F',
  borderMuted: '#3E4758', question: '#B3A0D4', diffAdded: '#82B89D', diffAddedBg: '#27392C', diffAddedGutter: '#57956B',
  diffRemoved: '#DA8A93', diffRemovedBg: '#3E2A2C', diffRemovedGutter: '#B26671', diffContext: '#7A8694',
  checkedFg: '$strong', panelSeparator: '#555555', panelLabel: '#888888', actorPillBg: '#3e4450', actorPillFg: '$strong',
  effortOff: '#8b949e', effortLow: '#7ee7c4', effortMedium: '#5282b5', effortHigh: '#d97757', effortMax: '#e8a8dc', effortAuto: '#e5b567',
  permissionDefault: '#a8adb5', permissionAuto: '#70b7ff', permissionCreative: '#d49aff', directorIntervention: '#d97757',
  automa: '#8a95a0', oauthBg: '#18181b', oauthFg: '#f4f4f5', oauthSuccess: '$success',
};
const mergedPalette = {
  ...mergedDefinitions,
  system: '#8D95A6', selectionFg: '#E8E6E0', toolExpanded: '#242B3A', checkedFg: '#ffffff',
  actorPillFg: '#ffffff', oauthSuccess: '#7ee7c4',
};
const builtinNames = ['logox-dark', 'claude-warm', 'monokai-pro', 'nord-polar', 'tokyo-night'];
const legacyNames = ['mist-dark', 'Mist Dark', 'mist_dark'];

function withThemeHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'logox-test-themes-'));
  const previous = {...palette};
  try {
    loadThemePresets(home);
    run(home);
  } finally {
    loadThemePresets(join(home, 'empty'));
    applyTheme(previous);
    rmSync(home, {recursive: true, force: true});
  }
}

function userThemeDir(home: string): string {
  const dir = join(home, '.logox', 'themes');
  mkdirSync(dir, {recursive: true});
  return dir;
}

test('exactly five shipped themes load with logox-dark first and valid colors', () => withThemeHome(home => {
  const themes = loadThemePresets(home);
  assert.equal(DEFAULT_THEME, 'logox-dark');
  assert.deepEqual(themes.map(theme => theme.name), builtinNames);
  assert.deepEqual(listThemes().map(theme => theme.name), builtinNames);
  assert.equal(existsSync(new URL('../src/config/themes/mist-dark.json', import.meta.url)), false);
  for (const theme of themes) {
    for (const [key, color] of Object.entries(theme.colors)) {
      assert.match(color, /^(?:#[0-9a-fA-F]{6}|\$[a-zA-Z][a-zA-Z0-9]*)$/, theme.name + '.' + key);
    }
    const resolved = applyThemePreset(theme.name);
    for (const [key, color] of Object.entries(resolved)) assert.match(color, /^#[0-9a-fA-F]{6}$/, theme.name + '.' + key);
    if (theme.name !== DEFAULT_THEME) {
      assert.equal(theme.base, DEFAULT_THEME);
      assert.deepEqual(resolved, resolveThemeColors({...mergedDefinitions, ...theme.colors}));
      assert.equal(resolved.cardExpanded, mergedPalette.cardExpanded, 'Unspecified tokens inherit the merged root');
    }
  }
}));

test('merged logox-dark preserves all 51 old mist colors and alias definitions without a root base', () => withThemeHome(() => {
  const data = JSON.parse(readFileSync(new URL('../src/config/themes/logox-dark.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(data), ['colors']);
  assert.equal(Object.keys(mergedDefinitions).length, 51);
  assert.deepEqual(Object.keys(mergedDefinitions).sort(), [...themeColorKeys].sort());
  assert.deepEqual(data.colors, mergedDefinitions);
  assert.deepEqual(defaultPalette, mergedPalette);
  assert.deepEqual(applyThemePreset(DEFAULT_THEME), mergedPalette);
  assert.deepEqual(applyThemePreset('unknown-theme'), mergedPalette);
  applyTheme({muted: '#102030', fg: '#203040', surface: '#304050', strong: '#405060', success: '#506070', cardBase: '#607080'});
  assert.equal(palette.system, '#102030');
  assert.equal(palette.selectionFg, '#203040');
  assert.equal(palette.toolExpanded, '#304050');
  assert.equal(palette.checkedFg, '#405060');
  assert.equal(palette.actorPillFg, '#405060');
  assert.equal(palette.oauthSuccess, '#506070');
  assert.equal(palette.cardCollapsed, '#242B3A', 'The old mist explicit card color is not a new alias');
}));

test('legacy selections resolve to the merged default without adding a preset', () => withThemeHome(() => {
  assert.equal(resolveTheme('Logox Dark')?.name, DEFAULT_THEME);
  for (const name of legacyNames) {
    assert.equal(resolveTheme(name)?.name, DEFAULT_THEME, name);
    assert.deepEqual(applyThemePreset(name), mergedPalette, name);
  }
  assert.equal(resolveTheme('nope'), undefined);
  assert.deepEqual(listThemes().map(theme => theme.name), builtinNames);
}));

test('legacy base aliases inherit the merged default and resolve color references after child overlays', () => withThemeHome(home => {
  const dir = userThemeDir(home);
  for (const [index, base] of legacyNames.entries()) {
    writeFileSync(join(dir, 'legacy-child-' + index + '.json'), JSON.stringify({base, colors: {fg: '#102030', panelLabel: '$muted'}}));
  }
  const themes = loadThemePresets(home);
  assert.deepEqual(themeIssues(), []);
  assert.equal(themes.some(theme => theme.name === 'mist-dark'), false);
  for (const index of legacyNames.keys()) {
    assert.deepEqual(applyThemePreset('legacy-child-' + index), {...mergedPalette, fg: '#102030', selectionFg: '#102030', panelLabel: '#8D95A6'});
  }
}));

test('real user mist-dark files beat compatibility aliases and remain byte-for-byte unchanged', () => withThemeHome(home => {
  const dir = userThemeDir(home), path = join(dir, 'mist-dark.json');
  const bytes = Buffer.from('{\r\n  "base": "logox-dark",\r\n  "colors": {"accent": "#112233", "fg": "#F0F0F0"}\r\n}\r\n');
  writeFileSync(path, bytes);
  for (const [index, base] of legacyNames.entries()) {
    writeFileSync(join(dir, 'my-night-' + index + '.json'), JSON.stringify({base, colors: {muted: '#304050'}}));
  }
  const themes = loadThemePresets(home);
  assert.ok(themes.some(theme => theme.name === 'mist-dark'), 'A real user theme remains selectable');
  assert.deepEqual(themeIssues(), []);
  for (const name of legacyNames) {
    assert.equal(resolveTheme(name)?.name, 'mist-dark', name);
    assert.equal(applyThemePreset(name).accent, '#112233', name);
  }
  for (const index of legacyNames.keys()) {
    assert.deepEqual(applyThemePreset('my-night-' + index), {...mergedPalette, accent: '#112233', fg: '#F0F0F0', selectionFg: '#F0F0F0', muted: '#304050', system: '#304050'});
  }
  assert.equal(applyThemePreset(DEFAULT_THEME).accent, '#7DA1DE', 'Legacy user data does not overwrite the canonical default');
  assert.deepEqual(readFileSync(path), bytes);
}));

test('broken user legacy themes fall back to the merged default and preserve their children and bytes', () => withThemeHome(home => {
  const dir = userThemeDir(home), path = join(dir, 'mist-dark.json');
  for (const [index, base] of legacyNames.entries()) {
    writeFileSync(join(dir, 'a-child-' + index + '.json'), JSON.stringify({base, colors: {accent: '#123456'}}));
  }
  for (const broken of ['{not json', '{"colors":{"accent":"blue"}}', '{"base":"missing-parent"}', '{"colors":{"fg":"$notAColor"}}', '{"colors":{"fg":"$muted","muted":"$fg"}}']) {
    writeFileSync(path, broken);
    const themes = loadThemePresets(home);
    assert.equal(themes.some(theme => theme.name === 'mist-dark'), false, broken);
    assert.ok(themeIssues().some(issue => issue.file === path), broken);
    for (const name of legacyNames) {
      assert.equal(resolveTheme(name)?.name, DEFAULT_THEME, name);
      assert.deepEqual(applyThemePreset(name), mergedPalette, name);
    }
    for (const index of legacyNames.keys()) {
      assert.ok(themes.some(theme => theme.name === 'a-child-' + index), broken);
      assert.deepEqual(applyThemePreset('a-child-' + index), {...mergedPalette, accent: '#123456'});
    }
    assert.equal(readFileSync(path, 'utf8'), broken);
  }
}));

test('broken user theme files are skipped instead of aborting startup', () => withThemeHome(home => {
  const dir = userThemeDir(home);
  writeFileSync(join(dir, 'broken.json'), '{not json');
  writeFileSync(join(dir, 'bad-color.json'), JSON.stringify({colors: {accent: 'blue'}}));
  const themes = loadThemePresets(home);
  assert.ok(!themes.some(theme => theme.name === 'broken'));
  assert.ok(!themes.some(theme => theme.name === 'bad-color'));
  assert.ok(themeIssues().length >= 2);
}));

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
