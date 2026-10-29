import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runLoginWizard, type LoginWizardDeps, type WizardAnswer, type WizardQuestion} from '../src/providers/login-wizard.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {LoginFlow} from '../src/providers/login.js';
import {AuthStorage, type OAuthToken} from '../src/providers/auth.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {createProvider} from '../src/providers/http.js';
import {ProviderRegistry} from '../src/providers/registry.js';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function scripted(values: readonly (string | null)[]) {
  const questions: WizardQuestion[] = [];
  const ask = async (question: WizardQuestion): Promise<WizardAnswer> => {
    questions.push(question);
    assert.ok(questions.length <= values.length, 'Unexpected question: ' + question.title);
    const value = values[questions.length - 1];
    return value === null ? {status: 'cancelled'} : {status: 'answered', value: value!};
  };
  return {questions, ask};
}
function deps(ask: LoginWizardDeps['ask'], overrides: Partial<LoginWizardDeps> = {}) {
  const calls: string[] = [];
  const value: LoginWizardDeps = {
    ask, notify: text => calls.push('notice:' + text),
    rows: async () => [{name: 'deepseek', custom: false, saved: true, baseUrl: 'https://api.deepseek.com', kind: 'openai_compat'},
      {name: 'local-proxy', custom: true, saved: true, baseUrl: 'http://127.0.0.1:9000/v1', kind: 'openai_compat', models: ['old-model']}],
    catalog: () => [{name: 'deepseek', custom: false, saved: false, baseUrl: 'https://api.deepseek.com', kind: 'openai_compat'}],
    saveKey: async (name, key) => {calls.push('key:' + name + ':' + key);},
    saveCustom: async record => {calls.push('custom:' + JSON.stringify(record));},
    removeCustom: async name => {calls.push('remove:' + name);},
    browserLogin: async name => {calls.push('oauth:' + name); return 'done';}, ...overrides,
  };
  return {deps: value, calls};
}
test('login root has only Add/Edit; Add has API, endpoint and account branches', async () => {
  const {ask, questions} = scripted(['add', null]); const {deps: input} = deps(ask);
  assert.equal(await runLoginWizard(input), 'cancelled');
  assert.deepEqual(questions[0]!.options?.map(option => option.id), ['add', 'edit']);
  assert.deepEqual(questions[1]!.options?.map(option => option.id), ['api', 'url', 'account']);
});
test('custom add follows route → masked key → connection → models → confirmation', async () => {
  const {ask, questions} = scripted(['add', 'url', 'my-proxy', '', '8045', 'responses', 'fixture-model', 'write']);
  const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'added');
  assert.equal(questions[3]!.secret, true); assert.equal(questions[3]!.allowEmpty, true);
  assert.equal(questions[5]!.options?.length, 3);
  assert.ok(calls.some(call => call.includes('"api":"responses"') && call.includes('http://127.0.0.1:8045/v1')));
  assert.ok(!calls.some(call => call.startsWith('key:')));
});
test('custom Add cannot reuse an existing route and silently inherit its saved credential', async () => {
  for (const name of ['local-proxy', 'deepseek']) {
    const script = scripted(['add', 'url', name]);
    let discovered = false, committed = false;
    const fixture = deps(script.ask, {discoverModels: async () => {discovered = true; return ['fixture'];},
      commitProvider: async () => {committed = true;}});
    assert.equal(await runLoginWizard(fixture.deps), 'failed');
    assert.equal(script.questions.length, 3, 'Reject collisions before asking for keys or endpoints');
    assert.equal(discovered, false); assert.equal(committed, false);
    assert.ok(fixture.calls.every(call => call.startsWith('notice:')), 'No credential or provider write occurs');
    assert.ok(fixture.calls.some(call => /exist|edit/i.test(call)));
  }
});

