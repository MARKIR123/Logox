import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../src/store/journal.js';
import {ContextManager, ContextBudgetError} from '../src/context/manager.js';
import {TokenMeter, estimateRequest, watermarks} from '../src/context/budget.js';
import {summarizeRound, type ModelCapacity} from '../src/context/contracts.js';
import {contextPolicySchema, loadConfig} from '../src/config/config.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';
import type {ModelMessage, ModelRequest, Provider} from '../src/runtime/messages.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';

// Chinese fixtures cover legacy round-summary parsing and multilingual token estimation.
const identity = {sessionId: 's', ownerId: 'logox'};
const signal = new AbortController().signal;
const base = {system: '只处理用户任务', tools: []};
const capacity: ModelCapacity = {identity: 'synthetic-model', window: 131072, maxOutput: 2048};
function noSummary(): never {throw new Error('常规整理不应额外调用模型');}
async function fixture(policy: Record<string, unknown> = {}, model = capacity, provider: Provider = {respond: async () => noSummary()}) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-context-'));
  const journal = new Journal(directory), reports: string[] = [];
  const options = {journal, policy: contextPolicySchema.parse(policy), model: () => model, maxOutput: 16384,
    summarizer: () => ({model, provider}), report: (_identity: unknown, text: string) => {reports.push(text);}};
  return {directory, journal, reports, contexts: new ContextManager(options), options,
    async append(activityId: string, message: ModelMessage) {
      await journal.append({version: 1, ...identity, activityId, role: message.role, text: message.text, message});
    },
    async cleanup() {await rm(directory, {recursive: true, force: true});}};
}
function assertPairs(messages: readonly ModelMessage[]) {
  const pending = new Set<string>();
  for (const value of messages) {
    if (value.role === 'assistant') for (const call of value.toolCalls ?? []) pending.add(call.id);
    if (value.role === 'tool') {assert.ok(pending.delete(value.callId), 'No orphaned tool result');}
  }
  assert.equal(pending.size, 0, 'Every tool call has a matching result');
}
const final = (name: string): ModelMessage => ({role: 'assistant', text: name.repeat(1000) + '\n【轮次摘要】\n标题：完成' + name + '\n报告：保留' + name + '的结果，未做额外验证。'});

test('compaction retains recent rounds, current input and paired recent tools across batches', async () => {
  const f = await fixture();
  try {
    for (let round = 0; round < 4; round++) {
      const id = 'round-' + round;
      await f.append(id, {role: 'user', text: '任务' + round});
      if (!round) {
        await f.append(id, {role: 'assistant', text: '', toolCalls: [0, 1, 2].map(index => ({id: 'call-' + index, name: 'read', arguments: '{"file_path":"example"}'}))});
        for (let index = 0; index < 3; index++) await f.append(id, {role: 'tool', callId: 'call-' + index, name: 'read', text: '结果' + index, isError: false});
      }
      await f.append(id, final('R' + round));
      await f.journal.finish('s', 'logox', id, 'completed');
    }
    await f.append('current', {role: 'user', text: '当前工作不可丢'});
    const raw = await f.journal.load('s', 'logox');
    const result = await f.contexts.prepare(identity, base, signal, true);
    assert.ok(result.compacted);
    assert.ok(result.request.messages.some(message => message.text === '当前工作不可丢'));
    for (const name of ['R2', 'R3']) assert.ok(result.request.messages.some(message => message.text.startsWith(name.repeat(1000))));
    assert.ok(!result.request.messages.some(message => message.text.startsWith('R0'.repeat(1000))));
    assert.deepEqual(result.request.messages.filter(message => message.role === 'tool').map(message => message.callId), ['call-1', 'call-2']);
    assertPairs(result.request.messages);
    assert.deepEqual(await f.journal.load('s', 'logox'), raw, 'Compaction never rewrites raw records');
  } finally {await f.cleanup();}
});

