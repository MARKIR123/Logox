import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskModels, TaskModelLedger} from '../src/actors/task-models.js';
import {Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {ProviderError, providerFailure} from '../src/providers/http.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';
import {loadConfig} from '../src/config/config.js';
import {ContextManager} from '../src/context/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {Tools} from '../src/tools/tools.js';
import {createAgent} from '../src/kernel/agent.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {waitForSnapshot} from './runtime-fixture.js';

function complete(response: ServerResponse, content = '完成') {
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end('data: ' + JSON.stringify({choices: [{delta: {content}, finish_reason: 'stop'}]}) + '\n\n' +
    'data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 50, completion_tokens: 4}}) + '\n\n');
}
async function fixture(handle: (body: Record<string, unknown>, response: ServerResponse) => void, configured = true, retries = 0,
  kind: 'openai_compat' | 'anthropic' = 'openai_compat') {
  const directory = await mkdtemp(join(tmpdir(), 'logox-task-models-'));
  const requests: Record<string, unknown>[] = [];
  const routes: string[] = [], authorizations: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw) as Record<string, unknown>; requests.push(body); handle(body, response);
    routes.push(request.url ?? ''); authorizations.push(request.headers.authorization);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config = await loadConfig(directory, {provider: {name: 'main', model: 'same', max_tokens: 3000},
    providers: Object.fromEntries(['main', 'actor', 'other'].map(name => [name, {base_url: 'http://127.0.0.1:' + address.port + '/' + name, default_model: 'same', kind}])),
    models: {'main/same': {context_window: 8192, max_output_tokens: 1000}, 'actor/same': {context_window: 16384, max_output_tokens: 2000}, 'other/same': {context_window: 8192}}}, {}, directory, directory);
  const registry = new ProviderRegistry(config, {}, fetch, new AuthStorage(join(directory, 'auth.json')));
  const ledger = new TaskModelLedger(join(directory, 'models'));
  const models = new TaskModels({registry, defaultModel: () => configured ? {provider: 'actor', model: 'same'} : undefined, ledger});
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore();
  const contexts = new ContextManager({journal, policy: config.context, maxOutput: 3000, model: id => models.model(id), summarizer: id => models.summarizer(id)});
  contexts.meter({sessionId: 's', ownerId: 'techne'}).configureUsage(() => models.summarizer({sessionId: 's', ownerId: 'techne'}).model.identity, () => {});
  let writes = 0;
  const extraTools = [{name: 'mcp', description: '测试文件操作', parameters: {type: 'object', properties: {}, additionalProperties: false}}];
  const ensemble = new Ensemble('s', store, journal, createAgent({cwd: directory, store, tools: new Tools(directory), context: contexts,
    taskModels: models, provider: () => {throw new Error('独立模型不调用主 provider');}, iterations: 20, retries,
    requestBase: async () => ({system: '动态角色规则', tools: extraTools}), extraTools, extraApprovalHandled: ['mcp'],
    executeExtra: async () => {writes++; await writeFile(join(directory, 'artifact.txt'), 'written'); return {text: '文件已写入', isError: false};}}));
  return {directory, registry, ledger, models, journal, store, contexts, ensemble, requests, routes, authorizations, writes: () => writes,
    async cleanup() {await ensemble.close(); store.interactions.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, {recursive: true, force: true});}};
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  await waitForSnapshot(f.store, state => state.interactions.some(item => item.status === 'pending'));
  return f.store.interactions.list().find(item => item.status === 'pending')!;
}
function switchModel(f: Awaited<ReturnType<typeof fixture>>, request: Awaited<ReturnType<typeof pending>>) {
  f.store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {task_model: {type: 'option', optionId: 'switch'}}}));
}

