import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime, type TaskResult} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {ModelRequest, ModelTurn, Provider, ToolCall} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import {buildStageRows} from '../src/tui/stage.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {createProvider} from '../src/providers/http.js';

const metadata = {title: 'Delivered result', verification: null, carry_forward: []};
const finish = (id = 'finish', args: unknown = metadata): ToolCall => ({id, name: '_FinishRound', arguments: typeof args === 'string' ? args : JSON.stringify(args)});
const turn = (text: string, calls?: ToolCall[], stop: ModelTurn['stop'] = calls ? 'tools' : 'complete'): ModelTurn => ({message: {role: 'assistant', text, ...(calls ? {toolCalls: calls} : {})}, stop});
async function fixture(respond: (request: ModelRequest, index: number) => ModelTurn | Promise<ModelTurn>, setup?: (journal: Journal) => void) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-finish-round-'));
  const journal = new Journal(join(cwd, 'sessions'));
  setup?.(journal);
  const store = new RuntimeStore();
  const unsubscribe = store.subscribe(() => {
    for (const request of store.getSnapshot().interactions) if (request.status === 'pending' && request.kind === 'permission') {
      store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision: 'allow_once'}));
    }
  });
  const requests: ModelRequest[] = [];
  const handed: TaskResult<string>[] = [];
  const provider: Provider = {async respond(request, delta, signal) {
    signal.throwIfAborted();
    requests.push(request);
    const value = await respond(request, requests.length);
    if (value.message.text) delta({kind: 'text', text: value.message.text});
    return value;
  }};
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({system: 'Test execution', tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, journal, execute, {handoff: async result => {handed.push(result);}});
  return {cwd, journal, store, requests, handed, ensemble,
    async cleanup() {await ensemble.close(); unsubscribe(); await rm(cwd, {recursive: true, force: true});}};
}

test('native provider serializers accept the finalizer and replay only paired business tools', async () => {
  for (const kind of ['anthropic', 'openai_compat'] as const) {
    const cwd = await mkdtemp(join(tmpdir(), 'logox-finish-wire-'));
    const bodies: Array<{messages: Array<{role: string; [key: string]: unknown}>; tools: unknown[]}> = [];
    const provider = createProvider({kind, baseUrl: 'https://synthetic.invalid/v1', model: 'fixture', key: '', temperature: 0.2, maxTokens: 512, timeoutMs: 1000}, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const read = bodies.length === 1;
      const call = read ? {id: 'read', name: 'Read', arguments: '{"file_path":"sample.txt"}'} : finish('native-' + bodies.length);
      const frames = kind === 'anthropic' ? [
        {type: 'message_start', message: {usage: {input_tokens: 20}}},
        ...(read ? [] : [{type: 'content_block_start', index: 0, content_block: {type: 'text', text: 'Native answer'}}]),
        {type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: call.id, name: call.name, input: {}}},
        {type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: call.arguments}},
        {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 8}}, {type: 'message_stop'},
      ] : [{choices: [{delta: {content: read ? '' : 'Native answer', tool_calls: [{index: 0, id: call.id, function: {name: call.name, arguments: call.arguments}}]}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 20, completion_tokens: 8}}];
      return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + (kind === 'openai_compat' ? 'data: [DONE]\n\n' : ''), {headers: {'content-type': 'text/event-stream'}});
    });
    const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
    const app = await createApplication({cwd, sessionId: 's', config, env: {}, provider, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
    try {
      await writeFile(join(cwd, 'sample.txt'), 'Source evidence');
      const first = app.ensemble.dispatch('logox', 'Inspect', 'direct'); await first.done;
      assert.equal(app.store.activities.get('s', first.activityId)?.status, 'completed', kind + ': ' + app.store.activities.get('s', first.activityId)?.detail);
      assert.equal(bodies.length, 2);
      assert.ok(JSON.stringify(bodies[0]!.tools).includes('_FinishRound'));
      assert.ok(JSON.stringify(bodies[1]!.messages).includes('Source evidence'));
      await app.ensemble.dispatch('logox', 'Continue', 'direct').done;
      assert.equal(bodies.length, 3);
      const history = JSON.stringify(bodies[2]!.messages.filter(message => message.role !== 'system'));
      assert.ok(!history.includes('_FinishRound'));
      assert.ok(history.includes('Native answer') && history.includes('Source evidence'));
      const entries = await app.journal.load('s', 'logox');
      assert.equal(entries.filter(entry => entry.message?.role === 'tool' && entry.message.name === '_FinishRound').length, 2);
    } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
  }
});

