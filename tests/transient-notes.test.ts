import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {AUTOMA_STREAK, REPEAT_LIMIT} from '../src/kernel/tool-pacing.js';
import {AUTOMA_STREAK_NOTE} from '../src/prompts/runtime/recovery.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {createRuntimeContextMessage, withoutAnsweredTransient} from '../src/runtime/context-updates.js';
import {retainRuntimeContext} from '../src/context/continuity.js';
import type {ModelMessage, ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';

const glob = (id: string, pattern = '*'): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: [{id, name: 'Glob', arguments: JSON.stringify({pattern})}]}, stop: 'tools'});
const reply = (text: string, calls: NonNullable<ModelTurn['message']['toolCalls']> = []): ModelTurn => ({message: {role: 'assistant', text, ...(calls.length ? {toolCalls: calls} : {})}, stop: calls.length ? 'tools' : 'complete'});
const finish = {id: 'finish', name: '_FinishRound', arguments: JSON.stringify({title: 'Done', summary: 'Round outcome.'})};

async function run(turns: ModelTurn[], opts: {companion?: boolean; appendOnly?: boolean} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-transient-'));
  const store = new RuntimeStore();
  if (opts.companion) store.activities.create({sessionId: 's', activityId: 'peer', ownerId: 'techne', kind: 'actor', title: 'Rig', status: 'running', stage: 'x', detail: ''});
  const requests: ModelRequest[] = [];
  const provider: Provider = {...opts.appendOnly ? {capabilities: {toolDiscovery: 'none', runtimeInstructions: 'meta-user', caching: 'anthropic', appendOnlyHistory: true}} : {},
    async respond(request, delta) {
      requests.push(structuredClone(request));
      const value = turns[requests.length - 1] ?? reply('Done.', [finish]);
      if (value.message.text) delta({kind: 'text', text: value.message.text});
      return value;
    }};
  const journal = new Journal(join(cwd, 'sessions'));
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, journal, execute, {handoff: async () => {}});
  const task = ensemble.dispatch('logox', 'Go', 'direct');
  await task.done;
  return {requests, journal, activity: store.activities.get('s', task.activityId), cleanup: async () => { await ensemble.close(); await rm(cwd, {recursive: true, force: true}); }};
}
const notes = (request: ModelRequest, needle = '') => request.messages.filter(message => message.role === 'context' && message.kind === 'recovery' && message.text.includes(needle));
const toolTexts = (request: ModelRequest) => request.messages.filter(message => message.role === 'tool').map(message => message.text);
const prefixOf = (before: ModelRequest, after: ModelRequest) => before.messages.every((message, index) => JSON.stringify(message) === JSON.stringify(after.messages[index]));

test('a recovery note reaches the request that follows it and is gone once the model answered', async () => {
  // An empty first reply makes the runtime ask again; the note rides on the second request only.
  const f = await run([reply(''), glob('g1', 'a'), glob('g2', 'b'), reply('Done.', [finish])], {companion: false});
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.equal(f.requests.length, 4);
    assert.equal(notes(f.requests[0]!).length, 0);
    assert.equal(notes(f.requests[1]!).length, 1, 'the request after the failure carries the recovery note');
    assert.equal(notes(f.requests[2]!).length, 0, 'the answered note is not replayed');
    assert.equal(notes(f.requests[3]!).length, 0);
    const ledger = await f.journal.loadRaw('s', 'logox');
    assert.ok(ledger.some(entry => entry.message?.role === 'context' && entry.message.kind === 'recovery'), 'the ledger still keeps it for audit and restore');
    assert.ok(prefixOf(f.requests[2]!, f.requests[3]!), 'after the drop each request extends the previous one byte for byte');
  } finally { await f.cleanup(); }
});

test('on an append-only protocol recovery notes stay in history', async () => {
  const f = await run([reply(''), glob('g1', 'a'), glob('g2', 'b'), reply('Done.', [finish])], {companion: false, appendOnly: true});
  try {
    assert.equal(f.requests.length, 4);
    assert.equal(notes(f.requests[1]!).length, 1);
    for (const request of f.requests.slice(2)) assert.equal(notes(request).length, 1, 'never removed');
    for (let index = 1; index < f.requests.length; index++) assert.ok(prefixOf(f.requests[index - 1]!, f.requests[index]!), 'request ' + index + ' keeps the earlier bytes');
  } finally { await f.cleanup(); }
});

test('the wait instruction is a recovery note on the closing request', async () => {
  const f = await run([...Array.from({length: REPEAT_LIMIT + 1}, (_, index) => glob('p' + index)), reply('Waiting.', [finish])], {companion: true});
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.equal(notes(f.requests.at(-1)!, 'tools are withdrawn').length, 1);
  } finally { await f.cleanup(); }
});

test('the Automa reminder is a request-only context note after the results, once per run, never while the Director waits', async () => {
  const streak = Array.from({length: AUTOMA_STREAK + 3}, (_, index) => glob('r' + index, 'p' + index));
  const free = await run([...streak, reply('Done.', [finish])], {companion: false});
  try {
    assert.equal(free.activity?.status, 'completed', free.activity?.detail);
    const first = free.requests.findIndex(request => notes(request, AUTOMA_STREAK_NOTE).length > 0);
    assert.equal(first, AUTOMA_STREAK, 'the request that follows the sixth read-only result');
    assert.equal(notes(free.requests[first]!, AUTOMA_STREAK_NOTE).length, 1);
    assert.ok(!AUTOMA_STREAK_NOTE.startsWith('[Runtime]'));
    for (const request of free.requests) assert.ok(!toolTexts(request).some(text => text.includes('read-only calls in a row')), 'never a tool-result suffix');
    for (const request of free.requests.slice(first + 1)) assert.equal(notes(request, AUTOMA_STREAK_NOTE).length, 0, 'once per run, not replayed');
    const raw = await free.journal.loadRaw('s', 'logox');
    assert.equal(raw.filter(entry => entry.role === 'context' && entry.text === AUTOMA_STREAK_NOTE).length, 1);
    assert.ok(prefixOf(free.requests[first + 1]!, free.requests[first + 2]!));
    assert.ok(prefixOf(free.requests[first + 2]!, free.requests[first + 3]!));
  } finally { await free.cleanup(); }
  const waiting = await run([...streak, reply('Done.', [finish])], {companion: true});
  try {
    for (const request of waiting.requests) assert.equal(notes(request, AUTOMA_STREAK_NOTE).length, 0, 'a waiting Director is never reminded');
  } finally { await waiting.cleanup(); }
});

test('the projection drops only answered transient notes and compaction does not bring them back', () => {
  const note = createRuntimeContextMessage('recovery', 'Retry.', {activityId: 'a', slot: 'x'});
  const other = createRuntimeContextMessage('task-state', 'Keep.', {activityId: 'a', slot: 'y'});
  const history: ModelMessage[] = [{role: 'user', text: 'Go'}, note, other, {role: 'assistant', text: 'ok'}, {role: 'user', text: 'More'}, note];
  const projected = withoutAnsweredTransient(history);
  assert.deepEqual(projected, [history[0], other, history[3], history[4], note]);
  assert.deepEqual(withoutAnsweredTransient(projected), projected, 'idempotent');
  assert.deepEqual(retainRuntimeContext(history, 'a').map(message => message.kind), ['task-state'], 'compaction keeps no recovery note');
});
