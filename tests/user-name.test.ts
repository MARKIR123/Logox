import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import stringWidth from 'string-width';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {commandCatalog} from '../src/commands.js';
import {EnvironmentState, formatEnvironment, type ExecutionEnvironment} from '../src/context/environment.js';
import {composeBaseSystemPrompt, PROMPT_CACHE_BOUNDARY} from '../src/prompts/boundary.js';
import {askPreferredName, type WizardAnswer, type WizardQuestion} from '../src/providers/login-wizard.js';
import {ONBOARDING_VERSION, markOnboardingDone, readOnboardingPrefs, shouldOfferOnboarding} from '../src/config/onboarding-preferences.js';
import {loadUserName, sanitizeUserName, saveUserName, setUserLabel, USER_NAME_MAX_CELLS, userLabel} from '../src/config/user-profile.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {ownerHeader} from '../src/tui/appearance/actor-style.js';
import type {ModelRequest} from '../src/runtime/messages.js';

const baseEnv: ExecutionEnvironment = {model: 'p/m', effort: 'auto', permission: 'default', directory: '/w', scratchpad: '/s', rules: 'abc', services: []};
const answering = (answer: WizardAnswer) => async (_question: WizardQuestion) => answer;

test('sanitizeUserName strips control characters, collapses whitespace and caps display cells', () => {
  assert.equal(sanitizeUserName('  Ada\u0000\u0007 \n Lovelace​  '), 'Ada Lovelace');
  assert.equal(sanitizeUserName('\u0007\n\t ​'), '');
  assert.equal(sanitizeUserName('x'.repeat(100)).length, USER_NAME_MAX_CELLS);
  const wide = sanitizeUserName('汉'.repeat(40));
  assert.ok(stringWidth(wide) <= USER_NAME_MAX_CELLS);
  assert.equal(wide.length, USER_NAME_MAX_CELLS / 2);
});

test('preferred name persists atomically under ~/.logox and clears', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-test-name-'));
  try {
    assert.equal(await loadUserName(home), undefined);
    assert.equal(await saveUserName(home, '  Ada \n'), 'Ada');
    assert.equal(await loadUserName(home), 'Ada');
    assert.deepEqual(JSON.parse(await readFile(join(home, '.logox', 'user-profile.json'), 'utf8')), {version: 1, name: 'Ada'});
    assert.equal(await saveUserName(home, undefined), undefined);
    assert.equal(await loadUserName(home), undefined);
    await writeFile(join(home, '.logox', 'user-profile.json'), '{broken');
    assert.equal(await loadUserName(home), undefined, 'a corrupt file never aborts startup');
  } finally {await rm(home, {recursive: true, force: true});}
});

test('onboarding name step returns a typed name and skips on empty Enter or Esc', async () => {
  const seen: WizardQuestion[] = [];
  assert.equal(await askPreferredName(async question => {seen.push(question); return {status: 'answered', value: '  Ada '};}), 'Ada');
  assert.equal(seen[0]!.question, 'What should Logox call you?');
  assert.equal(seen[0]!.allowEmpty, true);
  assert.equal(await askPreferredName(answering({status: 'answered', value: '   '})), undefined);
  assert.equal(await askPreferredName(answering({status: 'cancelled'})), undefined);
  assert.equal(await askPreferredName(answering({status: 'answered', value: '__cancel'})), undefined);
});

test('existing users who completed onboarding are not offered it again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-test-name-onboarding-'));
  try {
    markOnboardingDone(ONBOARDING_VERSION, home);
    assert.equal(shouldOfferOnboarding(readOnboardingPrefs(home)), false, 'the name step adds no onboarding revision');
  } finally {await rm(home, {recursive: true, force: true});}
});

test('environment line is present only when a name is set and is identical for every actor', () => {
  assert.ok(!formatEnvironment(baseEnv).includes('preferred name'));
  const line = "User's preferred name: Ada (address the user by it)";
  assert.ok(formatEnvironment({...baseEnv, userName: 'Ada'}).endsWith(line));
  const prompts = ['logox', 'techne', 'kalon', 'aletheia'].map(ownerId => {
    const withName = composeBaseSystemPrompt({cwd: '/w', ownerId, builtinPrompt: 'Persona', environmentBaseline: formatEnvironment({...baseEnv, userName: 'Ada'})}).system;
    const without = composeBaseSystemPrompt({cwd: '/w', ownerId, builtinPrompt: 'Persona', environmentBaseline: formatEnvironment(baseEnv)}).system;
    assert.ok(withName.includes(line) && !without.includes('preferred name'), ownerId);
    // The name lives in the variable tail, so the cache-stable prefix is byte-identical with and without it.
    assert.equal(withName.split(PROMPT_CACHE_BOUNDARY)[0], without.split(PROMPT_CACHE_BOUNDARY)[0]);
    assert.ok(withName.split(PROMPT_CACHE_BOUNDARY)[1]!.includes(line));
    return withName;
  });
  assert.equal(new Set(prompts.map(prompt => prompt.slice(prompt.indexOf(line)))).size, 1);
});

