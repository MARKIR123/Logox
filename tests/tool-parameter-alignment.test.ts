import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ActorContext} from '../src/actors/ensemble.js';
import {Tools, schemas, toolDefinitions} from '../src/tools/tools.js';
import {resolveRgPath} from '../src/tools/GrepTool/rg-path.js';
import {getInteractionUI} from '../src/tools/ui-registry.js';
import type {Interaction} from '../src/runtime/contracts.js';

function context(cwd: string): ActorContext {
  return {
    sessionId: 'session',
    activityId: 'activity',
    ownerId: 'logox',
    history: [],
    signal: new AbortController().signal,
    report() {},
    say() {},
    record: async () => {},
    ask: async () => ({status: 'cancelled'}),
    permission: async () => true,
    startTool() {},
    wait() { return () => {}; },
  } as unknown as ActorContext;
}

function schemaOf(name: string) {
  return toolDefinitions.find(tool => tool.name === name)!.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

test('模型可见参数对齐 Claude Code，且不再暴露旧字段', () => {
  assert.deepEqual(schemaOf('Read').required, ['file_path']);
  assert.ok(!('path' in (schemaOf('Read').properties ?? {})));
  assert.deepEqual(schemaOf('Write').required, ['file_path', 'content']);
  assert.deepEqual(schemaOf('Edit').required, ['file_path', 'old_string', 'new_string']);
  assert.ok(!('old_text' in (schemaOf('Edit').properties ?? {})));
  assert.deepEqual(schemaOf('Grep').required, ['pattern']);
  for (const key of ['glob', 'output_mode', '-A', '-B', '-C', '-i', '-n', 'type', 'head_limit', 'multiline']) {
    assert.ok(key in (schemaOf('Grep').properties ?? {}), 'Grep 缺少参数 ' + key);
  }
  assert.ok(!('limit' in (schemaOf('Grep').properties ?? {})));
  assert.deepEqual(schemaOf('Shell').required, ['command']);
  assert.deepEqual(schemaOf('AskUserQuestion').required, ['questions']);
  assert.ok(!('title' in (schemaOf('AskUserQuestion').properties ?? {})));
});

test('旧参数别名在迁移期仍可解析', () => {
  assert.deepEqual(schemas.Read.parse({path: 'a.txt'}), {file_path: 'a.txt'});
  assert.deepEqual(schemas.Write.parse({path: 'a.txt', content: 'x'}), {file_path: 'a.txt', content: 'x'});
  assert.deepEqual(schemas.Edit.parse({path: 'a.txt', old_text: 'a', new_text: 'b'}),
    {file_path: 'a.txt', old_string: 'a', new_string: 'b'});
  assert.deepEqual(schemas.Grep.parse({pattern: 'x', limit: 5}), {pattern: 'x', head_limit: 5});
  assert.deepEqual(schemas.Grep.parse({pattern: 'x', offset: 10}), {pattern: 'x'});
});

test('内置 ripgrep 路径存在且指向 ripgrep 二进制', () => {
  const path = resolveRgPath();
  assert.ok(existsSync(path), 'ripgrep 二进制不存在：' + path);
  assert.match(path.toLowerCase(), /ripgrep|(?:^|[\\/])rg(?:\.exe)?$/);
});

test('Grep 三种 output_mode、glob、大小写与 head_limit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-grep-modes-'));
  try {
    await writeFile(join(cwd, 'a.js'), 'const needle = 1;\nconst other = 2;\n');
    await writeFile(join(cwd, 'b.ts'), 'const NEEDLE = 3;\nconst NEEDLE = 4;\n');
    const tools = new Tools(cwd), ctx = context(cwd);
    const run = (args: Record<string, unknown>) => tools.execute({id: 'g', name: 'Grep', arguments: JSON.stringify(args)}, ctx);

    const files = await run({pattern: 'needle'});
    assert.equal(files.isError, false);
    assert.match(files.text, /a\.js/);
    assert.doesNotMatch(files.text, /b\.ts/);

    const insensitive = await run({pattern: 'needle', '-i': true});
    assert.match(insensitive.text, /a\.js/);
    assert.match(insensitive.text, /b\.ts/);

    const globbed = await run({pattern: 'needle', '-i': true, glob: '*.ts'});
    assert.match(globbed.text, /b\.ts/);
    assert.doesNotMatch(globbed.text, /a\.js/);

    const content = await run({pattern: 'needle', output_mode: 'content'});
    assert.match(content.text, /a\.js:1:.*const needle = 1;/);

    const limited = await run({pattern: 'NEEDLE', output_mode: 'content', head_limit: 1});
    assert.equal(limited.text.split('\n').filter(line => line.includes('b.ts')).length, 1);

    const counted = await run({pattern: 'NEEDLE', output_mode: 'count'});
    assert.match(counted.text, /b\.ts:2/);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('Shell timeout 采用毫秒语义，并兼容历史秒值', () => {
  assert.deepEqual(schemas.Shell.parse({command: 'x', timeout: 10_000}), {command: 'x', timeout: 10_000});
  assert.deepEqual(schemas.Shell.parse({command: 'x', timeout: 10}), {command: 'x', timeout: 10_000});
  assert.deepEqual(schemas.Shell.parse({command: 'x'}), {command: 'x'});
});

test('AskUserQuestion 完整对齐 Claude 参数并支持多选答案', () => {
  const parsed = schemas.AskUserQuestion.parse({
    questions: [{
      question: 'Which themes?',
      header: 'Themes',
      multiSelect: true,
      options: [
        {label: 'Night', description: 'Dark blue'},
        {label: 'Amber', description: 'Warm CRT'},
      ],
    }],
  });
  assert.equal(parsed.questions[0]!.options?.[0]?.label, 'Night');
  assert.equal(parsed.questions[0]!.multiSelect, true);

  // Legacy shape is still accepted and normalized.
  assert.deepEqual(schemas.AskUserQuestion.parse({
    title: 'Legacy',
    questions: [{id: 'style', header: 'Style', question: 'Pick', options: [
      {id: 'a', label: 'A', description: 'a'}, {id: 'b', label: 'B', description: 'b'},
    ]}],
  }), {
    questions: [{header: 'Style', question: 'Pick', options: [
      {label: 'A', description: 'a'}, {label: 'B', description: 'b'},
    ]}],
  });

  const request = {
    kind: 'question', requestId: 'r', sessionId: 's', activityId: 'a', ownerId: 'logox', title: 'Themes',
    status: 'pending',
    questions: [{
      id: 'q0', header: 'Themes', question: 'Which themes?', multiSelect: true,
      options: [{id: 'o0', label: 'Night', description: ''}, {id: 'o1', label: 'Amber', description: ''}],
    }],
  } as unknown as Interaction;
  let draft: import('../src/tui/interactions/choice-style.js').QuestionDraft = {questionIndex: 0, selected: 0, text: '', error: '', checked: []};
  const adapter = getInteractionUI(request)!;
  let answers: Record<string, import('../src/runtime/contracts.js').Answer> = {};
  for (const index of [0, 1]) {
    const next = adapter.reduce({request, draft, answers}, {kind: 'select', index});
    draft = next.draft;
    answers = next.answers;
  }
  const done = adapter.reduce({request, draft, answers}, {kind: 'submit'});
  assert.deepEqual(done.answers.q0, {type: 'options', optionIds: ['o0', 'o1']});
  assert.equal(done.complete, true);
});
