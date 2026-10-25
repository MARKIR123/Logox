import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolRegistry} from '../src/tools/registry.js';
import type {ToolDefinition} from '../src/runtime/messages.js';

test('ToolRegistry filters tools for director vs worker vs custom actor', () => {
  const registry = new ToolRegistry();

  // Director (logox) has access to core, orchestration, and protocol
  const logoxTools = registry.getToolsForActor('logox');
  const logoxNames = logoxTools.map((t: ToolDefinition) => t.name);
  assert.ok(logoxNames.includes('Read'));
  assert.ok(logoxNames.includes('Actor'));
  assert.ok(logoxNames.includes('CancelActor'));
  assert.ok(logoxNames.includes('_FinishRound'));

  // Worker (techne) has access to core and protocol, but NEVER orchestration (Actor, CancelActor)
  const techneTools = registry.getToolsForActor('techne');
  const techneNames = techneTools.map((t: ToolDefinition) => t.name);
  assert.ok(techneNames.includes('Read'));
  assert.ok(techneNames.includes('_FinishRound'));
  assert.equal(techneNames.includes('Actor'), false);
  assert.equal(techneNames.includes('CancelActor'), false);

  // Any newly defined dynamic actor automatically gets worker permissions
  const dynamicTools = registry.getToolsForActor('my-new-scout-actor');
  const dynamicNames = dynamicTools.map((t: ToolDefinition) => t.name);
  assert.ok(dynamicNames.includes('Read'));
  assert.ok(dynamicNames.includes('Grep'));
  assert.ok(dynamicNames.includes('_FinishRound'));
  assert.equal(dynamicNames.includes('Actor'), false);
});

test('ToolRegistry reports terminalVisibility correctly (silent for _FinishRound)', () => {
  const registry = new ToolRegistry();
  assert.equal(registry.getTerminalVisibility('Read'), 'card');
  assert.equal(registry.getTerminalVisibility('Shell'), 'card');
  assert.equal(registry.getTerminalVisibility('_FinishRound'), 'silent');
});

test('ToolRegistry loads and applies user overrides from .logox/tools.json', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-tools-override-'));
  const dotLogox = join(tempDir, '.logox');
  await mkdir(dotLogox, {recursive: true});

  // Override Read to be silent, and Actor to be available to techne
  await writeFile(
    join(dotLogox, 'tools.json'),
    JSON.stringify({
      Read: {terminalVisibility: 'silent'},
      Actor: {roles: ['logox', 'techne']},
    }),
    'utf8'
  );

  try {
    const registry = new ToolRegistry(tempDir, tempDir);
    await registry.reloadUserConfigs();

    assert.equal(registry.getTerminalVisibility('Read'), 'silent');

    const techneTools = registry.getToolsForActor('techne');
    assert.ok(techneTools.some((t: ToolDefinition) => t.name === 'Actor'));
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('ToolRegistry formats compact explicit prompt section grouped by category', () => {
  const registry = new ToolRegistry();
  const promptSection = registry.formatExplicitPromptSection('logox');
  assert.ok(promptSection.includes('Protocol'));
  assert.ok(promptSection.includes('_FinishRound'));
  assert.ok(promptSection.includes('Orchestration'));
  assert.ok(promptSection.includes('Actor'));
});

test('ToolRegistry formats tiered tools prompt aligned with user specification', () => {
  const registry = new ToolRegistry();
  const text = registry.formatTieredToolsPrompt('logox');

  // 1. Starts with tools:
  assert.ok(text.startsWith('tools:\n'));

  // 2. Core tools are indented by 2 spaces directly under tools:
  assert.ok(text.includes('  Read: '));
  assert.ok(text.includes('  Grep: '));
  assert.ok(text.includes('  Shell: '));

  // 3. Subdirectory tools are categorized bullet points
  assert.ok(text.includes('  - 流程规范工具 (Protocol):'));
  assert.ok(text.includes('    - _FinishRound: '));
  assert.ok(text.includes('    - _GitStatus: '));

  assert.ok(text.includes('  - 团队协作工具 (Coordination):'));
  assert.ok(text.includes('    - ListActors: '));

  assert.ok(text.includes('  - 调度编排工具 (Orchestration):'));
  assert.ok(text.includes('    - Actor: '));

  // 4. For worker (techne), Orchestration tools are omitted
  const workerText = registry.formatTieredToolsPrompt('techne');
  assert.ok(workerText.includes('  Read: '));
  assert.ok(workerText.includes('  - 流程规范工具 (Protocol):'));
  assert.ok(workerText.includes('    - _FinishRound: '));
  assert.ok(workerText.includes('    - _GitStatus: '));
  assert.ok(!workerText.includes('Actor: '));
  assert.ok(!workerText.includes('CancelActor: '));
});
