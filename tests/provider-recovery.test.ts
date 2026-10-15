import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {createProvider, providerFailure} from '../src/providers/http.js';
import {normalizeMessages, type ModelMessage} from '../src/runtime/messages.js';
import {waitForSnapshot} from './runtime-fixture.js';
import {buildStageRows} from '../src/tui/stage.js';

interface WireMessage {role: string; content?: string | null; reasoning_content?: string; tool_calls?: unknown[]}
const frame = (delta: Record<string, string>, finish_reason: string | null = null) =>
  'data: ' + JSON.stringify({choices: [{delta, finish_reason}]}) + '\n\n';

test('真实断流的错误码与已有输出保存到原任务，重启可查看但不重放请求', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-stream-diagnostic-'));
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write(frame({content: '已收到的合成进展'}));
    const timer = setTimeout(() => response.destroy(), 50);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'http://127.0.0.1:' + address.port,
    model: 'deepseek-flash', key: '', temperature: 0, maxTokens: 512, timeoutMs: 5000});
  const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'deepseek-flash', context_window: 131072}, kernel: {max_retries: 0}}, {}, cwd, cwd);
  const options = {cwd, config, provider, sessionId: 'diagnostic', resourceOptions: {home: cwd, boundary: cwd}};
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication(options);
    const handle = app.ensemble.dispatch('logox', '合成任务'); await handle.done;
    assert.equal(calls, 1, '关闭重试时只请求一次，仍保存完整诊断');
    assert.match(app.store.activities.get('diagnostic', handle.activityId)?.detail ?? '', /UND_ERR_SOCKET/);
    assert.ok((await app.journal.load('diagnostic', 'logox')).some(entry => entry.text === '已收到的合成进展'));
    await app.close(); app = await createApplication(options);
    assert.match(app.store.activities.get('diagnostic', handle.activityId)?.detail ?? '', /UND_ERR_SOCKET/);
    const rows = buildStageRows(app.store.getSnapshot(), 'diagnostic', 'logox', 110, {}, null);
    assert.equal(rows.filter(row => /UND_ERR_SOCKET/.test(row.text)).length, 1);
    assert.equal(calls, 1, '重启和展示不触发请求');
  } finally {
    await app?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, {recursive: true, force: true});
  }
});

test('思考阶段取消后重启会话，空助手消息不污染下一次 HTTP 请求', {timeout: 10000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-reasoning-cancel-'));
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    if (calls === 1) {
      const stream = new ReadableStream<Uint8Array>({start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({reasoning_content: '中断前的合成思考'})));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {once: true});
      }});
      return new Response(stream);
    }
    const body = JSON.parse(String(init?.body)) as {messages: WireMessage[]};
    if (body.messages.some(message => message.role === 'assistant' && !message.content && !message.tool_calls?.length)) {
      return Response.json({error: {code: 'invalid_request_error', message: 'Assistant message must have content or tool_calls.'}}, {status: 400});
    }
    return new Response(frame({content: '恢复成功'}, 'stop'));
  };
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', key: '',
    temperature: 0.2, maxTokens: 512, timeoutMs: 5000, thinkingControl: true}, fetcher);
  const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'deepseek-flash', context_window: 131072}}, {}, cwd, cwd);
  const options = {cwd, config, provider, sessionId: 'recovery', resourceOptions: {home: cwd, boundary: cwd}};
  let app = await createApplication(options);
  try {
    const first = app.ensemble.dispatch('logox', '合成任务');
    await waitForSnapshot(app.store, snapshot => snapshot.messages.some(message => message.kind === 'thinking' && !!message.text));
    first.cancel(); await first.done;
    const before = await app.journal.load('recovery', 'logox');
    assert.ok(before.some(entry => entry.message?.role === 'assistant' && !entry.text && entry.message.reasoning));
    await app.close(); app = await createApplication(options);
    const next = app.ensemble.dispatch('logox', '继续合成任务'); await next.done;
    assert.equal(app.store.activities.get('recovery', next.activityId)?.status, 'completed');
    assert.equal(calls, 2, '恢复不重放中断任务');
    const after = await app.journal.load('recovery', 'logox');
    assert.ok(after.some(entry => entry.message?.role === 'assistant' && entry.message.reasoning === '中断前的合成思考'), '原始账本保留中断思考');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('工具结果在下一条用户消息之前补齐，孤立和重复结果不冒充有效工具响应', () => {
  const messages: ModelMessage[] = [
    {role: 'user', text: '合成任务'},
    {role: 'assistant', text: '', reasoning: '已完成的合成思考', toolCalls: [
      {id: 'first', name: 'read', arguments: '{}'}, {id: 'missing', name: 'read', arguments: '{}'},
    ]},
    {role: 'tool', callId: 'first', name: 'read', text: '已有结果', isError: false},
    {role: 'tool', callId: 'first', name: 'read', text: '重复记录', isError: false},
    {role: 'user', text: '下一轮'},
    {role: 'tool', callId: 'unknown', name: 'read', text: '无调用记录的结果', isError: true},
  ];
  const before = JSON.stringify(messages), repaired = normalizeMessages(messages);
  assert.equal(repaired[3]?.role, 'tool');
  assert.ok(repaired[3]?.role === 'tool' && repaired[3].callId === 'missing' && repaired[3].isError);
  assert.equal(repaired.filter(message => message.role === 'tool').length, 2);
  assert.ok(repaired.some(message => message.role === 'user' && /重复记录/.test(message.text)));
  assert.ok(repaired.some(message => message.role === 'user' && /无调用记录的结果/.test(message.text)));
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(normalizeMessages(repaired), repaired, '重复整理保持同一视图');
});

test('HTTP 400 显示可识别的原因和字段，不泄漏服务端回显的秘密或正文', () => {
  for (const [message, issue] of [
    ['Assistant message must have content or tool_calls.', 'empty_assistant'],
    ['tool_call_id must match the preceding tool_calls.', 'tool_pairing'],
    ['reasoning_content must be passed back.', 'reasoning'],
  ]) {
    const error = providerFailure(400, {error: {code: 'invalid_request_error', param: 'messages[18].content', message: message + ' private-key private-user-text'}});
    assert.equal(error.diagnostic?.issue, issue);
    assert.equal(error.diagnostic?.status, 400);
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /messages\[18\]\.content/);
    assert.ok(!JSON.stringify(error).includes('private-'));
    assert.ok(!error.message.includes('private-'));
    assert.equal(error.retryable, false);
  }
  const unknown = providerFailure(400, {error: {code: 'private-key', param: 'private-user-text', message: 'private-user-text'}});
  assert.equal(unknown.message, '模型请求失败（HTTP 400）');
  assert.ok(!JSON.stringify(unknown).includes('private-'));
});

