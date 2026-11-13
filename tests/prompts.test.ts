import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeBaseSystemPrompt,
  SHARED_EXECUTION_RULES,
  ROUND_SUMMARY_CONTRACT,
  collaborationFor,
} from '../src/prompts/index.js';
import {readFileSync} from 'node:fs';
import {ACTOR_DESCRIPTION} from '../src/tools/orchestration/ActorTool/prompt.js';
import {createRuntimeContextMessage} from '../src/runtime/context-updates.js';
import {EMPTY_REPLY_REMINDER} from '../src/prompts/runtime/recovery.js';

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
  assert.deepEqual(names, ['persona', 'shared_execution', 'round_memory', 'collaboration', 'guidelines', 'environment']);

  // 2. 文本拼接严格遵循前缀顺序
  assert.ok(result.system.includes('与其思考，不如实践'));
  assert.ok(result.system.includes('## Custom Persona Extension'));
  assert.ok(result.system.includes('【特别约束】单文件输出'));
  assert.ok(result.system.includes('Working directory: /workspace/project'));
  assert.ok(result.system.includes(SHARED_EXECUTION_RULES));
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
  const recovery = createRuntimeContextMessage('reminder', 'Continue from preserved evidence.');
  assert.equal(recovery.role, 'context');
  assert.equal(recovery.kind, 'reminder');
  assert.ok(!base.system.includes(recovery.text));
  assert.ok(!base.system.includes('does not support image input'));
});

const profile = (id: string, file: string) => readFileSync(new URL('../src/actors/profiles/' + id + '/' + file, import.meta.url), 'utf8');

test('the status line is unambiguously the first line of each reply; personas never put the flourish on line one', () => {
  assert.match(SHARED_EXECUTION_RULES, /begin your reply with one line[\s\S]*before anything else/);
  assert.equal(SHARED_EXECUTION_RULES.split('begin your reply with one line').length - 1, 1);
  assert.match(SHARED_EXECUTION_RULES, /It is rare, under six words and physical only[\s\S]*inline after the first sentence of a conversational reply, and never in work turns, task reports or tool payloads/);
  assert.match(SHARED_EXECUTION_RULES, /Plain voice: no filler openers or closers[\s\S]*no mechanical First\/Second\/Finally scaffolding/);
  for (const id of ['logox', 'techne', 'kalon', 'aletheia']) {
    const persona = profile(id, 'persona.md');
    assert.match(persona, /Micro-Actions/, id);
    assert.doesNotMatch(persona, /Default Blank|under six words|never as the first line/, id + ': shared desk-action limits live in the charter');
    assert.doesNotMatch(persona, /["“]（/, id + ': examples must not open with the flourish');
  }
});

test('brief, scope and ownership rules live in the lowest layer that can enforce them', () => {
  assert.match(SHARED_EXECUTION_RULES, /State no figure \(frame rate, timing, size, count\) you did not measure/);
  const companion = collaborationFor('techne');
  assert.match(companion, /Do what the assignment asks and nothing more/);
  assert.match(companion, /outside your `You own` list only after telling their owner/);
  assert.doesNotMatch(collaborationFor('logox'), /Do what the assignment asks/);
  const director = profile('logox', 'collaboration.md');
  for (const needle of ['Split by artifact', 'no file-count or build-attempt quotas', 'Add no features the user did not ask for', 'Accept on the record', 'runtime record']) {
    assert.ok(director.includes(needle), needle);
  }
  assert.match(profile('techne', 'execution.md'), /Edit, Never Rewrite/);
  assert.match(profile('aletheia', 'execution.md'), /Behaviour first[\s\S]*Skip what the brief lists as already verified/);
  assert.match(profile('kalon', 'execution.md'), /Artifacts, Not Specs[\s\S]*review the rendered result/);
});

test('status line rule: one line per reply, short, stated once, nothing about phases or history', () => {
  const rule = SHARED_EXECUTION_RULES.slice(SHARED_EXECUTION_RULES.indexOf('## Status line'), SHARED_EXECUTION_RULES.indexOf('## Seeing'));
  assert.ok(rule.includes('The user sees one status line on your card. At the start of each step, begin your reply with one line `⏵ <what you are doing>` (20 words max, before anything else), then continue on the next line, for example `⏵ Fixing the wheel alignment in pelican-bike.html`. One per reply. The runtime shows it on your card and strips it from your text.'), 'the contract text is verbatim');
  assert.doesNotMatch(rule, /phase|two to four|deliverable|earlier stages|history|UpdateTaskProgress|will not see it/);
  assert.ok(rule.length < 450, 'the rule stays short: ' + rule.length);
  assert.equal(rule.split('⏵').length - 1, 2, 'one format mention plus one example');
  assert.doesNotMatch(rule, /Good, one task|Bad, the same/);
  const everywhere = [collaborationFor('logox'), collaborationFor('techne'), ...['logox', 'techne', 'kalon', 'aletheia'].flatMap(id => ['persona.md', 'execution.md', 'collaboration.md'].map(f => profile(id, f)))].join('\n');
  assert.ok(!everywhere.includes('⏵'), 'no other layer restates the stage rule');
});

test('final reports separate unverified checks and known risks; verification is incremental in both layers', () => {
  assert.match(SHARED_EXECUTION_RULES, /say plainly what is verified, what is inferred and what was not run[\s\S]*list the risks you found along the way/);
  assert.match(collaborationFor('techne'), /Verify incrementally: read the evidence a teammate's report provides or what the assignment says is already verified/);
  assert.doesNotMatch(collaborationFor('logox'), /Verify incrementally/);
  assert.match(profile('logox', 'collaboration.md'), /Accept on the record[\s\S]*check yourself only what the two leave doubtful[\s\S]*say in your answer what you relied on/);
});

test('the empty-reply reminder is one static constant', () => {
  assert.equal(EMPTY_REPLY_REMINDER, 'Your previous reply was empty. Continue the task: call a tool or give your answer.');
});

test('Director sets after for dependent work and accepts reports against the runtime record', () => {
  const director = profile('logox', 'collaboration.md');
  assert.ok(director.includes('The wake already carries the full reports.'));
  assert.ok(director.includes('Read the account against the record'));
  assert.ok(director.includes('you close the round once, when you accept the reports'));
  assert.match(ACTOR_DESCRIPTION, /set `after` to that actor id or activity id: the runtime starts it only when that work has ended and hands it the report/);
});

test('peer replies use type reply, help is for decisions, and the answer and _FinishRound share one reply', () => {
  assert.match(collaborationFor('logox'), /Answer an ask with type "reply", never "inform"/);
  assert.match(collaborationFor('techne'), /wakes it at once; your task report waits until your teammates' reports are in/);
  assert.match(collaborationFor('techne'), /found something urgent that changes the plan, never for status/);
  assert.match(ROUND_SUMMARY_CONTRACT, /write that answer text and call _FinishRound in the same reply/);
});

test('browser guidance opens static pages with file:// and keeps any HTTP server private to the task', () => {
  const skill = readFileSync(new URL('../src/resources/builtin-skills/public/browser-screenshot.md', import.meta.url), 'utf8');
  assert.ok(skill.includes('Open static pages with `file://`. Start a local HTTP server only when the page needs a real origin (fetch, ES modules, service workers); start your own inside your own task and never share one across actors.'));
  assert.doesNotMatch(skill, /Start the HTTP preview for local files/);
});
