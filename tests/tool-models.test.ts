import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolModelStorage} from '../src/tools/tool-models.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {commandSuggestions} from '../src/tui/completion.js';
import type {Draft} from '../src/tui/editor.js';

test('ToolModelStorage reads, writes, and deletes tool model configurations atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-tool-models-'));
  const primary = join(dir, 'tool-models.json');
  const fallback = join(dir, 'fallback-tool-models.json');

  try {
    const storage = new ToolModelStorage(primary, fallback);
    assert.equal(storage.get('automa'), undefined);

    // Save automa model
    await storage.save('automa', {provider: 'anthropic', model: 'claude-3-5-haiku'});
    assert.deepEqual(storage.get('automa'), {provider: 'anthropic', model: 'claude-3-5-haiku'});

    // Verify persisted content on disk
    const content = JSON.parse(await readFile(primary, 'utf8'));
    assert.deepEqual(content, {automa: {provider: 'anthropic', model: 'claude-3-5-haiku'}});

    // Clear automa model (inherit mode)
    await storage.save('automa', undefined);
    assert.equal(storage.get('automa'), undefined);

    const clearedContent = JSON.parse(await readFile(primary, 'utf8'));
    assert.deepEqual(clearedContent, {});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('ToolModelStorage loads fallback file if primary is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-tool-models-fallback-'));
  const primary = join(dir, 'primary.json');
  const fallback = join(dir, 'fallback.json');

  try {
    await writeFile(fallback, JSON.stringify({automa: {provider: 'deepseek', model: 'deepseek-chat'}}), 'utf8');
    const storage = new ToolModelStorage(primary, fallback);
    const map = await storage.read();
    assert.deepEqual(map.automa, {provider: 'deepseek', model: 'deepseek-chat'});
    assert.deepEqual(storage.get('automa'), {provider: 'deepseek', model: 'deepseek-chat'});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('/model automa configures automa model via slash command, opens picker, and supports inherit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-app-automa-model-'));
  const config = await loadConfig(cwd, {
    provider: {name: 'alpha', model: 'session-model'},
    providers: {
      alpha: {base_url: 'http://127.0.0.1:7777/v1'},
      beta: {base_url: 'http://127.0.0.1:8888/v1', default_model: 'fast-model'},
    },
  }, {}, cwd, cwd);

  const notices: string[] = [];
  const app = await createApplication({
    cwd,
    resourceOptions: {home: cwd, boundary: cwd},
    config,
    env: {},
    authPath: join(cwd, 'auth.json'),
    provider: {respond: async () => {throw new Error('Unexpected LLM call');}},
  });

  try {
    // Automa is initially inheriting session model (undefined in toolModelStorage)
    assert.equal(app.tools.modelStorage.get('automa'), undefined);

    // 1. Set automa model via /model automa beta/fast-model
    await app.submit('/model automa beta/fast-model');
    assert.deepEqual(app.tools.modelStorage.get('automa'), {provider: 'beta', model: 'fast-model'});

    // 2. Open picker via /model automa
    await app.submit('/model automa');
    const picker = app.surfaces.getSnapshot();
    assert.ok(picker?.kind === 'picker');
    assert.equal(picker.title, 'Automa Model');
    assert.equal(picker.current, JSON.stringify({provider: 'beta', model: 'fast-model'}));

    // Cancel picker
    app.surfaces.cancel();
    assert.equal(app.surfaces.getSnapshot(), null);

    // 3. Clear automa model via /model automa inherit
    await app.submit('/model automa inherit');
    assert.equal(app.tools.modelStorage.get('automa'), undefined);

    // 4. Verify Automa is strictly a tool and NOT an actor in ActorCatalog
    assert.equal(app.actors.find('automa'), undefined);
    assert.ok(!app.actors.list().some(a => a.id === 'automa'));
  } finally {
    await app.close();
    await rm(cwd, {recursive: true, force: true});
  }
});

test('/model completions include automa worker, but @ mentions do not include @automa', () => {
  const context = {
    providers: ['alpha', 'beta'],
    loginProviders: ['alpha'],
    models: ['session-model'],
    actors: ['logox', 'techne', 'kalon', 'aletheia'],
  };
  const draft = (text: string): Draft => ({text, cursor: text.length});

  // /model suggestions include automa
  const modelSuggestions = commandSuggestions(draft('/model '), context);
  const modelLabels = modelSuggestions.map(s => s.label);
  assert.ok(modelLabels.includes('automa'), 'model suggestions should include automa');
  assert.ok(modelLabels.includes('techne'));

  // @ mentions strictly only include actors
  const atSuggestions = commandSuggestions(draft('@'), context);
  const atLabels = atSuggestions.map(s => s.label);
  assert.ok(!atLabels.includes('@automa'), '@ mentions must NOT include @automa');
  assert.ok(atLabels.includes('@techne'));
  assert.ok(atLabels.includes('@logox'));
});