test('真实HTTP+Agent确认转用重做预算，完整工具结果保留且文件操作仅一次', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => {
    calls++;
    if (calls === 1) {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end('data: ' + JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: 'write', function: {name: 'mcp', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}) + '\n\n');
    } else if (calls === 2) {response.writeHead(404); response.end(JSON.stringify({error: {code: 'model_not_found', message: 'PRIVATE_SECRET'}}));}
    else complete(response);
  });
  try {
    const task = f.ensemble.dispatch('techne', '写入测试文件');
    const request = await pending(f);
    assert.equal(f.requests.length, 2); assert.equal(f.writes(), 1);
    assert.equal(f.registry.selection().provider, 'main');
    assert.ok(!JSON.stringify(f.store.getSnapshot()).includes('PRIVATE_SECRET'));
    switchModel(f, request); await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.deepEqual(f.requests.map(body => body.model), ['same', 'same', 'same']);
    assert.deepEqual(f.routes, ['/actor/chat/completions', '/actor/chat/completions', '/main/chat/completions']);
    assert.equal(f.requests[0]!.max_tokens, 2000); assert.equal(f.requests[2]!.max_tokens, 1000);
    const messages = f.requests[2]!.messages as {role: string; content: string}[];
    assert.equal(messages.filter(item => item.role === 'tool').length, 1);
    assert.equal(f.writes(), 1); assert.equal(await readFile(join(f.directory, 'artifact.txt'), 'utf8'), 'written');
    assert.equal(f.models.selection({sessionId: 's', ownerId: 'techne'}).provider, 'main');
    assert.equal(f.models.summarizer({sessionId: 's', ownerId: 'techne'}).model.identity, f.registry.capacity().identity);
    const usage = f.contexts.meter({sessionId: 's', ownerId: 'techne'}).usageRecords();
    assert.equal(usage.length, 1); assert.equal(usage[0]!.category, 'task'); assert.equal(usage[0]!.model, f.registry.capacity().identity);
    const states = await f.ledger.load('s', new Set([task.activityId]));
    assert.equal(states[0]?.switched, true); assert.equal(states[0]?.phase, 'completed');
    assert.deepEqual(await f.ledger.load('s', new Set()), []);
    f.models.restore(states); assert.equal(f.models.selection({sessionId: 's', ownerId: 'techne'}).provider, 'main');
  } finally {await f.cleanup();}
});

test('候选变化重新确认；替代失败不再询问；后续任务仍用默认模型', async () => {
  const f = await fixture((_body, response) => {response.writeHead(401); response.end('{}');});
  try {
    const task = f.ensemble.dispatch('techne', '测试'); const first = await pending(f);
    f.registry.select('other', 'same'); switchModel(f, first);
    const second = await pending(f); assert.notEqual(second.requestId, first.requestId); assert.equal(f.requests.length, 1);
    switchModel(f, second); await task.done;
    assert.equal(f.requests.length, 2); assert.equal(f.store.activities.get('s', task.activityId)?.status, 'failed');
    assert.equal(f.store.interactions.list().filter(item => item.kind === 'question').length, 2);
    const next = f.ensemble.dispatch('techne', '新任务'); await pending(f);
    assert.equal(f.models.selection({sessionId: 's', ownerId: 'techne'}).provider, 'actor'); next.cancel(); await next.done;
  } finally {await f.cleanup();}
});

test('取消等待、自由文本不当同意，确认前没有替代HTTP请求', async () => {
  const f = await fixture((_body, response) => {response.writeHead(403); response.end('{}');});
  try {
    const task = f.ensemble.dispatch('techne', '测试'); await pending(f); task.cancel(); await task.done;
    assert.equal(f.requests.length, 1); assert.equal(f.store.activities.get('s', task.activityId)?.status, 'cancelled');
    const next = f.ensemble.dispatch('techne', '再测试'); const request = await pending(f);
    f.store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {task_model: {type: 'text', text: '转用'}}}));
    await next.done; assert.equal(f.requests.length, 2); assert.equal(f.store.activities.get('s', next.activityId)?.status, 'failed');
  } finally {await f.cleanup();}
});

