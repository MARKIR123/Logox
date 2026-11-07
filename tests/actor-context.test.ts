import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {ContextManager} from '../src/context/manager.js';
import {roleSummaryInstruction} from '../src/context/contracts.js';
import {contextPolicySchema} from '../src/config/config.js';
import type {ModelRequest} from '../src/runtime/messages.js';

const base = {system: roleSummaryInstruction(), tools: []};
const signal = new AbortController().signal;
test('新活动开始不再强制折叠已关闭轮：Actor 与 Logox 都保持原样直到真实任务结束或水位', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-failed-round-'));
  try {
    const journal = new Journal(directory);
    const contexts = new ContextManager({journal, maxOutput: 512,
      policy: ({ownerId}) => contextPolicySchema.parse({keep_recent_rounds: ownerId === 'logox' ? 2 : 0, keep_recent_tools: 0}),
      model: () => ({identity: 'test', window: 131072}), summarizer: () => {throw new Error('不应发起额外模型请求');}});
    for (const ownerId of ['techne', 'logox']) {
      const identity = {sessionId: 's', ownerId};
      await journal.append({version: 1, ...identity, activityId: 'failed', role: 'user', text: '旧任务'});
      await journal.append({version: 1, ...identity, activityId: 'failed', role: 'assistant', text: '旧工作流程'.repeat(300)});
      await journal.finish('s', ownerId, 'failed', 'failed');
      await journal.append({version: 1, ...identity, activityId: 'next', role: 'user', text: '新任务'});
      const request = (await contexts.prepare(identity, base, signal)).request;
      assert.equal(request.messages.some(message => message.text.startsWith('旧工作流程')), true);
      assert.equal(request.messages.findLast(message => message.role === 'user')?.text, '新任务');
    }
  } finally {await rm(directory, {recursive: true, force: true});}
});
test('Actor task_end 用零旧轮和2/2/0工具组装实际请求，重启与回退沿有效分支', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-actor-context-'));
  try {
    const journal = new Journal(directory);
    const options = {journal, policy: ({ownerId}: {ownerId: string}) => contextPolicySchema.parse({keep_recent_rounds: ownerId === 'logox' ? 2 : 0, keep_recent_tools: ownerId === 'kalon' ? 0 : 2, task_end_floor_ratio: 0, compact_accept_ratio: 1}),
      contract: ({ownerId}: {ownerId: string}) => ownerId + '：保留实际验证和未完成事项', maxOutput: 1024,
      model: () => ({identity: 'test', window: 131072}), summarizer: () => {throw new Error('常规收尾禁止多发汇总请求');}};
    const contexts = new ContextManager(options);
    for (const ownerId of ['aletheia', 'techne', 'kalon', 'logox']) {
      const identity = {sessionId: 's', ownerId};
      const append = async (activityId: string, message: ModelRequest['messages'][number]) => journal.append({version: 1, ...identity, activityId, role: message.role, text: message.text, message});
      await append('first', {role: 'user', text: '旧任务'});
      await append('first', {role: 'assistant', text: '', toolCalls: [0, 1, 2].map(n => ({id: 'c' + n, name: 'read', arguments: '{}'}))});
      for (let n = 0; n < 3; n++) await append('first', {role: 'tool', text: '证据' + n, callId: 'c' + n, name: 'read', isError: false});
      await append('first', {role: 'assistant', text: '完整工作'.repeat(200) + '\n【轮次摘要】\n标题：已核验\n报告：验证通过'});
      await journal.finish('s', ownerId, 'first', 'completed');
      const actorBase = {system: roleSummaryInstruction(options.contract(identity)), tools: []};
      await contexts.taskEnd(identity, actorBase, signal);
      await append('next', {role: 'user', text: '继续核验'});
      const request = (await new ContextManager(options).prepare(identity, actorBase, signal)).request;
      assert.match(request.system, new RegExp(ownerId + '：保留实际验证'));
      assert.equal(request.messages.findLast(message => message.role === 'user')?.text, '继续核验');
      assert.equal(request.messages.some(message => message.text.startsWith('完整工作')), ownerId === 'logox');
      const tools = request.messages.filter(message => message.role === 'tool');
      assert.equal(tools.length, ownerId === 'kalon' ? 0 : ownerId === 'logox' ? 3 : 2);
      const ids = request.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls?.map(call => call.id) ?? [] : []);
      assert.deepEqual(tools.map(tool => tool.callId), ids);
    }
    await journal.fork('s', ['aletheia', 'techne', 'kalon', 'logox'], ['first']);
    for (const ownerId of ['aletheia', 'techne', 'kalon', 'logox']) {
      const request = (await new ContextManager(options).prepare({sessionId: 's', ownerId}, base, signal)).request;
      assert.deepEqual(request.messages, [{role: 'user', text: '继续核验'}]);
    }
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('短轮收尾也关闭零保留旧轮，契约进入真实最终历史汇总请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-role-summary-'));
  try {
    const journal = new Journal(directory), identity = {sessionId: 's', ownerId: 'kalon'}, seen: ModelRequest[] = [];
    const options = {journal, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0, max_budget_tokens: 700, target_budget_tokens: 300, task_end_floor_ratio: 0}),
      contract: () => '保留已确认风格', maxOutput: 100, model: () => ({identity: 'test', window: 4096}),
      summarizer: () => ({model: {identity: 'summary', window: 8192}, provider: {async respond(request: ModelRequest) {seen.push(request); return {message: {role: 'assistant' as const, text: '已确认简洁风格；继续核验。'}, stop: 'complete' as const};}}})};
    for (let n = 0; n < 4; n++) {
      await journal.append({version: 1, ...identity, activityId: 'r' + n, role: 'user', text: '确认目标'.repeat(100)});
      await journal.append({version: 1, ...identity, activityId: 'r' + n, role: 'assistant', text: '【轮次摘要】\n标题：风格确认\n报告：' + '保留审美目标'.repeat(70)});
      await journal.finish('s', 'kalon', 'r' + n, 'completed');
    }
    await new ContextManager(options).taskEnd(identity, base, signal);
    assert.ok(seen.length > 0); assert.ok(seen.every(request => request.system.includes('保留已确认风格') && !request.tools.length && request.thinking === false));
    const restored = (await new ContextManager(options).prepare(identity, base, signal)).request;
    assert.match(restored.messages[0]!.text, /已确认简洁风格/);
  } finally {await rm(directory, {recursive: true, force: true});}
});

