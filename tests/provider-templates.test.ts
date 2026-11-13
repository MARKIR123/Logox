import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {ModelPool} from '../src/providers/model-pool.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {accountTemplateNames, loadConfig, presets, templateNames, type Config} from '../src/config/config.js';
import {accountProviders} from '../src/providers/login.js';
import {AuthStorage} from '../src/providers/auth.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {createApplication} from '../src/application.js';

const signal = () => new AbortController().signal;
async function fixture(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'logox-templates-'));
  const config: Config = await loadConfig(root, {permissions: {mode: 'default'}, provider: {name: 'deepseek', model: 'fixture'}, ...overrides}, {}, root, root);
  const auth = new AuthStorage(join(root, 'auth.json')), store = new CustomProviderStorage(join(root, '.logox', 'custom-providers.json'));
  const registry = new ProviderRegistry(config, env, async () => {throw new Error('No real network');}, auth, store);
  return {root, config, auth, store, registry, done: () => rm(root, {recursive: true, force: true})};
}

test('names() lists saved records, then config providers, then environment templates, then the selection', async () => {
  const f = await fixture({provider: {name: 'anthropic', model: 'fixture'},
    providers: {'toml-gateway': {base_url: 'https://toml.invalid/v1', kind: 'openai_compat'}}}, {DEEPSEEK_API_KEY: 'present'});
  try {
    await f.store.save({name: 'saved-gateway', base_url: 'https://saved.invalid/v1', kind: 'openai_compat'});
    await f.registry.syncCustom();
    // Record, TOML (the store record also sits in the config after syncing, but is listed once), environment template, selected provider.
    assert.deepEqual(f.registry.names(), ['saved-gateway', 'toml-gateway', 'deepseek', 'anthropic']);
  } finally {await f.done();}
});

test('a template nobody set up is not a provider, but stays a template', async () => {
  const f = await fixture();
  try {
    await f.registry.syncCustom();
    assert.deepEqual(f.registry.names(), ['deepseek'], 'only the selected provider is listed');
    for (const name of ['openai', 'anthropic', 'antigravity', 'openai-compatible']) assert.ok(!f.registry.names().includes(name), name);
    assert.deepEqual(f.registry.templateNames(), templateNames());
    assert.ok(f.registry.templateNames().includes('antigravity'));
    // Without the environment variable the template is absent; with it, zero-setup use keeps working.
    const withEnvironment = new ProviderRegistry(f.config, {ANTHROPIC_API_KEY: 'present'}, undefined, f.auth, f.store);
    assert.ok(withEnvironment.names().includes('anthropic'));
    assert.ok(!f.registry.names().includes('anthropic'));
  } finally {await f.done();}
});

test('reconciliation writes a record for a template credential and leaves an unknown credential alone', async () => {
  const f = await fixture();
  try {
    await f.auth.save('anthropic', 'fixture-key', signal());
    await f.auth.save('orphan', 'fixture-key', signal());
    await f.registry.syncCustom();
    const record = await f.store.get('anthropic');
    assert.deepEqual(record, {name: 'anthropic', base_url: presets.anthropic!.base_url, kind: 'anthropic', catalog: true});
    assert.equal(await f.store.get('orphan'), undefined);
    assert.ok(!f.registry.names().includes('orphan'));
    assert.deepEqual((await f.auth.providers()).sort(), ['anthropic', 'orphan'], 'credentials are never deleted');
    assert.ok(f.registry.names().includes('anthropic'));
  } finally {await f.done();}
});

