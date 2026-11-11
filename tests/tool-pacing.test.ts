import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {AUTOMA_STREAK, REPEAT_LIMIT, ToolPacing} from '../src/kernel/tool-pacing.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';

const glob = (id: string, pattern = '*'): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: [{id, name: 'Glob', arguments: JSON.stringify({pattern})}]}, stop: 'tools'});
const reply = (text: string, calls: NonNullable<ModelTurn['message']['toolCalls']> = []): ModelTurn => ({message: {role: 'assistant', text, ...(calls.length ? {toolCalls: calls} : {})}, stop: calls.length ? 'tools' : 'complete'});
const finish = {id: 'finish', name: '_FinishRound', arguments: JSON.stringify({title: 'Waiting', summary: 'Round outcome.'})};

async function director(respond: (request: ModelRequest, index: number) => ModelTurn, opts: {companion?: boolean; refuseTools?: string} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-pacing-'));
  const store = new RuntimeStore();
  if (opts.companion !== false) store.activities.create({sessionId: 's', activityId: 'peer', ownerId: 'techne', kind: 'actor', title: 'Rig', status: 'running', stage: 'x', detail: ''});
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request, delta, signal) {
    signal.throwIfAborted();
    requests.push(request);
    const value = respond(request, requests.length);
    if (value.message.text) delta({kind: 'text', text: value.message.text});
    return value;
  }};
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions, ...(opts.refuseTools ? {refuseTools: opts.refuseTools} : {})})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(cwd, 'sessions')), execute, {handoff: async () => {}});
  const task = ensemble.dispatch('logox', 'Go', 'direct');
  await task.done;
  const activity = store.activities.get('s', task.activityId);
  return {requests, activity, cleanup: async () => { await ensemble.close(); await rm(cwd, {recursive: true, force: true}); }};
}
const toolNames = (request: ModelRequest) => request.tools.map(tool => tool.name);
const toolTexts = (request: ModelRequest) => request.messages.filter(message => message.role === 'tool').map(message => message.text);

const withdrawnNote = (request: ModelRequest) => request.messages.some(message => message.role === 'context' && message.text.includes('tools are withdrawn'));

test('a Director re-checking while a companion runs keeps its tool list but cannot use it, and closes the round', async () => {
  const f = await director((request, index) => !withdrawnNote(request) ? glob('poll-' + index) : index === REPEAT_LIMIT + 2 ? glob('late') : reply('Waiting on Techne.', [finish]));
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.equal(f.requests.length, REPEAT_LIMIT + 3, 'one first look, the repeats, one refused call, then the closing request');
    for (const request of f.requests) assert.deepEqual(request.tools, f.requests[0]!.tools, 'withdrawal never changes the cache prefix');
    assert.ok(toolNames(f.requests[0]!).includes('Glob'));
    assert.ok(toolTexts(f.requests.at(-1)!).some(text => text.includes('withdrawn until a teammate finishes or a message arrives')));
    assert.ok(!toolTexts(f.requests.at(-1)!).some(text => text.includes('[Runtime]')), 'a repeated look carries no runtime note');
    assert.ok(f.requests.at(-1)!.messages.some(message => message.role === 'context' && message.text.includes('tools are withdrawn')));
  } finally { await f.cleanup(); }
});

test('a Director that keeps calling withdrawn tools is ended by the runtime after two refused batches', async () => {
  const f = await director((_request, index) => glob('poll-' + index));
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.equal(f.requests.length, REPEAT_LIMIT + 3, 'one first look, the repeats, then exactly two refused batches');
    for (const request of f.requests) assert.deepEqual(request.tools, f.requests[0]!.tools);
  } finally { await f.cleanup(); }
});

