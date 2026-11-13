import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateOpenAiAccount} from '../src/providers/account-migration.js';
import {AuthStorage, type OAuthToken} from '../src/providers/auth.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {createProvider} from '../src/providers/http.js';
import {loadConfig} from '../src/config/config.js';
import {createApplication} from '../src/application.js';
import {parseActor, serializeActor} from '../src/actors/definitions.js';
import {builtinActors} from '../src/actors/builtins.js';
import {TaskModels} from '../src/actors/task-models.js';
import {ProviderError} from '../src/providers/http.js';
import {modelTable} from '../src/providers/model-table.js';

const signal = () => new AbortController().signal;
const token: OAuthToken = {access_token: 'eyJfixture-access', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3_600_000, account_id: 'acct'};
const actorFile = (id: string, provider: string) => serializeActor({...builtinActors.find(actor => actor.id === 'techne')!, id, defaultModel: {provider, model: 'gpt-5.5'}});

/** A temp user home and project; every path the migration may touch lives under it. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-migration-'));
  const home = join(root, 'home'), project = join(root, 'project'), other = join(root, 'other-project');
  const logox = join(home, '.logox');
  for (const directory of [logox, join(logox, 'actors'), join(project, '.logox', 'state'), join(project, '.logox', 'actors'), join(other, '.logox', 'state')]) await mkdir(directory, {recursive: true});
  const auth = new AuthStorage(join(logox, 'auth.json')), customStorage = new CustomProviderStorage(join(logox, 'custom-providers.json'));
  const write = (path: string, value: unknown) => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  const files = {
    userPref: join(logox, 'model-preferences.json'), projectPref: join(project, '.logox', 'state', 'model-preferences.json'),
    otherPref: join(other, '.logox', 'state', 'model-preferences.json'), actorModels: join(logox, 'actor-models.json'),
    toolModels: join(logox, 'tool-models.json'), store: join(logox, 'models-store.json'),
    projectActor: join(project, '.logox', 'actors', 'techne.md'), userActor: join(logox, 'actors', 'kalon.md'), otherActor: join(project, '.logox', 'actors', 'aletheia.md'),
  };
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  /** The account sign-in as an existing user has it: credential, record and every reference under the name `openai`. */
  const seed = async () => {
    await auth.saveOAuth('openai', token, signal());
    await auth.save('deepseek', 'sk-deepseek-fixture', signal());
    await customStorage.save({name: 'openai', base_url: 'https://api.openai.com/v1', kind: 'openai_compat', catalog: true, models: ['gpt-5.5', 'gpt-5.4'], default_model: 'gpt-5.5'});
    const selection = {version: 1, provider: 'openai', model: 'gpt-5.5', effort: 'auto'};
    await write(files.userPref, selection); await write(files.projectPref, selection); await write(files.otherPref, selection);
    await write(files.actorModels, {techne: {provider: 'openai', model: 'gpt-5.5'}, kalon: {provider: 'deepseek', model: 'deepseek-flash'}});
    await write(files.toolModels, {automa: {provider: 'openai', model: 'gpt-5.4'}});
    await write(files.store, {version: 1, updatedAt: 1, models: [{provider: 'openai', id: 'gpt-5.5'}, {provider: 'deepseek', id: 'deepseek-flash'}]});
    await write(files.projectActor, actorFile('techne', 'openai')); await write(files.userActor, actorFile('kalon', 'openai')); await write(files.otherActor, actorFile('aletheia', 'deepseek'));
  };
  const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, 'utf8').catch(() => '')])));
  return {root, home, project, other, auth, customStorage, files, seed, read, snapshot, write,
    migrate: (extra: Partial<Parameters<typeof migrateOpenAiAccount>[0]> = {}) => migrateOpenAiAccount({auth, customStorage, home, project, ...extra}),
    done: () => rm(root, {recursive: true, force: true})};
}