test('a catalog record takes endpoint and protocol from the template, a plain record keeps its own', async () => {
  const f = await fixture();
  try {
    await f.store.save({name: 'deepseek', base_url: 'https://stale.invalid/v1', kind: 'anthropic', catalog: true, models: ['m1'], default_model: 'm1'});
    await f.store.save({name: 'openai', base_url: 'https://stale.invalid/v1', kind: 'openai_compat', api: 'responses'});
    await f.store.save({name: 'retired-template', base_url: 'https://retired.invalid/v1', kind: 'anthropic', catalog: true});
    await f.registry.syncCustom();
    const catalog = f.registry.configuredSettings('deepseek');
    assert.equal(catalog.baseUrl, presets.deepseek!.base_url);
    assert.equal(catalog.kind, 'openai_compat');
    assert.deepEqual(await f.registry.modelsFor('deepseek', signal()), ['m1']);
    assert.equal(f.registry.configuredSettings('openai', 'fixture').baseUrl, 'https://stale.invalid/v1', 'without catalog the stored URL stands');
    const retired = f.registry.configuredSettings('retired-template', 'fixture');
    assert.equal(retired.baseUrl, 'https://retired.invalid/v1', 'a catalog record whose name is no longer a template is plain');
    assert.equal(retired.kind, 'anthropic');
  } finally {await f.done();}
});

test('a keyless template gets a record on request and is removed with its credential', async () => {
  const f = await fixture();
  try {
    await f.registry.ensureTemplateRecord('antigravity');
    assert.equal((await f.store.get('antigravity'))?.catalog, true);
    assert.ok(f.registry.names().includes('antigravity'));
    await f.registry.ensureTemplateRecord('not-a-template');
    assert.equal(await f.store.get('not-a-template'), undefined);
    await f.auth.save('antigravity', 'fixture-key', signal());
    await f.registry.unregister('antigravity');
    assert.equal(await f.store.get('antigravity'), undefined);
    assert.equal(await f.auth.key('antigravity'), '');
    assert.ok(!f.registry.names().includes('antigravity'));
  } finally {await f.done();}
});

test('account sign-in is a template property', () => {
  assert.deepEqual(accountTemplateNames(), Object.keys(presets).filter(name => presets[name]!.account));
  assert.deepEqual([...accountProviders], accountTemplateNames());
  assert.ok(accountTemplateNames().includes('openai') && !accountTemplateNames().includes('anthropic'));
});

test('/login Add lists every template and marks the ones already set up', async () => {
  const f = await fixture();
  try {
    await f.store.save({name: 'deepseek', base_url: presets.deepseek!.base_url, kind: 'openai_compat', catalog: true});
    const app = await createApplication({cwd: f.root, config: f.config, resourceOptions: {home: f.root, boundary: f.root}, env: {}, authPath: join(f.root, 'auth.json'),
      provider: {respond: async () => {throw new Error('Must not invoke model');}}});
    try {
      const submitted = app.submit('/login');
      const wait = async (key = -1) => {
        for (let i = 0; i < 300; i++) {const state = app.authentication.getSnapshot(); if (state?.wizard && state.wizard.key !== key) return state.wizard; await delay(5);}
        throw new Error('Missing local question');
      };
      let view = await wait();
      for (const id of ['add', 'api']) {app.authentication.answerWizard({selected: [id]}); view = await wait(view.key);}
      const options = view.questions[0]!.options!;
      assert.deepEqual(options.map(option => option.id), templateNames());
      assert.equal(options.find(option => option.id === 'deepseek')!.description, 'Already set up');
      assert.equal(options.find(option => option.id === 'anthropic')!.description, '');
      app.authentication.cancel(); await submitted;
    } finally {await app.close();}
  } finally {await f.done();}
});

