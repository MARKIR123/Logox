import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolRegistry} from '../src/tools/registry.js';
import {toolMetadataSchema} from '../src/tools/metadata.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'logox-tools-taxonomy-'));
  try {await run(root);} finally {await rm(root, {recursive: true, force: true});}
}

const definition = {name: 'InspectMetrics', description: 'Inspect runtime metrics.', parameters: {
  type: 'object', properties: {scope: {type: 'string'}}, required: ['scope'], additionalProperties: false,
}};

test('tool category descriptions come from the root AGENTS.md, including new categories', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'AGENTS.md'), '---\ncategories:\n  protocol: Session lifecycle checks\n  observability: Inspect runtime measurements\n---\n# Navigation fixture only\n');
    await writeFile(join(root, 'AGENT.md'), '---\ncategories:\n  protocol: Retired category source\n---\n');
    const registry = new ToolRegistry(root, root, root);
    registry.register({name: definition.name, category: 'observability', roles: 'actors', terminalVisibility: 'card'}, definition);
    const prompt = registry.formatTieredToolsPrompt('new-specialist');
    assert.match(prompt, /protocol\/: Session lifecycle checks/);
    assert.match(prompt, /observability\/: Inspect runtime measurements/);
    assert.match(prompt, /InspectMetrics/);
    assert.doesNotMatch(prompt, /Retired category source|Navigation fixture only/);
    assert.doesNotMatch(registry.formatTieredToolsPrompt('logox'), /observability\//);
    const tool = registry.getToolsForActor('new-specialist').find(tool => tool.name === definition.name);
    assert.ok(tool, 'Collapsed indexing must not remove callable tools');
    assert.deepEqual(tool.parameters, {
      type: 'object', properties: {scope: {type: 'string'}}, required: ['scope'], additionalProperties: false,
    });
  });
});

test('every deferred tool expands below its directory description regardless of legacy display distinctions', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'AGENTS.md'), '---\ncategories:\n  observability: Runtime measurements\n---\n');
    const registry = new ToolRegistry(root, root, root);
    registry.register({name: 'InspectMetrics', category: 'observability', roles: 'all', terminalVisibility: 'silent'}, definition);
    registry.register({name: 'TraceRequest', category: 'observability', roles: 'all', terminalVisibility: 'silent',
      promptVisibility: 'explicit', description: 'Trace a request on demand.'}, {...definition, name: 'TraceRequest'});
    const prompt = registry.formatTieredToolsPrompt('any-new-actor');
    assert.match(prompt, /  - observability\/: Runtime measurements\n    - InspectMetrics: Inspect runtime metrics\.\n    - TraceRequest: Trace a request on demand\./);
    assert.match(prompt, /InspectMetrics/);
    assert.ok(registry.getToolsForActor('any-new-actor').some(tool => tool.name === 'InspectMetrics'));
  });
});

test('visibility overrides expand the index without changing parameter schemas', async () => {
  await fixture(async root => {
    await mkdir(join(root, '.logox'));
    await writeFile(join(root, '.logox', 'tools.json'), JSON.stringify({InspectMetrics: {promptVisibility: 'explicit'}}));
    const registry = new ToolRegistry(root, root, root);
    registry.register({name: definition.name, category: 'observability', roles: ['new-specialist'], terminalVisibility: 'card'}, definition);
    await registry.reloadUserConfigs();
    assert.match(registry.formatTieredToolsPrompt('new-specialist'), /    - InspectMetrics: Inspect runtime metrics\./);
    assert.deepEqual(registry.getToolsForActor('new-specialist').find(tool => tool.name === definition.name)?.parameters,
      definition.parameters);
    assert.doesNotMatch(registry.formatTieredToolsPrompt('other-specialist'), /observability/);
  });
});

test('missing or invalid category signposts fall back to directory names without crashing', async () => {
  await fixture(async root => {
    for (const raw of [undefined, '---\ncategories: [\n---\n', '---\ncategories:\n  observability: 42\n---\n']) {
      if (raw !== undefined) await writeFile(join(root, 'AGENTS.md'), raw);
      const registry = new ToolRegistry(root, root, root);
      registry.register({name: definition.name, category: 'observability', roles: 'all', terminalVisibility: 'card'}, definition);
      assert.match(registry.formatTieredToolsPrompt('new-specialist'), /  - observability\//);
    }
  });
});

test('metadata accepts new category directories and defaults nested tools to summary visibility', () => {
  const parsed = toolMetadataSchema.parse({name: 'InspectMetrics', category: 'observability', roles: 'all', terminalVisibility: 'card'});
  assert.equal(parsed.promptVisibility, 'summary');
  const core = toolMetadataSchema.parse({name: 'Read', category: 'core', roles: 'all', terminalVisibility: 'card'});
  assert.equal(core.promptVisibility, 'always');
});

test('shipped category signpost is available in the built distribution and uses English', () => {
  const registry = new ToolRegistry();
  const prompt = registry.formatTieredToolsPrompt('logox');
  assert.match(prompt, /protocol\/: Round lifecycle and working-tree inspection/);
  assert.match(prompt, /orchestration\/: Task dispatch and execution management/);
  assert.doesNotMatch(prompt, /[㐀-鿿]/);
  assert.doesNotMatch(prompt, /    - _FinishRound:/);
  assert.match(prompt, /    - ReadActor:/);
  assert.ok(registry.getToolsForActor('logox').some(tool => tool.name === 'ReadActor' && tool.parameters));
});