test('catalog add inherits endpoint/protocol and can retain whole catalog', async () => {
  const {ask, questions} = scripted(['add', 'api', 'deepseek', 'fixture-key', 'default', '', 'write']);
  const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'added');
  assert.ok(!questions.some(question => question.question.includes('wire protocol')));
  assert.ok(calls.some(call => call.includes('"catalog":true') && call.includes('"models":[]')));
  assert.ok(calls.includes('key:deepseek:fixture-key'));
});
test('OAuth account goes directly to browser login, not another API-key menu', async () => {
  const {ask, questions} = scripted(['add', 'account', 'openai']); const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'signed-in');
  assert.equal(questions.length, 3); assert.ok(calls.includes('oauth:openai'));
});
test('single account Cancel sentinel never starts login or asks for a key', async () => {
  const {ask, questions} = scripted(['add', 'account', '__cancel']); const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'cancelled'); assert.equal(questions.length, 3); assert.deepEqual(calls, []);
});
test('edit is a targeted field change; deletion needs confirmation', async () => {
  const {ask, questions} = scripted(['edit', 'local-proxy', 'url', '9100']); const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'updated');
  assert.ok(calls.some(call => call.includes('http://127.0.0.1:9100/v1') && call.includes('old-model')));
  assert.ok(!questions.some(question => question.secret));
  const cancelled = scripted(['edit', 'local-proxy', 'delete', 'cancel']); const cancelDeps = deps(cancelled.ask);
  assert.equal(await runLoginWizard(cancelDeps.deps), 'cancelled'); assert.deepEqual(cancelDeps.calls, []);
});
test('catalog edit omits connection fields; unchanged protocol and blank key do not write', async () => {
  const a = scripted(['edit', 'deepseek', null]), da = deps(a.ask); await runLoginWizard(da.deps);
  assert.deepEqual(a.questions[2]!.options?.map(option => option.id), ['key', 'models', 'delete']);
  for (const answers of [['edit', 'local-proxy', 'protocol', 'completions'], ['edit', 'local-proxy', 'key', '']]) {
    const s = scripted(answers), d = deps(s.ask); assert.equal(await runLoginWizard(d.deps), 'cancelled'); assert.deepEqual(d.calls, []);
  }
});
test('cancelling final confirmation leaves storage untouched and summaries redact keys', async () => {
  const s = scripted(['add', 'url', 'new-route', 'fixture-secret', '8045', 'completions', 'model', 'cancel']);
  const d = deps(s.ask); assert.equal(await runLoginWizard(d.deps), 'cancelled');
  assert.ok(!JSON.stringify(s.questions).includes('fixture-secret')); assert.deepEqual(d.calls, []);
});
test('saved Responses protocol reaches the Responses wire endpoint after reload', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-wire-'));
  try {
    const storage = new CustomProviderStorage(join(cwd, 'custom.json'));
    await storage.save({name: 'gateway', base_url: 'https://example.invalid/v1', kind: 'openai_compat', api: 'responses', models: ['fixture']});
    const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'fixture'}}, {}, cwd, cwd);
    const registry = new ProviderRegistry(config, {}, async () => {throw new Error('No real network');}, new AuthStorage(join(cwd, 'auth.json')), storage);
    await registry.syncCustom();
    const settings = await registry.candidate('gateway', 'fixture').settings(false);
    assert.equal(settings.api, 'responses');
    let requested = '';
    const provider = createProvider(settings, async input => {requested = String(input);
      return new Response('data: ' + JSON.stringify({type: 'response.output_text.delta', delta: 'Ready'}) + '\n\n' +
        'data: ' + JSON.stringify({type: 'response.completed', response: {status: 'completed'}}) + '\n\n');});
    const turn = await provider.respond({system: '', messages: [{role: 'user', text: 'Fixture'}], tools: []}, () => {}, new AbortController().signal);
    assert.equal(turn.message.text, 'Ready'); assert.equal(requested, 'https://example.invalid/v1/responses');
    assert.deepEqual(await registry.modelsFor('gateway', new AbortController().signal), ['fixture']);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('account login waits for OAuth completion and never opens a key/method question', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-oauth-local-'));
  const auth = new AuthStorage(join(cwd, 'auth.json'));
  const token = deferred<OAuthToken>();
  const phases: string[] = [];
  const flow = new LoginFlow(auth, () => ['openai'], () => {}, new CustomProviderStorage(join(cwd, 'custom.json')),
    async () => {throw new Error('Network must not be used');}, undefined,
    async () => {throw new Error('External import must not be scanned');},
    async () => ({authUrl: 'https://example.invalid/auth', waitForToken: () => token.promise, cancel: () => token.reject(new Error('cancelled'))}));
  flow.subscribe(() => {const state = flow.getSnapshot(); if (state) phases.push(state.phase);});
  try {
    let settled = false;
    const result = flow.browserLogin('openai').then(result => {settled = true; return result;});
    for (let i = 0; i < 100 && !flow.getSnapshot()?.oauthUrl; i++) await delay(1);
    assert.equal(settled, false); assert.equal(flow.getSnapshot()?.phase, 'oauth');
    assert.ok(!phases.includes('method')); assert.ok(!phases.includes('key'));
    token.resolve({access_token: 'fixture-token'});
    assert.equal(await result, 'done'); assert.equal((await auth.credential('openai'))?.type, 'oauth');
  } finally {await flow.close(); await rm(cwd, {recursive: true, force: true});}
});
test('cancelling pending OAuth never reopens the old method selector', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-oauth-cancel-'));
  const token = deferred<OAuthToken>();
  const flow = new LoginFlow(new AuthStorage(join(cwd, 'auth.json')), () => ['openai'], () => {}, new CustomProviderStorage(join(cwd, 'custom.json')),
    async () => {throw new Error('No network');}, undefined, async () => [],
    async () => ({authUrl: 'https://example.invalid/auth', waitForToken: () => token.promise, cancel: () => {}}));
  try {
    const result = flow.browserLogin('openai');
    for (let i = 0; i < 100 && !flow.getSnapshot()?.oauthUrl; i++) await delay(1);
    flow.cancel();
    let nextSettled = false;
    const next = flow.ask({title: 'New form', question: 'Keep this question'}).then(answer => {nextSettled = true; return answer;});
    token.reject(new Error('cancelled'));
    assert.equal(await result, 'cancelled');
    assert.equal(flow.getSnapshot()?.phase, 'wizard'); assert.equal(nextSettled, false);
    flow.cancel(); await next;
  } finally {await flow.close(); await rm(cwd, {recursive: true, force: true});}
});