test('zero retained closed rounds still protect current work and include real ledger coordinates', async () => {
  const f = await fixture({keep_recent_rounds: 0, keep_recent_tools: 0});
  try {
    await f.append('old', {role: 'user', text: '旧目标'});
    await f.append('old', final('OLD'));
    await f.journal.finish('s', 'logox', 'old', 'completed');
    await f.append('current', {role: 'user', text: '新的完整目标'});
    await f.append('current', {role: 'assistant', text: '当前进展'});
    const {request} = await f.contexts.prepare(identity, base, signal, true);
    assert.ok(!request.messages.some(message => message.text.startsWith('OLD'.repeat(1000))));
    assert.equal(request.messages.filter(message => message.role !== 'context').at(-1)?.text, '当前进展');
    assert.match(request.messages[0]!.text, /^1 \| .* \| Completed \| .* \| 1:2$/);
    assert.ok(request.messages.some(message => message.text === '新的完整目标'));
  } finally {await f.cleanup();}
});

test('tool archives commit before projection and restart falls back safely on missing or changed sources', async () => {
  const f = await fixture({keep_recent_tools: 0});
  try {
    await f.append('old', {role: 'user', text: '保存证据'});
    await f.append('old', {role: 'assistant', text: '', toolCalls: [{id: 'read-1', name: 'read', arguments: JSON.stringify({file_path: 'source', note: '参数'.repeat(1000)})}]});
    await f.append('old', {role: 'tool', callId: 'read-1', name: 'read', isError: false, text: '真实证据'.repeat(3000)});
    await f.append('old', {role: 'assistant', text: '已读取'});
    await f.journal.finish('s', 'logox', 'old', 'completed');
    const first = await f.contexts.prepare(identity, base, signal, true);
    const entries = await f.journal.load('s', 'logox');
    const state = await f.journal.loadContext('s', 'logox', entries);
    assert.ok(state?.archives.length);
    const archive = f.journal.archivePath('s', 'logox', state.archives[0]!.hash);
    const payload = JSON.parse(await readFile(archive, 'utf8')) as {result: {text: string}};
    assert.equal(payload.result.text, '真实证据'.repeat(3000));
    assertPairs(first.request.messages);
    const restored = await new ContextManager(f.options).prepare(identity, base, signal);
    assert.deepEqual(restored.request.messages, first.request.messages);
    await rm(archive);
    assert.equal(await f.journal.loadContext('s', 'logox', entries), undefined);
    const changed = entries.map((entry, index) => index ? entry : {...entry, text: '回退后的目标', message: {role: 'user', text: '回退后的目标'}});
    await writeFile(f.journal.path('s', 'logox'), changed.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    assert.equal(await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox')), undefined);
    const current = await new ContextManager(f.options).prepare(identity, base, signal);
    assert.ok(current.request.messages.some(message => message.text === '真实证据'.repeat(3000)));
    assert.equal(current.request.messages[0]?.text, '回退后的目标');
  } finally {await f.cleanup();}
});

test('archive and checkpoint failures retain raw history instead of using uncommitted projections', async () => {
  for (const failure of ['archive', 'checkpoint']) {
    const f = await fixture({keep_recent_tools: 0, keep_recent_rounds: 0});
    try {
      await f.append('old', {role: 'user', text: '目标'});
      await f.append('old', {role: 'assistant', text: '', toolCalls: [{id: 'c', name: 'read', arguments: '{}'}]});
      await f.append('old', {role: 'tool', callId: 'c', name: 'read', text: '内容'.repeat(2500), isError: false});
      await f.append('old', final('DONE'));
      await f.journal.finish('s', 'logox', 'old', 'completed');
      const raw = await f.journal.load('s', 'logox');
      if (failure === 'archive') f.journal.archive = async () => {throw new Error('模拟归档失败');};
      else f.journal.saveContext = async () => {throw new Error('模拟落盘失败');};
      await assert.rejects(f.contexts.prepare(identity, base, signal, true), /模拟/);
      assert.deepEqual(await f.journal.load('s', 'logox'), raw);
      assert.equal(await f.journal.loadContext('s', 'logox', raw), undefined);
      const retry = await new ContextManager(f.options).prepare(identity, base, signal);
      assert.ok(retry.request.messages.some(message => message.text === '内容'.repeat(2500)));
    } finally {await f.cleanup();}
  }
});

test('small windows clamp reserves and output allowance and reject oversized current work', async () => {
  const model = {identity: 'small', window: 256, maxOutput: 500};
  const f = await fixture({}, model);
  try {
    assert.deepEqual(watermarks(model, f.options.policy), {high: 192, low: 128, safety: 16});
    await f.append('current', {role: 'user', text: 'hello'});
    const result = await f.contexts.prepare(identity, {system: '', tools: []}, signal);
    assert.ok(result.request.maxTokens! <= model.window - estimateRequest(result.request) - 16);
    await f.append('current', {role: 'assistant', text: '太长'.repeat(1000)});
    await assert.rejects(f.contexts.prepare(identity, base, signal), ContextBudgetError);
  } finally {await f.cleanup();}
});

test('usage anchors require the same model, rules, tools and prefix and reject invalid usage', () => {
  const meter = new TokenMeter(), request: ModelRequest = {...base, messages: [{role: 'user', text: 'goal'}]};
  const turn = {message: {role: 'assistant' as const, text: 'answer'}, stop: 'complete' as const, usage: {input: 1234, output: 10, cacheRead: 400}};
  meter.observe(request, turn, capacity);
  const next = {...request, messages: [...request.messages, turn.message]};
  assert.equal(meter.estimate(next, capacity), 1244);
  assert.equal(meter.spent.input, 1234, 'Cached input is already included in total input');
  assert.equal(meter.estimate({...next, system: 'new rules'}, capacity), estimateRequest({...next, system: 'new rules'}));
  assert.equal(meter.estimate(next, {...capacity, identity: 'other'}), estimateRequest(next));
  assert.equal(meter.estimate({...next, tools: [{name: 'new', description: '', parameters: {}}]}, capacity), estimateRequest({...next, tools: [{name: 'new', description: '', parameters: {}}]}));
  meter.observe(request, {...turn, usage: {input: 0, output: 0}}, capacity);
  assert.equal(meter.estimate(next, capacity), estimateRequest(next));
  meter.observe(request, {...turn, stop: 'other'}, capacity);
  assert.equal(meter.estimate(next, capacity), estimateRequest(next));
});

test('incremental image estimates exclude base64 just like full request estimates', () => {
  const request: ModelRequest = {system: '', tools: [], messages: [{role: 'user', text: 'Inspect the screenshot'}]};
  const turn = {message: {role: 'assistant' as const, text: '', toolCalls: [{id: 'image', name: 'Read', arguments: '{"file_path":"desktop.png"}'}]}, stop: 'tools' as const};
  const prefix = {...request, messages: [...request.messages, turn.message]};
  const meter = new TokenMeter();
  meter.observe(request, {...turn, usage: {input: estimateRequest(prefix) - 10, output: 10}}, capacity);
  for (const size of [4, 1_354_000]) {
    const next: ModelRequest = {...prefix, messages: [...prefix.messages, {role: 'tool', name: 'Read', callId: 'image', text: 'Desktop screenshot', isError: false,
      images: [{data: 'A'.repeat(size), mimeType: 'image/png'}]}]};
    assert.equal(meter.estimate(next, capacity), estimateRequest(next));
    assert.ok(meter.estimate(next, capacity) < 2000);
  }
});

test('a screenshot does not trigger premature compaction with a calibrated usage anchor', async () => {
  const f = await fixture({}, {identity: 'image-model', window: 1_000_000});
  try {
    await f.append('current', {role: 'user', text: 'Inspect the screenshot'});
    const first = await f.contexts.prepare(identity, base, signal);
    const turn = {message: {role: 'assistant' as const, text: '', toolCalls: [{id: 'image', name: 'Read', arguments: '{}'}]}, stop: 'tools' as const,
      usage: {input: 25_000, output: 100}};
    f.contexts.observe(identity, first.request, turn, first.model);
    await f.append('current', turn.message);
    await f.append('current', {role: 'tool', name: 'Read', callId: 'image', text: 'Screenshot', isError: false,
      images: [{data: 'A'.repeat(4_000_000), mimeType: 'image/png'}]});
    const result = await f.contexts.prepare(identity, base, signal);
    assert.equal(result.compacted, false);
    assert.ok(f.contexts.status(identity)!.input < 27_000);
    assert.equal(f.reports.length, 0);
    assert.equal(await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox')), undefined);
  } finally {await f.cleanup();}
});

test('gpt-6.1-sol retains a 350k working context within its 1M built-in window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-sol-capacity-'));
  try {
    const config = await loadConfig(directory, {provider: {name: 'openai', model: 'gpt-6.1-sol'}}, {}, directory, directory);
    const model = new ProviderRegistry(config, {}, undefined, new AuthStorage(join(directory, 'auth.json'))).capacity();
    const f = await fixture({}, model);
    try {
      await f.append('current', {role: 'user', text: 'x'.repeat(1_400_000)});
      const result = await f.contexts.prepare(identity, base, signal);
      assert.equal(result.compacted, false);
      assert.equal(f.contexts.status(identity)!.window, 1_000_000);
      assert.equal(f.contexts.status(identity)!.high, 967_232);
      assert.ok(f.contexts.status(identity)!.input > 350_000);
      assert.ok(result.request.maxTokens! > 0);
    } finally {await f.cleanup();}
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('compaction notices distinguish automatic thresholds, forced cleanup and no-op outcomes in English', async () => {
  for (const force of [false, true]) {
    const f = await fixture({keep_recent_rounds: 0}, {identity: 'notice-model', window: 4096});
    try {
      await f.append('old', {role: 'user', text: 'Old evidence '.repeat(2000)});
      await f.append('old', final('DONE'));
      await f.journal.finish('s', 'logox', 'old', 'completed');
      await f.append('current', {role: 'user', text: 'Continue'});
      assert.equal((await f.contexts.prepare(identity, base, signal, force)).compacted, true);
      const notice = f.reports.find(text => text.startsWith('[Context] Compacted'))!;
      assert.match(notice, /high watermark 3072; window 4096/);
      assert.match(notice, force ? /history cleanup/ : /automatic/);
      assert.ok(f.reports.every(text => !/\p{Script=Han}/u.test(text)));
      f.reports.length = 0;
      await f.contexts.prepare(identity, base, signal, true);
      assert.ok(f.reports.every(text => text.startsWith('[Context]') && !/\p{Script=Han}/u.test(text)));
    } finally {await f.cleanup();}
  }
  const f = await fixture();
  try {
    await f.append('current', {role: 'user', text: 'Continue'});
    await f.contexts.prepare(identity, base, signal, true);
    assert.match(f.reports.at(-1)!, /\[Context\].*No reducible/);
  } finally {await f.cleanup();}
});

test('compaction persistence failures retain the view and report English diagnostics', async () => {
  const f = await fixture({keep_recent_rounds: 0});
  try {
    await f.append('old', {role: 'user', text: 'Inspect evidence'});
    await f.append('old', final('DONE'));
    await f.journal.finish('s', 'logox', 'old', 'completed');
    f.journal.saveContext = async () => {throw new Error('disk full');};
    await assert.rejects(f.contexts.prepare(identity, base, signal, true), /disk full/);
    assert.match(f.reports.at(-1)!, /\[Context\].*retaining.*disk full/);
    assert.ok(f.reports.every(text => !/\p{Script=Han}/u.test(text)));
  } finally {await f.cleanup();}
});

test('oversized closed history uses bounded summarization without tools, thinking or current work', async () => {
  const requests: ModelRequest[] = [];
  const model = {identity: 'memo-model', window: 4096, maxOutput: 512};
  const f = await fixture({keep_recent_rounds: 0}, model, {async respond(request) {
    requests.push(request);
    assert.equal(request.thinking, false); assert.deepEqual(request.tools, []);
    assert.ok(estimateRequest(request) + request.maxTokens! + 128 <= model.window);
    assert.ok(!JSON.stringify(request).includes('CURRENT_ONLY'));
    return {message: {role: 'assistant', text: '确认目标及旧历史结果，保留来源；后续核对验证。'}, stop: 'complete'};
  }});
  try {
    for (let n = 0; n < 4; n++) {
      await f.append('old-' + n, {role: 'user', text: '历史要求'.repeat(2200)});
      await f.append('old-' + n, {role: 'assistant', text: '[Round Summary]\nTitle: Historical decisions\nReport: ' + '保留要求'.repeat(400)});
      await f.journal.finish('s', 'logox', 'old-' + n, 'completed');
    }
    await f.append('current', {role: 'user', text: 'CURRENT_ONLY'});
    const result = await f.contexts.prepare(identity, base, signal);
    assert.ok(requests.length > 1 && requests.length <= 16);
    assert.ok(f.reports.some(text => text.startsWith('[Context] Summarizing')));
    assert.ok(f.reports.every(text => !/\p{Script=Han}/u.test(text)));
    assert.match(result.request.messages[0]!.text, /Historical working overview/);
    assert.equal(result.request.messages.filter(message => message.role !== 'context').at(-1)?.text, 'CURRENT_ONLY');
    const state = await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox'));
    assert.equal(state?.memo?.end, 8);
  } finally {await f.cleanup();}
});

test('ineffective or cancelled summaries preserve history and prevent over-budget requests', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const f = await fixture({}, {identity: 'tiny', window: 4096}, {async respond(request) {
      if (cancelled) {controller.abort(); controller.signal.throwIfAborted();}
      return {message: {role: 'assistant', text: request.messages[0]!.text}, stop: 'complete'};
    }});
    try {
      for (let n = 0; n < 4; n++) {
        await f.append('old-' + n, {role: 'user', text: '历史'.repeat(5000)});
        await f.append('old-' + n, {role: 'assistant', text: '[Round Summary]\nTitle: Historical decisions\nReport: ' + '保留要求'.repeat(400)});
        await f.journal.finish('s', 'logox', 'old-' + n, 'completed');
      }
      await f.append('current', {role: 'user', text: '继续'});
      const raw = await f.journal.load('s', 'logox');
      await assert.rejects(f.contexts.prepare(identity, base, controller.signal), cancelled ? {name: 'AbortError'} : ContextBudgetError);
      assert.deepEqual(await f.journal.load('s', 'logox'), raw);
      assert.equal(await f.journal.loadContext('s', 'logox', raw), undefined);
    } finally {await f.cleanup();}
  }
});

test('long-running compaction preserves the current goal and latest paired tool batch', async () => {
  const f = await fixture({}, {identity: 'long-task', window: 4096});
  try {
    await f.append('current', {role: 'user', text: 'CURRENT_GOAL'});
    await f.append('current', {role: 'assistant', text: '已核对'.repeat(1600), toolCalls: [{id: 'first', name: 'read', arguments: '{}'}]});
    await f.append('current', {role: 'tool', callId: 'first', name: 'read', text: '第一处证据', isError: false});
    await f.append('current', {role: 'assistant', text: '继续核对', toolCalls: [{id: 'second', name: 'read', arguments: '{}'}]});
    await f.append('current', {role: 'tool', callId: 'second', name: 'read', text: '第二处证据', isError: false});
    const result = await f.contexts.prepare(identity, base, signal);
    assert.equal(result.request.messages[0]?.text, 'CURRENT_GOAL');
    assert.match(result.request.messages[1]!.text, /Current task progress/);
    assert.equal(result.request.messages.filter(message => message.role !== 'context').at(-1)?.text, '第二处证据');
    assertPairs(result.request.messages);
  } finally {await f.cleanup();}
});

test('round summaries retain the real outcome and local fallback makes no model request', async () => {
  assert.equal(summarizeRound([final('verified')], 'completed').source, 'model');
  const cancelled = summarizeRound([final('verified')], 'cancelled');
  assert.equal(cancelled.source, 'local'); assert.match(cancelled.report, /已中断/);
  const f = await fixture();
  try {
    await f.append('failed', {role: 'user', text: '需要继续'});
    const summary = await f.journal.finish('s', 'logox', 'failed', 'failed');
    assert.match(summary.report, /执行失败/);
    const records = await f.journal.rounds('s', 'logox', await f.journal.load('s', 'logox'));
    assert.equal(records[0]?.status, 'failed');
  } finally {await f.cleanup();}
});

test('model capacity honors explicit configuration and live metadata without leaking across switches', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-capacity-'));
  try {
    const config = await loadConfig(cwd, {provider: {name: 'local', model: 'first', context_window: 8192}, providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}}}, {}, cwd, cwd);
    const registry = new ProviderRegistry(config, {}, async () => Response.json({data: [{id: 'second', context_window: 4096, max_output_tokens: 500}]}), new AuthStorage(join(cwd, 'auth.json')));
    assert.equal(registry.capacity().window, 8192);
    await registry.models(signal);
    registry.select('local', 'second'); assert.equal(registry.capacity().window, 4096); assert.equal(registry.capacity().maxOutput, 500);
    registry.select('local', 'unknown'); assert.throws(() => registry.capacity(), /窗口未知/);
    await assert.rejects(loadConfig(cwd, {context: {keep_recent_rounds: -1}}, {}, cwd, cwd));
    await assert.rejects(loadConfig(cwd, {context: {max_budget_tokens: 100, target_budget_tokens: 100}}, {}, cwd, cwd));
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('application auto-compaction and manual compaction share policy and restore without replay', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-context-app-'));
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    requests.push(request);
    return {message: {role: 'assistant', text: '完成'.repeat(3200) + '\n【轮次摘要】\n标题：已完成核对\n报告：保留确认决定与结果，尚未执行额外验证。'}, stop: 'complete'};
  }};
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 16384}, context: {keep_recent_rounds: 0, keep_recent_tools: 0}}, {}, cwd, cwd);
  let app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'context-app', config, provider, env: {}, authPath: join(cwd, 'auth.json')});
  try {
    for (let index = 0; index < 3; index++) await app.ensemble.dispatch('logox', '目标' + index).done;
    assert.equal(requests.length, 3, JSON.stringify(app.store.getSnapshot().activities));
    assert.ok(requests[2]!.messages.some(message => message.text.includes('| 已完成核对 | Completed')));
    const before = await app.journal.load('context-app', 'logox');
    await app.submit('/compact');
    assert.deepEqual(await app.journal.load('context-app', 'logox'), before);
    assert.equal(requests.length, 3, 'Ordinary compaction makes no extra summary request');
    await app.close();
    app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'context-app', config, provider, env: {}, authPath: join(cwd, 'auth.json')});
    assert.equal(requests.length, 3, 'Restore makes no model request');
    await app.ensemble.dispatch('logox', '继续').done;
    assert.ok(requests[3]!.messages.some(message => message.text.includes('| 已完成核对 | Completed')));
    assert.equal(requests[3]!.messages.findLast(message => message.role === 'user')?.text, '继续');
    assert.ok(requests[3]!.maxTokens! < config.provider.max_tokens);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('memo compaction clears overlapping working ranges and restores without repeated summarization', async () => {
  let summaries = 0;
  const f = await fixture({}, {identity: 'progress-memo', window: 4096}, {async respond() {
    summaries++;
    return {message: {role: 'assistant', text: '保留用户目标、已处理结果与剩余核验。'}, stop: 'complete'};
  }});
  try {
    await f.append('work', {role: 'user', text: '原始任务'});
    await f.append('work', {role: 'assistant', text: '进展'.repeat(2500), toolCalls: [{id: 'one', name: 'read', arguments: '{}'}]});
    await f.append('work', {role: 'tool', callId: 'one', name: 'read', isError: false, text: '证据一'});
    await f.append('work', {role: 'assistant', text: '继续', toolCalls: [{id: 'two', name: 'read', arguments: '{}'}]});
    await f.append('work', {role: 'tool', callId: 'two', name: 'read', isError: false, text: '证据二'});
    await f.contexts.prepare(identity, base, signal);
    assert.ok((await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox')))?.working);
    await f.append('work', {role: 'assistant', text: '【轮次摘要】\n标题：已核对\n报告：保留两个证据，验证待续。'});
    await f.journal.finish('s', 'logox', 'work', 'completed');
    for (let n = 0; n < 4; n++) {
      await f.append('next-' + n, {role: 'user', text: '历史要求'.repeat(1500)});
      await f.append('next-' + n, {role: 'assistant', text: '【轮次摘要】\n标题：已确认\n报告：' + '保留确认要求'.repeat(300)});
      await f.journal.finish('s', 'logox', 'next-' + n, 'completed');
    }
    await f.append('current', {role: 'user', text: '当前目标'});
    const first = await f.contexts.prepare(identity, base, signal);
    const state = await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox'));
    assert.ok(state?.memo); assert.equal(state.working, undefined);
    const calls = summaries;
    const restored = await new ContextManager(f.options).prepare(identity, base, signal);
    assert.deepEqual(restored.request.messages, first.request.messages);
    assert.equal(summaries, calls);
  } finally {await f.cleanup();}
});
