import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {
  coerceSetting, readSettings, saveSettings, settingDefinition, settingDefinitions, settingGroups, settingOptions, settingsPages, settingText,
  type SettingDefinition, type SettingValue,
} from '../src/config/settings-definitions.js';
import {StatusbarPreferences} from '../src/config/statusbar-preferences.js';
import {applyUiSettings, defaultUiSettings, UiPreferences, uiSettings} from '../src/config/ui-settings.js';
import {settingsFixture} from './settings-fixture.js';

const kinds = new Set(['boolean', 'select', 'number', 'text']);
/** A value different from the current one that the definition accepts. */
function alternative(definition: SettingDefinition, current: SettingValue, options: readonly string[]): SettingValue {
  if (definition.kind === 'boolean') return !current;
  if (definition.kind === 'number') return Number(current) === definition.max ? definition.min! : Number(current) + definition.step!;
  if (definition.kind === 'select') return options.find(option => option !== current)!;
  return 'Tester';
}

test('every definition names a known group, a description, a label, a default and valid choices', async () => {
  const f = await settingsFixture();
  try {
    const groups = new Set(settingGroups.map(group => group.id));
    assert.deepEqual(settingGroups.map(group => group.id), ['appearance', 'splash', 'conversation', 'pages']);
    assert.equal(new Set(settingDefinitions.map(definition => definition.key)).size, settingDefinitions.length, 'keys are unique');
    for (const definition of settingDefinitions) {
      const label = definition.key;
      assert.ok(groups.has(definition.group), label + ' group');
      assert.ok(definition.label.trim() && definition.description.trim().endsWith('.'), label + ' label and description');
      assert.ok(kinds.has(definition.kind), label + ' kind');
      assert.notEqual(definition.default, undefined, label + ' default');
      assert.equal(typeof definition.default, definition.kind === 'boolean' ? 'boolean' : definition.kind === 'number' ? 'number' : 'string', label + ' default type');
      assert.equal(typeof definition.read, 'function'); assert.equal(typeof definition.write, 'function');
      if (definition.kind === 'select') {
        const options = settingOptions(definition, f.env);
        assert.ok(options.length >= 2, label + ' offers a choice');
        assert.ok(options.includes(String(definition.default)), label + ' default is one of its options');
        for (const value of Object.keys(definition.labels ?? {})) assert.ok(options.includes(value), label + ' label for ' + value + ' is an option');
      }
      if (definition.kind === 'number') {
        assert.ok(definition.min !== undefined && definition.max !== undefined && definition.step, label + ' bounds');
        assert.ok(Number(definition.default) >= definition.min! && Number(definition.default) <= definition.max!, label + ' default inside bounds');
      }
    }
    assert.ok(settingDefinitions.some(definition => definition.preview) && settingDefinition('theme')?.revert, 'the theme previews and reverts');
    assert.deepEqual(settingsPages.map(page => page.id), ['statusbar', 'permissions', 'models', 'shortcuts']);
    for (const page of settingsPages) assert.ok(page.label && page.description.endsWith('.'), page.id + ' description');
    assert.equal(settingText(settingDefinition('diffLayout')!, 'auto'), 'auto (by width)');
    assert.equal(settingText(settingDefinition('animations')!, true), '[✓]');
  } finally {await f.close();}
});

test('a fresh environment reads every setting at its declared default', async () => {
  const f = await settingsFixture();
  try {
    for (const definition of settingDefinitions) assert.equal(definition.read(f.env), definition.default, definition.key);
    assert.deepEqual(Object.keys(readSettings(f.env)), settingDefinitions.map(definition => definition.key));
  } finally {await f.close();}
});

test('every setting persists through its own store and survives a reload', async () => {
  const f = await settingsFixture();
  try {
    for (const definition of settingDefinitions) {
      const next = alternative(definition, definition.read(f.env), settingOptions(definition, f.env));
      await definition.write(f.env, next);
      assert.equal(definition.read(f.env), next, definition.key + ' reads back what was written');
    }
    // Everything the ui-preferences file owns comes back from disk.
    const reloadedUi = new UiPreferences(f.root); await reloadedUi.load();
    assert.deepEqual({...reloadedUi.get()}, {...f.ui.get()});
    assert.equal(reloadedUi.get().theme, 'claude-warm'); assert.equal(reloadedUi.get().cursor, 'Underline _');
    for (const key of ['toolTint', 'startPage', 'emblem', 'tagline', 'thinkingDisplay', 'diffLayout', 'notify', 'enterKey'] as const) {
      assert.notEqual(reloadedUi.get()[key], defaultUiSettings[key], key + ' was saved');
    }
    const reloadedBar = new StatusbarPreferences(join(f.root, '.logox', 'statusbar.json')); await reloadedBar.load();
    assert.equal(reloadedBar.getSnapshot().motion, false, 'animations');
    assert.equal(reloadedBar.getSnapshot().gaugeCells, 20, 'context bar width');
    assert.equal(reloadedBar.getSnapshot().modules.find(module => module.id === 'context')?.enabled, false, 'context bar');
    // The other stores took the write through their hooks.
    assert.equal(f.state.name, 'Tester'); assert.deepEqual(f.state.savedEfforts, ['off']); assert.deepEqual(f.state.savedModes, ['auto']);
    assert.deepEqual(f.state.appliedThemes, ['claude-warm']); assert.deepEqual(f.state.appliedCursors, ['Underline _']);
    // Live settings follow the saved file.
    assert.equal(uiSettings().toolTint, f.ui.get().toolTint); assert.equal(uiSettings().enterKey, 'newline');
  } finally {applyUiSettings(defaultUiSettings); await f.close();}
});

test('saveSettings writes in page order, coerces numbers and reports the first failure with what was saved', async () => {
  const f = await settingsFixture();
  try {
    assert.equal(coerceSetting(settingDefinition('contextBarWidth')!, 17, f.env), 16, 'numbers snap to the step grid');
    assert.equal(coerceSetting(settingDefinition('contextBarWidth')!, 99, f.env), 24, 'and clamp to the bounds');
    const done = await saveSettings(f.env, {toolTint: 'subtle', animations: false, contextBarWidth: 12});
    assert.equal(done.error, undefined);
    assert.deepEqual(done.saved, {animations: false, toolTint: 'subtle', contextBarWidth: 12}, 'saved values come back in definition order');
    const failed = await saveSettings(f.env, {theme: 'claude-warm', cursor: 'Sparkle', startPage: false});
    assert.match(failed.error ?? '', /Cursor was not saved: Cursor: "Sparkle" is not one of/);
    assert.deepEqual(failed.saved, {theme: 'claude-warm'}, 'the earlier row stays saved, the later one is not attempted');
    assert.equal(f.ui.get().startPage, true);
    assert.deepEqual(await saveSettings(f.env, {}), {saved: {}});
  } finally {applyUiSettings(defaultUiSettings); await f.close();}
});

test('the user name setting is trimmed through the same sanitiser as /name', async () => {
  const f = await settingsFixture();
  try {
    await settingDefinition('userName')!.write(f.env, '  Ada   Lovelace  ');
    assert.equal(f.state.name, 'Ada Lovelace');
    await settingDefinition('userName')!.write(f.env, '   ');
    assert.equal(f.state.name, undefined, 'an empty name clears it');
  } finally {await f.close();}
});
