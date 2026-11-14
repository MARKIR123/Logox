import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config/config.js';
import {AuthStorage} from '../src/providers/auth.js';
import {ModelTable, isSubscriptionProvider, modelTable, normalizeModelId, tablePrice, thinkingHint, type ModelTableData} from '../src/providers/model-table.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {modelPrice} from '../src/context/cost.js';

type Meta = {source: string; version: string};
const sync = await import(new URL('../../scripts/sync-model-table.mjs', import.meta.url).href) as {
  decodeCatalog(raw: unknown): Record<string, unknown>[];
  buildTable(models: Record<string, unknown>[], meta: Meta, keep?: string[], upstream?: Record<string, string>): ModelTableData;
  renderTable(table: ModelTableData, copyright?: string): string;
  readPackage(directory: string): {models: Record<string, unknown>[]; meta: Meta; copyright: string};
  copyrightOf(license: string): string;
  thinkingLevels(model: unknown): string[];
};
const model = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({id, name: id.toUpperCase(), provider, reasoning: false, input: ['text'],
  cost: {input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25}, contextWindow: 100000, maxTokens: 8000, ...extra});
const SWITCH = Date.UTC(2026, 11, 1);
const argonCost = {input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0, timeBased: {offPeakMultiplier: 1, peakWindows: [{startMinute: 60, endMinute: 240, weekdays: [1]}],
  effectiveRates: [{effectiveFrom: SWITCH, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0}, {effectiveFrom: -8640000000000000, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0}]}};
const upstream = [
  model('google', 'gemini-4-argon', {reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536, cost: argonCost,
    thinking: {efforts: ['minimal', 'low', 'medium', 'high'], mode: 'google-level', requiresEffort: true}}),
  model('google', 'gemini-4-hydrogen', {reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536,
    cost: {input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0}, thinking: {efforts: ['low', 'medium', 'high', 'xhigh'], mode: 'google-level', requiresEffort: true}}),
  model('google', 'img-only-no-window', {contextWindow: undefined}),
  model('google-antigravity', 'claude-opus-5-5', {reasoning: true, contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5},
    thinking: {efforts: ['low', 'medium', 'high']}}),
  model('anthropic', 'claude-opus-5-5', {reasoning: true, contextWindow: 1000000, maxTokens: 128000,
    cost: {input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, longContext: {inputThreshold: 200000, input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5}},
    thinking: {efforts: ['xhigh', 'max', 'low', 'medium', 'high'], mode: 'anthropic-adaptive'}}),
  model('anthropic', 'claude-haiku-4-5-20251001', {contextWindow: 200000, maxTokens: 64000}),
  model('xai', 'grok-fixed', {reasoning: true, maxTokens: undefined}),
  model('openai-codex', 'gpt-6.1-sol', {reasoning: true, contextWindow: 500000, maxTokens: 128000, cost: {input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5}}),
  model('openai', 'gpt-6.1-sol', {reasoning: true, contextWindow: 272000, maxTokens: 128000, cost: {input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5}}),
  model('moonshot', 'kimi-k3', {contextWindow: 262144}),
  model('openrouter', 'anthropic/claude-sonnet-4-5', {contextWindow: 200000}),
  model('openrouter', 'anthropic/claude-sonnet-4-5:free', {contextWindow: 100}),
  model('openrouter', 'acme/only-here', {contextWindow: 7777}),
  model('ignored', 'nope'),
];
const meta = {source: '@oh-my-pi/pi-catalog', version: '9.9.9'};
const KEEP = ['anthropic', 'google', 'google-antigravity', 'moonshotai', 'openai', 'openai-codex', 'openrouter', 'xai'];
const fixture = () => new ModelTable(sync.buildTable(upstream, meta, KEEP));

