import test from 'node:test';
import assert from 'node:assert/strict';
import {bindingChoices, INHERIT_CHOICE} from '../src/commands/model-choices.js';
import {groupModelsForProvider} from '../src/config/model-grouping.js';

const pool = [
  {provider: 'gateway', id: 'alpha-low'}, {provider: 'gateway', id: 'alpha-high'}, {provider: 'gateway', id: 'beta'},
  {provider: 'other', id: 'gamma', window: 200_000, isOffline: true},
];

test('the dedicated-model list is Inherit, then one row per model family, folded like the session picker', () => {
  const items = bindingChoices(undefined).items(pool);
  assert.equal(items[0]!.id, INHERIT_CHOICE);
  const families = ['gateway', 'other'].flatMap(provider => groupModelsForProvider(pool.filter(model => model.provider === provider).map(model => model.id), provider, '').map(family => family.baseModel));
  assert.deepEqual(items.slice(1).map(item => item.label), families, 'the same families the session picker shows');
  assert.ok(items.length - 1 <= pool.length);
  assert.deepEqual([...new Set(items.slice(1).map(item => item.group))], ['gateway', 'other']);
  assert.match(items.at(-1)!.description ?? '', /200k.*\[offline\]/);
});

test('two pickers built from the same pool offer the same rows whatever each is bound to', () => {
  const actor = bindingChoices({provider: 'gateway', model: 'beta'}), automa = bindingChoices(undefined);
  assert.deepEqual(actor.items(pool).map(item => [item.id, item.label, item.group]), automa.items(pool).map(item => [item.id, item.label, item.group]));
  assert.equal(automa.current, INHERIT_CHOICE);
  assert.equal(actor.current, JSON.stringify({provider: 'gateway', model: 'beta'}));
});

test('a choice resolves to its binding: Inherit clears, a family row picks the variant for the chosen effort, an unknown id is refused', () => {
  const choices = bindingChoices(undefined);
  const items = choices.items(pool);
  assert.equal(choices.resolve(INHERIT_CHOICE), undefined);
  const beta = items.find(item => item.label === 'beta')!;
  assert.deepEqual(choices.resolve(beta.id), {provider: 'gateway', model: 'beta'});
  assert.deepEqual(choices.resolve(JSON.stringify({provider: 'gateway', model: 'alpha-high'})), {provider: 'gateway', model: 'alpha-high'}, 'an exact variant id is accepted');
  assert.equal(choices.resolve(JSON.stringify({provider: 'nowhere', model: 'x'})), null);
});

test('a model id that names its level decides the effort, whatever effort the session carries', async () => {
  const {effortInName} = await import('../src/config/model-preferences.js');
  assert.equal(effortInName('gemini-4-hydrogen-high'), 'high');
  assert.equal(effortInName('family-extra-low'), 'low');
  assert.equal(effortInName('family-MAX'), 'max');
  for (const plain of ['gemini-4-hydrogen', 'claude-thinking', 'family-tiered', 'highland']) assert.equal(effortInName(plain), undefined, plain);
  const {loadConfig, modelSettings} = await import('../src/config/config.js');
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {ProviderRegistry} = await import('../src/providers/registry.js');
  const {AuthStorage} = await import('../src/providers/auth.js');
  const {CustomProviderStorage} = await import('../src/providers/custom-storage.js');
  const cwd = await mkdtemp(join(tmpdir(), 'logox-effort-'));
  try {
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'gw', model: 'family-low', thinking_effort: 'medium'},
      providers: {gw: {base_url: 'https://gateway.invalid/v1'}}}, {}, cwd, cwd);
    assert.equal(modelSettings(config, {}).thinkingEffort, 'low');
    const registry = new ProviderRegistry(config, {}, async () => {throw new Error('no network');}, new AuthStorage(join(cwd, 'auth.json')), new CustomProviderStorage(join(cwd, 'custom.json')));
    // An actor bound to the `-high` variant inherits the session's effort field, but its model name wins.
    assert.equal(registry.candidate('gw', 'family-high').thinking().effort, 'high');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a model label shows the family once and the level once', async () => {
  const {modelLabel} = await import('../src/config/model-preferences.js');
  assert.equal(modelLabel('claude-opus-5-5-medium', 'medium'), 'claude-opus-5-5 · medium');
  assert.equal(modelLabel('gemini-4-hydrogen-high', 'low'), 'gemini-4-hydrogen · high', 'the level in the name is the one shown');
  assert.equal(modelLabel('gpt-5.5', 'high'), 'gpt-5.5 · high');
  assert.equal(modelLabel('gpt-4o'), 'gpt-4o');
});

test('the one-hour role default is trusted only on the official Anthropic endpoint; elsewhere it must be configured', async () => {
  const {anthropicRetention, cacheLifetimeMs, SHORT_CACHE_MS, LONG_CACHE_MS} = await import('../src/providers/cache.js');
  const director = {cacheRetention: {role: 'long' as const}};
  assert.equal(anthropicRetention({baseUrl: 'https://api.anthropic.com/v1'}, director), 'long');
  assert.equal(anthropicRetention({baseUrl: 'http://127.0.0.1:8045/v1'}, director), 'short', 'a proxy is not assumed to keep entries for an hour');
  assert.equal(anthropicRetention({baseUrl: 'http://127.0.0.1:8045/v1', cacheRetention: 'long'}, director), 'long', 'an explicit setting still asks for it');
  assert.equal(anthropicRetention({baseUrl: 'http://127.0.0.1:8045/v1'}, {cacheRetention: {role: 'short', actor: 'long'}}), 'long', 'an actor setting is explicit too');
  assert.equal(cacheLifetimeMs({kind: 'anthropic', baseUrl: 'http://127.0.0.1:8045/v1'}, director), SHORT_CACHE_MS, 'so the keep-alive and the fold-on-expiry work with five minutes');
  assert.equal(cacheLifetimeMs({kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1'}, director), LONG_CACHE_MS);
  assert.equal(cacheLifetimeMs({kind: 'anthropic', baseUrl: 'http://127.0.0.1:8045/v1', cacheTtlMs: 120_000}, director), 120_000, 'a configured lifetime always wins');
});
