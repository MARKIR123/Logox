import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {badgeOf, runLoginWizard, type LoginWizardDeps, type WizardAnswer, type WizardProviderRow, type WizardQuestion} from '../src/providers/login-wizard.js';
import {createApplication} from '../src/application.js';
import {loadConfig, templateNames} from '../src/config/config.js';
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
const template = (name: string, extra: Partial<WizardProviderRow> = {}): WizardProviderRow => ({name, custom: false, saved: false,
  baseUrl: 'https://' + name + '.invalid/v1', kind: 'openai_compat', description: name + ' description', ...extra});
const own = (name: string, extra: Partial<WizardProviderRow> = {}): WizardProviderRow => ({name, custom: true, saved: true,
  baseUrl: 'http://127.0.0.1:9000/v1', kind: 'openai_compat', ...extra});
/** The default list: unset deepseek / openai (account) / antigravity (keyless), and one saved custom provider. */
const rowList: readonly WizardProviderRow[] = [
  template('deepseek', {baseUrl: 'https://api.deepseek.com'}),
  template('openai', {baseUrl: 'https://api.openai.com/v1', account: true}),
  template('antigravity', {baseUrl: 'http://127.0.0.1:8045/v1', keyless: true}),
  own('local-proxy', {models: ['old-model']}),
];
/** deepseek as a provider the user has set up (a record and a stored key). */
const deepseekSetUp = (): readonly WizardProviderRow[] => [template('deepseek', {baseUrl: 'https://api.deepseek.com', saved: true, state: 'signed-in'}), ...rowList.slice(1)];
/** Answers the sign-in method question with `API key` first, and hides it from `questions`, so indices count from the provider list. */
function keyed(values: readonly (string | null)[]) {
  const inner = scripted(['key', ...values]), questions: WizardQuestion[] = [];
  let first = true;
  const ask = async (question: WizardQuestion): Promise<WizardAnswer> => {
    const answer = await inner.ask(question);
    if (first) first = false; else questions.push(question);
    return answer;
  };
  return {questions, ask};
}
function deps(ask: LoginWizardDeps['ask'], overrides: Partial<LoginWizardDeps> = {}) {
  const calls: string[] = [];
  const value: LoginWizardDeps = {
    ask, notify: text => calls.push('notice:' + text),
    rows: async () => rowList,
    saveKey: async (name, key) => {calls.push('key:' + name + ':' + key);},
    saveCustom: async record => {calls.push('custom:' + JSON.stringify(record));},
    removeCustom: async name => {calls.push('remove:' + name);},
    browserLogin: async name => {calls.push('oauth:' + name); return 'done';}, ...overrides,
  };
  return {deps: value, calls};
}
test('one provider list: templates, then own providers and bare credentials, then Custom endpoint; each entry carries origin, state and a description', async () => {
  const rows = [
    template('deepseek', {saved: true, state: 'signed-in', description: 'DeepSeek official API'}),
    template('openai', {account: true, state: 'env-key', description: 'OpenAI API or ChatGPT account'}),
    template('antigravity', {keyless: true, saved: true, state: 'local', description: 'Local Antigravity proxy on port 8045'}),
    template('anthropic', {description: 'Anthropic Claude API'}),
    own('gateway', {state: 'signed-in'}), own('plain'), {name: 'orphan', custom: true, saved: true} satisfies WizardProviderRow,
  ];
  const {ask, questions} = scripted(['key', null]);
  assert.equal(await runLoginWizard(deps(ask, {rows: async () => rows}).deps), 'cancelled');
  assert.equal(questions.length, 2, 'a sign-in method question, then the list: no Add/Edit menu');
  assert.deepEqual(questions[0]!.options?.map(option => [option.id, option.label, option.description]), [
    ['key', 'API key', 'Sign in with a URL and an API key'], ['account', 'Account sign-in', 'Authorize in the browser with a provider account']]);
  const options = questions[1]!.options!;
  assert.deepEqual(options.map(option => option.id), ['deepseek', 'openai', 'antigravity', 'anthropic', 'gateway', 'plain', 'orphan', '__custom']);
  assert.equal(options.at(-1)!.label, 'Custom endpoint');
  assert.equal(options.at(-1)!.description, 'Any OpenAI- or Anthropic-compatible URL with an API key');
  const badge = (id: string) => options.find(option => option.id === id)!.badge!.map(part => part.text).join('');
  assert.deepEqual(['deepseek', 'openai', 'antigravity', 'anthropic', 'gateway', 'plain', 'orphan'].map(badge),
    ['built-in · ✓ signed in', 'built-in · ✓ env key', 'built-in · ✓ local', 'built-in', 'custom · ✓ signed in', 'custom', 'credential only']);
  const tones = (id: string) => options.find(option => option.id === id)!.badge!.map(part => part.tone);
  assert.deepEqual(tones('deepseek'), ['dim', 'dim', 'success'], 'only the check-marked state is coloured');
  assert.deepEqual(tones('anthropic'), ['dim']);
  assert.deepEqual(tones('orphan'), ['warning']);
  assert.deepEqual(options.map(option => option.description), ['DeepSeek official API', 'OpenAI API or ChatGPT account', 'Local Antigravity proxy on port 8045',
    'Anthropic Claude API', 'http://127.0.0.1:9000/v1', 'http://127.0.0.1:9000/v1', 'Saved credential without an endpoint', 'Any OpenAI- or Anthropic-compatible URL with an API key']);
  assert.deepEqual(badgeOf(rows[3]!), [{text: 'built-in', tone: 'dim'}]);
});
test('Custom endpoint follows route → masked key → connection → models → confirmation', async () => {
  const {ask, questions} = keyed(['__custom', 'my-proxy', '', '8045', 'responses', 'fixture-model', 'write']);
  const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'added');
  assert.equal(questions[2]!.secret, true); assert.equal(questions[2]!.allowEmpty, true);
  assert.equal(questions[4]!.options?.length, 3);
  assert.ok(calls.some(call => call.includes('"api":"responses"') && call.includes('http://127.0.0.1:8045/v1')));
  assert.ok(!calls.some(call => call.startsWith('key:')));
});
test('Custom endpoint cannot reuse an existing route and silently inherit its saved credential', async () => {
  for (const name of ['local-proxy', 'deepseek']) {
    const script = keyed(['__custom', name]);
    let discovered = false, committed = false;
    const fixture = deps(script.ask, {discoverModels: async () => {discovered = true; return ['fixture'];},
      commitProvider: async () => {committed = true;}});
    assert.equal(await runLoginWizard(fixture.deps), 'failed');
    assert.equal(script.questions.length, 2, 'Reject collisions before asking for keys or endpoints');
    assert.equal(discovered, false); assert.equal(committed, false);
    assert.ok(fixture.calls.every(call => call.startsWith('notice:')), 'No credential or provider write occurs');
    assert.ok(fixture.calls.some(call => /exist|edit/i.test(call)));
  }
});