/** A tiny hand-encoded catalog: arrays, nested objects, shared nodes, `[-1]`, and 33 booleans so the mask spans two words (bits 0 and 31 of word 0, bit 0 of word 1). */
function encodedCatalog() {
  const flags = Array.from({length: 33}, (_, index) => 'f' + index);
  const keys = ['name', 'tags', 'nested', 'cost', 'api', ...flags];
  return {version: 1, keys, booleanShapes: [flags.map((_, index) => 5 + index), []],
    nodes: [
      [0, [0, 'Alpha', 1, [1], 2, [2]], 0, [(1 | 0x80000000) >>> 0, 1]],
      [1, ['text', 'image', [-1]]],
      [0, [3, 1.5], 1, []],
      [0, [4, 'x'], 1, []],
      [0, [0, 'Beta', 1, [1]], 1, []],
    ],
    compat: {},
    providers: [['fixture-provider', [3], [['m1', [0]], ['m2', [4], {wire: true}]]], ['empty', [-1], []]]};
}

test('decoder reads objects, arrays, shared nodes, undefined and booleans across two mask words', () => {
  const models = sync.decodeCatalog(encodedCatalog());
  assert.equal(models.length, 2);
  const [first, second] = models as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(first.id, 'm1');
  assert.equal(first.provider, 'fixture-provider');
  assert.equal(first.api, 'x', 'provider constants apply to every row');
  assert.equal(first.name, 'Alpha');
  assert.deepEqual(first.tags, ['text', 'image', undefined]);
  assert.deepEqual(first.nested, {cost: 1.5});
  const on = Object.keys(first).filter(key => /^f\d+$/.test(key) && first[key] === true);
  assert.deepEqual(on, ['f0', 'f31', 'f32']);
  assert.equal(Object.keys(first).filter(key => /^f\d+$/.test(key) && first[key] === false).length, 30);
  assert.deepEqual([second.id, second.name, second.api, second.tags], ['m2', 'Beta', 'x', ['text', 'image', undefined]]);
  assert.equal('f0' in second, false, 'an empty boolean shape adds nothing');
});

test('sync parser keeps windowed models, derives levels, tiers and dated cards, and trims fields', () => {
  const table = sync.buildTable(upstream, meta, [...KEEP, 'missing']);
  assert.deepEqual(Object.keys(table.providers), ['anthropic', 'google', 'google-antigravity', 'moonshotai', 'openai', 'openai-codex', 'openrouter', 'xai']);
  const google = table.providers.google!.models;
  assert.deepEqual(google.map(row => row[0]), ['gemini-4-argon', 'gemini-4-hydrogen'], 'a model without a context window is dropped');
  assert.deepEqual(google[0], ['gemini-4-argon', 'GEMINI-4-ARGON', 1048576, 65536, 'text,image', 'minimal,low,medium,high', [2, 10, 0.1, 0], [], [[SWITCH, 4, 20, 0.2, 0]]]);
  assert.deepEqual(google[1]![6], [1.5, 7.5, 0.075, 0]);
  assert.equal(google[1]![8], undefined, 'no dated card, no trailing fields');
  const opus = table.providers.anthropic!.models.find(row => row[0] === 'claude-opus-5-5')!;
  assert.equal(opus[5], 'off,low,medium,high,xhigh,max', 'off is offered unless effort is mandatory; levels are put in a fixed order');
  assert.deepEqual(opus[7], [[200000, 10, 37.5, 1, 12.5]]);
  assert.equal(table.providers.anthropic!.models.find(row => row[0] === 'claude-haiku-4-5-20251001')![5], '');
  const fixed = table.providers.xai!.models[0]!;
  assert.deepEqual([fixed[3], fixed[5]], [0, 'fixed'], 'unknown max output is 0; reasoning without a control is fixed');
  assert.equal(table.providers['openai-codex']!.subscription, true);
  assert.deepEqual(sync.thinkingLevels({reasoning: false}), []);
});

