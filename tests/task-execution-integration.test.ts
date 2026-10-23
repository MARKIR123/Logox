import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {buildStageRows} from '../src/tui/stage.js';

const thought = (): ModelTurn => ({message: {role: 'assistant', text: '', reasoning: '核对当前步骤的实现方式'},
  stop: 'length', usage: {input: 7000, output: 16384}});
const answer = (): ModelTurn => ({message: {role: 'assistant', text: '已核对文件内容。'}, stop: 'complete'});
const tool = (name: string, arguments_: unknown): ModelTurn => ({message: {role: 'assistant', text: '',
  toolCalls: [{id: 'call', name, arguments: JSON.stringify(arguments_)}]}, stop: 'tools'});
const stage = {id: 'inspect', title: '核对文件中的事实', purpose: '确认当前文件内容', activeForm: '正在核对文件内容'};

async function fixture(turns: ModelTurn[]) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-task-flow-'));
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request, onDelta) {
    requests.push(request);
    const turn = turns.shift(); assert.ok(turn, '不允许额外模型请求');
    if (turn.message.reasoning) onDelta({kind: 'reasoning', text: turn.message.reasoning});
    if (turn.message.text) onDelta({kind: 'text', text: turn.message.text});
    return structuredClone(turn);
  }};
  const config = await loadConfig(cwd, {provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 'task-flow', config, provider, resourceOptions: {home: cwd, boundary: cwd}});
  return {cwd, config, app, provider, requests, async close() {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}

test('真实主会话三次只有思考即收束，原文和用量保留，纠偏不发送空助手', async () => {
  const f = await fixture([thought(), thought(), thought()]);
  try {
    const handle = f.app.ensemble.dispatch('logox', '核对这个任务'); await handle.done;
    assert.equal(f.requests.length, 3);
    assert.equal(f.app.store.activities.get('task-flow', handle.activityId)?.status, 'failed');
    assert.match(f.requests[1]!.system, /minimum deliverable step/i);
    assert.match(f.requests[2]!.system, /Pivot the action plan/i);
    for (const request of f.requests) assert.ok(request.messages.every(message => message.role !== 'assistant' || message.text.trim() || message.toolCalls?.length));
    const history = await f.app.journal.load('task-flow', 'logox');
    const reasoning = history.filter(entry => entry.message?.role === 'assistant' && entry.message.reasoning);
    assert.equal(reasoning.length, 3, '最后一次耗尽也保留原始思考');
    assert.ok(reasoning.every(entry => entry.step?.note));
    const usage = f.app.contexts.meter({sessionId: 'task-flow', ownerId: 'logox'}).usageRecords();
    assert.equal(usage.filter(record => record.category === 'task').reduce((sum, record) => sum + record.output, 0), 3 * 16384,
      '终止请求也记录真实用量');
  } finally {await f.close();}
});

test('参数截断整批零执行，最多两次接续，畸形工具历史不送回API', async () => {
  const truncated: ModelTurn = {message: {role: 'assistant', text: '已确认目标是独立文件。', toolCalls: [
    {id: 'first', name: 'write', arguments: '{"file_path":"bad.txt","content":"must not write"}'},
    {id: 'second', name: 'read', arguments: '{"file_path":'},
  ]}, stop: 'length'};
  const f = await fixture([truncated, truncated, truncated]);
  try {
    const handle = f.app.ensemble.dispatch('logox', '创建文件'); await handle.done;
    assert.equal(f.requests.length, 3);
    await assert.rejects(readFile(join(f.cwd, 'bad.txt')));
    assert.equal(f.app.store.interactions.list().length, 0, '截断批次不进入审批或执行');
    for (const request of f.requests.slice(1)) assert.ok(request.messages.every(message =>
      message.role !== 'assistant' || !message.toolCalls?.length));
    assert.ok(f.requests[1]!.messages.some(message => message.role === 'assistant' && message.text === truncated.message.text),
      '去除截断工具后仍保留合法正文');
    const history = await f.app.journal.load('task-flow', 'logox');
    assert.equal(history.filter(entry => entry.role === 'tool').length, 6, '每批未执行结果完整保存');
    assert.match(f.app.store.activities.get('task-flow', handle.activityId)!.detail, /截断/);
  } finally {await f.close();}
});

test('阶段工具通过正式Agent执行，真实阶段成果重置无交付，重启保持归属而不重放', async () => {
  const f = await fixture([
    tool('update_task_progress', {stages: [stage], update: {id: stage.id, status: 'in_progress'}}),
    tool('read', {path: 'facts.txt'}), thought(),
    tool('update_task_progress', {update: {id: stage.id, status: 'completed', result: 'facts.txt 的事实已核对：内容为 confirmed'}}),
    thought(), answer(),
  ]);
  try {
    await writeFile(join(f.cwd, 'facts.txt'), 'confirmed');
    const handle = f.app.ensemble.dispatch('logox', '读取并核对事实'); await handle.done;
    const activity = f.app.store.activities.get('task-flow', handle.activityId)!;
    assert.equal(activity.status, 'completed');
    assert.equal(activity.progress?.stages[0]?.status, 'completed');
    assert.equal(f.requests.length, 6);
    assert.match(f.requests[4]!.system, /(?:已完成成果|Completed milestones).*confirmed/);
    const history = await f.app.journal.load('task-flow', 'logox');
    assert.equal(history.find(entry => entry.message?.role === 'tool' && entry.message.name === 'read')?.step?.stage?.id, stage.id);
    assert.equal(history.find(entry => entry.message?.role === 'assistant')?.step?.stage?.id, 'planning', '旧探查不事后重归类');
    await f.app.close();
    const restored = await createApplication({cwd: f.cwd, sessionId: 'task-flow', config: f.config, provider: f.provider,
      resourceOptions: {home: f.cwd, boundary: f.cwd}});
    try {
      assert.equal(f.requests.length, 6);
      assert.deepEqual(restored.store.activities.get('task-flow', handle.activityId)?.progress, activity.progress);
      assert.equal(restored.store.getSnapshot().messages.filter(message => message.kind === 'thinking').length, 6);
    } finally {await restored.close();}
  } finally {await f.close();}
});

test('权限规则直接拒绝仍保存Denied分类，区别真实执行Error', async () => {
  const f = await fixture([tool('write', {path: 'blocked.txt', content: 'blocked'}), tool('read', {path: 'missing.txt'}), answer()]);
  try {
    await f.app.permissions.add({scope: 'session', decision: 'deny', tool: 'write', pattern: '**'});
    const handle = f.app.ensemble.dispatch('logox', '尝试文件操作'); await handle.done;
    const messages = f.app.store.getSnapshot().messages;
    const denied = messages.find(message => message.kind === 'tool' && message.step?.title.startsWith('write'))!;
    const failed = messages.find(message => message.kind === 'tool' && message.step?.title.startsWith('read'))!;
    assert.equal(denied.step?.disposition, 'denied');
    assert.equal(failed.step?.disposition, 'error');
    const rows = buildStageRows(f.app.store.getSnapshot(), 'task-flow', 'logox', 100, {}, null);
    assert.ok(rows.some(row => row.text.includes('Denied')));
    assert.ok(rows.some(row => row.text.includes('Error')));
    assert.ok(!rows.some(row => row.text.includes('许可已拒绝')));
  } finally {await f.close();}
});
