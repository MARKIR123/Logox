import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {createApplication as productionApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelRequest, ModelTurn, Provider, ToolDefinition} from '../src/runtime/messages.js';
import {recoverTextCalls} from '../src/kernel/text-recovery.js';
import {refineTurn} from '../src/kernel/turn-refine.js';
import {runWorker, type WorkerRun} from '../src/kernel/worker-run.js';
import {TEXT_CALL_RECOVERED_NOTE} from '../src/prompts/runtime/recovery.js';

const schema = (required: string[], properties: Record<string, unknown> = {}): ToolDefinition['parameters'] => ({type: 'object', required, properties});
const offered: ToolDefinition[] = [
  {name: 'Read', description: 'read', parameters: schema(['file_path'])},
  {name: 'Write', description: 'write', parameters: schema(['file_path', 'content'])},
  {name: 'Grep', description: 'search', parameters: schema(['pattern'])},
];
const argsOf = (calls: {arguments: string}[] | undefined) => (calls ?? []).map(call => JSON.parse(call.arguments) as unknown);

test('JSON shapes: name+arguments, name+parameters, tool+input, bare, fenced and arrays', () => {
  const bare = recoverTextCalls('{"name": "Read", "arguments": {"file_path": "a.ts"}}', offered)!;
  assert.deepEqual(bare.calls.map(call => call.name), ['Read']);
  assert.deepEqual(argsOf(bare.calls), [{file_path: 'a.ts'}]);
  assert.equal(bare.text, '');
  assert.deepEqual(argsOf(recoverTextCalls('{"name":"Grep","parameters":{"pattern":"x"}}', offered)?.calls), [{pattern: 'x'}]);
  assert.deepEqual(argsOf(recoverTextCalls('{"tool":"Grep","input":{"pattern":"y"}}', offered)?.calls), [{pattern: 'y'}]);
  const fenced = recoverTextCalls('Let me look.\n```json\n{"name":"Read","arguments":{"file_path":"b.ts"}}\n```\nThen I will edit.', offered)!;
  assert.equal(fenced.text, 'Let me look.\n\nThen I will edit.');
  assert.deepEqual(argsOf(fenced.calls), [{file_path: 'b.ts'}]);
  assert.deepEqual(recoverTextCalls('```\n{"name":"Read","arguments":{"file_path":"c"}}\n```', offered)?.calls.map(call => call.name), ['Read']);
  const array = recoverTextCalls('[{"name":"Read","arguments":{"file_path":"a"}},{"name":"Grep","arguments":{"pattern":"p"}}]', offered)!;
  assert.deepEqual(array.calls.map(call => call.name), ['Read', 'Grep']);
  const string = recoverTextCalls('{"name":"Read","arguments":"{\\"file_path\\":\\"s\\"}"}', offered)!;
  assert.deepEqual(argsOf(string.calls), [{file_path: 's'}]);
});

test('tag form: one or several <tool_call> tags, prose kept around them', () => {
  const text = 'First.\n<tool_call>{"name":"Read","arguments":{"file_path":"a"}}</tool_call>\n<tool_call>{"name":"Grep","arguments":{"pattern":"q"}}</tool_call>\nDone.';
  const result = recoverTextCalls(text, offered)!;
  assert.deepEqual(result.calls.map(call => call.name), ['Read', 'Grep']);
  assert.equal(result.text, 'First.\n\nDone.');
  assert.equal(new Set(result.calls.map(call => call.id)).size, 2, 'fresh unique ids');
});

test('XML form: parameter values parse as JSON when they can, otherwise stay strings; the function_calls wrapper is optional', () => {
  const text = 'Working.\n<function_calls>\n<invoke name="Write">\n<parameter name="file_path">a.json</parameter>\n<parameter name="content">{"x": [1, 2]}</parameter>\n</invoke>\n</function_calls>';
  const result = recoverTextCalls(text, offered)!;
  assert.equal(result.text, 'Working.');
  assert.deepEqual(argsOf(result.calls), [{file_path: 'a.json', content: {x: [1, 2]}}]);
  const plain = recoverTextCalls('<invoke name="Grep"><parameter name="pattern">todo</parameter><parameter name="limit">5</parameter><parameter name="flag">true</parameter><parameter name="word">null</parameter></invoke>', offered)!;
  assert.deepEqual(argsOf(plain.calls), [{pattern: 'todo', limit: 5, flag: true, word: 'null'}]);
});