test('editing configured Responses models preserves protocol and connection settings and authenticates discovery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-edit-'));
  const authPath = join(cwd, 'auth.json');
  try {
    await new AuthStorage(authPath).save('test-provider', 'fixture-key', new AbortController().signal);
    const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'fixture'}, providers: {
      'test-provider': {base_url: 'https://example.invalid/v1', kind: 'openai_compat', api: 'responses', default_model: 'fixture-default', api_key_env: 'FIXTURE_KEY'},
    }}, {}, cwd, cwd);
    let authenticated = false;
    const app = await createApplication({cwd, config, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath,
      fetcher: async (_input, init) => {authenticated = new Headers(init?.headers).get('authorization') === 'Bearer fixture-key';
        return new Response(JSON.stringify({data: [{id: 'remote-fixture'}]}));},
      provider: {respond: async () => {throw new Error('No model');}}});
    try {
      const submitted = app.submit('/login');
      const wait = async (key = -1) => {
        for (let i = 0; i < 200; i++) {const state = app.authentication.getSnapshot(); if (state?.wizard && state.wizard.key !== key) return state.wizard; await delay(1);}
        throw new Error('Missing local question');
      };
      let view = await wait();
      for (const id of ['edit', 'test-provider', 'models']) {
        app.authentication.answerWizard({selected: [id]}); view = await wait(view.key);
      }
      assert.equal(authenticated, true);
      assert.ok(view.questions[0]?.options?.some(option => option.id === 'remote-fixture'));
      app.authentication.answerWizard({selected: ['remote-fixture']}); await submitted;
      const record = await new CustomProviderStorage(join(cwd, '.logox', 'custom-providers.json')).get('test-provider');
      assert.equal(record?.api, 'responses'); assert.deepEqual(record?.models, ['remote-fixture']);
      assert.equal(config.providers['test-provider']?.api_key_env, 'FIXTURE_KEY');
      assert.equal(config.providers['test-provider']?.default_model, 'fixture-default');
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('application /login uses local form, never runtime interactions or external imports', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-wizard-'));
  try {
    const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'fixture'}}, {}, cwd, cwd);
    const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'),
      provider: {respond: async () => {throw new Error('Must not invoke model');}}});
    try {
      const submitted = app.submit('/login');
      for (let i = 0; i < 200 && !app.authentication.getSnapshot(); i++) await delay(10);
      const state = app.authentication.getSnapshot(); assert.equal(state?.phase, 'wizard');
      assert.deepEqual(state?.wizard?.questions[0]?.options?.map(option => option.id), ['add', 'edit']);
      assert.equal(app.store.interactions.list().length, 0); assert.equal(app.store.getSnapshot().activities.length, 0);
      app.authentication.cancel(); await submitted;
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});