test('migrates the credential, record, saved selections, bindings, model store and actor files; other projects and providers stay', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const before = await f.snapshot();
    const result = await f.migrate();
    assert.equal(result.status, 'migrated');
    assert.equal(result.notice, 'OpenAI account sign-in is now the provider openai-auth; your saved model choices were updated.');
    // Credential: moved, identical, and gone from the old name; unrelated credentials untouched.
    const moved = await f.auth.credential('openai-auth');
    assert.equal(moved?.type, 'oauth'); assert.equal(moved?.type === 'oauth' ? moved.access_token : '', token.access_token);
    assert.equal(await f.auth.credential('openai'), undefined);
    assert.equal(await f.auth.key('deepseek'), 'sk-deepseek-fixture');
    // Record: same models and default model, endpoint from the new template; the old record is gone.
    assert.equal(await f.customStorage.get('openai'), undefined);
    assert.deepEqual(await f.customStorage.get('openai-auth'), {name: 'openai-auth', base_url: 'https://api.openai.com/v1', kind: 'openai_compat', catalog: true, models: ['gpt-5.5', 'gpt-5.4'], default_model: 'gpt-5.5'});
    // Saved selections: user level and the current project only.
    assert.equal((await f.read(f.files.userPref)).provider, 'openai-auth');
    assert.equal((await f.read(f.files.projectPref)).provider, 'openai-auth');
    assert.equal((await f.read(f.files.projectPref)).model, 'gpt-5.5');
    assert.equal(await readFile(f.files.otherPref, 'utf8'), before.otherPref, 'another project is not touched');
    // Bindings.
    assert.deepEqual(await f.read(f.files.actorModels), {techne: {provider: 'openai-auth', model: 'gpt-5.5'}, kalon: {provider: 'deepseek', model: 'deepseek-flash'}});
    assert.deepEqual(await f.read(f.files.toolModels), {automa: {provider: 'openai-auth', model: 'gpt-5.4'}});
    assert.deepEqual((await f.read(f.files.store)).models, [{provider: 'openai-auth', id: 'gpt-5.5'}, {provider: 'deepseek', id: 'deepseek-flash'}]);
    // Actor definition files keep working: still parseable, only the provider changed.
    assert.equal(parseActor(await readFile(f.files.projectActor, 'utf8')).defaultModel?.provider, 'openai-auth');
    assert.equal(parseActor(await readFile(f.files.userActor, 'utf8')).defaultModel?.provider, 'openai-auth');
    assert.equal(await readFile(f.files.otherActor, 'utf8'), before.otherActor);
    assert.equal(parseActor(await readFile(f.files.projectActor, 'utf8')).prompt, builtinActors.find(actor => actor.id === 'techne')!.prompt);
    assert.ok(result.rewritten.length === 7);
  } finally {await f.done();}
});

test('does nothing for an API-key openai, and again once everything has moved (idempotent)', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.auth.save('openai', 'sk-openai-fixture', signal());
    const before = await f.snapshot();
    assert.equal((await f.migrate()).status, 'none');
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(await f.auth.key('openai'), 'sk-openai-fixture');
    assert.equal(await f.auth.credential('openai-auth'), undefined);
    // No openai credential at all.
    await f.auth.remove('openai');
    assert.equal((await f.migrate()).status, 'none');
    // A real migration, then a second run.
    await f.auth.saveOAuth('openai', token, signal());
    assert.equal((await f.migrate()).status, 'migrated');
    const migrated = await f.snapshot(), credentials = JSON.stringify(await f.auth.providers());
    const again = await f.migrate();
    assert.equal(again.status, 'none'); assert.equal(again.notice, undefined);
    assert.deepEqual(await f.snapshot(), migrated);
    assert.equal(JSON.stringify(await f.auth.providers()), credentials);
  } finally {await f.done();}
});

test('an existing openai-auth credential is never overwritten: both stay and nothing else moves', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.auth.saveOAuth('openai-auth', {access_token: 'eyJother-account'}, signal());
    const before = await f.snapshot();
    const result = await f.migrate();
    assert.equal(result.status, 'skipped'); assert.equal(result.notice, undefined);
    assert.equal((await f.auth.credential('openai-auth') as {access_token?: string}).access_token, 'eyJother-account');
    assert.equal((await f.auth.credential('openai') as {access_token?: string}).access_token, token.access_token);
    assert.deepEqual(await f.snapshot(), before);
    assert.ok(await f.customStorage.get('openai'));
  } finally {await f.done();}
});

