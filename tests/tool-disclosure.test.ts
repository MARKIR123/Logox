import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolRegistry} from '../src/tools/registry.js';
import type {ModelMessage, Provider} from '../src/runtime/messages.js';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgent} from '../src/kernel/agent.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {Journal} from '../src/store/journal.js';
import {Tools} from '../src/tools/index.js';
import {toolMetadataSchema} from '../src/tools/metadata.js';
import {createProvider} from '../src/providers/http.js';

test('mandatory finalization cannot be hidden or deferred by configuration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-finalizer-config-'));
  try {
    await mkdir(join(cwd, '.logox'));
    for (const override of [{roles: []}, {loading: 'deferred'}, {promptVisibility: 'hidden'}]) {
      await writeFile(join(cwd, '.logox', 'tools.json'), JSON.stringify({_FinishRound: override}));
      await assert.rejects(new ToolRegistry(cwd, cwd).reloadUserConfigs(), /mandatory.*_FinishRound/i);
    }
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a business tool revoked during the producing request cannot execute through an extension adapter', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-current-pool-'));
  const registry = new ToolRegistry(cwd, cwd), store = new RuntimeStore(), journal = new Journal(cwd);
  const finish = registry.resolveForActor('logox').find(item => item.definition.name === '_FinishRound')!;
  const probe = {name: 'Probe', description: 'Fixture operation', parameters: {type: 'object', additionalProperties: false}};
  const metadata = toolMetadataSchema.parse({name: 'Probe', category: 'extensions', roles: 'all', terminalVisibility: 'card'});
  let legal = true, count = 0, turns = 0;
  const provider: Provider = {async respond() {
    if (++turns === 1) {legal = false; return {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [{id: 'probe', name: 'Probe', arguments: '{}'}]}};}
    return {stop: 'tools', message: {role: 'assistant', text: 'Finished.', toolCalls: [{id: 'finish', name: '_FinishRound', arguments: JSON.stringify({title: 'Finished', verification: null, carry_forward: []})}]}};
  }};
  const run = createAgent({cwd, store, tools: new Tools(cwd, undefined, undefined, {home: cwd}), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => {const pool = legal ? [finish, {metadata, definition: probe}] : [finish]; return {system: 'Rules', pool, tools: pool.map(item => item.definition)};},
    extraTools: [probe], extraApprovalHandled: ['Probe'], async executeExtra() {count++; return {text: 'Executed', isError: false};}});
  const ensemble = new EnsembleRuntime<string>('s', store, journal, run);
  try {
    await ensemble.dispatch('logox', 'Inspect.', 'direct', {inputKind: 'human'}).done;
    assert.equal(count, 0);
    const result = (await journal.load('s', 'logox')).find(entry => entry.message?.role === 'tool' && entry.message.callId === 'probe')?.message;
    assert.ok(result?.role === 'tool' && result.isError);
  } finally {await ensemble.close(); await rm(cwd, {recursive: true, force: true});}
});

async function discovery() {
  const path = '../src/tools/discovery.js';
  const module = await import(path);
  assert.equal(typeof module.resolveToolLoad, 'function');
  return module;
}
test('exact batch loading canonicalizes aliases, deduplicates and never grants denied or hidden names', async () => {
  const module = await discovery(), registry = new ToolRegistry();
  const pool = registry.resolveForActor('new-scout');
  const first = module.resolveToolLoad({names: ['git_status', '_GitStatus', 'Actor', 'Missing']}, pool, new Set());
  assert.deepEqual(first.loaded, ['_GitStatus']);
  assert.deepEqual(first.unavailable.sort(), ['Actor', 'Missing']);
  assert.deepEqual(module.resolveToolLoad({names: ['_GitStatus']}, pool, new Set(first.loaded)).alreadyLoaded, ['_GitStatus']);
  const history: ModelMessage[] = [{role: 'tool', name: 'LoadTools', callId: 'load', text: 'Loaded', isError: false, discoveredTools: ['_GitStatus']} as ModelMessage];
  assert.deepEqual([...module.extractDiscoveredToolNames(history)], ['_GitStatus']);
  assert.equal(module.extractDiscoveredToolNames([{role: 'user', text: JSON.stringify(history[0])}]).size, 0);
});
test('native exposure adds only discovered deferred definitions and falls back consistently without its loader', async () => {
  const module = await discovery(), registry = new ToolRegistry(), pool = registry.resolveForActor('logox');
  assert.equal(module.resolveExposureProtocol(pool, 'anthropic'), 'anthropic');
  const initial = module.buildToolExposure(pool, new Set(), 'anthropic');
  assert.ok(initial.some((tool: {name: string}) => tool.name === 'LoadTools'));
  assert.ok(initial.some((tool: {name: string}) => tool.name === '_FinishRound'));
  assert.ok(!initial.some((tool: {name: string}) => tool.name === '_GitStatus'));
  const expanded = module.buildToolExposure(pool, new Set(['_GitStatus']), 'anthropic');
  assert.equal(expanded.find((tool: {name: string}) => tool.name === '_GitStatus').deferLoading, true);
  assert.deepEqual(initial, expanded.filter((tool: {deferLoading?: boolean}) => !tool.deferLoading));
  const withoutLoader = pool.filter(item => item.definition.name !== 'LoadTools');
  assert.equal(module.resolveExposureProtocol(withoutLoader, 'anthropic'), 'none');
  assert.ok(module.buildToolExposure(withoutLoader, new Set(), 'none').some((tool: {name: string}) => tool.name === '_GitStatus'));
  assert.ok(!module.buildToolExposure(pool, new Set(), 'none').some((tool: {name: string}) => tool.name === 'LoadTools'));
});
test('unknown endpoints and model names never imply native discovery, explicit incompatible protocols fail locally', async () => {
  const path = '../src/providers/capabilities.js';
  const module = await import(path).catch(() => undefined);
  assert.equal(typeof module?.resolveProviderCapabilities, 'function');
  const settings = {kind: 'anthropic', baseUrl: 'https://proxy.invalid/v1', model: 'claude-opus-5', key: '', temperature: 0.2, maxTokens: 512, timeoutMs: 1000};
  assert.equal(module.resolveProviderCapabilities(settings).toolDiscovery, 'none');
  assert.equal(module.resolveProviderCapabilities({...settings, toolDiscovery: 'anthropic'}).toolDiscovery, 'anthropic');
  assert.throws(() => createProvider({...settings, kind: 'openai_compat', toolDiscovery: 'anthropic'} as Parameters<typeof createProvider>[0]), /Anthropic.*protocol/i);
});
