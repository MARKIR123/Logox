import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolRegistry} from '../src/tools/registry.js';
import {toolMetadataSchema} from '../src/tools/metadata.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelRequest, ToolDefinition} from '../src/runtime/messages.js';

test('loading defaults are independent from role and terminal presentation', () => {
  const input = {name: 'Inspect', category: 'observability', roles: 'all', terminalVisibility: 'silent'};
  assert.equal(Reflect.get(toolMetadataSchema.parse(input), 'loading'), 'deferred');
  assert.equal(Reflect.get(toolMetadataSchema.parse({...input, category: 'core'}), 'loading'), 'eager');
  const registry = new ToolRegistry();
  assert.equal(Reflect.get(registry.getMetadata('_FinishRound')!, 'loading'), 'eager');
  assert.equal(registry.getTerminalVisibility('_GitStatus'), 'silent');
  assert.ok(registry.getToolsForActor('logox').some(tool => tool.name === 'SendMessage'));
  assert.ok(registry.getToolsForActor('new-scout').some(tool => tool.name === 'UpdateTaskProgress'));
});

test('the discovery directory lists every eligible deferred name with short descriptions, never schemas', () => {
  const registry = new ToolRegistry();
  const resolve = Reflect.get(registry, 'resolveForActor');
  const format = Reflect.get(registry, 'formatDiscoveryCatalog');
  assert.equal(typeof resolve, 'function'); assert.equal(typeof format, 'function');
  const pool = resolve.call(registry, 'logox');
  const first = format.call(registry, pool, 'anthropic');
  for (const name of ['Actor', 'ReadActor', 'ListActors', '_GitStatus', 'SendMessage']) assert.match(first, new RegExp('\\b' + name + ': [^\\n]+'));
  assert.doesNotMatch(first, /(?:^|\n)\s*-?\s*(Read|Write|_FinishRound):|parameters|properties|src\/tools/);
  assert.equal(format.call(registry, pool, 'none'), '');
  assert.equal(format.call(registry, resolve.call(registry, 'logox'), 'anthropic'), first);
  const read = registry.getToolsForActor('logox').find(tool => tool.name === 'Read')!;
  assert.ok(read.parameters.properties, 'Native schemas remain complete.');
});

test('known builtin duplicates cannot bypass eligibility and conflicting extensions are rejected', () => {
  const registry = new ToolRegistry();
  const resolve = Reflect.get(registry, 'resolveForActor');
  assert.equal(typeof resolve, 'function');
  const actor = registry.getToolsForActor('logox').find(tool => tool.name === 'Actor')!;
  const extras = [{metadata: {name: 'dispatch_role', category: 'other', roles: 'all' as const, terminalVisibility: 'card' as const}, definition: actor}];
  assert.ok(!resolve.call(registry, 'new-scout', extras).some((item: {definition: ToolDefinition}) => item.definition.name === 'Actor'));
  const extension = (description: string) => ({metadata: {name: 'Inspect', category: 'extensions', roles: 'all' as const, terminalVisibility: 'card' as const},
    definition: {name: 'Inspect', description, parameters: {type: 'object'}}});
  assert.throws(() => resolve.call(registry, 'logox', [extension('one'), extension('two')]), /Conflicting tool/);
});

test('capability changes append deltas without replacing the original discovery directory', async () => {
  const path = '../src/tools/discovery.js';
  const module = await import(path).catch(() => undefined);
  assert.equal(typeof module?.planToolCatalog, 'function');
  const registry = new ToolRegistry();
  const pool = registry.resolveForActor('logox');
  const first = module.planToolCatalog(registry, pool, 'anthropic', []);
  assert.match(first.catalog, /Actor:/);
  assert.equal(first.updates.length, 1);
  assert.equal(module.planToolCatalog(registry, pool, 'anthropic', first.updates).updates.length, 0);
  const changed = module.planToolCatalog(registry, pool.filter(tool => tool.definition.name !== 'Actor'), 'anthropic', first.updates);
  assert.equal(changed.catalog, first.catalog);
  assert.equal(changed.updates.length, 1);
  assert.match(changed.updates[0].text, /removed: Actor/i);
});

test('application startup and reload apply tool overrides without global state or extras bypass', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-disclosure-registry-'));
  const seen: ModelRequest[] = [];
  await mkdir(join(cwd, '.logox'));
  const path = join(cwd, '.logox', 'tools.json');
  await writeFile(path, JSON.stringify({Read: {roles: []}, CraftActor: {roles: []}, _GitStatus: {loading: 'eager'}}));
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd},
    provider: {async respond(request) {
      seen.push(request);
      return {stop: 'tools', message: {role: 'assistant', text: 'Done.', toolCalls: [{id: 'done-' + seen.length, name: '_FinishRound',
        arguments: JSON.stringify({title: 'Done', verification: null, carry_forward: []})}]}};
    }}});
  try {
    await app.ensemble.dispatch('logox', 'Inspect the catalog.', 'direct', {inputKind: 'human'}).done;
    const names = seen[0]!.tools.map(tool => tool.name);
    assert.ok(!names.includes('Read') && !names.includes('CraftActor'));
    assert.equal(names.filter(name => name === 'UpdateTaskProgress').length, 1);
    await writeFile(path, JSON.stringify({Write: {roles: []}}));
    await app.submit('/reload');
    await app.ensemble.dispatch('logox', 'Inspect the updated catalog.', 'direct', {inputKind: 'human'}).done;
    assert.ok(seen[1]!.tools.some(tool => tool.name === 'Read'));
    assert.ok(!seen[1]!.tools.some(tool => tool.name === 'Write'));
    assert.ok(new ToolRegistry().getToolsForActor('logox').some(tool => tool.name === 'Write'));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
