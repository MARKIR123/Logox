import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseDocument} from 'yaml';
import {builtinActors} from '../src/actors/builtins.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {cast, type ActorId} from '../src/actors/ensemble.js';
import {loadThemePresets, applyThemePreset} from '../src/config/theme-presets.js';
import {applyTheme, palette} from '../src/tui/appearance/theme.js';
import {ownerColor, ownerSurface} from '../src/tui/appearance/actor-style.js';

const ids: readonly ActorId[] = ['logox', 'aletheia', 'techne', 'kalon'];
const shipped = new URL('../src/actors/profiles/', import.meta.url);

test('builtin and fallback colors share shipped YAML without changing builtin behavior or cast shape', async () => {
  assert.deepEqual(Object.keys(cast), ids);
  assert.deepEqual(builtinActors.map(actor => actor.id), ids);
  for (const id of ids) {
    const actor = builtinActors.find(actor => actor.id === id)!;
    const config = parseDocument(await readFile(new URL(id + '/config.yaml', shipped), 'utf8'));
    assert.equal(actor.color, config.get('color'), id);
    assert.equal(cast[id].color, config.get('color'), id);
    assert.equal(actor.cardClosed, config.get('card_closed'), id);
    assert.equal(actor.cardOpen, config.get('card_open'), id);
    assert.deepEqual(Object.keys(cast[id]).sort(), ['color', 'name', 'symbol', 'title']);
    assert.deepEqual(actor.context, {keep_recent_rounds: id === 'logox' ? 2 : 0, keep_recent_tools: id === 'kalon' ? 0 : 2});
    assert.equal(actor.thinkingAnimation, undefined, 'Do not import unrelated YAML defaults');
    assert.equal(actor.defaultModel, undefined);
    for (const [field, file] of [['prompt', 'persona.md'], ['compression', 'compression.md'],
      ['execution', 'execution.md'], ['collaboration', 'collaboration.md']] as const) {
      assert.equal(actor[field], (await readFile(new URL(id + '/' + file, shipped), 'utf8')).trim(), id + ':' + field);
    }
    assert.ok(Object.isFrozen(actor) && Object.isFrozen(actor.context) && Object.isFrozen(cast[id]));
  }
});

test('merged default keeps Logox mist-blue identity separate from the human palette and theme switches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-test-'));
  const previous = {...palette};
  try {
    const shippedYaml = parseDocument(await readFile(new URL('logox/config.yaml', shipped), 'utf8'));
    const identity = shippedYaml.get('color');
    assert.equal(identity, '#7DA1DE');
    assert.equal(cast.logox.color, identity);
    assert.equal(builtinActors.find(actor => actor.id === 'logox')!.color, identity);
    loadThemePresets(home);
    applyThemePreset('logox-dark');
    assert.equal(palette.user, '#D77757');
    assert.equal(ownerColor('user'), '#D77757');
    assert.equal(ownerColor('logox'), identity);
    assert.notEqual(ownerColor('user'), ownerColor('logox'));
    const surfaces = [ownerSurface('logox', false), ownerSurface('logox', true)];
    applyThemePreset('claude-warm');
    assert.notEqual(palette.accent, identity, 'System accent can change without repainting Logox');
    assert.equal(ownerColor('logox'), identity);
    assert.deepEqual([ownerSurface('logox', false), ownerSurface('logox', true)], surfaces);
    applyThemePreset('logox-dark');
    assert.equal(ownerColor('user'), '#D77757');
    assert.equal(ownerColor('logox'), identity);
  } finally {
    loadThemePresets(join(home, 'empty'));
    applyTheme(previous);
    await rm(home, {recursive: true, force: true});
  }
});

test('theme changes preserve shipped and installed actor colors and surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-test-'));
  const originalPalette = {...palette};
  try {
    const home = join(root, 'home'), cwd = join(root, 'project');
    const actorRoot = join(home, '.logox', 'actors');
    await mkdir(cwd, {recursive: true});
    await cp(shipped, actorRoot, {recursive: true});
    const path = join(actorRoot, 'techne', 'config.yaml');
    const config = parseDocument(await readFile(path, 'utf8'));
    const custom = {color: '#123456', cardClosed: '#182736', cardOpen: '#293847'};
    config.set('color', custom.color);
    config.set('card_closed', custom.cardClosed);
    config.set('card_open', custom.cardOpen);
    const userConfig = config.toString();
    await writeFile(path, userConfig);
    const catalog = new ActorCatalog(cwd, {home});
    assert.deepEqual((await catalog.load()).issues, []);
    const actor = catalog.find('techne')!;
    assert.equal(actor.color, custom.color);
    assert.equal(actor.cardClosed, custom.cardClosed);
    assert.equal(actor.cardOpen, custom.cardOpen);
    assert.notEqual(actor.color, cast.techne.color, 'Installed YAML overrides only the catalog, not shipped defaults');
    const roles = Object.fromEntries(catalog.list().map(actor => [actor.id, actor]));
    const defaults = Object.fromEntries(builtinActors.map(actor => [actor.id, actor]));
    const appearance = () => ids.map(id => [ownerColor(id), ownerSurface(id, false), ownerSurface(id, true),
      ownerColor(id, defaults), ownerSurface(id, false, defaults), ownerSurface(id, true, defaults),
      ownerColor(id, roles), ownerSurface(id, false, roles), ownerSurface(id, true, roles)]);
    const before = appearance();
    const themes = join(home, '.logox', 'themes');
    await mkdir(themes, {recursive: true});
    await writeFile(join(themes, 'actor-source-test.json'), JSON.stringify({colors: {
      accent: '#654321', user: '#abcdef', cardCollapsed: '#111222', cardExpanded: '#333444',
    }}));
    const presets = loadThemePresets(home);
    assert.ok(presets.some(theme => theme.name === 'actor-source-test'));
    applyThemePreset('actor-source-test');
    assert.equal(palette.accent, '#654321');
    assert.equal(ownerColor('user'), '#abcdef');
    assert.equal(palette.cardCollapsed, '#111222');
    assert.deepEqual(appearance(), before);
    assert.equal(ownerColor('techne', roles), custom.color);
    assert.equal(ownerSurface('techne', false, roles), custom.cardClosed);
    assert.equal(ownerSurface('techne', true, roles), custom.cardOpen);
    assert.deepEqual((await catalog.reload()).issues, []);
    assert.equal(catalog.find('techne')!.color, custom.color);
    assert.equal(await readFile(path, 'utf8'), userConfig, 'Theme application and catalog reload leave user YAML unchanged');
  } finally {
    applyTheme(originalPalette);
    await rm(root, {recursive: true, force: true});
  }
});

test('builtin and ensemble fallback modules contain no literal RGB colors', async () => {
  for (const file of ['builtins.js', 'ensemble.js']) {
    const source = await readFile(new URL('../src/actors/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /#[\da-f]{6}\b/i, file);
    assert.doesNotMatch(source, /\brgba?\s*\(/i, file);
  }
});