test('a failure while writing the new credential leaves the old one and every reference untouched', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const before = await f.snapshot();
    class Failing extends AuthStorage {
      override async saveOAuth(provider: string, value: OAuthToken, signal: AbortSignal): Promise<void> {
        if (provider === 'openai-auth') throw new Error('disk full');
        return super.saveOAuth(provider, value, signal);
      }
    }
    const failing = new Failing(f.auth.path);
    assert.equal((await f.migrate({auth: failing})).status, 'failed');
    assert.equal((await f.auth.credential('openai'))?.type, 'oauth');
    assert.equal(await f.auth.credential('openai-auth'), undefined);
    assert.ok(await f.customStorage.get('openai')); assert.equal(await f.customStorage.get('openai-auth'), undefined);
    assert.deepEqual(await f.snapshot(), before);
    // Removing the old credential fails after the copy: the copy and the new record are rolled back, the original stays.
    class Stuck extends AuthStorage {
      override async remove(provider: string, signal?: AbortSignal): Promise<void> {
        if (provider === 'openai') throw new Error('locked');
        return super.remove(provider, signal);
      }
    }
    assert.equal((await f.migrate({auth: new Stuck(f.auth.path)})).status, 'failed');
    assert.equal((await f.auth.credential('openai'))?.type, 'oauth');
    assert.equal(await f.auth.credential('openai-auth'), undefined);
    assert.equal(await f.customStorage.get('openai-auth'), undefined);
    assert.deepEqual(await f.snapshot(), before);
    // And a retry with a working store succeeds.
    assert.equal((await f.migrate()).status, 'migrated');
  } finally {await f.done();}
});

test('after the migration both providers can be signed in at once and each resolves its own settings', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.migrate();
    await f.auth.save('openai', 'sk-openai-fixture', signal());
    const config = await loadConfig(f.root, {permissions: {mode: 'default'}, provider: {name: 'deepseek', model: 'deepseek-flash'}}, {}, f.root, f.root);
    const registry = new ProviderRegistry(config, {}, async () => {throw new Error('No real network');}, f.auth, f.customStorage);
    await registry.syncCustom();
    await registry.customStorage.save({name: 'openai', base_url: 'https://api.openai.com/v1', kind: 'openai_compat', catalog: true}); await registry.syncCustom();
    assert.ok(registry.names().includes('openai') && registry.names().includes('openai-auth'));
    const key = await registry.candidate('openai', 'gpt-5.5').settings(), account = await registry.candidate('openai-auth', 'gpt-5.5').settings();
    assert.equal(key.key, 'sk-openai-fixture'); assert.equal(account.key, token.access_token);
    assert.equal(key.baseUrl, account.baseUrl);
    assert.equal(key.thinkingProtocol, 'reasoning-effort'); assert.equal(account.thinkingProtocol, 'reasoning-effort', 'the account provider shares the OpenAI reasoning protocol');
    assert.deepEqual(registry.capacity('openai-auth', 'gpt-5.5'), {...registry.capacity('openai', 'gpt-5.5'), identity: registry.capacity('openai-auth', 'gpt-5.5').identity});
    assert.equal(modelTable.catalogsFor('openai-auth', {oauth: true, baseUrl: 'https://api.openai.com/v1'})[0], 'openai-codex', 'the account provider prefers the subscription catalog');
    assert.ok(registry.tableHit('openai-auth', 'gpt-5.5'));
    // The account always speaks streaming Responses; the key provider keeps Chat Completions.
    const urls: string[] = [];
    const respond = async (settings: typeof key) => {
      await createProvider(settings, async input => {
        urls.push(String(input));
        return new Response('data: ' + JSON.stringify({type: 'response.output_text.delta', delta: 'Ready'}) + '\n\n' + 'data: ' + JSON.stringify({type: 'response.completed', response: {status: 'completed'}}) + '\n\ndata: [DONE]\n\n');
      }).respond({system: '', messages: [{role: 'user', text: 'Fixture'}], tools: []}, () => {}, signal()).catch(() => undefined);
    };
    await respond(account); await respond(key);
    assert.match(urls[0]!, /\/responses$/); assert.match(urls[1]!, /\/chat\/completions$/);
    // Signing the account out leaves the key provider alone, and the account provider then fails explicitly.
    await f.auth.remove('openai-auth');
    await assert.rejects(registry.candidate('openai-auth', 'gpt-5.5').settings(), /not logged in/);
    assert.equal((await registry.candidate('openai', 'gpt-5.5').settings()).key, 'sk-openai-fixture');
  } finally {await f.done();}
});