test('HTTP 402 优先识别余额不足，保留公开API信息，不被invalid_request_error误判成格式故障', () => {
  const error = providerFailure(402, {error: {type: 'unknown_error', code: 'invalid_request_error', message: 'Insufficient Balance'}});
  assert.equal(error.category, 'quota'); assert.equal(error.retryable, false);
  assert.match(error.message, /HTTP 402/); assert.match(error.message, /Insufficient Balance/);
  assert.match(error.message, /余额不足/); assert.match(error.message, /充值.*\/model/);
  assert.ok(!error.message.includes('格式无效'));
  assert.equal(providerFailure(402).category, 'quota', '缺少错误正文也不误判');
  const echoed = providerFailure(402, {error: {code: 'private-key', message: 'private-user-text private-key'}});
  assert.equal(echoed.category, 'quota'); assert.ok(!JSON.stringify(echoed).includes('private-'));
});

test('完整回复的思考字段经上下文投影和 HTTP 回传，格式失败展示且不盲目重试', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-thinking-history-'));
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {messages: WireMessage[]};
    calls++;
    if (calls === 1) return new Response(frame({reasoning_content: '合成的完整思考'}) + frame({content: '第一轮完成'}, 'stop'));
    const previous = body.messages.find(message => message.role === 'assistant');
    assert.equal(previous?.reasoning_content, '合成的完整思考');
    if (calls === 2) return new Response(frame({content: '第二轮完成'}, 'stop'));
    return Response.json({error: {code: 'invalid_request_error', param: 'messages[1].content', message: 'Assistant content invalid: private-echo'}}, {status: 400});
  };
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', key: '',
    temperature: 0.2, maxTokens: 512, timeoutMs: 5000, thinkingControl: true}, fetcher);
  const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'deepseek-flash', context_window: 131072}}, {}, cwd, cwd);
  const options = {cwd, config, provider, sessionId: 'thinking', resourceOptions: {home: cwd, boundary: cwd}};
  let app = await createApplication(options);
  try {
    await app.ensemble.dispatch('logox', '第一轮').done;
    const second = app.ensemble.dispatch('logox', '第二轮'); await second.done;
    assert.equal(app.store.activities.get('thinking', second.activityId)?.status, 'completed');
    const third = app.ensemble.dispatch('logox', '第三轮'); await third.done;
    const activity = app.store.activities.get('thinking', third.activityId);
    assert.equal(activity?.status, 'failed');
    assert.match(activity?.detail ?? '', /HTTP 400.*助手消息/);
    assert.ok(!activity?.detail?.includes('private-echo'));
    assert.equal(calls, 3, '协议错误不重试同一请求');
    await app.close(); app = await createApplication(options);
    const restored = app.store.activities.get('thinking', third.activityId);
    assert.match(restored?.detail ?? '', /失败原因：.*HTTP 400.*助手消息/);
    const rows = buildStageRows(app.store.getSnapshot(), 'thinking', 'logox', 100, {}, null);
    assert.equal(rows.filter(row => /HTTP 400/.test(row.text)).length, 1, '恢复后的折叠卡直接显示简短原因，不追加整块详情');
    assert.ok(!rows.some(row => /失败原因：/.test(row.text)), '详情正文仍折叠');
    const expanded = buildStageRows(app.store.getSnapshot(), 'thinking', 'logox', 100, {[third.activityId]: true}, null);
    assert.ok(expanded.some(row => /HTTP 400/.test(row.text)), '展开原任务可查看失败原因');
    assert.equal(calls, 3, '展示失败原因不重放模型请求');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
