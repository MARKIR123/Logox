import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeBaseSystemPrompt,
  CORE_EXECUTION_CHARTER,
  TOOL_USAGE_RULES,
  collaborationFor,
} from '../src/prompts/index.js';
import {readFileSync} from 'node:fs';
import {createRuntimeContextMessage} from '../src/runtime/context-updates.js';

test('提示词工程：基础系统提示词按静态切片分层组装，核心准则在最前，定制人设追加在后', () => {
  const result = composeBaseSystemPrompt({
    cwd: '/workspace/project',
    ownerId: 'techne',
    builtinPrompt: '你是 Techne，工匠。信条：与其思考，不如实践。',
    customPrompt: '【特别约束】单文件输出，不使用构建工具。',
    rulesContext: '【项目规则】遵循 AGENTS.md。',
    includeSummary: true,
  });

  // 1. 结构化切片数组正确导出
  assert.ok(result.sections.length >= 4);
  const names = result.sections.map(s => s.name);
  assert.deepEqual(names, ['persona', 'tool_rules', 'execution_charter', 'activity_visibility', 'round_memory', 'guidelines', 'collaboration', 'environment']);

  // 2. 文本拼接严格遵循前缀顺序
  assert.ok(result.system.includes('与其思考，不如实践'));
  assert.ok(result.system.includes('## Custom Persona Extension'));
  assert.ok(result.system.includes('【特别约束】单文件输出'));
  assert.ok(result.system.includes('Working directory: /workspace/project'));
  assert.ok(result.system.includes(TOOL_USAGE_RULES));
  assert.ok(result.system.includes(CORE_EXECUTION_CHARTER));
  assert.ok(result.system.includes(collaborationFor('techne')));
  assert.ok(result.system.includes('【项目规则】遵循 AGENTS.md。'));

  // 验证基础人设索引 < 定制人设索引 < 工作目录
  const baseIdx = result.system.indexOf('与其思考，不如实践');
  const customIdx = result.system.indexOf('【特别约束】');
  const cwdIdx = result.system.indexOf('Working directory: /workspace/project');
  assert.ok(baseIdx < customIdx);
  assert.ok(customIdx < cwdIdx);
});

test('协作协议单一来源：角色人设不重复工具名与协作流程', () => {
  for (const id of ['aletheia', 'techne', 'kalon']) {
    const persona = readFileSync(new URL('../src/actors/profiles/' + id + '/persona.md', import.meta.url), 'utf8');
    assert.doesNotMatch(persona, /request_assist|approve_assist|send_message|SendMessage|borrow_skill/i, id);
  }
  const base = composeBaseSystemPrompt({cwd: '/workspace', ownerId: 'techne', builtinPrompt: 'Techne', includeSummary: false});
  assert.equal(base.system.split(collaborationFor('techne')).length - 1, 1);
});

test('提示词工程：纯自定义角色在无内置底座时直接使用自身人设，空人设报错', () => {
  const result = composeBaseSystemPrompt({
    cwd: '/workspace',
    ownerId: 'custom-scout',
    customPrompt: '你是独立侦察兵。',
  });
  assert.ok(result.system.includes('你是独立侦察兵。'));
  assert.ok(!result.system.includes('## Custom Persona Extension'));

  assert.throws(() => {
    composeBaseSystemPrompt({cwd: '/workspace', ownerId: 'ghost'});
  }, /Actor has no valid persona: ghost/);
});

test('runtime facts remain typed messages rather than rewriting the system prompt', () => {
  const base = composeBaseSystemPrompt({cwd: '/workspace', ownerId: 'techne', builtinPrompt: 'Techne'});
  const recovery = createRuntimeContextMessage('recovery', 'Continue from preserved evidence.');
  assert.equal(recovery.role, 'context');
  assert.equal(recovery.kind, 'recovery');
  assert.ok(!base.system.includes(recovery.text));
  assert.ok(!base.system.includes('does not support image input'));
});