test('an unset template pre-fills its URL, asks for it before the key, and can retain the whole catalog', async () => {
  const {ask, questions} = keyed(['deepseek', 'default', 'fixture-key', '', 'write']);
  const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'added');
  assert.ok(!questions.some(question => question.question.includes('wire protocol')));
  assert.match(questions[1]!.question, /base URL/);
  assert.equal(questions[1]!.options?.[0]?.description, 'https://api.deepseek.com', 'the template URL is the default');
  assert.equal(questions[1]!.allowEmpty, true);
  assert.equal(questions[2]!.secret, true, 'the key is asked after the URL');
  assert.ok(calls.some(call => call.includes('"catalog":true') && call.includes('"models":[]') && call.includes('https://api.deepseek.com')));
  assert.ok(calls.includes('key:deepseek:fixture-key'));
});
test('an unset template keeps its URL on Enter and stores a URL the user typed instead', async () => {
  const kept = keyed(['deepseek', '', 'fixture-key', '', 'write']), keptDeps = deps(kept.ask);
  assert.equal(await runLoginWizard(keptDeps.deps), 'added');
  assert.ok(keptDeps.calls.some(call => call.startsWith('custom:') && call.includes('"base_url":"https://api.deepseek.com"')));
  const typed = keyed(['deepseek', 'https://mirror.invalid/v1', 'fixture-key', '', 'write']), typedDeps = deps(typed.ask);
  assert.equal(await runLoginWizard(typedDeps.deps), 'added');
  assert.ok(typedDeps.calls.some(call => call.startsWith('custom:') && call.includes('"base_url":"https://mirror.invalid/v1"') && call.includes('"catalog":true')));
});
const accountRow = (state?: WizardProviderRow['state'], extra: Partial<WizardProviderRow> = {}) =>
  template('openai', {account: true, baseUrl: 'https://api.openai.com/v1', description: 'OpenAI API or ChatGPT account', ...state ? {saved: true, state} : {}, ...extra});