test('provider names upstream spells differently map to the names LOGOX uses', () => {
  const table = sync.buildTable(upstream, meta, KEEP);
  assert.deepEqual(table.providers.moonshotai!.models.map(row => row[0]), ['kimi-k3']);
  assert.equal('moonshot' in table.providers, false);
  assert.equal(new ModelTable(table).resolve('moonshotai', 'kimi-k3')!.confidence, 'exact');
  assert.deepEqual(Object.keys(sync.buildTable(upstream, meta, ['kimi'], {kimi: 'moonshot'}).providers), ['kimi']);
});

test('generated file is deterministic and carries source, version and MIT notice', () => {
  const first = sync.renderTable(sync.buildTable(upstream, meta, KEEP), 'Copyright (c) 2025 Test Author.');
  assert.equal(sync.renderTable(sync.buildTable([...upstream].reverse(), meta, [...KEEP].reverse()), 'Copyright (c) 2025 Test Author.'), first);
  assert.match(first, /GENERATED by scripts\/sync-model-table\.mjs/);
  assert.match(first, /@oh-my-pi\/pi-catalog@9\.9\.9\./);
  assert.match(first, /MIT licensed\. Copyright \(c\) 2025 Test Author\. Permission/);
  assert.doesNotMatch(first, /nope/);
  assert.equal(sync.copyrightOf('MIT License\n\nCopyright (c) 2025-2026 Can Bölük\nCopyright (c) 2026 Stencil Labs, Inc.\n'), 'Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.');
  assert.match(sync.copyrightOf(''), /Can Bölük/);
});