test('a restricted request keeps its tool list, refuses the call, and a second refused batch fails the round', async () => {
  const obeys = await director((_request, index) => index === 1 ? glob('once') : reply('Recovery is exhausted.', [finish]), {companion: false, refuseTools: 'Not executed: restricted.'});
  try {
    assert.equal(obeys.activity?.status, 'completed', obeys.activity?.detail);
    assert.deepEqual(toolTexts(obeys.requests[1]!), ['Not executed: restricted.']);
    assert.deepEqual(obeys.requests[1]!.tools, obeys.requests[0]!.tools);
  } finally { await obeys.cleanup(); }
  const ignores = await director((_request, index) => glob('again-' + index), {companion: false, refuseTools: 'Not executed: restricted.'});
  try {
    assert.equal(ignores.activity?.status, 'failed', ignores.activity?.detail);
    assert.equal(ignores.requests.length, 2);
  } finally { await ignores.cleanup(); }
});

test('a Director that says nothing while a companion runs ends its round instead of being retried', async () => {
  const f = await director(() => reply(''));
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.equal(f.requests.length, 1);
  } finally { await f.cleanup(); }
});

test('with no companion running, repeated calls and an empty reply keep their old behavior', async () => {
  const f = await director((_request, index) => index <= 6 ? glob('same-' + index) : reply('Done.', [finish]), {companion: false});
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.equal(f.requests.length, 7);
    assert.ok(toolNames(f.requests.at(-1)!).includes('Glob'), 'tools are never withdrawn');
    assert.ok(!toolTexts(f.requests.at(-1)!).some(text => text.includes('Same result')));
  } finally { await f.cleanup(); }
});

test('pacing counts only identical observations, and new input clears the count', () => {
  const pacing = new ToolPacing();
  const waiting = {waiting: 'director' as const, automaOffered: true};
  const call = (pattern: string) => ({id: pattern, name: 'Glob', arguments: JSON.stringify({pattern})});
  const ok = (text: string) => ({text, isError: false});
  assert.equal(pacing.observe(call('*'), ok('a'), waiting), undefined);
  assert.equal(pacing.observe(call('*'), ok('a,b'), waiting), undefined, 'a changed result is news');
  assert.equal(pacing.observe(call('*.js'), ok('a'), waiting), undefined, 'other arguments are a new look');
  assert.equal(pacing.observe(call('*'), {text: 'a', isError: true}, waiting), undefined, 'errors do not count');
  assert.equal(pacing.observe({id: 'x', name: 'Actor', arguments: '{}'}, ok('a'), waiting), undefined);
  pacing.observe(call('*'), ok('a'), waiting);
  pacing.observe(call('*'), ok('a'), waiting);
  assert.equal(pacing.withdrawn, false);
  pacing.observe(call('*'), ok('a'), waiting);
  assert.equal(pacing.withdrawn, true);
  pacing.reset();
  assert.equal(pacing.withdrawn, false);
  assert.equal(pacing.observe(call('*'), ok('a'), waiting), undefined, 'the same look after new input is not a repeat');
});

test('a long read-only streak reminds about Automa once, only when it is offered and not while waiting', () => {
  const read = (index: number) => ({id: String(index), name: 'Read', arguments: JSON.stringify({file_path: index + '.ts'})});
  const ok = {text: 'x', isError: false};
  const working = {waiting: undefined, automaOffered: true};
  const pacing = new ToolPacing();
  const notes = Array.from({length: AUTOMA_STREAK * 3}, (_, index) => pacing.observe(read(index), ok, working)).map(note => note ? 1 : 0);
  assert.equal(notes.indexOf(1), AUTOMA_STREAK - 1);
  assert.equal(notes.filter(Boolean).length, 1);
  const broken = new ToolPacing();
  for (let index = 0; index < AUTOMA_STREAK * 2; index++) {
    assert.equal(broken.observe(read(index), ok, working), undefined);
    if (index % (AUTOMA_STREAK - 2) === 0) broken.observe({id: 'e', name: 'Edit', arguments: '{}'}, ok, working);
  }
  const absent = new ToolPacing();
  for (let index = 0; index < AUTOMA_STREAK * 2; index++) assert.equal(absent.observe(read(index), ok, {waiting: undefined, automaOffered: false}), undefined);
});