test('继承任务不询问；未知参数不误转用；HTTP错误代码归一', async () => {
  for (const status of [400, 404]) {
    const f = await fixture((_body, response) => {response.writeHead(status); response.end(JSON.stringify({error: {code: 'unknown_parameter', message: 'secret'}}));});
    try {const task = f.ensemble.dispatch('techne', '测试'); await task.done; assert.equal(f.requests.length, 1); assert.equal(f.store.interactions.list().length, 0);}
    finally {await f.cleanup();}
  }
  const f = await fixture((_body, response) => complete(response), false);
  try {const task = f.ensemble.dispatch('techne', '继承'); await task.done; assert.equal(f.models.selection({sessionId: 's', ownerId: 'techne'}).provider, 'main'); assert.equal(f.store.interactions.list().length, 0);}
  finally {await f.cleanup();}
  assert.equal(providerFailure(400, {error: {code: 'model_not_found'}}).category, 'model_missing');
  assert.equal(providerFailure(429, {error: {code: 'insufficient_quota'}}).category, 'quota');
  assert.equal(providerFailure(429).category, 'temporary');
  assert.equal(providerFailure(200, {error: {type: 'overloaded_error'}}).category, 'temporary');
  assert.equal(new ProviderError('窗口', false, 'capacity').retryable, false);
});

test('Actor余额不足的转用卡保留API错误和HTTP状态，用户确认前不换模型', async () => {
  const f = await fixture((body, response) => {
    if (body.model === 'same' && f.requests.length === 1) {
      response.writeHead(402); response.end(JSON.stringify({error: {code: 'invalid_request_error', message: 'Insufficient Balance'}}));
    } else complete(response);
  });
  try {
    const task = f.ensemble.dispatch('techne', '继续报告');
    const request = await pending(f); assert.equal(request.kind, 'question');
    if (request.kind === 'question') assert.match(request.questions[0]?.question ?? '', /HTTP 402.*Insufficient Balance.*余额不足/);
    assert.equal(f.requests.length, 1); assert.equal(f.models.selection({sessionId: 's', ownerId: 'techne'}).provider, 'actor');
    switchModel(f, request); await task.done;
    assert.equal(f.requests.length, 2); assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.models.selection({sessionId: 's', ownerId: 'techne'}).provider, 'main');
  } finally {await f.cleanup();}
});

test('已输出未完整工具的技术故障结束本次执行，不询问转用或执行半个调用', async () => {
  let calls = 0;
  const f = await fixture((_body, response) => {
    if (++calls === 1) {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: ' + JSON.stringify({choices: [{delta: {content: '已有进展', tool_calls: [{index: 0, id: 'partial', function: {name: 'mcp', arguments: '{'}}]}}]}) + '\n\n');
      setTimeout(() => response.destroy(), 20);
    } else complete(response);
  });
  try {
    const task = f.ensemble.dispatch('techne', '测试'); await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'failed');
    assert.equal(f.store.interactions.list().length, 0);
    assert.equal(f.writes(), 0);
    assert.equal(f.requests.length, 1, JSON.stringify({activity: f.store.activities.get('s', task.activityId), messages: f.store.getSnapshot().messages}));
    const entries = await f.journal.load('s', 'techne'); assert.ok(entries.some(entry => entry.text === '已有进展'));
    assert.equal(entries.some(entry => entry.message?.role === 'assistant' && entry.message.toolCalls?.length), false);
  } finally {await f.cleanup();}
});

test('暂时故障先有界重试、失败交上层处理，同一模型不提出转用', async () => {
  const f = await fixture((_body, response) => {response.writeHead(503); response.end('{}');}, true, 1);
  try {
    const task = f.ensemble.dispatch('techne', '测试'); await task.done; assert.equal(f.requests.length, 2);
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'failed');
    assert.equal(f.store.interactions.list().length, 0);
    f.registry.select('actor', 'same'); const next = f.ensemble.dispatch('techne', '同模型'); await next.done;
    assert.equal(f.requests.length, 4);
    assert.equal(f.store.interactions.list().filter(item => item.kind === 'question').length, 0);
  } finally {await f.cleanup();}
});

