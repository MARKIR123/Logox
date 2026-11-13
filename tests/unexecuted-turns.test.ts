import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {withoutAnsweredUnexecuted, type ModelMessage, type ModelRequest, type ModelTurn, type Provider} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';

type Tool = Extract<ModelMessage, {role: 'tool'}>;
const call = (id: string, name = 'Glob') => ({id, name, arguments: '{}'});
const turn = (ids: string[], text = ''): ModelMessage => ({role: 'assistant', text, toolCalls: ids.map(id => call(id))});
const result = (id: string, extra: Partial<Tool> = {}): Tool => ({role: 'tool', callId: id, name: 'Glob', text: 'x', isError: true, ...extra});
const never = (id: string) => result(id, {unexecuted: true});
const user: ModelMessage = {role: 'user', text: 'Go'};
const ran = (id: string) => result(id, {isError: false});

test('an unexecuted turn is dropped once a later turn executed a call', () => {
  const history = [user, turn(['a']), never('a'), turn(['b']), ran('b')];
  assert.deepEqual(withoutAnsweredUnexecuted(history), [user, history[3], history[4]]);
});

test('an unexecuted turn is dropped once a later turn delivered a final answer', () => {
  const history: ModelMessage[] = [user, turn(['a']), never('a'), {role: 'assistant', text: 'Here is the answer.'}];
  assert.deepEqual(withoutAnsweredUnexecuted(history), [user, history[3]]);
});

test('repeated failures stay visible until something later ran', () => {
  const history = [user, turn(['a']), never('a'), turn(['b']), never('b'), {role: 'assistant', text: '  '} as ModelMessage];
  assert.deepEqual(withoutAnsweredUnexecuted(history), history);
  assert.deepEqual(withoutAnsweredUnexecuted(history.slice(0, 3)), history.slice(0, 3));
});

test('a turn that also spoke to the user is kept', () => {
  const history = [user, turn(['a'], 'Let me explain what I will try.'), never('a'), turn(['b']), ran('b')];
  assert.deepEqual(withoutAnsweredUnexecuted(history), history);
});

test('a permission denial and a tool that ran and failed are kept', () => {
  const denied = [user, turn(['a']), result('a'), turn(['b']), ran('b')];
  assert.deepEqual(withoutAnsweredUnexecuted(denied), denied);
});

test('a mixed turn where one call ran is kept', () => {
  const history = [user, turn(['a', 'b']), never('a'), ran('b'), turn(['c']), ran('c')];
  assert.deepEqual(withoutAnsweredUnexecuted(history), history);
});

test('a mixed turn is only judged by its own results and the projection is idempotent', () => {
  const history = [user, turn(['a', 'b']), never('a'), never('b'), turn(['c']), ran('c'), turn(['d']), never('d')];
  const projected = withoutAnsweredUnexecuted(history);
  assert.deepEqual(projected, [user, history[4], history[5], history[6], history[7]], 'the trailing failure has nothing after it and stays');
  assert.deepEqual(withoutAnsweredUnexecuted(projected), projected);
});

const reply = (text: string, calls: NonNullable<ModelTurn['message']['toolCalls']> = []): ModelTurn => ({message: {role: 'assistant', text, ...(calls.length ? {toolCalls: calls} : {})}, stop: calls.length ? 'tools' : 'complete'});
const finish = {id: 'finish', name: '_FinishRound', arguments: JSON.stringify({title: 'Done', summary: 'Round outcome.'})};

async function run(turns: ModelTurn[], appendOnly = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-unexecuted-'));
  const store = new RuntimeStore();
  const requests: ModelRequest[] = [];
  const provider: Provider = {...appendOnly ? {capabilities: {toolDiscovery: 'none', runtimeInstructions: 'meta-user', caching: 'anthropic', appendOnlyHistory: true}} : {},
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
const calls = (request: ModelRequest) => request.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls?.map(item => item.id) ?? [] : []);
const turns = () => [
  reply('', [{id: 'bad', name: 'NoSuchTool', arguments: '{}'}]),
  reply('', [{id: 'good', name: 'Glob', arguments: JSON.stringify({pattern: '*'})}]),
  reply('Done.', [finish]),
];

test('a request after recovery no longer carries the failed call while the ledger keeps it', async () => {
  const f = await run(turns());
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.ok(calls(f.requests[1]!).includes('bad'), 'while no later turn ran, the failure stays in view');
    assert.ok(!calls(f.requests[2]!).includes('bad'), 'once a later call ran, the failed turn is gone');
    assert.ok(!f.requests[2]!.messages.some(message => message.role === 'tool' && message.callId === 'bad'));
    assert.ok(calls(f.requests[2]!).includes('good'));
    const ledger = await f.journal.loadRaw('s', 'logox');
    const stored = ledger.flatMap(entry => entry.message?.role === 'tool' && entry.message.callId === 'bad' ? [entry.message] : [])[0];
    assert.ok(stored, 'the ledger keeps the failed call');
    assert.equal(stored.unexecuted, true);
  } finally { await f.cleanup(); }
});

test('an append-only provider still receives the failed call', async () => {
  const f = await run(turns(), true);
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.ok(calls(f.requests[2]!).includes('bad'));
  } finally { await f.cleanup(); }
});
