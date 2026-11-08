import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskModels, TaskModelLedger} from '../src/actors/task-models.js';
import {Ensemble} from '../src/actors/ensemble.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';
import {loadConfig} from '../src/config/config.js';
import {ContextManager} from '../src/context/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {Tools} from '../src/tools/tools.js';
import {createAgent} from '../src/kernel/agent.js';

test('a model turn stores its provider usage, model and priced cost on the assistant ledger entry and reloads it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-turn-usage-'));
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.end('data: ' + JSON.stringify({choices: [{delta: {content: 'done'}, finish_reason: 'stop'}]}) + '\n\n' +
      'data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: {cached_tokens: 400}}}) + '\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const store = new RuntimeStore();
  let ensemble: Ensemble | undefined;
  try {
    const config = await loadConfig(directory, {permissions: {mode: 'default'}, provider: {name: 'main', model: 'm', max_tokens: 3000},
      providers: {main: {base_url: 'http://127.0.0.1:' + address.port + '/main', default_model: 'm', kind: 'openai_compat'}},
      models: {'main/m': {context_window: 16384, max_output_tokens: 1000, prices: {currency: 'USD', input: 2, output: 10, cache_read: 1}}}}, {}, directory, directory);
    const registry = new ProviderRegistry(config, {}, fetch, new AuthStorage(join(directory, 'auth.json')));
    const models = new TaskModels({registry, defaultModel: () => undefined, ledger: new TaskModelLedger(join(directory, 'models'))});
    const journal = new Journal(join(directory, 'journal'));
    const contexts = new ContextManager({journal, pricing: config, policy: config.context, maxOutput: 3000, model: id => models.model(id), summarizer: id => models.summarizer(id)});
    ensemble = new Ensemble('s', store, journal, createAgent({cwd: directory, store, tools: new Tools(directory), context: contexts, taskModels: models,
      provider: () => registry.provider(), iterations: 5, retries: 0, requestBase: async () => ({system: 'rules', tools: []})}));
    const task = ensemble.dispatch('techne', 'say done');
    await task.done;
    const entries = await journal.load('s', 'techne');
    const withUsage = entries.filter(entry => entry.usage);
    assert.equal(withUsage.length, 1, 'exactly one turn carries usage');
    const entry = withUsage[0]!;
    assert.equal(entry.role, 'assistant');
    assert.deepEqual({...entry.usage, cost: undefined}, {input: 1000, output: 200, cacheRead: 400, cacheWrite: 0, provider: 'main', model: 'm', currency: 'USD', cost: undefined});
    // fresh 600 * 2 + cache 400 * 1 + output 200 * 10, per million tokens
    assert.ok(Math.abs((entry.usage?.cost ?? NaN) - (600 * 2 + 400 * 1 + 200 * 10) / 1e6) < 1e-12);
    assert.ok(!('usage' in (entry.message ?? {})), 'usage lives on the entry, not the model message');
    // The per-actor tree file the scorer reads carries the same record.
    const tree = (await readFile(join(directory, 'journal', 's', 'subagents', 'techne.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {usage?: unknown});
    assert.deepEqual(tree.filter(row => row.usage).map(row => row.usage), [entry.usage]);
  } finally {
    await ensemble?.close(); store.interactions.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});

test('ledger entries without usage still load, and an unpriced turn keeps its tokens without a cost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-turn-usage-'));
  try {
    const journal = new Journal(directory);
    const identity = {sessionId: 's', ownerId: 'logox'};
    await journal.append({version: 1, ...identity, role: 'assistant', text: 'old', message: {role: 'assistant', text: 'old'}});
    await journal.append({version: 1, ...identity, role: 'assistant', text: 'new', message: {role: 'assistant', text: 'new'},
      usage: {input: 10, output: 2, cacheRead: 0, cacheWrite: 0, provider: 'p', model: 'm'}});
    const entries = await new Journal(directory).load('s', 'logox');
    assert.deepEqual(entries.map(entry => entry.usage), [undefined, {input: 10, output: 2, cacheRead: 0, cacheWrite: 0, provider: 'p', model: 'm'}]);
    await assert.rejects(journal.append({version: 1, ...identity, role: 'assistant', text: 'bad', usage: {input: -1, output: 0, cacheRead: 0, cacheWrite: 0, provider: 'p', model: 'm'}}));
  } finally {await rm(directory, {recursive: true, force: true});}
});