test('truncated JSON is closed only after a complete value and only when every required field is present', () => {
  const nested = recoverTextCalls('{"name":"Write","arguments":{"file_path":"a","content":"hi","meta":{"tags":["x","y"]', offered)!;
  assert.deepEqual(argsOf(nested.calls), [{file_path: 'a', content: 'hi', meta: {tags: ['x', 'y']}}]);
  assert.deepEqual(argsOf(recoverTextCalls('{"name":"Read","arguments":{"file_path":"a",', offered)?.calls), [{file_path: 'a'}], 'a trailing comma is dropped');
  assert.equal(recoverTextCalls('{"name":"Write","arguments":{"file_path":"a"', offered), undefined, 'a required field is missing');
  assert.equal(recoverTextCalls('{"name":"Write","arguments":{"file_path":"a","content":"cut off here', offered), undefined, 'a string that is itself cut is never closed');
  assert.equal(recoverTextCalls('{"name":"Read","arguments":{"file_path":"a","limit":2', offered), undefined, 'a cut number could be shorter');
  assert.equal(recoverTextCalls('{"name":"Read","arguments":{"file_path":"a","offset":', offered), undefined);
  assert.deepEqual(recoverTextCalls('<tool_call>{"name":"Read","arguments":{"file_path":"t"}', offered)?.calls.length, 1, 'an unterminated last tag');
  assert.equal(recoverTextCalls('<invoke name="Read"><parameter name="file_path">a</parameter>', offered), undefined, 'an unterminated invoke is never guessed');
});

test('unknown tools, unusable calls and prose with braces change nothing', () => {
  assert.equal(recoverTextCalls('{"name":"Delete","arguments":{"file_path":"a"}}', offered), undefined);
  assert.equal(recoverTextCalls('{"name":"read","arguments":{"file_path":"a"}}', []), undefined, 'no tools offered');
  assert.equal(recoverTextCalls('Run <tool_call>{"name": "Read", oops}</tool_call>', offered), undefined);
  assert.equal(recoverTextCalls('<invoke name="Nope"><parameter name="a">1</parameter></invoke>', offered), undefined);
  assert.equal(recoverTextCalls('One of them is unknown: [{"name":"Read","arguments":{"file_path":"a"}},{"name":"Nope","arguments":{}}]', offered), undefined);
  assert.equal(recoverTextCalls('The config is {"name": "demo", "version": 2} and a set {1, 2}.', offered), undefined, 'JSON that is no call is prose');
  assert.equal(recoverTextCalls('{"name":"Read","arguments":[1,2]}', offered), undefined, 'arguments must be an object');
});

test('known aliases of an offered tool are accepted; case is otherwise exact', () => {
  assert.deepEqual(recoverTextCalls('{"name":"read_file","arguments":{"file_path":"a"}}', offered)?.calls.map(call => call.name) ?? [], [], 'not an alias of anything');
  assert.deepEqual(recoverTextCalls('{"name":"grep","arguments":{"pattern":"a"}}', offered)?.calls.map(call => call.name), ['Grep']);
  assert.equal(recoverTextCalls('{"name":"GREPPER","arguments":{"pattern":"a"}}', offered), undefined);
});

const turnOf = (text: string, extra: Partial<ModelTurn> = {}): ModelTurn => ({message: {role: 'assistant', text, ...extra.message}, stop: 'complete', ...extra});
const request = {tools: offered, messages: []};
const callText = '{"name":"Read","arguments":{"file_path":"a.ts"}}';

test('refineTurn recovers into an ordinary tool turn and keeps prose, but never touches structured turns, thinking or unoffered requests', () => {
  const turn = refineTurn(turnOf('Reading now. ' + callText), request);
  assert.equal(turn.stop, 'tools');
  assert.equal(turn.recovered, 1);
  assert.equal(turn.message.text, 'Reading now.');
  assert.equal(turn.message.toolCalls?.[0]?.name, 'Read');
  const structured = turnOf(callText, {message: {role: 'assistant', text: callText, toolCalls: [{id: 'x', name: 'Grep', arguments: '{"pattern":"p"}'}]}, stop: 'tools'});
  assert.equal(refineTurn(structured, request), structured);
  const thinking = turnOf('Plan done.', {message: {role: 'assistant', text: 'Plan done.', reasoning: callText}});
  assert.equal(refineTurn(thinking, request), thinking, 'reasoning is never read');
  const plain = turnOf(callText);
  assert.equal(refineTurn(plain, {tools: [], messages: []}), plain);
  assert.equal(refineTurn(turnOf('No call here.'), request).recovered, undefined);
});

test('a call quoted inside echoed runtime text is never run', () => {
  const quoted = '<persisted-output>\nTool: Read\n' + callText + '\n</persisted-output>';
  const turn = refineTurn(turnOf(quoted), request);
  assert.equal(turn.recovered, undefined);
  assert.equal(turn.echo, true);
});

// Application level ---------------------------------------------------------------------------------------------------------

