import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {automaSchema, executeAutoma, runAutomaReadOnlyTool, automaToolDefinitions} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {AUTOMA_ANIMATION_FRAMES, AUTOMA_COLOR_TOKEN} from '../src/tools/orchestration/AutomaTool/prompt.js';
import {UI} from '../src/tools/orchestration/AutomaTool/UI.js';
import {validateToolCall} from '../src/tools/index.js';
import type {ModelMessage, ToolCall} from '../src/runtime/messages.js';

test('Automa schema validates prompt and description', () => {
  const valid = automaSchema.safeParse({
    prompt: 'Find all functions named createTheme in src/',
    description: 'search createTheme',
    paths: ['src/'],
  });
  assert.ok(valid.success);
  assert.equal(valid.data.description, 'search createTheme');

  const missingPrompt = automaSchema.safeParse({
    description: 'search something',
  });
  assert.equal(missingPrompt.success, false);

  const missingDescription = automaSchema.safeParse({
    prompt: 'search something',
  });
  assert.equal(missingDescription.success, false);
});

test('Automa tool definitions only expose read-only tools', () => {
  const names = automaToolDefinitions.map(t => t.name);
  assert.deepEqual(names.sort(), ['Glob', 'Grep', 'Read', 'WebFetch'].sort());
  assert.ok(!names.includes('Write'));
  assert.ok(!names.includes('Edit'));
  assert.ok(!names.includes('Shell'));
});

test('Automa read-only sandbox rejects Write, Edit, and Shell tools', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-sandbox-'));
  const controller = new AbortController();
  try {
    const writeCall: ToolCall = {
      id: 'call_1',
      name: 'Write',
      arguments: JSON.stringify({file_path: 'hacked.txt', content: 'danger'}),
    };
    const result = await runAutomaReadOnlyTool(writeCall, cwd, controller.signal);
    assert.equal(result.isError, true);
    assert.ok(result.text.includes('not permitted in Automa read-only sandbox'));

    const shellCall: ToolCall = {
      id: 'call_2',
      name: 'Shell',
      arguments: JSON.stringify({command: 'rm -rf /'}),
    };
    const shellResult = await runAutomaReadOnlyTool(shellCall, cwd, controller.signal);
    assert.equal(shellResult.isError, true);
    assert.ok(shellResult.text.includes('not permitted in Automa read-only sandbox'));
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('Automa executes multi-turn loop and extracts coordinates', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-loop-'));
  const controller = new AbortController();
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'example.ts'), 'export const hello = "world";\nexport function legacyComponent() {}\n');

  try {
    let turn = 0;
    const mockProvider = {
      async respond(params: {system: string; messages: readonly ModelMessage[]}) {
        turn++;
        if (turn === 1) {
          // Model decides to grep for legacyComponent
          return {
            message: {
              role: 'assistant' as const,
              text: '',
              toolCalls: [{
                id: 'call_grep',
                name: 'Grep',
                arguments: JSON.stringify({pattern: 'legacyComponent'}),
              }],
            },
            stop: 'tools' as const,
          };
        }
        // Model receives grep output and outputs final coordinates
        const lastToolMsg = params.messages.findLast(m => m.role === 'tool');
        assert.ok(lastToolMsg && lastToolMsg.text.includes('src/example.ts'));
        return {
          message: {
            role: 'assistant' as const,
            text: 'src/example.ts:2',
          },
          stop: 'complete' as const,
        };
      },
    };

    const journalPath = join(cwd, '.logox', 'state', 'subagents', 'automa.jsonl');
    const result = await executeAutoma({
      prompt: 'Find all references to legacyComponent',
      description: 'search legacyComponent',
      paths: ['src/'],
    }, controller.signal, {
      cwd,
      provider: mockProvider,
      journalPath,
    });

    assert.equal(result.isError, false);
    assert.equal(result.text, 'src/example.ts:2');

    // Verify append-only audit log
    const journalText = await readFile(journalPath, 'utf8');
    const entry = JSON.parse(journalText.trim());
    assert.equal(entry.description, 'search legacyComponent');
    assert.equal(entry.toolCalls, 1);
    assert.equal(entry.resultExcerpt, 'src/example.ts:2');
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('Automa execution is stateless across calls', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-stateless-'));
  const controller = new AbortController();
  try {
    const receivedMessages: ModelMessage[][] = [];
    const mockProvider = {
      async respond(params: {system: string; messages: readonly ModelMessage[]}) {
        receivedMessages.push([...params.messages]);
        return {
          message: {
            role: 'assistant' as const,
            text: `Answer for ${params.messages[0]?.text}`,
          },
          stop: 'complete' as const,
        };
      },
    };

    // First call
    await executeAutoma({
      prompt: 'Task 1',
      description: 'first task',
    }, controller.signal, {cwd, provider: mockProvider});

    // Second call
    await executeAutoma({
      prompt: 'Task 2',
      description: 'second task',
    }, controller.signal, {cwd, provider: mockProvider});

    assert.equal(receivedMessages.length, 2);
    // Second call must NOT contain Task 1 history
    assert.equal(receivedMessages[1]!.length, 1);
    assert.equal(receivedMessages[1]![0]!.text, 'Task 2');
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('Automa UI metadata has radar rotation animation and a semantic color token', () => {
  assert.deepEqual(AUTOMA_ANIMATION_FRAMES, ['◜', '◠', '◝', '◞', '◡', '◟']);
  assert.equal(AUTOMA_COLOR_TOKEN, 'automa');

  const title = UI.title({
    id: 'call_automa',
    name: 'Automa',
    arguments: JSON.stringify({description: 'extract CSS rules', prompt: 'scan css'}),
  });
  assert.equal(title, 'Automa · extract CSS rules');
});

test('validateToolCall accepts Automa tool with correct parameters', () => {
  const validation = validateToolCall({
    id: 'call_automa_val',
    name: 'Automa',
    arguments: JSON.stringify({prompt: 'scan references', description: 'scan references'}),
  });
  assert.equal(validation.valid, true);
});