test('cancellation during internal receipt persistence remains cancelled and preserves text', async () => {
  let ensemble: EnsembleRuntime<string>;
  let activityId = '';
  const f = await fixture(() => turn('Preserved answer', [finish()]), journal => {
    const append = journal.append.bind(journal);
    journal.append = async entry => {
      await append(entry);
      if (entry.message?.role === 'tool' && entry.message.name === '_FinishRound') ensemble.cancel(activityId);
    };
  });
  ensemble = f.ensemble;
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct'); activityId = task.activityId;
    await task.done;
    assert.equal(f.store.activities.get('s', activityId)?.status, 'cancelled');
    assert.equal(f.requests.length, 1);
    const entries = await f.journal.load('s', 'logox');
    assert.ok(entries.some(entry => entry.text === 'Preserved answer'));
    const record = (await f.journal.rounds('s', 'logox', entries))[0]!;
    assert.equal(record.status, 'cancelled'); assert.equal(record.memory?.source, 'runtime');
  } finally {await f.cleanup();}
});

test('round sidecar failure still hands the actual full report to Director', async () => {
  const report = 'Outcome: completed\n' + 'Full evidence. '.repeat(300);
  const f = await fixture(() => turn(report, [finish()]), journal => {journal.finishRecord = async () => {throw new Error('Sidecar unavailable');};});
  try {
    const task = f.ensemble.dispatch('techne', 'Inspect', 'logox', {inputKind: 'director'}); await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.handed[0]?.delivery?.text, report);
    assert.equal(f.requests.length, 1);
  } finally {await f.cleanup();}
});

test('internal repair text and memory metadata stay invisible across actor views and restart', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-finish-restart-'));
  let calls = 0;
  const seen: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    seen.push(request); calls++;
    if (calls === 1) return turn('Normal answer');
    return turn(calls === 2 ? 'PRIVATE_REPAIR_TEXT' : 'Next answer', [finish('finish-' + calls, {...metadata, title: 'PRIVATE_MEMORY_TITLE'})]);
  }};
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const options = {cwd, sessionId: 's', config, env: {}, provider, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}};
  let app = await createApplication(options);
  try {
    const first = app.ensemble.dispatch('techne', 'Explain', 'direct', {inputKind: 'human'});
    await first.done;
    const original = await readFile(app.journal.path('s', 'techne'), 'utf8');
    assert.ok(original.includes('PRIVATE_REPAIR_TEXT') && original.includes('PRIVATE_MEMORY_TITLE'));
    for (const view of ['logox', 'techne']) {
      const rows = buildStageRows(app.store.getSnapshot(), 's', view, 90, {[first.activityId]: true}, null);
      assert.ok(rows.every(row => !row.text.includes('PRIVATE_') && !row.text.includes('_FinishRound')));
    }
    await app.close(); app = await createApplication(options);
    assert.equal(calls, 2, 'Restart does not request a model');
    for (const view of ['logox', 'techne']) {
      const rows = buildStageRows(app.store.getSnapshot(), 's', view, 90, {[first.activityId]: true}, null);
      assert.ok(rows.every(row => !row.text.includes('PRIVATE_') && !row.text.includes('_FinishRound')));
    }
    await app.ensemble.dispatch('techne', 'Continue', 'direct', {inputKind: 'human'}).done;
    assert.equal(calls, 3);
    assert.ok(!JSON.stringify(seen.at(-1)!.messages).includes('_FinishRound'));
    assert.ok(!JSON.stringify(seen.at(-1)!.messages).includes('PRIVATE_REPAIR_TEXT'));
    const entries = await app.journal.load('s', 'techne');
    const records = await app.journal.rounds('s', 'techne', entries);
    assert.deepEqual(records[0]?.sourceLines, {start: 1, end: 4});
    assert.ok((await readFile(app.journal.path('s', 'techne'), 'utf8')).startsWith(original));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('text plus terminal metadata closes in one request without a visible tool surface', async () => {
  const f = await fixture((_request, index) => {assert.equal(index, 1); return turn('Normal answer', [finish()]);});
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct', {inputKind: 'human'});
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 1);
    const entries = await f.journal.load('s', 'logox');
    assert.deepEqual(entries.map(entry => entry.role), ['user', 'assistant', 'tool']);
    assert.equal(entries.at(-1)?.message?.role, 'tool');
    assert.deepEqual(entries.at(-1)?.message, {role: 'tool', callId: 'finish', name: '_FinishRound', text: '', isError: false});
    const rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 90, {}, null);
    assert.ok(rows.some(row => row.text.includes('Normal answer')));
    assert.ok(rows.every(row => !row.text.includes('_FinishRound') && !row.text.includes('Delivered result')));
    assert.equal(f.store.getSnapshot().messages.filter(message => message.kind === 'tool').length, 0);
  } finally {await f.cleanup();}
});

