import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import net, {connect} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {loadConfig, modelSettings} from '../src/config/config.js';
import {ProviderError, ThoughtSplitter, createProvider, providerFailure} from '../src/providers/http.js';
import {createHttpTransport} from '../src/providers/transport.js';
import type {Delta, ModelRequest} from '../src/runtime/messages.js';

type Body = Record<string, unknown> & {stream?: boolean; google?: {thinking_config?: {include_thoughts?: boolean}}};
const send = (res: ServerResponse, delta: unknown, finish_reason: string | null = null) =>
  res.write('data: ' + JSON.stringify({choices: [{delta, finish_reason}]}) + '\n\n');
const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return {server, url: `http://127.0.0.1:${address.port}`, async close() {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }};
};
const readBody = async (req: AsyncIterable<Buffer | string>) => {let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text) as Body;};

async function actorFixture(reply: (res: ServerResponse, body: Body, count: number) => void) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-stream-resilience-'));
  const requests: Body[] = [];
  const mock = await listen(async (req, res) => {
    const body = await readBody(req); requests.push(body); reply(res, body, requests.length);
  });
  const transport = createHttpTransport({});
  const provider = createProvider({kind: 'openai_compat', baseUrl: mock.url, model: 'test', key: '', maxTokens: 512, temperature: 0.2, timeoutMs: 3000}, transport.fetch);
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, config, provider, sessionId: 'resilience', outageDelaysMs: [5], resourceOptions: {home: cwd, boundary: cwd}});
  return {app, requests, async close() {await app.close(); await transport.close(); await mock.close(); await rm(cwd, {recursive: true, force: true});}};
}
const sse = (res: ServerResponse) => res.writeHead(200, {'content-type': 'text/event-stream'});

test('a retry after an interrupted stream keeps streaming', {timeout: 15_000}, async () => {
  const f = await actorFixture((res, _body, count) => {
    sse(res);
    if (count === 1) {send(res, {reasoning_content: 'thinking'}); setTimeout(() => res.destroy(), 20);}
    else {send(res, {content: 'recovered'}, 'stop'); res.end('data: [DONE]\n\n');}
  });
  try {
    const task = f.app.ensemble.dispatch('logox', 'Go');
    await task.done;
    assert.ok(f.requests.length >= 2);
    assert.deepEqual(f.requests.map(body => body.stream), f.requests.map(() => true), 'every attempt, retries included, asked for a stream');
  } finally {await f.close();}
});

test('the request is resent without stream only when the endpoint says it cannot stream', {timeout: 15_000}, async () => {
  const f = await actorFixture((res, body) => {
    if (body.stream) {res.writeHead(400, {'content-type': 'application/json'}); res.end(JSON.stringify({error: {message: 'Streaming is not supported for this model'}})); return;}
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: 'plain reply'}, finish_reason: 'stop'}], usage: {prompt_tokens: 3, completion_tokens: 2}}));
  });
  try {
    const task = f.app.ensemble.dispatch('logox', 'Go');
    await task.done;
    assert.equal(f.requests[0]!.stream, true);
    assert.ok(f.requests.length >= 2 && !f.requests[1]!.stream, 'the second request carries no stream flag');
    assert.ok(f.app.store.getSnapshot().messages.some(message => message.text.includes('plain reply')));
  } finally {await f.close();}
});

test('an unrelated 400 never downgrades the request to non-streaming', {timeout: 15_000}, async () => {
  const f = await actorFixture(res => {res.writeHead(400, {'content-type': 'application/json'}); res.end(JSON.stringify({error: {message: 'Invalid temperature', code: 'invalid_request_error'}}));});
  try {
    const task = f.app.ensemble.dispatch('logox', 'Go');
    await task.done;
    assert.equal(f.requests.length, 1);
    assert.equal(f.app.store.activities.get('resilience', task.activityId)?.status, 'failed');
  } finally {await f.close();}
});

test('only a streaming rejection is classified as stream_unsupported', () => {
  const issue = (status: number, message: string) => providerFailure(status, {error: {message}}).diagnostic?.issue;
  assert.equal(issue(400, 'Streaming is not supported for this model'), 'stream_unsupported');
  assert.equal(issue(422, 'This endpoint does not support streaming'), 'stream_unsupported');
  assert.equal(issue(400, 'stream: unsupported value'), 'stream_unsupported');
  assert.notEqual(issue(400, 'Invalid temperature'), 'stream_unsupported');
  assert.notEqual(issue(500, 'streaming is not supported'), 'stream_unsupported');
});