async function seed(journal: Journal, ownerId: string, closed: number, closedChars: number, openChars = 0) {
  const identity = {sessionId: 's', ownerId};
  for (let n = 0; n < closed; n++) {
    await journal.append({version: 1, ...identity, activityId: 'r' + n, role: 'user', text: '任务 ' + n});
    await journal.append({version: 1, ...identity, activityId: 'r' + n, role: 'assistant', text: 'work '.repeat(closedChars / 5) + '\n【轮次摘要】\n标题：完成 ' + n + '\n报告：验证通过'});
    await journal.finish('s', ownerId, 'r' + n, 'completed');
  }
  if (openChars) {
    await journal.append({version: 1, ...identity, activityId: 'open', role: 'user', text: '进行中'});
    await journal.append({version: 1, ...identity, activityId: 'open', role: 'assistant', text: 'draft '.repeat(openChars / 6)});
  }
  return identity;
}
const gateOptions = (journal: Journal, extra: object = {}) => ({journal, maxOutput: 256, model: () => ({identity: 'test', window: 131072}),
  policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0, max_budget_tokens: 4000, ...extra}),
  summarizer: () => {throw new Error('不应发起额外模型请求');}});
const savedFolds = async (journal: Journal, identity: {sessionId: string; ownerId: string}) =>
  (await journal.loadContext(identity.sessionId, identity.ownerId, await journal.load(identity.sessionId, identity.ownerId)))?.folded ?? [];

test('任务结束整理：低于高水位50%时跳过，高于下限且收益足够时才整理', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-taskend-floor-'));
  try {
    const journal = new Journal(directory), options = gateOptions(journal);
    const small = await seed(journal, 'techne', 3, 400);              // far below 2000 tokens (50% of high 4000)
    await new ContextManager(options).taskEnd(small, base, signal);
    assert.deepEqual(await savedFolds(journal, small), [], 'below the floor the view stays untouched');
    const large = await seed(journal, 'kalon', 3, 5600);              // above the floor, below high
    await new ContextManager(options).taskEnd(large, base, signal);
    assert.equal((await savedFolds(journal, large)).length, 3, 'above the floor a worthwhile compaction is saved');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('收益不足25%的整理被丢弃，视图与前缀缓存保持不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-taskend-benefit-'));
  try {
    const journal = new Journal(directory), options = gateOptions(journal);
    const identity = await seed(journal, 'techne', 1, 50, 7600);     // tiny closed round + large unfoldable open round
    const manager = new ContextManager(options), reports: string[] = [];
    const before = (await manager.prepare(identity, base, signal)).request;
    await new ContextManager({...options, report: (_who: unknown, text: string) => {reports.push(text);}}).taskEnd(identity, base, signal);
    assert.deepEqual(await savedFolds(journal, identity), []);
    assert.ok(reports.every(text => !text.includes('Compacted')), 'a discarded candidate publishes no Compacted notice');
    assert.deepEqual((await new ContextManager(options).prepare(identity, base, signal)).request.messages, before.messages);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('越过高水位的整理不受下限与收益门控影响', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-taskend-watermark-'));
  try {
    const journal = new Journal(directory), options = gateOptions(journal);
    const identity = await seed(journal, 'techne', 3, 7000);          // well above high (4000)
    const result = await new ContextManager(options).prepare(identity, base, signal);
    assert.equal(result.compacted, true);
    assert.equal((await savedFolds(journal, identity)).length, 3);
  } finally {await rm(directory, {recursive: true, force: true});}
});
