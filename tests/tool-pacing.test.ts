import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {AUTOMA_STREAK, ToolPacing} from '../src/kernel/tool-pacing.js';
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

const polls = 9;
const untouched = (request: ModelRequest) => !request.messages.some(message => message.role === 'context' && message.kind === 'recovery');

test('a Director that keeps re-reading while a companion runs is left alone: tools run, no note is injected', async () => {
  const f = await director((_request, index) => index <= polls ? glob('poll-' + index) : reply('Waiting on Techne.', [finish]));
  try {
    assert.equal(f.activity?.status, 'completed', f.activity?.detail);
    assert.equal(f.requests.length, polls + 1, 'every look is answered, then the round closes');
    for (const request of f.requests) {
      assert.deepEqual(request.tools, f.requests[0]!.tools);
      assert.ok(untouched(request), 'no runtime note');
      assert.ok(!toolTexts(request).some(text => /withdrawn|not executed|\[Runtime\]/i.test(text)), 'every result is the real one');
    }
    assert.equal(toolTexts(f.requests.at(-1)!).length, polls);
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

test('a long read-only streak reminds about Automa once, only when it is offered and not while waiting', () => {
  const read = (index: number) => ({id: String(index), name: 'Read', arguments: JSON.stringify({file_path: index + '.ts'})});
  const ok = {text: 'x', isError: false};
  const working = {directorWaiting: false, automaOffered: true};
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
  for (let index = 0; index < AUTOMA_STREAK * 2; index++) assert.equal(absent.observe(read(index), ok, {directorWaiting: false, automaOffered: false}), undefined);
});

test('a waiting Director is never reminded about Automa, and errors do not count', () => {
  const read = (index: number) => ({id: String(index), name: 'Read', arguments: JSON.stringify({file_path: index + '.ts'})});
  const waiting = new ToolPacing();
  for (let index = 0; index < AUTOMA_STREAK * 2; index++) assert.equal(waiting.observe(read(index), {text: 'x', isError: false}, {directorWaiting: true, automaOffered: true}), undefined);
  const failing = new ToolPacing();
  for (let index = 0; index < AUTOMA_STREAK * 2; index++) assert.equal(failing.observe(read(index), {text: 'x', isError: true}, {directorWaiting: false, automaOffered: true}), undefined);
});