test('only formal Director dispatch produces an independent full report', async () => {
  const report = 'Outcome: completed\nDeliverables: src/app.ts\nVerification: not run\nOpen Items: Windows testing\n' + 'Evidence. '.repeat(400);
  const f = await fixture(() => turn(report, [finish()]));
  try {
    await f.ensemble.dispatch('techne', 'Implement', 'logox', {inputKind: 'director'}).done;
    const formal = f.handed[0] as TaskResult<string> & {delivery?: {text: string}};
    assert.equal(formal?.delivery?.text, report);
    assert.ok(formal.summary.report.length <= 2000);
    assert.match(f.requests[0]!.system, /Outcome[\s\S]*Deliverables[\s\S]*Verification[\s\S]*Open Items/);
    const direct = f.ensemble.dispatch('techne', 'Discuss', 'direct', {inputKind: 'human'});
    await direct.done;
    assert.equal(f.handed.length, 1);
    assert.ok(!f.requests[1]!.system.includes('# Task report'));
    assert.ok(!JSON.stringify(f.requests[1]!.messages).includes('_FinishRound'));
    const entries = await f.journal.load('s', 'techne');
    const records = await f.journal.rounds('s', 'techne', entries);
    assert.equal(records.find(record => record.activityId === direct.activityId)?.delivery, undefined);
  } finally {await f.cleanup();}
});

test('missing metadata gets one metadata-only correction without repeating the answer', async () => {
  const f = await fixture((request, index) => {
    if (index === 1) return turn('Already delivered');
    assert.equal(index, 2);
    assert.deepEqual(request.tools.map(tool => tool.name), ['_FinishRound']);
    assert.match(request.system, /metadata-only/i);
    return turn('Already delivered', [finish()]);
  });
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 2);
    assert.equal(f.store.getSnapshot().messages.filter(message => message.role === 'assistant' && message.kind !== 'thinking').map(message => message.text).join('\n'), 'Already delivered');
    const entries = await f.journal.load('s', 'logox');
    assert.equal((await f.journal.rounds('s', 'logox', entries))[0]?.memory?.source, 'model');
  } finally {await f.cleanup();}
});

test('invalid metadata repair is bounded and falls back without fabricating verification', async () => {
  const f = await fixture((_request, index) => {assert.ok(index <= 2); return turn(index === 1 ? 'Actual answer' : '', [finish('bad-' + index, {title: 'Only title'})]);});
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 2);
    const entries = await f.journal.load('s', 'logox');
    const record = (await f.journal.rounds('s', 'logox', entries))[0]!;
    assert.equal(record.memory?.source, 'runtime');
    assert.equal(record.memory?.verification, null);
    assert.ok(record.memory?.carryForward.length);
  } finally {await f.cleanup();}
});

test('metadata without a delivered answer cannot complete a round', async () => {
  const f = await fixture((_request, index) => {assert.ok(index <= 2); return turn('', [finish('no-text-' + index)]);});
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'failed');
    assert.equal(f.requests.length, 2);
    const entries = await f.journal.load('s', 'logox');
    assert.ok(entries.filter(entry => entry.message?.role === 'tool').every(entry => entry.message?.role === 'tool' && entry.message.isError));
  } finally {await f.cleanup();}
});

test('mixed business/finalizer batches execute no side effects and require corrected metadata', async () => {
  const f = await fixture((request, index) => {
    if (index === 1) return turn('No file was created', [{id: 'write', name: 'Write', arguments: JSON.stringify({file_path: 'never.txt', content: 'bad'})}, finish('mixed')]);
    assert.equal(index, 2);
    assert.deepEqual(request.tools.map(tool => tool.name), ['_FinishRound']);
    return turn('', [finish('corrected')]);
  });
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.store.getSnapshot().interactions.length, 0);
    await assert.rejects(readFile(join(f.cwd, 'never.txt')), {code: 'ENOENT'});
    assert.equal(f.requests.length, 2);
  } finally {await f.cleanup();}
});

test('truncated finalizer arguments never receive a successful receipt', async () => {
  const f = await fixture((_request, index) => index === 1 ? turn('Delivered answer', [finish('truncated', '{"title":')], 'length') : turn('', [finish('corrected')]));
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.requests.length, 2);
    const entries = await f.journal.load('s', 'logox');
    assert.ok(entries.some(entry => entry.message?.role === 'tool' && entry.message.callId === 'truncated' && entry.message.isError));
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
  } finally {await f.cleanup();}
});

