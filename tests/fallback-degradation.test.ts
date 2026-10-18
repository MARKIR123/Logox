import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TaskModels} from '../src/actors/task-models.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {loadConfig} from '../src/config/config.js';
import {ModelPool} from '../src/providers/model-pool.js';

test('TaskModels degrades to default fallback model when designated provider is unavailable', async () => {
  const config = await loadConfig(process.cwd(), {}, {});
  const registry = new ProviderRegistry(config, process.env);
  const taskModels = new TaskModels({
    registry,
    defaultModel: owner => owner === 'techne' ? {provider: 'unregistered-prov', model: 'missing-model'} : undefined,
    defaultFallbackModel: () => ({provider: 'deepseek', model: 'deepseek-flash'}),
  });

  const selection = taskModels.selection({sessionId: 's1', ownerId: 'techne'});
  assert.equal(selection.provider, 'deepseek');
  assert.equal(selection.model, 'deepseek-flash');
});

test('ModelPool resolves shorthand for actor model assignment', () => {
  const pool = new ModelPool();
  pool.setMockModels([
    {provider: 'antigravity', id: 'claude-sonnet-4-6', window: 1000000},
    {provider: 'openai', id: 'gpt-4o', window: 128000},
  ]);

  const resolved = pool.resolveShorthand('gpt-4o', 'antigravity');
  assert.deepEqual(resolved, {provider: 'openai', model: 'gpt-4o'});
});