test('a changed or cleared name is announced as an environment change', () => {
  const state = new EnvironmentState();
  const first = state.plan({...baseEnv, userName: 'Ada'}, []);
  assert.equal(first.updates[0]!.kind, 'environment-baseline');
  const history = [...first.updates] as never;
  assert.deepEqual(state.plan({...baseEnv, userName: 'Ada'}, history).updates, []);
  assert.match(state.plan({...baseEnv, userName: 'Grace'}, history).updates[0]!.text, /preferred name: Grace/);
  assert.match(state.plan(baseEnv, history).updates[0]!.text, /preferred name: none/);
});

test('user speaker header shows the preferred name, defaulting to You', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Hello.', {activityId: 'main', inputKind: 'human'});
  const header = () => buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, null).find(row => row.railGlyph === '❯')!;
  try {
    setUserLabel(undefined);
    assert.match(header().text, /You/);
    assert.equal(ownerHeader('user'), 'You');
    setUserLabel('Ada');
    assert.match(header().text, /Ada/);
    assert.doesNotMatch(header().text, /You/);
    assert.equal(ownerHeader('user'), 'Ada');
  } finally {setUserLabel(undefined);}
});

test('/name is in the command catalog', () => {
  const command = commandCatalog.find(item => item.name === 'name');
  assert.ok(command && command.argument === 'text' && command.usage.startsWith('/name'));
});

test('/name sets, shows and resets the name; the next model request carries it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-test-name-app-')));
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(join(project, '.logox'), {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  await writeFile(join(project, '.logox', 'config.toml'), ['[provider]', 'name="namey"', 'model="m"', '[providers.namey]', 'base_url="https://name.invalid/v1"',
    '[models."namey/m"]', 'context_window=131072', 'thinking_protocol="deepseek"'].join('\n'));
  await writeFile(join(home, '.logox', 'models-store.json'), JSON.stringify({version: 1, updatedAt: Date.now(),
    models: [{provider: 'namey', id: 'm', window: 131072, thinkingLevels: ['auto', 'off', 'low', 'high', 'max']}]}));
  const requests: ModelRequest[] = [];
  const config = await loadConfig(project, {}, {}, home, project);
  const app = await createApplication({cwd: project, config, env: {}, resourceOptions: {home, boundary: project},
    authPath: join(home, '.logox', 'auth.json'), statusbarPath: join(home, '.logox', 'statusbar.json'),
    provider: {async respond(request: ModelRequest) {
      requests.push(request);
      return {message: {role: 'assistant' as const, text: 'Done', toolCalls: [{id: 'f' + requests.length, name: '_FinishRound',
        arguments: JSON.stringify({title: 'Done', summary: 'ok'})}]}, stop: 'tools' as const};
    }}});
  const lastNotice = () => app.store.getSnapshot().messages.filter(message => message.role === 'system').at(-1)?.text;
  try {
    await app.submit('/name');
    assert.match(lastNotice()!, /No preferred name set/);
    await app.submit('/name  Ada \u0007Lovelace ');
    assert.equal(userLabel(), 'Ada Lovelace');
    assert.match(lastNotice()!, /Preferred name set to Ada Lovelace/);
    assert.equal(await loadUserName(home), 'Ada Lovelace');
    await app.submit('/name');
    assert.match(lastNotice()!, /Preferred name: Ada Lovelace/);
    await app.submit('hello');
    const deadline = Date.now() + 10000;
    while (!requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(requests.length, 'the provider received a request');
    assert.match(requests[0]!.system, /User's preferred name: Ada Lovelace \(address the user by it\)/);
    await assert.rejects(app.submit('/name ​'), /Usage/);
    assert.equal(userLabel(), 'Ada Lovelace', 'an unusable name leaves the current one');
    await app.submit('/name --reset');
    assert.equal(userLabel(), 'You');
    assert.equal(await loadUserName(home), undefined);
    assert.match(lastNotice()!, /cleared/);
  } finally {
    setUserLabel(undefined);
    await app.close(); await rm(root, {recursive: true, force: true});
  }
});