test('独立scope固定选择和共享认证；未知窗口提示配置；显式汇总覆盖', async () => {
  const f = await fixture((_body, response) => complete(response));
  try {
    await f.registry.auth.save('actor', 'synthetic-key', new AbortController().signal);
    const context: ActorContext = {sessionId: 's', activityId: 'fixed', ownerId: 'techne', history: [], signal: new AbortController().signal,
      report: () => {}, say: () => {}, record: async () => {}, permission: async () => false, ask: async () => {throw new Error('不可询问');}};
    const scope = await f.models.begin(context);
    f.registry.select('other', 'same');
    await scope.provider().respond({system: 'test', tools: [], messages: [{role: 'user', text: 'test'}]}, () => {}, context.signal);
    assert.equal(scope.selection().provider, 'actor'); assert.equal(scope.model().window, 16384);
    assert.deepEqual(f.authorizations, ['Bearer synthetic-key']);
    const models = new TaskModels({registry: f.registry, defaultModel: () => ({provider: 'actor', model: 'unknown'}), summaryModel: () => ({provider: 'main', model: 'same'})});
    const unknown = await models.begin({...context, activityId: 'unknown'});
    assert.throws(() => unknown.model(), (error: unknown) => error instanceof ProviderError && error.category === 'capacity');
    assert.equal(models.summarizer(context).model.window, 8192);
    assert.equal(f.requests.length, 1);
    const saved = await f.ledger.load('s', new Set(['fixed'])); assert.ok(!JSON.stringify(saved).includes('synthetic-key'));
  } finally {await f.cleanup();}
});

test('工具输出截断、拒绝与协议错误不会触发模型转用', async () => {
  for (const finish_reason of ['length', 'content_filter', undefined]) {
    let count = 0;
    const f = await fixture((_body, response) => {
      if (++count > 1) {complete(response); return;}
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end('data: ' + JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: 'incomplete', function: {name: 'mcp', arguments: '{}'}}]}, finish_reason}]}) + '\n\n');
    });
    try {
      const task = f.ensemble.dispatch('techne', '测试截断'); await task.done;
      assert.equal(f.writes(), 0); assert.equal(f.store.interactions.list().length, 0);
      assert.ok(f.routes.every(route => route.startsWith('/actor/')));
    } finally {await f.cleanup();}
  }
});

test('跨原生模型转用保留工具配对与账本，旧签名思考不回放给替代模型', async () => {
  let count = 0;
  const f = await fixture((_body, response) => {
    if (++count === 2) {response.writeHead(401); response.end('{}'); return;}
    const frames = count === 1 ? [
      {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: '原模型思考', signature: 'old-signed-thought'}},
      {type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: 'native-write', name: 'mcp', input: {}}},
      {type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{}'}},
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}},
    ] : [
      {type: 'content_block_start', index: 0, content_block: {type: 'text', text: '完成'}},
      {type: 'message_delta', delta: {stop_reason: 'end_turn'}},
    ];
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.end(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''));
  }, true, 0, 'anthropic');
  try {
    const task = f.ensemble.dispatch('techne', '测试'); const request = await pending(f); switchModel(f, request); await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed'); assert.equal(f.writes(), 1);
    assert.ok(JSON.stringify(f.requests[1]!.messages).includes('old-signed-thought'));
    assert.ok(!JSON.stringify(f.requests[2]!.messages).includes('old-signed-thought'));
    assert.ok(JSON.stringify(f.requests[2]!.messages).includes('native-write'));
    const entries = await f.journal.load('s', 'techne'); assert.ok(entries.some(entry => entry.message?.role === 'assistant' && entry.message.signature === 'old-signed-thought'));
  } finally {await f.cleanup();}
});
