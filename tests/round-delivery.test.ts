import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {ModelRequest, ModelTurn, Provider, ToolCall} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import {EMPTY_REPLY_REMINDER, SYNOPSIS_CLOSING_TOOL_RESULT, SYNOPSIS_FOLLOW_UP} from '../src/prompts/runtime/recovery.js';

const SYNOPSIS = '<synopsis title="Delivered result">\nExplained the cache bug; nothing open.\n</synopsis>';
const turn = (text: string, calls?: ToolCall[]): ModelTurn => ({message: {role: 'assistant', text, ...(calls ? {toolCalls: calls} : {})}, stop: calls ? 'tools' : 'complete'});
const finalizerText = (request: ModelRequest) => request.messages.findLast(message => message.role === 'context' && message.kind === 'finalizer')?.text ?? '';

async function fixture(respond: (request: ModelRequest, index: number, store: RuntimeStore) => ModelTurn) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-round-delivery-'));
  const journal = new Journal(join(cwd, 'sessions')), store = new RuntimeStore();
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request, delta, signal) {
    signal.throwIfAborted(); requests.push(request);
    const value = respond(request, requests.length, store);
    if (value.message.text) delta({kind: 'text', text: value.message.text});
    return value;
  }};
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId: 'logox', builtinPrompt: 'Test execution'}), tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, journal, execute, {});
  return {cwd, store, journal, requests, ensemble, async cleanup() {await ensemble.close(); await rm(cwd, {recursive: true, force: true});}};
}
const visibleText = (store: RuntimeStore) => store.getSnapshot().messages.filter(message => message.role === 'assistant' && message.kind !== 'thinking').map(message => message.text);

test('a reply that ends with a synopsis closes the round in one request', async () => {
  const f = await fixture(() => turn('Here is the answer.\n\n' + SYNOPSIS));
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.requests.length, 1);
    const record = await f.journal.lastRound('s', 'logox');
    assert.equal(record?.memory?.source, 'model');
    assert.equal(record?.summary.report, 'Here is the answer.');
  } finally {await f.cleanup();}
});

test('a delivered answer without a synopsis gets one follow-up asking only for it, with unchanged tools; its synopsis is the memory and folds under the answer', async () => {
  const f = await fixture((request, index) => {
    if (index === 1) return turn('Here is the answer.');
    assert.equal(index, 2);
    assert.deepEqual(request.tools, f.requests[0]!.tools, 'the cache prefix is unchanged');
    assert.ok(finalizerText(request).startsWith(SYNOPSIS_FOLLOW_UP));
    assert.ok(!JSON.stringify(request.messages).includes(EMPTY_REPLY_REMINDER), 'no wasted empty-reply reminder');
    return turn('Here is the answer, again.\n\n' + SYNOPSIS);
  });
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 2);
    // The follow-up's repeated answer is never shown; only its synopsis, as the block alone.
    assert.deepEqual(visibleText(f.store), ['Here is the answer.', SYNOPSIS]);
    const record = await f.journal.lastRound('s', 'logox');
    assert.deepEqual({title: record?.memory?.title, summary: record?.memory?.summary, source: record?.memory?.source},
      {title: 'Delivered result', summary: 'Explained the cache bug; nothing open.', source: 'model'});
    assert.equal(record?.summary.report, 'Here is the answer.', 'the report is the delivered answer, not the follow-up');
  } finally {await f.cleanup();}
});

test('a follow-up that still brings no synopsis ends the round with a runtime record, never a failure', async () => {
  const f = await fixture((_request, index) => turn(index === 1 ? 'Delivered text.' : 'Sorry, here it is again: delivered text.'));
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 2, 'asked once, never twice');
    assert.deepEqual(visibleText(f.store), ['Delivered text.']);
    const record = await f.journal.lastRound('s', 'logox');
    assert.equal(record?.memory?.source, 'runtime');
    assert.match(record?.summary.report ?? '', /Reply: Delivered text\.$/, 'without model memory the report is the runtime summary of the delivered text');
    assert.ok(!record?.summary.report.includes('again'), 'never the follow-up text');
  } finally {await f.cleanup();}
});

test('calls in the follow-up never run: each gets the closing result and the round ends', async () => {
  const f = await fixture((_request, index) => index === 1 ? turn('Delivered text.')
    : turn('', [{id: 'late-write', name: 'Write', arguments: JSON.stringify({file_path: 'never.txt', content: 'x'})}]));
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 2);
    await assert.rejects(readFile(join(f.cwd, 'never.txt')), 'the write never ran');
    const entries = await f.journal.load('s', 'logox');
    const result = entries.find(entry => entry.message?.role === 'tool' && entry.message.callId === 'late-write');
    assert.ok(result?.message?.role === 'tool' && result.message.isError && result.message.text === SYNOPSIS_CLOSING_TOOL_RESULT);
  } finally {await f.cleanup();}
});