test('a stale openai reference without its own key fails explicitly instead of falling back to the account', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.migrate();
    const config = await loadConfig(f.root, {permissions: {mode: 'default'}, provider: {name: 'openai', model: 'gpt-5.5'}}, {}, f.root, f.root);
    const registry = new ProviderRegistry(config, {}, async () => {throw new Error('No real network');}, f.auth, f.customStorage);
    await registry.syncCustom();
    await assert.rejects(registry.settings(), error => error instanceof Error && /Provider openai is not logged in/.test(error.message));
    assert.equal((await registry.candidate('openai-auth', 'gpt-5.5').settings()).key, token.access_token);
  } finally {await f.done();}
});

test('startup runs the migration once, moves the live selection and posts one notice', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const config = await loadConfig(f.project, {permissions: {mode: 'default'}}, {}, f.home, f.home);
    assert.equal(config.provider.name, 'openai', 'the saved selection still names openai before the migration');
    const app = await createApplication({cwd: f.project, config, resourceOptions: {home: f.home, boundary: f.root}, sessionId: 'migrate',
      provider: {respond: async () => {throw new Error('Must not invoke model');}}});
    try {
      assert.deepEqual(app.status('logox').model, {provider: 'openai-auth', model: 'gpt-5.5'});
      assert.deepEqual(app.status('techne').model, {provider: 'openai-auth', model: 'gpt-5.5'}, 'the actor binding moved with it');
      assert.equal(JSON.stringify(app.store.getSnapshot()).split('OpenAI account sign-in is now the provider openai-auth').length - 1, 1);
      assert.equal(await f.auth.credential('openai'), undefined);
    } finally {await app.close();}
    const second = await createApplication({cwd: f.project, resourceOptions: {home: f.home, boundary: f.root}, sessionId: 'migrate-again',
      provider: {respond: async () => {throw new Error('Must not invoke model');}}});
    try {assert.ok(!JSON.stringify(second.store.getSnapshot()).includes('OpenAI account sign-in is now'), 'no notice on later starts');}
    finally {await second.close();}
  } finally {await f.done();}
});

test('resuming an old session whose ledger names openai/<model> restores without crashing and fails with the normal not-logged-in error on use', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.migrate();
    const config = await loadConfig(f.root, {permissions: {mode: 'default'}, provider: {name: 'openai-auth', model: 'gpt-5.5'}}, {}, f.root, f.root);
    const registry = new ProviderRegistry(config, {}, async () => {throw new Error('No real network');}, f.auth, f.customStorage);
    await registry.syncCustom();
    const models = new TaskModels({registry, defaultModel: () => undefined});
    const stale = {provider: 'openai', model: 'gpt-5.5'};
    models.restore([{version: 1, sessionId: 'old', ownerId: 'logox', activityId: 'a1', initial: stale, actual: stale, inherited: true, switched: false, phase: 'completed'}]);
    // Display identity is the recorded one (no silent switch to the account provider) ...
    assert.deepEqual(models.selection({sessionId: 'old', ownerId: 'logox'}), {provider: 'openai-auth', model: 'gpt-5.5'}, 'a finished Director task reports the current session model');
    // ... and a restored scope for a companion keeps the recorded identity and fails explicitly when used.
    models.restore([{version: 1, sessionId: 'old', ownerId: 'techne', activityId: 'a2', initial: stale, actual: stale, inherited: true, switched: false, phase: 'started'}]);
    assert.deepEqual(models.selection({sessionId: 'old', ownerId: 'techne'}), stale);
    await assert.rejects(models.summarizer({sessionId: 'old', ownerId: 'techne'}).provider.respond({system: '', messages: [{role: 'user', text: 'x'}], tools: []}, () => {}, signal()),
      error => error instanceof ProviderError && error.category === 'authentication' && /Provider openai is not logged in/.test(error.message));
  } finally {await f.done();}
});