test('saving a key for an environment-only template through Edit creates its provider record', async () => {
  const f = await fixture();
  try {
    const app = await createApplication({cwd: f.root, config: f.config, resourceOptions: {home: f.root, boundary: f.root}, env: {ANTHROPIC_API_KEY: 'from-environment'}, authPath: join(f.root, 'auth.json'),
      provider: {respond: async () => {throw new Error('Must not invoke model');}}, fetcher: async () => new Response('', {status: 500})});
    try {
      const submitted = app.submit('/login');
      const wait = async (key = -1) => {
        for (let i = 0; i < 300; i++) {const state = app.authentication.getSnapshot(); if (state?.wizard && state.wizard.key !== key) return state.wizard; await delay(5);}
        throw new Error('Missing local question');
      };
      let view = await wait();
      app.authentication.answerWizard({selected: ['edit']}); view = await wait(view.key);
      const listed = view.questions[0]!.options!.find(option => option.id === 'anthropic');
      assert.equal(listed?.description, 'Built-in, not set up yet', 'an environment-only template is listed with the not-set-up label');
      assert.ok(!view.questions[0]!.options!.some(option => option.id === 'openai'), 'a template with nothing behind it is not listed');
      for (const id of ['anthropic', 'key']) {app.authentication.answerWizard({selected: [id]}); view = await wait(view.key);}
      app.authentication.answerWizard({selected: [], custom: 'fixture-key'}); await submitted;
      const record = await new CustomProviderStorage(join(f.root, '.logox', 'custom-providers.json')).get('anthropic');
      assert.equal(record?.catalog, true);
      assert.equal(await new AuthStorage(join(f.root, 'auth.json')).key('anthropic'), 'fixture-key');
    } finally {await app.close();}
  } finally {await f.done();}
});

async function poolFixture(extra: {fetcher?: typeof fetch; file?: string} = {}) {
  const f = await fixture();
  const registry = new ProviderRegistry(f.config, {}, extra.fetcher ?? (async () => Response.json({data: [{id: 'fresh-model'}]})), f.auth, f.store);
  await writeFile(join(f.root, extra.file ?? 'models-store.json'), JSON.stringify({version: 1, updatedAt: 1, models: [
    {provider: 'deepseek', id: 'cached-model'}, {provider: 'google', id: 'ghost-model'}]}));
  return {...f, registry, pool: new ModelPool(registry, join(f.root, 'models-store.json'))};
}
const fileProviders = async (root: string) => (JSON.parse(await readFile(join(root, 'models-store.json'), 'utf8')).models as {provider: string}[]).map(item => item.provider);

test('the model pool hides unlisted providers at once and drops them from the file on the next sync', async () => {
  const f = await poolFixture();
  try {
    await f.registry.syncCustom();
    await f.auth.save('deepseek', 'fixture-key', signal());
    assert.deepEqual(f.pool.snapshot().map(item => item.provider), ['deepseek'], 'the ghost provider is not shown');
    assert.deepEqual(f.pool.resolveShorthand('ghost-model', 'deepseek'), {provider: 'deepseek', model: 'ghost-model'}, 'shorthand never resolves to an unlisted provider');
    assert.deepEqual((await fileProviders(f.root)).sort(), ['deepseek', 'google'], 'the file is untouched until a sync');
    await f.pool.syncProvider('deepseek');
    assert.deepEqual(f.pool.snapshot().map(item => item.id), ['fresh-model']);
    assert.deepEqual(await fileProviders(f.root), ['deepseek'], 'the ghost entries are gone from the file');
  } finally {await f.done();}
});

test('a listed provider that is offline keeps its cached models through refresh, while an unlisted one is dropped', async () => {
  const f = await poolFixture({fetcher: async () => {throw new Error('offline');}});
  try {
    await f.registry.syncCustom();
    await f.pool.refresh();
    assert.deepEqual(f.pool.snapshot().map(item => [item.provider, item.id, item.isOffline]), [['deepseek', 'cached-model', true]]);
    assert.deepEqual(await fileProviders(f.root), ['deepseek']);
  } finally {await f.done();}
});

test('the legacy models-cache.json gets the same read-side filter', async () => {
  const f = await poolFixture({file: 'models-cache.json'});
  try {
    assert.deepEqual(f.pool.snapshot().map(item => item.provider), ['deepseek']);
  } finally {await f.done();}
});
