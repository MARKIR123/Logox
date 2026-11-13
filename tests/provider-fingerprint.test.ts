import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {loadConfig, type ModelSettings} from '../src/config/config.js';
import {anthropicMessages, createProvider, openaiMessages} from '../src/providers/http.js';
import {buildFingerprint, fingerprintBlocks, flushFingerprints, messageLabel, shortHash, type FingerprintRecord} from '../src/providers/fingerprint.js';
import {createRuntimeContextMessage} from '../src/runtime/context-updates.js';
import type {ModelMessage, ModelRequest} from '../src/runtime/messages.js';

const image = {mimeType: 'image/png', data: 'AAAA'};
const history = (): ModelMessage[] => [
  {role: 'user', text: 'build the page'},
  {role: 'assistant', text: 'looking', toolCalls: [{id: 'c1', name: 'Read', arguments: '{"file_path":"a.html"}'}]},
  {role: 'tool', callId: 'c1', name: 'Read', text: 'file body', isError: false},
];
const encode = (message: ModelMessage) => openaiMessages([message], false, true, true);
const blocksOf = (messages: ModelMessage[]) => fingerprintBlocks(messages, 'test', encode, () => true);

test('an appended request keeps every leading hash and adds blocks at the end', () => {
  const first = blocksOf(history());
  const second = blocksOf([...history(), {role: 'assistant', text: 'done'}]);
  assert.equal(second.length, first.length + 1);
  assert.deepEqual(second.slice(0, first.length).map(block => block.hash), first.map(block => block.hash));
  assert.match(first[0]!.hash, /^[0-9a-f]{10}$/);
});

test('a changed middle message changes its own hash and label, not the blocks before it', () => {
  const before = blocksOf(history());
  const changed = history();
  changed[1] = {role: 'assistant', text: 'looking elsewhere', toolCalls: [{id: 'c1', name: 'Grep', arguments: '{}'}]};
  const after = blocksOf(changed);
  const first = after.findIndex((block, index) => block.hash !== before[index]!.hash);
  assert.equal(first, 1);
  assert.equal(before[1]!.label, 'assistant+calls1');
  assert.equal(after[first]!.label, 'assistant+calls1');
  assert.equal(after[0]!.hash, before[0]!.hash);
});

test('labels come from the typed messages: reminder, snapshot slot, tool result, image, plain assistant', () => {
  assert.equal(messageLabel(createRuntimeContextMessage('reminder', 'Check the roster.')), 'context:reminder');
  assert.equal(messageLabel(createRuntimeContextMessage('task-state', 'x', {slot: 'ensemble'})), 'context:task-state/ensemble');
  assert.equal(messageLabel(createRuntimeContextMessage('snapshot', 'roster', {activityId: 'a1'})), 'context:snapshot');
  assert.equal(messageLabel({role: 'tool', callId: 'c', name: 'Shell', text: 'ok', isError: false}), 'tool:Shell');
  assert.equal(messageLabel({role: 'tool', callId: 'c', name: 'Read', text: 'shot', isError: false, images: [image, image]}), 'tool:Read+img2');
  assert.equal(messageLabel({role: 'user', text: 'look', images: [image]}), 'user+img1');
  assert.equal(messageLabel({role: 'assistant', text: 'done'}), 'assistant');
});

test('sizes split by category: thinking only when replayed, images counted apart, tool results per tool name with an other bucket', () => {
  const messages: ModelMessage[] = [
    {role: 'user', text: 'u'.repeat(400), images: [image]},
    {role: 'assistant', text: 'a'.repeat(400), reasoning: 'r'.repeat(800), toolCalls: [{id: 'c1', name: 'Read', arguments: '{"file_path":"a"}'}]},
    {role: 'tool', callId: 'c1', name: 'Read', text: 't'.repeat(4000), isError: false},
    createRuntimeContextMessage('reminder', 'n'.repeat(200)),
  ];
  const build = (replays: boolean) => buildFingerprint({id: 'x', time: 1, target: {file: 'f', ownerId: 'techne'}, purpose: 'task', model: 'm', host: 'h', protocol: 'chat',
    toolsJson: '[]', systemBlocks: ['"s"'], systemText: 's', blocks: fingerprintBlocks(messages, 'sizes-' + replays, encode, () => replays),
    fields: {maxTokens: 1, thinking: 'none', retention: 'none', ttlMs: null, cacheKey: false, stream: true, discovery: 'none'}});
  const replayed = build(true), dropped = build(false);
  assert.ok(replayed.sizes.thinking >= 200 && dropped.sizes.thinking === 0);
  assert.ok(replayed.sizes.toolResults['Read']! >= 1000);
  assert.deepEqual(replayed.sizes.images, {count: 1, tokens: 1200});
  assert.ok(replayed.sizes.context > 0 && replayed.sizes.user >= 100 && replayed.sizes.toolArgs > 0);
  assert.equal(replayed.sizes.total, replayed.sizes.tools + replayed.sizes.system + replayed.sizes.user + replayed.sizes.assistantText + replayed.sizes.thinking +
    replayed.sizes.toolArgs + replayed.sizes.toolResults['Read']! + replayed.sizes.images.tokens + replayed.sizes.context);
  const many: ModelMessage[] = Array.from({length: 11}, (_, index) => ({role: 'tool', callId: 'c' + index, name: 'Tool' + index, text: 'x'.repeat(40 * (index + 1)), isError: false}));
  const wide = buildFingerprint({...{id: 'x', time: 1, target: {file: 'f', ownerId: 'techne'}, purpose: 'task', model: 'm', host: 'h', protocol: 'chat' as const,
    toolsJson: '[]', systemBlocks: ['"s"'], systemText: 's', fields: replayed.fields}, blocks: fingerprintBlocks(many, 'wide', encode, () => true)});
  assert.equal(Object.keys(wide.sizes.toolResults).length, 9, 'eight named tools plus other');
  assert.ok('other' in wide.sizes.toolResults);
});