test('sync reads an extracted package directory as data only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-model-table-'));
  try {
    await mkdir(join(root, 'src'), {recursive: true});
    await mkdir(join(root, 'dist'), {recursive: true});
    await writeFile(join(root, 'package.json'), JSON.stringify({version: '3.2.1'}));
    await writeFile(join(root, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 Somebody\n');
    await writeFile(join(root, 'src', 'models.json'), JSON.stringify(encodedCatalog()));
    await writeFile(join(root, 'src', 'models.ts'), 'throw new Error("package code must never run")');
    await writeFile(join(root, 'dist', 'index.js'), 'throw new Error("package code must never run")');
    const read = sync.readPackage(root);
    assert.deepEqual(read.meta, {source: '@oh-my-pi/pi-catalog', version: '3.2.1'});
    assert.equal(read.copyright, 'Copyright (c) 2026 Somebody');
    assert.deepEqual(read.models.map(item => item.id), ['m1', 'm2']);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('catalog resolution: declared mirror, aliases, normalized ids and low-confidence bare matches', () => {
  const table = fixture();
  const catalogs = {antigravity: {mirror: 'google', aliases: {'gemini-4-argon-fast': 'gemini-4-argon'}}};
  const exact = table.resolve('antigravity', 'gemini-4-argon', {catalogs})!;
  assert.deepEqual([exact.confidence, exact.model.catalog, exact.model.window], ['exact', 'google', 1048576]);
  const alias = table.resolve('antigravity', 'gemini-4-argon-fast', {catalogs})!;
  assert.deepEqual([alias.confidence, alias.model.id], ['alias', 'gemini-4-argon']);
  const normalized = table.resolve('antigravity', 'gemini-4-argon-high', {catalogs})!;
  assert.deepEqual([normalized.confidence, normalized.model.id], ['normalized', 'gemini-4-argon']);
  const inferred = table.resolve('antigravity', 'claude-opus-5-5-medium', {catalogs})!;
  assert.deepEqual([inferred.confidence, inferred.model.catalog, inferred.model.id], ['inferred', 'anthropic', 'claude-opus-5-5']);
  assert.equal(table.resolve('antigravity', 'claude-sonnet-4-5', {catalogs})!.model.id, 'anthropic/claude-sonnet-4-5');
  assert.equal(table.resolve('antigravity', 'only-here', {catalogs})!.model.window, 7777);
  assert.equal(table.resolve('antigravity', 'no-such-model', {catalogs}), undefined);
  assert.equal(table.resolve('gateway', 'gemini-4-argon')!.confidence, 'inferred', 'without a mirror an unknown gateway is only matched by bare id');
  assert.equal(table.resolve('anthropic', 'claude-haiku-4-5')!.model.id, 'claude-haiku-4-5-20251001');
  assert.equal(normalizeModelId('Vendor/Claude-Opus-4.5-20251101:free'), 'claude-opus-4-5');
});

test('the antigravity gateway mirrors google-antigravity, google, anthropic by default; a declared mirror wins', () => {
  const table = fixture();
  assert.deepEqual(table.catalogsFor('antigravity'), ['google-antigravity', 'google', 'anthropic']);
  assert.deepEqual(table.catalogsFor('antigravity', {catalogs: {antigravity: {mirror: 'anthropic'}}}), ['anthropic']);
  assert.deepEqual(table.catalogsFor('gateway'), []);
  // gemini-4-hydrogen is not in google-antigravity, so it falls through to google; the effort suffix is stripped by id normalisation.
  for (const id of ['gemini-4-hydrogen', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh']) {
    const price = table.price('antigravity', id)!;
    assert.deepEqual([price.input, price.output, price.cache_read, price.catalog], [1.5, 7.5, 0.075, 'google'], id);
  }
  assert.equal(table.resolve('antigravity', 'gemini-4-hydrogen-high')!.confidence, 'normalized');
  // The first catalog that knows the model answers: the proxy's own Claude price beats the first-party one.
  assert.deepEqual([table.price('antigravity', 'claude-opus-5-5')!.input, table.price('antigravity', 'claude-opus-5-5')!.catalog], [4, 'google-antigravity']);
  assert.deepEqual([table.price('antigravity', 'claude-opus-5-5', {catalogs: {antigravity: {mirror: 'anthropic'}}})!.input], [5]);
});

test('the shipped table prices antigravity/gemini-4-hydrogen and its effort variants without any [catalogs] entry', () => {
  const hydrogen = tablePrice('google', 'gemini-4-hydrogen')!;
  assert.ok(hydrogen && hydrogen.input > 0 && hydrogen.output > 0);
  for (const id of ['gemini-4-hydrogen', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh']) {
    const price = tablePrice('antigravity', id)!;
    assert.deepEqual([price.input, price.output, price.cache_read], [hydrogen.input, hydrogen.output, hydrogen.cache_read], id);
    assert.notEqual(price.confidence, 'inferred', id);
    assert.deepEqual([modelPrice({models: {}, catalogs: {}}, 'antigravity', id)?.input], [hydrogen.input], id);
  }
  assert.equal(modelPrice({models: {'antigravity/gemini-4-hydrogen-high': {prices: {currency: 'USD', input: 9}}}, catalogs: {}}, 'antigravity', 'gemini-4-hydrogen-high')?.input, 9, 'a configured price still wins');
});

test('dated rate cards: the card in force at the time answers, and the base card before the first date', () => {
  const table = fixture();
  const at = (when: number) => { const price = table.price('google', 'gemini-4-argon', {at: when})!; return [price.input, price.output, price.cache_read]; };
  assert.deepEqual(at(SWITCH - 1), [2, 10, 0.1]);
  assert.deepEqual(at(SWITCH), [4, 20, 0.2]);
  assert.deepEqual(at(SWITCH + 86_400_000 * 400), [4, 20, 0.2]);
  assert.deepEqual(at(0), [2, 10, 0.1]);
  const now = table.price('google', 'gemini-4-argon')!;
  assert.deepEqual([now.input, now.output], Date.now() >= SWITCH ? [4, 20] : [2, 10], 'without `at` the card in force now applies');
  assert.deepEqual([table.price('google', 'gemini-4-hydrogen', {at: SWITCH * 2})!.input], [1.5], 'a model without dated cards is unaffected');
});

test('price lookup carries cache rates, tiers and the subscription flag', () => {
  const table = fixture();
  const opus = table.price('anthropic', 'claude-opus-5-5')!;
  assert.deepEqual([opus.input, opus.output, opus.cache_read, opus.cache_write, opus.subscription, opus.currency], [5, 25, 0.5, 6.25, false, 'USD']);
  assert.deepEqual(opus.tiers, [{above: 200000, input: 10, output: 37.5, cache_read: 1, cache_write: 12.5}]);
  const codex = table.price('openai', 'gpt-6.1-sol', {oauth: true})!;
  assert.deepEqual([codex.catalog, codex.subscription], ['openai-codex', true]);
  assert.deepEqual([table.price('openai', 'gpt-6.1-sol')!.catalog, table.price('openai', 'gpt-6.1-sol')!.subscription], ['openai', false]);
  assert.equal(table.price('antigravity', 'gemini-4-argon', {catalogs: {antigravity: {mirror: 'google', subscription: true}}})!.subscription, true);
  assert.equal(isSubscriptionProvider('openai', {oauth: true}), true);
  assert.equal(isSubscriptionProvider('anthropic'), false);
});

test('user prices win over the table and gateway mapping reaches modelPrice', () => {
  const catalogs = {antigravity: {mirror: ['google'], aliases: {'gemini-4-argon-high': 'gemini-4-argon'}}};
  const models = {'antigravity/gemini-4-argon-high': {prices: {currency: 'CNY', input: 1}}};
  assert.deepEqual(modelPrice({models, catalogs}, 'antigravity', 'gemini-4-argon-high'), {currency: 'CNY', input: 1});
  const mapped = modelPrice({models: {}, catalogs}, 'antigravity', 'gemini-4-argon-high');
  assert.equal(mapped?.currency, 'USD');
  assert.ok(mapped?.input && mapped.input > 0 && mapped.output);
  assert.equal(modelPrice({models: {}}, 'deepseek', 'deepseek-flash')?.currency, 'USD');
});

test('thinking levels map onto LOGOX efforts (xhigh to max, minimal to low) and ignore low-confidence matches', () => {
  const table = fixture();
  assert.deepEqual(thinkingHint(table.resolve('google', 'gemini-4-argon')), ['low', 'medium', 'high'], 'minimal and low collapse into low; mandatory effort has no off');
  assert.deepEqual(thinkingHint(table.resolve('google', 'gemini-4-hydrogen')), ['low', 'medium', 'high', 'max'], 'xhigh becomes max');
  assert.deepEqual(thinkingHint(table.resolve('anthropic', 'claude-opus-5-5')), ['off', 'low', 'medium', 'high', 'max']);
  assert.equal(thinkingHint(table.resolve('antigravity', 'claude-opus-5-5-medium', {catalogs: {antigravity: {mirror: 'google'}}})), undefined);
  assert.equal(thinkingHint(table.resolve('anthropic', 'claude-haiku-4-5')), undefined);
  assert.equal(thinkingHint(table.resolve('xai', 'grok-fixed')), undefined, 'a reasoning model without an effort control offers no levels');
});

test('shipped table covers current vendors and the configured gateway models', () => {
  assert.ok(modelTable.data.version && modelTable.data.providers.openai && modelTable.data.providers['openai-codex'] && modelTable.data.providers['google-antigravity'] && modelTable.data.providers.moonshotai);
  assert.equal(modelTable.data.source, '@oh-my-pi/pi-catalog');
  assert.equal(tablePrice('deepseek', 'deepseek-flash')?.confidence, 'exact');
  assert.equal(modelTable.resolve('openai', 'gpt-5.6-luna')?.confidence, 'exact');
  assert.ok(Object.keys(modelTable.data.providers).every(name => !/token-plan|bedrock/.test(name)));
  const argon = tablePrice('google', 'gemini-4-argon', {at: Date.UTC(2026, 10, 14)})!, later = tablePrice('google', 'gemini-4-argon', {at: Date.UTC(2026, 11, 2)})!;
  assert.deepEqual([argon.input, argon.output, later.input, later.output], [2, 10, 4, 20], 'the shipped dated card switches on 2026-12-01');
});

async function registryWith(config: Record<string, unknown>) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-model-table-'));
  const loaded = await loadConfig(cwd, config, {}, cwd, cwd);
  return {registry: new ProviderRegistry(loaded, {}, fetch, new AuthStorage(join(cwd, 'auth.json'))), async cleanup() {await rm(cwd, {recursive: true, force: true});}};
}

test('capacity precedence: user config, model override, table, then base and heuristics', async () => {
  const f = await registryWith({provider: {name: 'anthropic', model: 'claude-sonnet-4-5'}, models: {'anthropic/claude-opus-4-5': {context_window: 12345, max_output_tokens: 99}}});
  try {
    assert.equal(f.registry.capacity().window, 200000, 'the table (200k) outranks the hand-written 1M base entry');
    assert.deepEqual([f.registry.capacity('anthropic', 'claude-opus-4-5').window, f.registry.capacity('anthropic', 'claude-opus-4-5').maxOutput], [12345, 99]);
    assert.equal(f.registry.capacity('openai', 'gpt-realtime-2.1').window, 128000, 'ids missing from the table fall back to the base table');
    assert.equal(f.registry.capacity('deepseek', 'deepseek-v4-pro').window, 1048576, 'the table lists 1048576 (the hand-written base says 1000000)');
  } finally {await f.cleanup();}
});

test('gateway catalog mapping resolves windows and aliases; bare-id matches are low confidence', async () => {
  const f = await registryWith({provider: {name: 'antigravity', model: 'gemini-4-argon-high'},
    catalogs: {antigravity: {mirror: 'google', aliases: {'gemini-4-argon-high': 'gemini-4-argon'}}}});
  try {
    assert.equal(f.registry.capacity().window, 1048576);
    assert.equal(f.registry.capacity().maxOutput, modelTable.resolve('google', 'gemini-4-argon')!.model.maxOutput);
    assert.equal(f.registry.tableHit('antigravity', 'gemini-4-argon-high')?.confidence, 'alias');
    assert.ok(f.registry.capacity('antigravity', 'claude-opus-5-5-medium').window > 0);
    assert.equal(f.registry.tableHit('antigravity', 'claude-opus-5-5-medium')?.confidence, 'inferred');
  } finally {await f.cleanup();}
});

test('the antigravity endpoint resolves hydrogen variants through its default mirror in a registry without [catalogs]', async () => {
  const f = await registryWith({provider: {name: 'antigravity', model: 'gemini-4-hydrogen-high'}});
  try {
    const hit = f.registry.tableHit('antigravity', 'gemini-4-hydrogen-high');
    assert.deepEqual([hit?.confidence, hit?.model.catalog, hit?.model.id], ['normalized', 'google', 'gemini-4-hydrogen']);
    assert.equal(f.registry.capacity().window, 1048576);
  } finally {await f.cleanup();}
});

test('catalogs config validates strictly', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-model-table-'));
  try {
    await assert.rejects(loadConfig(cwd, {permissions: {mode: 'default'}, catalogs: {x: {mirror: '', aliases: {}}}}, {}, cwd, cwd));
    await assert.rejects(loadConfig(cwd, {permissions: {mode: 'default'}, catalogs: {x: {catalog: 'google'}}}, {}, cwd, cwd));
    const ok = await loadConfig(cwd, {permissions: {mode: 'default'}, catalogs: {x: {mirror: ['google', 'anthropic']}}}, {}, cwd, cwd);
    assert.deepEqual(ok.catalogs.x, {mirror: ['google', 'anthropic'], aliases: {}});
  } finally {await rm(cwd, {recursive: true, force: true});}
});