test('TCP keep-alive probes are enabled on direct and proxied sockets', async () => {
  const calls: Array<[boolean | undefined, number | undefined]> = [];
  const original = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setKeepAlive = function (this: net.Socket, ...args: Parameters<typeof original>) {
    calls.push([args[0] as boolean | undefined, args[1] as number | undefined]);
    return original.apply(this, args);
  } as typeof original;
  const origin = await listen((_req, res) => res.end('ok'));
  const proxy = createServer();
  proxy.on('connect', (_req, client, head) => {
    const address = origin.server.address() as net.AddressInfo;
    const upstream = connect(address.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  const direct = createHttpTransport({});
  const proxied = createHttpTransport({http_proxy: `http://127.0.0.1:${proxyPort}`, NO_PROXY: ''});
  try {
    await (await direct.fetch(origin.url)).text();
    assert.ok(calls.length >= 1, 'the direct socket was configured');
    const direct_calls = calls.length;
    await (await proxied.fetch(origin.url)).text();
    assert.ok(calls.length > direct_calls, 'the proxy socket was configured');
    assert.ok(calls.every(([enabled, delay]) => enabled === true && delay === 10_000), JSON.stringify(calls));
  } finally {
    net.Socket.prototype.setKeepAlive = original;
    await direct.close(); await proxied.close();
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await origin.close();
  }
});

const request: ModelRequest = {system: '', messages: [{role: 'user', text: 'hi'}], tools: []};
const respond = async (settings: Partial<Parameters<typeof createProvider>[0]>, events: string[], extra: Partial<ModelRequest> = {}) => {
  const bodies: Body[] = [];
  const mock = await listen(async (req, res) => {
    bodies.push(await readBody(req)); sse(res);
    for (const event of events) res.write(event);
    res.end('data: [DONE]\n\n');
  });
  const provider = createProvider({kind: 'openai_compat', baseUrl: mock.url, model: 'gemini-4-neon-high', key: '', maxTokens: 512, temperature: 0.2, timeoutMs: 3000,
    thinkingProtocol: 'reasoning-effort', ...settings}, fetch);
  const deltas: Delta[] = [];
  try {
    const turn = await provider.respond({...request, ...extra}, delta => deltas.push(delta), new AbortController().signal);
    return {bodies, deltas, turn};
  } finally {await mock.close();}
};
const chunk = (content: string) => 'data: ' + JSON.stringify({choices: [{delta: {content}}]}) + '\n\n';

test('stream_thoughts sends the Gemini thought request and maps thought spans to reasoning', async () => {
  const on = await respond({streamThoughts: true}, [chunk('<thou'), chunk('ght>plan the '), chunk('work</thought>An'), chunk('swer'),
    'data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]}) + '\n\n']);
  assert.deepEqual(on.bodies[0]!.google, {thinking_config: {include_thoughts: true}});
  assert.equal(on.turn.message.reasoning, 'plan the work');
  assert.equal(on.turn.message.text, 'Answer');
  assert.ok(on.deltas.some(delta => delta.kind === 'reasoning'), 'thought text is reported as reasoning progress');

  for (const settings of [{}, {streamThoughts: false}]) {
    const off = await respond(settings, [chunk('<thought>kept as text</thought>')]);
    assert.ok(!('google' in off.bodies[0]!), 'nothing is sent unless the option is on');
    assert.equal(off.turn.message.text, '<thought>kept as text</thought>');
  }
  const none = await respond({streamThoughts: true}, [chunk('x')], {thinking: false});
  assert.ok(!('google' in none.bodies[0]!), 'no thought request when thinking is off');
});

test('ThoughtSplitter holds back a split tag and treats an unfinished tag start as text', () => {
  const splitter = new ThoughtSplitter();
  const out = [...splitter.push('a<'), ...splitter.push('thought>b</thou'), ...splitter.push('ght>c<th'), ...splitter.flush()];
  assert.deepEqual(out.map(part => part.kind + ':' + part.text), ['text:a', 'reasoning:b', 'text:c', 'text:<th']);
});

test('stream_thoughts resolves model > provider > named provider', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-stream-thoughts-'));
  try {
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'antigravity', model: 'gemini-4-neon-high', base_url: 'http://127.0.0.1:8045/v1', stream_thoughts: true},
      providers: {antigravity: {base_url: 'http://127.0.0.1:8045/v1', stream_thoughts: false}}}, {}, cwd, cwd);
    assert.equal(modelSettings(config, {}).streamThoughts, true);
    const plain = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'antigravity', model: 'gemini-4-neon-high', base_url: 'http://127.0.0.1:8045/v1'}}, {}, cwd, cwd);
    assert.equal(modelSettings(plain, {}).streamThoughts, undefined);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a stream of SSE comments keeps the request alive until the configured idle timeout, and no longer', {timeout: 15_000}, async () => {
  const mock = await listen(async (req, res) => {
    await readBody(req); sse(res);
    const timer = setInterval(() => res.write(': keep-alive\n\n'), 50);
    res.on('close', () => clearInterval(timer));
  });
  const provider = createProvider({kind: 'openai_compat', baseUrl: mock.url, model: 'test', key: '', maxTokens: 512, temperature: 0.2, timeoutMs: 700}, fetch);
  try {
    const startedAt = Date.now();
    const error = await provider.respond(request, () => {}, new AbortController().signal).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof ProviderError && error.diagnostic?.code === 'idle_timeout', 'comments are not model progress, so the configured idle timeout still ends the request');
    assert.ok(Date.now() - startedAt >= 650, 'the comments kept the connection open for the whole idle timeout');
  } finally {await mock.close();}
});
