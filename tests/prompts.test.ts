import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeBaseSystemPrompt,
  composeRuntimeSystemPrompt,
  CORE_EXECUTION_CHARTER,
  TOOL_USAGE_RULES,
  NO_VISION_NOTE,
  collaborationFor,
} from '../src/prompts/index.js';
import {readFileSync} from 'node:fs';

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
  assert.deepEqual(names, ['persona', 'environment', 'tool_rules', 'execution_charter', 'collaboration', 'rules_context']);

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

test('提示词工程：单轮运行时动态组装，安全沉底追加视觉约束、阶段推进与自愈提示', () => {
  const baseSystem = '基础静态系统提示词';
  const runtimeSystem = composeRuntimeSystemPrompt({
    baseSystem,
    supportsVision: false,
    progressInstruction: '当前阶段：骨架验证。成果：无。',
    recoveryInstruction: '输出已截断，缩小调用。',
  });

  // 基础系统提示词始终保持在最前面（保证前缀 Prompt Cache 不变）
  assert.ok(runtimeSystem.startsWith(baseSystem));
  // 视觉提示注入
  assert.ok(runtimeSystem.includes(NO_VISION_NOTE));
  // 阶段推进指令注入
  assert.ok(runtimeSystem.includes('当前阶段：骨架验证。'));
  // 恢复提示沉底
  assert.ok(runtimeSystem.includes('输出已截断，缩小调用。'));

  // 当支持视觉且无恢复时，不污染运行时系统提示
  const cleanSystem = composeRuntimeSystemPrompt({
    baseSystem,
    supportsVision: true,
  });
  assert.equal(cleanSystem, baseSystem);
});
