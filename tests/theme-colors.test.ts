import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyTheme, defaultPalette, palette, resolveThemeColors, themeColorKeys, themeRevision} from '../src/config/theme-palette.js';
import {applyThemePreset, loadThemePresets, themeIssues} from '../src/config/theme-presets.js';
import {themeSchema} from '../src/config/config.js';
import {toggleColor} from '../src/tui/components/toggle-marker.js';
import {effortStyles} from '../src/tui/panels/picker.js';
import {computeActivePills} from '../src/tui/status/actor-pills.js';
import {statusbarParts} from '../src/tui/status/statusbar.js';
import {createBuilder} from '../src/tui/timeline/scene.js';
import {presentedSegments} from '../src/tui/timeline/row-presentation.js';
import {encodeRow} from '../src/tui/terminal/terminal-plane.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {RuntimeStore} from '../src/runtime/store.js';

function withPalette(run: () => void): void {
  const previous = {...palette};
  try {run();} finally {applyTheme(previous);}
}

test('complete default palette comes from shipped data and legacy TOML shares its defaults', () => {
  const data = JSON.parse(readFileSync(new URL('../src/config/themes/logox-dark.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(data.colors).sort(), [...themeColorKeys].sort());
  assert.deepEqual(resolveThemeColors(), defaultPalette);
  assert.deepEqual(themeSchema.parse(undefined), {user: defaultPalette.user, accent: defaultPalette.accent,
    dream_collapsed: defaultPalette.dreamCollapsed, dream_expanded: defaultPalette.dreamExpanded});
});

test('aliases follow final overrides; sparse switches reset all tokens and invalid overlays are atomic', () => withPalette(() => {
  const identity = palette;
  applyTheme({fg: '#102030', selectionFg: '$fg', strong: '#203040', checkedFg: '$strong', system: '$muted', muted: '#304050'});
  assert.equal(palette.selectionFg, '#102030');
  assert.equal(palette.checkedFg, '#203040');
  assert.equal(palette.system, '#304050');
  const before = {...palette}, version = themeRevision();
  assert.throws(() => applyTheme({accent: '$noSuchColor'}), /Unknown theme color reference/);
  assert.throws(() => applyTheme({fg: '$muted', muted: '$fg'}), /Circular theme color reference/);
  assert.deepEqual(palette, before); assert.equal(themeRevision(), version);
  applyTheme({accent: '#405060'});
  assert.equal(palette, identity); assert.equal(palette.checkedFg, defaultPalette.checkedFg);
  assert.equal(palette.selectionFg, defaultPalette.fg);
  assert.equal(themeRevision(), version + 1);
  applyTheme({dream_collapsed: '#506070', dream_expanded: '#607080'});
  assert.equal(palette.dreamCollapsed, '#506070'); assert.equal(palette.dreamExpanded, '#607080');
}));

test('user inheritance resolves aliases after child overlays and rejects broken graphs without touching files', () => withPalette(() => {
  const home = mkdtempSync(join(tmpdir(), 'logox-test-colors-'));
  try {
    const dir = join(home, '.logox', 'themes'); mkdirSync(dir, {recursive: true});
    const put = (name: string, value: unknown) => writeFileSync(join(dir, name + '.json'), JSON.stringify(value));
    put('parent', {base: 'mist-dark', colors: {selectionFg: '$fg', panelLabel: '$muted'}});
    put('child', {base: 'parent', colors: {fg: '#102030', muted: '#304050'}});
    put('unknown', {colors: {fg: '$missing'}});
    put('cycle', {colors: {fg: '$muted', muted: '$fg'}});
    put('base-cycle-a', {base: 'base-cycle-b'}); put('base-cycle-b', {base: 'base-cycle-a'});
    put('missing-base', {base: 'missing'});
    const before = readFileSync(join(dir, 'child.json'), 'utf8');
    const themes = loadThemePresets(home);
    assert.ok(themes.some(theme => theme.name === 'child'));
    for (const name of ['unknown', 'cycle', 'base-cycle-a', 'base-cycle-b', 'missing-base']) assert.ok(!themes.some(theme => theme.name === name), name);
    assert.ok(themeIssues().length >= 5);
    applyThemePreset('child'); assert.equal(palette.selectionFg, '#102030'); assert.equal(palette.panelLabel, '#304050');
    assert.equal(readFileSync(join(dir, 'child.json'), 'utf8'), before);
  } finally {loadThemePresets(join(home, 'empty')); rmSync(home, {recursive: true, force: true});}
}));

test('invalid parent overrides fall back before alphabetically earlier children are validated', () => withPalette(() => {
  const home = mkdtempSync(join(tmpdir(), 'logox-test-parent-colors-'));
  try {
    const dir = join(home, '.logox', 'themes'); mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'a-child.json'), JSON.stringify({base: 'mist-dark', colors: {accent: '#123456'}}));
    for (const parent of [{base: 'missing-parent', colors: {}}, {colors: {fg: '$notAColor'}}]) {
      writeFileSync(join(dir, 'mist-dark.json'), JSON.stringify(parent));
      assert.ok(loadThemePresets(home).some(theme => theme.name === 'a-child'));
      applyThemePreset('a-child'); assert.equal(palette.accent, '#123456');
      assert.equal(palette.fg, '#E8E6E0');
    }
    // Legacy alias fallback must honor a valid canonical user override before validating children.
    writeFileSync(join(dir, 'logox-dark.json'), JSON.stringify({colors: {fg: '#234567'}}));
    assert.ok(loadThemePresets(home).some(theme => theme.name === 'a-child'));
    applyThemePreset('a-child'); assert.equal(palette.accent, '#123456'); assert.equal(palette.fg, '#234567');
    // The damaged user parent may also be reached through a legacy intermediate base.
    writeFileSync(join(dir, 'mist-dark.json'), JSON.stringify({base: 'logox-dark'}));
    writeFileSync(join(dir, 'logox-dark.json'), JSON.stringify({colors: {fg: '$missing'}}));
    assert.ok(loadThemePresets(home).some(theme => theme.name === 'a-child'));
    applyThemePreset('a-child'); assert.equal(palette.accent, '#123456'); assert.equal(palette.fg, defaultPalette.fg);
    // A parent's original bad base can hide the canonical parent until alias fallback is selected.
    writeFileSync(join(dir, 'mist-dark.json'), JSON.stringify({base: 'missing-parent'}));
    assert.ok(loadThemePresets(home).some(theme => theme.name === 'a-child'));
    applyThemePreset('a-child'); assert.equal(palette.accent, '#123456'); assert.equal(palette.fg, '#E8E6E0');
  } finally {loadThemePresets(join(home, 'empty')); rmSync(home, {recursive: true, force: true});}
}));

test('every semantic field accepts an explicit independent override', () => withPalette(() => {
  for (const key of themeColorKeys) {
    applyTheme({[key]: '#13579b'}); assert.equal(palette[key], '#13579b', key);
  }
}));

test('controls, effort getters, permission modes and missing-role pills read the live semantic palette', () => withPalette(() => {
  applyTheme({checkedFg: '#112233', accent: '#223344', muted: '#334455', effortHigh: '#445566',
    permissionDefault: '#556677', permissionAuto: '#667788', permissionCreative: '#778899', actorPillBg: '#8899aa', actorPillFg: '#99aabb'});
  assert.equal(toggleColor(true, false), palette.checkedFg);
  assert.equal(toggleColor(true, true), palette.accent);
  assert.equal(toggleColor(true, true, true), palette.muted);
  assert.equal(effortStyles.high!.color, palette.effortHigh);
  for (const [mode, expected] of [['default', palette.permissionDefault], ['auto', palette.permissionAuto], ['creative', palette.permissionCreative]]) {
    assert.equal(statusbarParts({ownerId: 'logox', name: 'Logox', state: 'ready', permission: mode!}, 80,
      [{id: 'permission', enabled: true}])[0]?.color, expected);
  }
  const pill = computeActivePills([{sessionId: 's', status: 'running', ownerId: 'custom', activityId: 'a'}], 's')[0]!;
  assert.equal(pill.bg, palette.actorPillBg); assert.equal(pill.fg, palette.actorPillFg);
  applyTheme({effortHigh: '#abcdef'}); assert.equal(effortStyles.high!.color, '#abcdef');
}));

test('selection foreground and encoded-row cache update on theme switches', () => withPalette(() => {
  const builder = createBuilder(40, null);
  builder.pushProse('m', 'select this text', palette.accent);
  const row = builder.rows[0]!;
  applyTheme({selectionFg: '#112233', selectionBg: '#445566', fg: '#102030'});
  const selected = presentedSegments(row, 0, {anchor: {x: row.gutterCols, y: 0}, focus: {x: row.gutterCols + 5, y: 0}});
  assert.ok(selected.some(segment => segment.bg === '#445566' && segment.color === '#112233'));
  const raw = {...row, color: undefined, segments: [{text: 'plain'}]};
  const first = encodeRow(raw, 0, null);
  applyTheme({fg: '#304050'});
  const second = encodeRow(raw, 0, null);
  assert.notEqual(first, second); assert.ok(second.includes('38;2;48;64;80m'));
}));

test('stage message cache refreshes body and system colors even when actor rails stay unchanged', () => withPalette(() => {
  const store = new RuntimeStore();
  store.message('s', 'techne', 'assistant', 'Assistant body');
  store.message('s', 'system', 'notice', 'System message');
  const snapshot = store.getSnapshot();
  applyTheme({fg: '#112233', system: '#334455'});
  const first = buildStageRows(snapshot, 's', 'logox', 80, {}, null);
  applyTheme({fg: '#556677', system: '#778899'});
  const second = buildStageRows(snapshot, 's', 'logox', 80, {}, null);
  const body = second.find(row => row.text.includes('Assistant body'))!;
  assert.ok(body.segments?.some(segment => segment.text.includes('Assistant body') && segment.color === '#556677'));
  const system = second.find(row => row.text.includes('System message'))!;
  assert.equal(system.railColor, '#778899'); assert.equal(system.color, '#778899');
  assert.notDeepEqual(second, first);
}));