test('the hash of a message does not depend on the cache marker that moves to the newest message', () => {
  const messages = history();
  const marked = JSON.stringify(anthropicMessages(messages, new Set(), true));
  const bare = JSON.stringify(anthropicMessages(messages, new Set(), false));
  assert.notEqual(marked, bare, 'the marker is part of the wire body');
  const blocks = fingerprintBlocks(messages, 'anthropic', message => anthropicMessages([message], new Set(), false), () => false);
  assert.equal(blocks[0]!.hash, shortHash(JSON.stringify(anthropicMessages([messages[0]!], new Set(), false))));
});

const anthropic = (): ModelSettings => ({kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', key: 'sk-ant-TOPSECRET',
  temperature: 0.2, maxTokens: 4096, timeoutMs: 5000});
const reply = (usage: Record<string, number> = {input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}) =>
  new Response(JSON.stringify({content: [{type: 'text', text: 'ok'}], stop_reason: 'end_turn', usage}), {status: 200, headers: {'content-type': 'application/json'}});
const lines = async (file: string) => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

test('a provider request appends a request line and a result line with the same id, and stores no text, key or header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-fingerprint-'));
  try {
    const file = join(root, 'requests', 'techne.fingerprints.jsonl');
    const provider = createProvider(anthropic(), (async () => reply()) as unknown as typeof fetch);
    const base: ModelRequest = {system: 'Stable rules SECRET-PROMPT\n\nvolatile', tools: [{name: 'Read', description: 'Read', parameters: {type: 'object'}}],
      messages: history(), stream: false, cacheKey: 'logox-key', cacheRetention: {role: 'long'}, fingerprint: {file, ownerId: 'techne', activityId: 'act1', purpose: 'task'}};
    await provider.respond(base, () => {}, new AbortController().signal);
    await provider.respond({...base, messages: [...history(), {role: 'assistant', text: 'next'}], maxTokens: 1, purpose: 'keepalive'}, () => {}, new AbortController().signal);
    await flushFingerprints();
    const rows = await lines(file);
    assert.deepEqual(rows.map(row => row['kind']), ['request', 'result', 'request', 'result']);
    const [first, firstResult, second, secondResult] = rows as [FingerprintRecord, Record<string, unknown>, FingerprintRecord, Record<string, unknown>];
    assert.equal(first.id, firstResult['id']);
    assert.equal(second.id, secondResult['id']);
    assert.notEqual(first.id, second.id);
    assert.deepEqual([first.purpose, second.purpose], ['task', 'keepalive']);
    assert.deepEqual([first.ownerId, first.activityId, first.protocol, first.model], ['techne', 'act1', 'anthropic', 'claude-test']);
    assert.equal(first.messages.length, 3);
    assert.deepEqual(second.messages.slice(0, 3), first.messages, 'the appended request keeps the leading blocks');
    assert.equal(first.tools, second.tools);
    assert.equal(first.system.length, 1, 'one hash per system block');
    assert.deepEqual(first.fields, {maxTokens: 4096, thinking: 'none:auto', retention: 'long', ttlMs: 3_600_000, cacheKey: false, stream: false, discovery: 'none'});
    assert.equal(second.fields.maxTokens, 1);
    assert.deepEqual(firstResult['usage'], {input: 5, output: 1, cacheRead: 0, cacheWrite: 0});
    const raw = await readFile(file, 'utf8');
    for (const secret of ['TOPSECRET', 'SECRET-PROMPT', 'build the page', 'file body', 'x-api-key', 'authorization', 'a.html']) assert.ok(!raw.includes(secret), secret + ' must never be recorded');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('a failed request records an error result and a request without a target writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-fingerprint-'));
  try {
    const file = join(root, 'requests', 'techne.fingerprints.jsonl');
    const failing = createProvider(anthropic(), (async () => new Response('{"error":{"type":"authentication_error"}}', {status: 401})) as unknown as typeof fetch);
    await assert.rejects(failing.respond({system: 's', tools: [], messages: history(), stream: false, fingerprint: {file, ownerId: 'techne'}}, () => {}, new AbortController().signal));
    await failing.respond({system: 's', tools: [], messages: history(), stream: false}, () => {}, new AbortController().signal).catch(() => {});
    await flushFingerprints();
    const rows = await lines(file);
    assert.deepEqual(rows.map(row => row['kind']), ['request', 'result']);
    assert.equal(rows[1]!['error'], 'authentication');
    assert.equal(rows[0]!['purpose'], 'task', 'the default purpose is task');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('an unwritable fingerprint path never fails the request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-fingerprint-'));
  try {
    const provider = createProvider(anthropic(), (async () => reply()) as unknown as typeof fetch);
    const turn = await provider.respond({system: 's', tools: [], messages: history(), stream: false, fingerprint: {file: join(root, 'a\0b', 'x.jsonl'), ownerId: 'techne'}}, () => {}, new AbortController().signal);
    assert.equal(turn.message.text, 'ok');
    await flushFingerprints();
  } finally {await rm(root, {recursive: true, force: true});}
});

