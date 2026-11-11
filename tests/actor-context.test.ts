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
test('Actor 新任务开始时用零旧轮和2/2/0工具组装实际请求，Logox 不折叠，重启与回退沿有效分支', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-actor-context-'));
  try {
    const journal = new Journal(directory);
    const options = {journal, policy: ({ownerId}: {ownerId: string}) => contextPolicySchema.parse({keep_recent_rounds: ownerId === 'logox' ? 2 : 0, keep_recent_tools: ownerId === 'kalon' ? 0 : 2}),
      contract: ({ownerId}: {ownerId: string}) => ownerId + '：保留实际验证和未完成事项', maxOutput: 1024,
      model: () => ({identity: 'test', window: 131072}), summarizer: () => {throw new Error('常规折叠禁止多发汇总请求');}};
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
      await append('next', {role: 'user', text: '继续核验'});
      await contexts.roundStart(identity, actorBase, signal, {keepLast: false});
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

test('索引行自身仍超过高水位时才合并成概览：输入只有索引行，契约进入汇总请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-role-summary-'));
  try {
    const journal = new Journal(directory), identity = {sessionId: 's', ownerId: 'kalon'}, seen: ModelRequest[] = [];
    const options = {journal, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0, max_budget_tokens: 700, target_budget_tokens: 300}),
      contract: () => '保留已确认风格', maxOutput: 100, model: () => ({identity: 'test', window: 4096}),
      summarizer: () => ({model: {identity: 'summary', window: 8192}, provider: {async respond(request: ModelRequest) {seen.push(request); return {message: {role: 'assistant' as const, text: '已确认简洁风格；继续核验。'}, stop: 'complete' as const};}}})};
    for (let n = 0; n < 4; n++) {
      await journal.append({version: 1, ...identity, activityId: 'r' + n, role: 'user', text: '确认目标'.repeat(100)});
      await journal.append({version: 1, ...identity, activityId: 'r' + n, role: 'assistant', text: '【轮次摘要】\n标题：风格确认\n报告：' + '保留审美目标'.repeat(70)});
      await journal.finish('s', 'kalon', 'r' + n, 'completed');
    }
    await journal.append({version: 1, ...identity, activityId: 'open', role: 'user', text: '新任务'});
    await new ContextManager(options).roundStart(identity, base, signal, {keepLast: false});
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

test('新任务开始时折叠全部已结束轮：没有半水位下限，不发模型请求，思考一并截断', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-tail-fold-'));
  try {
    const journal = new Journal(directory), options = gateOptions(journal), reports: string[] = [];
    const small = await seed(journal, 'techne', 3, 400, 60);          // far below any share of the high watermark
    await new ContextManager({...options, report: (_who: unknown, text: string) => {reports.push(text);}}).roundStart(small, base, signal, {keepLast: false});
    const entries = await journal.load('s', 'techne'), state = await journal.loadContext('s', 'techne', entries);
    assert.equal(state?.folded.length, 3, 'every closed round is folded however small the context is');
    assert.equal(state?.thinkingCut, entries.length, 'a fold strips earlier thinking like any compaction');
    assert.deepEqual(reports, [], 'a routine companion fold is silent');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('新任务开始时的折叠没有25%收益门槛：只折叠很小的一轮也保存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-tail-fold-benefit-'));
  try {
    const journal = new Journal(directory), options = gateOptions(journal);
    const identity = await seed(journal, 'techne', 1, 50, 7600);     // tiny closed round + large open round
    await new ContextManager(options).roundStart(identity, base, signal, {keepLast: false});
    assert.equal((await savedFolds(journal, identity)).length, 1);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('同一根任务的续做保留上一轮细节且什么都不折叠；之后无关的新任务把两轮一起折叠', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-tail-fold-root-'));
  try {
    const journal = new Journal(directory), options = gateOptions(journal);
    const identity = await seed(journal, 'techne', 2, 400, 60);
    const manager = new ContextManager(options);
    await manager.roundStart(identity, base, signal, {keepLast: true});
    assert.deepEqual(await savedFolds(journal, identity), [], 'the follow-up keeps everything in full');
    await manager.roundStart(identity, base, signal, {keepLast: false});
    assert.equal((await savedFolds(journal, identity)).length, 2, 'an unrelated task folds the kept round too');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('越过高水位的整理照常进行，不依赖任何开轮触发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-taskend-watermark-'));
  try {
    const journal = new Journal(directory), options = gateOptions(journal);
    const identity = await seed(journal, 'techne', 3, 7000);          // well above high (4000)
    const result = await new ContextManager(options).prepare(identity, base, signal);
    assert.equal(result.compacted, true);
    assert.equal((await savedFolds(journal, identity)).length, 3);
  } finally {await rm(directory, {recursive: true, force: true});}
});