const badgeText = (option: {badge?: readonly {text: string}[]} | undefined) => option?.badge?.map(part => part.text).join('');

test('Account sign-in lists the templates that support it; ✓ account shows only here, and an unset one starts the browser flow', async () => {
  const rows = [template('deepseek'), accountRow(), template('future', {account: true})];
  const account = scripted(['account', 'openai']), accountDeps = deps(account.ask, {rows: async () => rows});
  assert.equal(await runLoginWizard(accountDeps.deps), 'signed-in');
  assert.deepEqual(account.questions[1]!.options?.map(option => option.id), ['openai', 'future'], 'derived from the account property, no Custom endpoint');
  assert.equal(account.questions[1]!.options?.[0]?.description, 'OpenAI API or ChatGPT account');
  assert.deepEqual(accountDeps.calls, ['oauth:openai'], 'no confirmation when nothing is replaced');
  // Each credential state, as shown in the account list and in the API key list.
  const states: [WizardProviderRow['state'], string, string][] = [
    [undefined, 'built-in', 'built-in'], ['account', 'built-in · ✓ account', 'built-in'], ['signed-in', 'built-in', 'built-in · ✓ signed in'],
    ['env-key', 'built-in', 'built-in · ✓ env key']];
  for (const [state, inAccountList, inKeyList] of states) {
    const inAccount = scripted(['account', null]); await runLoginWizard(deps(inAccount.ask, {rows: async () => [accountRow(state)]}).deps);
    assert.equal(badgeText(inAccount.questions[1]!.options![0]), inAccountList, 'account list, state ' + state);
    const inKey = scripted(['key', null]); await runLoginWizard(deps(inKey.ask, {rows: async () => [accountRow(state)]}).deps);
    assert.equal(badgeText(inKey.questions[1]!.options![0]), inKeyList, 'API key list, state ' + state);
  }
  const none = scripted(['account']), noneDeps = deps(none.ask, {rows: async () => [template('deepseek')]});
  assert.equal(await runLoginWizard(noneDeps.deps), 'failed');
  assert.deepEqual(noneDeps.calls, ['notice:Account sign-in is not supported for this provider.']);
  const cancelled = scripted(['account', null]), cancelledDeps = deps(cancelled.ask, {rows: async () => rows});
  assert.equal(await runLoginWizard(cancelledDeps.deps), 'cancelled'); assert.deepEqual(cancelledDeps.calls, [], 'cancelling never starts a login');
});
test('a provider signed in by account opens an account menu: sign in again, models, delete with the in-use confirmation', async () => {
  const rows = async () => [accountRow('account', {models: ['gpt-old']})];
  const menuProbe = scripted(['account', 'openai', null]);
  await runLoginWizard(deps(menuProbe.ask, {rows}).deps);
  assert.deepEqual(menuProbe.questions[2]!.options?.map(option => option.id), ['signin', 'models', 'delete'], 'no API key, Base URL or Wire protocol here');
  const again = scripted(['account', 'openai', 'signin']), againDeps = deps(again.ask, {rows});
  assert.equal(await runLoginWizard(againDeps.deps), 'signed-in'); assert.deepEqual(againDeps.calls, ['oauth:openai']);
  const models = scripted(['account', 'openai', 'models', 'gpt-new']), modelsDeps = deps(models.ask, {rows});
  assert.equal(await runLoginWizard(modelsDeps.deps), 'updated');
  assert.ok(modelsDeps.calls.some(call => call.startsWith('custom:') && call.includes('"name":"openai"') && call.includes('gpt-new') && call.includes('"catalog":true')));
  const removal = scripted(['account', 'openai', 'delete', 'delete']), removalDeps = deps(removal.ask, {rows, users: async () => ['session', 'techne']});
  assert.equal(await runLoginWizard(removalDeps.deps), 'deleted');
  assert.match(removal.questions[3]!.detail ?? '', /^In use by: session, techne\./);
  assert.deepEqual(removalDeps.calls, ['remove:openai']);
});
test('signing in by account over a saved API key asks first and says it replaces the key', async () => {
  const rows = async () => [accountRow('signed-in')];
  const yes = scripted(['account', 'openai', 'continue']), yesDeps = deps(yes.ask, {rows});
  assert.equal(await runLoginWizard(yesDeps.deps), 'signed-in');
  assert.equal(yes.questions[2]!.detail, 'Replaces the saved API key');
  assert.deepEqual(yesDeps.calls, ['oauth:openai']);
  const no = scripted(['account', 'openai', 'cancel']), noDeps = deps(no.ask, {rows});
  assert.equal(await runLoginWizard(noDeps.deps), 'cancelled');
  assert.deepEqual(noDeps.calls, [], 'declining never opens the browser');
  const env = scripted(['account', 'openai']), envDeps = deps(env.ask, {rows: async () => [accountRow('env-key')]});
  assert.equal(await runLoginWizard(envDeps.deps), 'signed-in');
  assert.equal(env.questions.length, 2, 'an environment key is not replaced, so there is nothing to confirm');
});
test('a provider signed in by account is not set up for API keys: saving a key replaces the login and the confirmation says so', async () => {
  const rows = async () => [accountRow('account', {baseUrl: 'https://api.openai.com/v1'})];
  const script = keyed(['openai', 'default', 'fixture-key', '', 'write']), fixture = deps(script.ask, {rows});
  assert.equal(await runLoginWizard(fixture.deps), 'added');
  assert.match(script.questions[1]!.question, /base URL/, 'the normal add flow, not an edit menu');
  assert.match(script.questions[4]!.detail ?? '', /Replaces the account sign-in$/);
  assert.ok(fixture.calls.includes('key:openai:fixture-key'));
  const plain = keyed(['deepseek', 'default', 'fixture-key', '', 'write']), plainDeps = deps(plain.ask);
  await runLoginWizard(plainDeps.deps);
  assert.doesNotMatch(plain.questions[4]!.detail ?? '', /Replaces/, 'nothing is replaced for an ordinary add');
});
test('/login <name> jumps to that provider: the key flow of an unset template, the edit menu of a set-up one', async () => {
  const unset = scripted(['default', 'fixture-key', '', 'write']), unsetDeps = deps(unset.ask);
  assert.equal(await runLoginWizard(unsetDeps.deps, 'deepseek'), 'added');
  assert.match(unset.questions[0]!.question, /base URL/, 'no sign-in method question and no list');
  const setUp = scripted([null]);
  await runLoginWizard(deps(setUp.ask, {rows: async () => deepseekSetUp()}).deps, 'deepseek');
  assert.deepEqual(setUp.questions[0]!.options?.map(option => option.id), ['key', 'url', 'protocol', 'models', 'delete']);
  const unknown = scripted(['key', null]);
  await runLoginWizard(deps(unknown.ask).deps, 'nothing-like-it');
  assert.equal(unknown.questions[0]!.question, 'Choose a sign-in method', 'an unknown name falls back to the wizard root');
});
test('a keyless template is added with an empty key and keeps its template endpoint', async () => {
  const keylessRows = async () => [template('lan-demo', {baseUrl: 'http://127.0.0.1:8045/v1', keyless: true}), template('deepseek')];
  const {ask, questions} = keyed(['lan-demo', '', '', '', 'write']);
  const {deps: input, calls} = deps(ask, {rows: keylessRows});
  assert.equal(await runLoginWizard(input), 'added');
  assert.equal(questions[2]!.allowEmpty, true);
  assert.equal(questions[2]!.secret, true);
  assert.ok(calls.some(call => call.startsWith('custom:') && call.includes('"catalog":true') && call.includes('http://127.0.0.1:8045/v1')));
  assert.ok(!calls.some(call => call.startsWith('key:')));
  const needsKey = keyed(['deepseek', '', '']);
  assert.equal(await runLoginWizard(deps(needsKey.ask).deps), 'cancelled', 'a template that needs a key still requires one');
});
test('selecting a provider that is set up shows its edit menu, which never offers account sign-in', async () => {
  const setUp = keyed(['deepseek', null]);
  await runLoginWizard(deps(setUp.ask, {rows: async () => deepseekSetUp()}).deps);
  assert.deepEqual(setUp.questions[1]!.options?.map(option => option.id), ['key', 'url', 'protocol', 'models', 'delete']);
  const openai = keyed(['openai', null]);
  await runLoginWizard(deps(openai.ask, {rows: async () => [template('openai', {account: true, saved: true, state: 'account'})]}).deps);
  assert.deepEqual(openai.questions[1]!.options?.map(option => option.id), ['default'], 'signed in by account counts as not set up for API keys: the add flow, not an edit menu');
  const signedKey = keyed(['openai', null]);
  await runLoginWizard(deps(signedKey.ask, {rows: async () => [template('openai', {account: true, saved: true, state: 'signed-in'})]}).deps);
  assert.deepEqual(signedKey.questions[1]!.options?.map(option => option.id), ['key', 'url', 'protocol', 'models', 'delete'], 'an account-capable template with a saved key has no Account sign-in item here');
  const custom = keyed(['local-proxy', null]);
  await runLoginWizard(deps(custom.ask).deps);
  assert.deepEqual(custom.questions[1]!.options?.map(option => option.id), ['key', 'url', 'protocol', 'models', 'delete']);
  // A provider that only its environment variable supplies has nothing stored to delete.
  const env = keyed(['anthropic', null]);
  await runLoginWizard(deps(env.ask, {rows: async () => [template('anthropic', {state: 'env-key'})]}).deps);
  assert.deepEqual(env.questions[1]!.options?.map(option => option.id), ['key', 'url', 'protocol', 'models']);
});
test('edit is a targeted field change; deletion needs confirmation', async () => {
  const {ask, questions} = keyed(['local-proxy', 'url', '9100']); const {deps: input, calls} = deps(ask);
  assert.equal(await runLoginWizard(input), 'updated');
  assert.ok(calls.some(call => call.includes('http://127.0.0.1:9100/v1') && call.includes('old-model')));
  assert.ok(!questions.some(question => question.secret));
  const cancelled = keyed(['local-proxy', 'delete', 'cancel']); const cancelDeps = deps(cancelled.ask);
  assert.equal(await runLoginWizard(cancelDeps.deps), 'cancelled'); assert.deepEqual(cancelDeps.calls, []);
});
test('every provider with a record can edit its URL and protocol; unchanged protocol and blank key do not write', async () => {
  const rows = async () => deepseekSetUp();
  const url = keyed(['deepseek', 'url', 'https://mirror.invalid/v1']), urlDeps = deps(url.ask, {rows});
  assert.equal(await runLoginWizard(urlDeps.deps), 'updated');
  assert.ok(urlDeps.calls.some(call => call.startsWith('custom:') && call.includes('"name":"deepseek"') && call.includes('"catalog":true') && call.includes('https://mirror.invalid/v1')));
  const protocol = keyed(['deepseek', 'protocol', 'anthropic']), protocolDeps = deps(protocol.ask, {rows});
  assert.equal(await runLoginWizard(protocolDeps.deps), 'updated');
  assert.ok(protocolDeps.calls.some(call => call.startsWith('custom:') && call.includes('"kind":"anthropic"')));
  for (const answers of [['local-proxy', 'protocol', 'completions'], ['local-proxy', 'key', '']]) {
    const s = keyed(answers), d = deps(s.ask); assert.equal(await runLoginWizard(d.deps), 'cancelled'); assert.deepEqual(d.calls, []);
  }
});
test('cancelling final confirmation leaves storage untouched and summaries redact keys', async () => {
  const s = keyed(['__custom', 'new-route', 'fixture-secret', '8045', 'completions', 'model', 'cancel']);
  const d = deps(s.ask); assert.equal(await runLoginWizard(d.deps), 'cancelled');
  assert.ok(!JSON.stringify(s.questions).includes('fixture-secret')); assert.deepEqual(d.calls, []);
});
test('saved Responses protocol reaches the Responses wire endpoint after reload', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-wire-'));
  try {
    const storage = new CustomProviderStorage(join(cwd, 'custom.json'));
    await storage.save({name: 'gateway', base_url: 'https://example.invalid/v1', kind: 'openai_compat', api: 'responses', models: ['fixture']});
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'deepseek', model: 'fixture'}}, {}, cwd, cwd);
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
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'deepseek', model: 'fixture'}, providers: {
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
      for (const id of ['key', 'test-provider', 'models']) {
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
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'deepseek', model: 'fixture'}}, {}, cwd, cwd);
    const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'),
      provider: {respond: async () => {throw new Error('Must not invoke model');}}});
    try {
      const submitted = app.submit('/login');
      for (let i = 0; i < 200 && !app.authentication.getSnapshot(); i++) await delay(10);
      const state = app.authentication.getSnapshot(); assert.equal(state?.phase, 'wizard');
      assert.deepEqual(state?.wizard?.questions[0]?.options?.map(option => option.id), ['key', 'account'], 'the root is the sign-in method');
      assert.equal(app.store.interactions.list().length, 0); assert.equal(app.store.getSnapshot().activities.length, 0);
      app.authentication.cancel(); await submitted;
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('login wizard groups models by family and expands toggled families to full tier variants', async () => {
  const script = keyed(['__custom', 'tier-proxy', '', '8045', 'completions', 'gemini-4-argon', 'write']);
  let committedRecord: any;
  const fixture = deps(script.ask, {
    discoverModels: async () => [
      'gemini-4-argon-low',
      'gemini-4-argon-medium',
      'gemini-4-argon-high',
      'text-embedding-3-small',
    ],
    saveCustom: async record => { committedRecord = record; },
  });

  const outcome = await runLoginWizard(fixture.deps);
  assert.equal(outcome, 'added');

  // Question 5 is model selection (0: list, 1: name, 2: key, 3: url, 4: protocol, 5: models, 6: confirm):
  const modelQuestion = script.questions[5]!;
  assert.ok(modelQuestion.options?.some(opt => opt.id === 'gemini-4-argon'));
  assert.ok(!modelQuestion.options?.some(opt => opt.id.includes('text-embedding')));

  // Committed record has all 3 variants expanded:
  assert.ok(committedRecord);
  assert.deepEqual(committedRecord.models, [
    'gemini-4-argon-low',
    'gemini-4-argon-medium',
    'gemini-4-argon-high',
  ]);
  assert.equal(committedRecord.default_model, 'gemini-4-argon-low');
});
test('a built-in provider that is not set up is added, not edited; a bare credential can only be deleted', async () => {
  const rows = async () => [template('antigravity', {baseUrl: 'http://127.0.0.1:8045/v1'}), {name: 'orphan', custom: true, saved: true} satisfies WizardProviderRow];
  const builtin = keyed(['antigravity', null]), first = deps(builtin.ask, {rows});
  assert.equal(await runLoginWizard(first.deps), 'cancelled');
  assert.match(builtin.questions[1]!.question, /base URL/, 'an unset template opens the add flow');
  const orphan = keyed(['orphan', 'delete', 'delete']), second = deps(orphan.ask, {rows});
  assert.equal(await runLoginWizard(second.deps), 'deleted');
  assert.deepEqual(orphan.questions[1]!.options?.map(option => option.id), ['delete']);
  assert.deepEqual(second.calls, ['remove:orphan']);
});
test('availableModels ignores the enabled subset, and falls back to known models when the endpoint refuses the listing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-models-'));
  try {
    const storage = new CustomProviderStorage(join(cwd, 'custom.json'));
    await storage.save({name: 'gateway', base_url: 'https://example.invalid/v1', kind: 'openai_compat', models: ['picked']});
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'deepseek', model: 'fixture'}}, {}, cwd, cwd);
    const signal = new AbortController().signal;
    const listing = new ProviderRegistry(config, {}, async () => Response.json({data: [{id: 'picked'}, {id: 'other'}]}), new AuthStorage(join(cwd, 'auth.json')), storage);
    await listing.syncCustom();
    assert.deepEqual(await listing.modelsFor('gateway', signal), ['picked']);
    assert.deepEqual(await listing.availableModels('gateway', signal), ['other', 'picked']);
    // A subscription login cannot list models: the edit screen must still offer the built-in catalog instead of an empty list.
    const refused = new ProviderRegistry(config, {}, async () => new Response('', {status: 401}), new AuthStorage(join(cwd, 'auth2.json')), storage);
    assert.ok((await refused.availableModels('openai', signal, false)).length > 0);
    await assert.rejects(refused.modelsFor('openai', signal), /not logged in/);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('deleting a provider names who uses it in the confirmation, and says nothing when nobody does', async () => {
  const busy = keyed(['local-proxy', 'delete', 'delete']), busyDeps = deps(busy.ask, {users: async name => name === 'local-proxy' ? ['session', 'techne', 'kalon'] : []});
  assert.equal(await runLoginWizard(busyDeps.deps), 'deleted');
  assert.match(busy.questions[2]!.detail ?? '', /^In use by: session, techne, kalon\./);
  assert.deepEqual(busyDeps.calls, ['remove:local-proxy']);
  const cancelled = keyed(['local-proxy', 'delete', 'cancel']), cancelledDeps = deps(cancelled.ask, {users: async () => ['techne']});
  assert.equal(await runLoginWizard(cancelledDeps.deps), 'cancelled');
  assert.deepEqual(cancelledDeps.calls, [], 'cancelling leaves everything in place');
  const idle = keyed(['local-proxy', 'delete', 'delete']), idleDeps = deps(idle.ask, {users: async () => []});
  assert.equal(await runLoginWizard(idleDeps.deps), 'deleted');
  assert.equal(idle.questions[2]!.detail, undefined);
});