function sse(text: string, withCall: boolean): Response {
  const chunk = (delta: unknown, finish?: string) => 'data: ' + JSON.stringify({choices: [{delta, ...(finish ? {finish_reason: finish} : {})}]}) + '\n\n';
  const body = withCall ? chunk({tool_calls: [{index: 0, id: 'g1', function: {name: 'glob', arguments: JSON.stringify({pattern: '*.nothing'})}}]}, 'tool_calls')
    : chunk({content: text}) + chunk({}, 'stop');
  return new Response(body + 'data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 10, completion_tokens: 5}}) + '\n\ndata: [DONE]\n\n', {status: 200, headers: {'content-type': 'text/event-stream'}});
}
async function runActor(fingerprints: boolean): Promise<{files: string[]; requests: number; rows: Record<string, unknown>[]}> {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-fingerprint-app-'));
  try {
    let requests = 0;
    const fetcher = (async () => sse('done', ++requests === 1)) as unknown as typeof fetch;
    const provider = createProvider({kind: 'openai_compat', baseUrl: 'https://gateway.example/v1', model: 'test', key: 'k', temperature: 0.2, maxTokens: 1000, timeoutMs: 5000}, fetcher);
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}, kernel: {request_fingerprints: fingerprints}}, {}, cwd, cwd);
    const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'fp', config, provider});
    try {await app.ensemble.dispatch('techne', 'build the page').done;} finally {await app.close();}
    await flushFingerprints();
    const dir = join(cwd, '.logox', 'state', 'sessions', 'fp', 'requests');
    const files = await readdir(dir).catch(() => [] as string[]);
    const rows = files.includes('techne.fingerprints.jsonl') ? await lines(join(dir, 'techne.fingerprints.jsonl')) : [];
    return {files, requests, rows};
  } finally {await rm(cwd, {recursive: true, force: true});}
}
test('an actor run writes one request line per model request under the session state, and kernel.request_fingerprints = false writes nothing', async () => {
  const on = await runActor(true);
  assert.ok(on.requests >= 2, 'the scripted run made at least two model requests');
  const requests = on.rows.filter(row => row['kind'] === 'request');
  assert.equal(requests.length, on.requests, 'one request line per model request');
  assert.equal(on.rows.filter(row => row['kind'] === 'result').length, on.requests, 'and one result line each');
  assert.ok(requests.every(row => row['ownerId'] === 'techne' && row['purpose'] === 'task' && typeof row['activityId'] === 'string'));
  assert.deepEqual(on.files, ['techne.fingerprints.jsonl']);
  const [first, second] = requests as unknown as FingerprintRecord[];
  assert.equal(first!.tools, second!.tools);
  assert.deepEqual(second!.messages[0], first!.messages[0], 'the first block of the stable history keeps its hash');
  const off = await runActor(false);
  assert.ok(off.requests >= 2);
  assert.deepEqual(off.files, [], 'switched off: no requests directory content');
});