test('an independently pending accepted injection must finish before terminal closure', async () => {
  let ensemble: EnsembleRuntime<string>;
  let injected: Promise<boolean> | undefined;
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  const entering = new Promise<void>(resolve => {started = resolve;});
  const f = await fixture((_request, index) => {
    assert.ok(index <= 2);
    return turn(index === 1 ? 'Initial answer' : 'Updated answer', [finish('finish-' + index)]);
  }, journal => {
    const append = journal.append.bind(journal);
    journal.append = async entry => {
      if (entry.inputKind === 'collaboration') {started(); await held;}
      await append(entry);
      if (entry.message?.role === 'tool' && entry.message.callId === 'finish-1') {
        injected = ensemble.injectTaskMessage('techne', 'New evidence must be processed');
        await entering;
      }
    };
  });
  ensemble = f.ensemble;
  try {
    const task = ensemble.dispatch('techne', 'Inspect', 'logox', {inputKind: 'director'});
    await entering;
    await new Promise<void>(resolve => setImmediate(resolve));
    release();
    await task.done;
    assert.equal(await injected, true);
    assert.equal(f.requests.length, 2);
    assert.equal(f.handed[0]?.delivery?.text, 'Updated answer');
    const entries = await f.journal.load('s', 'techne');
    const record = (await f.journal.rounds('s', 'techne', entries))[0]!;
    assert.equal(record.end, entries.length);
    assert.equal(await ensemble.injectTaskMessage('techne', 'Too late'), false);
  } finally {release(); await f.cleanup();}
});

test('continuation invalidates successful old metadata even when the next correction fails', async () => {
  let ensemble: EnsembleRuntime<string>, injected = false;
  const f = await fixture((_request, index) => {
    assert.ok(index <= 3);
    return index === 1 ? turn('Old answer', [finish('stale', {...metadata, title: 'Stale clean result'})])
      : turn(index === 2 ? 'Updated answer: integration is failing; do not ship' : 'Unable to provide metadata');
  }, journal => {
    const append = journal.append.bind(journal);
    journal.append = async entry => {
      if (entry.role === 'assistant' && entry.text === 'Old answer' && !injected) {
        injected = true; assert.equal(await ensemble.injectTaskMessage('techne', 'New blocker: integration is failing'), true);
      }
      await append(entry);
    };
  });
  ensemble = f.ensemble;
  try {
    const task = ensemble.dispatch('techne', 'Inspect', 'logox', {inputKind: 'director'}); await task.done;
    assert.equal(f.requests.length, 3);
    const entries = await f.journal.load('s', 'techne');
    const record = (await f.journal.rounds('s', 'techne', entries))[0]!;
    assert.equal(record.memory?.source, 'runtime');
    assert.notEqual(record.memory?.title, 'Stale clean result');
    assert.ok(record.memory?.carryForward.length);
    assert.equal(record.delivery?.text, 'Updated answer: integration is failing; do not ship');
  } finally {await f.cleanup();}
});

test('an inbox message arriving during receipt persistence invalidates stale memory', async () => {
  let ensemble: EnsembleRuntime<string>;
  const f = await fixture((request, index) => {
    assert.ok(index <= 2);
    if (index === 2) assert.ok(request.messages.some(message => message.text.includes('New evidence')));
    return turn(index === 1 ? 'Initial answer' : 'Updated answer', [finish('finish-' + index, {...metadata, title: index === 1 ? 'Stale title' : 'Updated title'})]);
  }, journal => {
    const append = journal.append.bind(journal);
    journal.append = async entry => {
      await append(entry);
      if (entry.message?.role === 'tool' && entry.message.callId === 'finish-1') assert.equal(await ensemble.injectTaskMessage('techne', 'New evidence'), true);
    };
  });
  ensemble = f.ensemble;
  try {
    const task = f.ensemble.dispatch('techne', 'Inspect', 'logox', {inputKind: 'director'});
    await task.done;
    assert.equal(f.requests.length, 2);
    const entries = await f.journal.load('s', 'techne');
    const records = await f.journal.rounds('s', 'techne', entries);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.memory?.title, 'Updated title');
    assert.equal(records[0]?.delivery?.text, 'Updated answer');
    assert.equal(new Set(entries.map(entry => entry.activityId)).size, 1);
  } finally {await f.cleanup();}
});

test('a failed internal receipt write preserves the delivered text and execution outcome', async () => {
  const f = await fixture(() => turn('Durable report', [finish()]), journal => {
    const append = journal.append.bind(journal);
    journal.append = async entry => {
      if (entry.message?.role === 'tool' && entry.message.name === '_FinishRound') throw new Error('Receipt storage unavailable');
      await append(entry);
    };
  });
  try {
    const task = f.ensemble.dispatch('techne', 'Inspect', 'logox', {inputKind: 'director'});
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 1);
    assert.equal((f.handed[0] as TaskResult<string> & {delivery?: {text: string}})?.delivery?.text, 'Durable report');
    assert.ok((await f.journal.load('s', 'techne')).some(entry => entry.text === 'Durable report'));
  } finally {await f.cleanup();}
});
