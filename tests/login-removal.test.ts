import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';

async function fixture(selected: 'gw' | 'other', bound = true) {
  const root = await mkdtemp(join(tmpdir(), 'logox-removal-'));
  await mkdir(join(root, '.logox'), {recursive: true});
  const store = new CustomProviderStorage(join(root, '.logox', 'custom-providers.json'));
  await store.save({name: 'gw', base_url: 'https://gw.invalid/v1', kind: 'openai_compat'});
  await store.save({name: 'other', base_url: 'https://other.invalid/v1', kind: 'openai_compat'});
  await writeFile(join(root, '.logox', 'actor-models.json'), JSON.stringify({
    kalon: {provider: 'other', model: 'x'}, ...bound ? {techne: {provider: 'gw', model: 'm1'}, aletheia: {provider: 'gw', model: 'm2'}} : {}}));
  await writeFile(join(root, '.logox', 'tool-models.json'), JSON.stringify(bound ? {automa: {provider: 'gw', model: 'm1'}} : {}));
  const config = await loadConfig(root, {permissions: {mode: 'default'}, provider: {name: selected, model: 'm1'}}, {}, root, root);
  const app = await createApplication({cwd: root, config, resourceOptions: {home: root, boundary: root}, env: {}, authPath: join(root, 'auth.json'),
    provider: {respond: async () => {throw new Error('No model');}}});
  const wait = async (key = -1) => {
    for (let i = 0; i < 300; i++) {const state = app.authentication.getSnapshot(); if (state?.wizard && state.wizard.key !== key) return state.wizard; await delay(5);}
    throw new Error('Missing local question');
  };
  const deleteProvider = async (answer: string) => {
    const submitted = app.submit('/login');
    let view = await wait();
    for (const id of ['key', 'gw', 'delete']) {app.authentication.answerWizard({selected: [id]}); view = await wait(view.key);}
    const detail = view.questions[0]!.detail;
    app.authentication.answerWizard({selected: [answer]}); await submitted;
    return detail;
  };
  const notices = () => app.store.getSnapshot().messages.map(message => message.text).filter(text => text.startsWith("Provider 'gw' removed."));
  return {root, app, store, deleteProvider, notices, done: async () => {await app.close(); await rm(root, {recursive: true, force: true});}};
}
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

test('deleting a provider in use names every user, clears bindings without substituting a model, and tells the user what to choose', async () => {
  const f = await fixture('gw');
  try {
    assert.equal(f.app.taskModels.idleSelection('techne').provider, 'gw', 'bound before the deletion');
    const detail = await f.deleteProvider('delete');
    assert.match(detail ?? '', /^In use by: session, aletheia, techne, automa\./);
    assert.equal(await f.store.get('gw'), undefined);
    assert.ok(await f.store.get('other'));
    const actorModels = await json(join(f.root, '.logox', 'actor-models.json'));
    assert.deepEqual(Object.keys(actorModels), ['kalon'], 'only the actors bound to the deleted provider are cleared');
    assert.deepEqual(await json(join(f.root, '.logox', 'tool-models.json')), {}, 'the dedicated Automa model is cleared');
    // Unbound actors use the session model, which is now explicitly empty - never another provider's model.
    // Unbound actors inherit the session model, which is now explicitly empty (the same state as a fresh install): no model, and never another provider's.
    assert.throws(() => f.app.taskModels.idleSelection('techne'), 'an unbound actor follows the empty session model instead of getting a substitute');
    assert.equal(f.app.taskModels.idleSelection('kalon').provider, 'other', 'a binding to another provider is untouched');
    const [text] = f.notices();
    assert.ok(text, 'one notice is posted');
    assert.match(text!, /Cleared the model of aletheia, techne. They use the session model until you choose one with \/model <actor>\./);
    assert.match(text!, /dedicated Automa model/);
    assert.match(text!, /session model gw\/m1 was on this provider; no model is selected now\. Choose one with \/model\./);
    assert.equal(f.notices().length, 1);
  } finally {await f.done();}
});

test('cancelling the confirmation keeps the provider, the bindings and the session model', async () => {
  const f = await fixture('gw');
  try {
    await f.deleteProvider('cancel');
    assert.ok(await f.store.get('gw'));
    assert.deepEqual(Object.keys(await json(join(f.root, '.logox', 'actor-models.json'))).sort(), ['aletheia', 'kalon', 'techne']);
    assert.equal(f.app.taskModels.idleSelection('techne').provider, 'gw');
    assert.deepEqual(f.notices(), []);
  } finally {await f.done();}
});

test('deleting a provider nobody uses stays quiet about bindings and keeps the session model', async () => {
  const f = await fixture('other', false);
  try {
    const detail = await f.deleteProvider('delete');
    assert.equal(detail, undefined, 'no usage line when nobody uses it');
    assert.equal(await f.store.get('gw'), undefined);
    assert.deepEqual(Object.keys(await json(join(f.root, '.logox', 'actor-models.json'))), ['kalon']);
    assert.deepEqual(f.notices(), []);
    assert.equal(f.app.taskModels.idleSelection('techne').provider, 'other');
    assert.equal(f.app.taskModels.idleSelection('techne').model, 'm1');
  } finally {await f.done();}
});