function scripted(turns: Array<ModelTurn | ((request: ModelRequest) => ModelTurn)>): Provider {
  return {async respond(req, onDelta) {
    const next = turns.shift();
    assert.ok(next, 'unexpected extra model request');
    const turn = typeof next === 'function' ? next(req) : next;
    if (turn.message.text) onDelta({kind: 'text', text: turn.message.text});
    return turn;
  }};
}
const assistant = (text: string): ModelTurn => ({message: {role: 'assistant', text}, stop: 'complete'});
const call = (name: string, args: unknown, id = 'c'): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: [{id, name, arguments: JSON.stringify(args)}]}, stop: 'tools'});
async function rawFixture(provider: Provider) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-text-recovery-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}, kernel: {max_iterations: 50}}, {}, cwd, cwd);
  const probe = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'test', config, provider});
  await probe.close();
  const app = await productionApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'test', config, provider});
  return {cwd, app, async cleanup() {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
const closing = () => call('_FinishRound', {title: 'Searched', summary: 'Searched.'}, 'fin');
const reminders = (req: ModelRequest) => req.messages.filter(message => message.role === 'context' && message.kind === 'reminder').map(message => message.text);

test('an actor runs a call written as text, drops the call text from the reply, and is reminded once', async () => {
  const seen: ModelRequest[] = [];
  const watch = (turn: ModelTurn) => (req: ModelRequest) => {seen.push(req); return turn;};
  const f = await rawFixture(scripted([
    watch(assistant('Searching.\n```json\n{"name":"Glob","arguments":{"pattern":"*.nothing"}}\n```')),
    watch(assistant('Nothing found.')),
    watch(closing()),
  ]));
  try {
    const handle = f.app.ensemble.dispatch('techne', 'search');
    await handle.done;
    assert.equal(f.app.store.activities.get('test', handle.activityId)?.status, 'completed');
    assert.deepEqual(reminders(seen[1]!), [TEXT_CALL_RECOVERED_NOTE]);
    assert.deepEqual(reminders(seen[2]!), [], 'answered, so no longer sent');
    const assistantTurn = seen[1]!.messages.find(message => message.role === 'assistant' && message.toolCalls?.length);
    assert.ok(assistantTurn && assistantTurn.role === 'assistant');
    assert.equal(assistantTurn.toolCalls?.[0]?.name, 'Glob');
    assert.equal(assistantTurn.text, 'Searching.');
    const result = seen[1]!.messages.find(message => message.role === 'tool');
    assert.ok(result && result.role === 'tool' && !result.isError, 'the recovered call really ran');
    const shown = f.app.store.getSnapshot().messages.filter(message => message.activityId === handle.activityId);
    assert.ok(!shown.some(message => message.text.includes('"arguments"')), 'the call text never reaches the card');
  } finally {await f.cleanup();}
});

test('recovered arguments still go through schema validation: invalid ones give the normal tool error', async () => {
  const seen: ModelRequest[] = [];
  const f = await rawFixture(scripted([
    assistant('{"name":"Glob","arguments":{"patern":"oops"}}'),
    (req: ModelRequest) => {seen.push(req); return assistant('Fixed.');},
    closing(),
  ]));
  try {
    const handle = f.app.ensemble.dispatch('techne', 'search');
    await handle.done;
    const result = seen[0]!.messages.find(message => message.role === 'tool');
    assert.ok(result && result.role === 'tool' && result.isError && result.unexecuted, result && 'text' in result ? result.text : 'no tool result');
  } finally {await f.cleanup();}
});

test('a call to a tool that was not offered stays an ordinary reply', async () => {
  const f = await rawFixture(scripted([assistant('{"name":"Teleport","arguments":{"to":"moon"}}'), closing()]));
  try {
    const handle = f.app.ensemble.dispatch('techne', 'explain');
    await handle.done;
    assert.match(f.app.store.activities.get('test', handle.activityId)!.summary!.report, /Teleport/);
  } finally {await f.cleanup();}
});

test('an Automa worker recovers a call written as text through the same function and is reminded once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-worker-recovery-'));
  const seen: ModelRequest[] = [];
  const executed: string[] = [];
  const turns: ModelTurn[] = [assistant('<tool_call>{"name":"Read","arguments":{"file_path":"a.ts"}}</tool_call>'), call('Finish', {status: 'done', summary: 'ok'}, 'fin')];
  const run: WorkerRun<string> = {
    provider: {async respond(req) {seen.push(req); return turns.shift()!;}}, model: 'mock/worker', system: 'sys',
    tools: [...offered, {name: 'Finish', description: 'finish', parameters: schema(['summary'])}], messages: [{role: 'user', text: 'go'}], signal: new AbortController().signal, cwd, sessionId: 's',
    workerId: 'w1', cacheKey: 'k', retries: 0,
    terminal: {name: 'Finish', reminder: 'call Finish', alone: 'alone', accepted: 'accepted', settle: item => ({ok: true, value: JSON.parse(item.arguments).summary as string})},
    async executeCall(item) {executed.push(item.name + ' ' + item.arguments); return {text: 'file text', isError: false};},
  };
  try {
    const end = await runWorker(run);
    assert.equal(end.kind, 'finished');
    assert.deepEqual(executed, ['Read {"file_path":"a.ts"}']);
    assert.deepEqual(reminders(seen[1]!), [TEXT_CALL_RECOVERED_NOTE]);
  } finally {await rm(cwd, {recursive: true, force: true});}
});
