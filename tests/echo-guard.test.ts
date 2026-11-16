import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {createApplication as productionApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelMessage, ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {createRuntimeContextMessage, runtimeContextText} from '../src/runtime/context-updates.js';
import {FIXED_MARKER_TEXTS, requestMarkerTexts, stripMarkers} from '../src/kernel/echo-guard.js';
import {refineTurn} from '../src/kernel/turn-refine.js';
import {runWorker, type WorkerRun} from '../src/kernel/worker-run.js';
import {supersededReadText} from '../src/prompts/compaction.js';
import {ECHO_REMINDER, ECHO_STOP_ERROR} from '../src/prompts/runtime/recovery.js';
import {persistedIndex} from '../src/kernel/scratchpad.js';

const reminderText = runtimeContextText(createRuntimeContextMessage('reminder', 'Do not repeat the same read; try another path.'));
const tombstone = supersededReadText('lines 1-40');
const persisted = persistedIndex('line\n'.repeat(40), '/tmp/out.txt', {tool: 'Shell', arguments: '{"command":"ls"}'});

test('every kind of runtime marker is recognised verbatim and with whitespace differences', () => {
  const samples = [reminderText, reminderText.replace(/\n/g, ' \n  '), tombstone, tombstone.replace(/ /g, '  '), persisted,
    '<automa-result id="T1" title="x" status="done" took="1s" model="m">\nSummary: ok\n</automa-result>',
    '[Image omitted: mock/model cannot see images.] Ask the user to choose a model that can see images for this actor.', '[image: /tmp/a.png]',
    '[Unpaired tool record, for reference only; does not mean it was re-executed]\nRead\nfile text',
    '[Runtime record of this activity: recorded by the runtime, not written by Techne]\nChanged: a.ts\nCommands: none',
    '[Interrupted by user]\nThe user stopped your previous run before it finished.',
    'Dispatched to techne (Batch b1):\n- a1 techne: Build',
    'Brief check: clear.',
    ...FIXED_MARKER_TEXTS.map(item => item.text), ...FIXED_MARKER_TEXTS.map(item => item.text.replace(/ /g, '\n'))];
  for (const sample of samples) {
    const result = stripMarkers(sample);
    assert.ok(result.pure, 'not recognised as a pure marker: ' + sample.slice(0, 80));
    assert.equal(result.text, '');
  }
});

test('markers plus real prose: the prose stays, the markers go; plain mentions are untouched', () => {
  const mixed = stripMarkers('Here is the answer to your question.\n\n' + tombstone + '\n\nIt is 42.');
  assert.equal(mixed.pure, false);
  assert.equal(mixed.text, 'Here is the answer to your question.\n\nIt is 42.');
  const prose = 'The old read was Superseded by a newer one, and the persisted-output idea is separate from Application context handling.';
  assert.deepEqual(stripMarkers(prose), {text: prose, matched: 0, pure: false});
  assert.equal(stripMarkers('[Superseded] is a word in my notes, [image: x] too').text.includes('[Superseded]'), true);
});

test('a short filler beside markers is still an echo; a longer one is a reply', () => {
  assert.equal(stripMarkers('Okay. ' + tombstone).pure, true);
  assert.equal(stripMarkers('I looked at everything and here are my findings. ' + tombstone).pure, false);
});

test('the text of host context messages in the request counts as a marker, even without its header', () => {
  const messages: ModelMessage[] = [createRuntimeContextMessage('reminder', 'Stop using Grep for this; the answer is in the Read output above.')];
  const known = requestMarkerTexts(messages);
  assert.equal(stripMarkers('Stop using Grep for this;\nthe answer is in the Read output above.', known).pure, true);
  assert.equal(stripMarkers('Stop using Grep for this; the answer is in the Read output above.').matched, 0);
});

test('refineTurn marks a pure echo, strips mixed text and leaves ordinary replies and tool turns alone', () => {
  const base = (text: string, calls?: ModelTurn['message']['toolCalls']): ModelTurn => ({message: {role: 'assistant', text, ...(calls ? {toolCalls: calls} : {})}, stop: calls ? 'tools' : 'complete'});
  const request = {tools: [], messages: []};
  const echo = refineTurn(base(reminderText), request);
  assert.equal(echo.echo, true);
  assert.equal(echo.message.text, '');
  const mixed = refineTurn(base('Result: the build passes and all tests are green.\n' + tombstone), request);
  assert.equal(mixed.echo, undefined);
  assert.equal(mixed.message.text, 'Result: the build passes and all tests are green.');
  const normal = base('Superseded plans are listed below.');
  assert.equal(refineTurn(normal, request), normal);
  const withCall = refineTurn(base(reminderText, [{id: 'a', name: 'Read', arguments: '{}'}]), request);
  assert.equal(withCall.echo, undefined, 'a turn with tool calls is never an echo');
  assert.equal(withCall.message.text, '');
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
  const cwd = await mkdtemp(join(tmpdir(), 'logox-echo-guard-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}, kernel: {max_iterations: 50}}, {}, cwd, cwd);
  const probe = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'test', config, provider});
  await probe.close();
  const app = await productionApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'test', config, provider});
  return {cwd, app, async cleanup() {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
const closing = () => call('_FinishRound', {title: 'Answered', summary: 'Answered.'}, 'fin');
const reminders = (req: ModelRequest) => req.messages.filter(message => message.role === 'context' && message.kind === 'reminder').map(message => message.text);
const shownText = (f: Awaited<ReturnType<typeof rawFixture>>, activityId: string) =>
  f.app.store.getSnapshot().messages.filter(message => message.activityId === activityId && message.role !== 'user').map(message => message.text).join('\n');

test('a pure echo is not delivered: a reminder follows and the loop continues to the real reply', async () => {
  const seen: ModelRequest[] = [];
  const watch = (turn: ModelTurn) => (req: ModelRequest) => {seen.push(req); return turn;};
  const f = await rawFixture(scripted([watch(assistant(tombstone)), watch(assistant('The real answer.')), watch(closing())]));
  try {
    const handle = f.app.ensemble.dispatch('techne', 'answer');
    await handle.done;
    const activity = f.app.store.activities.get('test', handle.activityId)!;
    assert.equal(activity.status, 'completed');
    assert.equal(activity.summary?.report, 'The real answer.');
    assert.deepEqual(reminders(seen[1]!), [ECHO_REMINDER]);
    assert.ok(!shownText(f, handle.activityId).includes('Superseded'), 'the echo never reaches the timeline');
  } finally {await f.cleanup();}
});

test('an echo with real prose delivers the prose with the markers stripped', async () => {
  const f = await rawFixture(scripted([assistant('The answer is 42, as the logs show.\n\n' + tombstone), closing()]));
  try {
    const handle = f.app.ensemble.dispatch('techne', 'answer');
    await handle.done;
    const activity = f.app.store.activities.get('test', handle.activityId)!;
    assert.equal(activity.status, 'completed');
    assert.equal(activity.summary?.report, 'The answer is 42, as the logs show.');
    assert.ok(!shownText(f, handle.activityId).includes('Superseded by'));
  } finally {await f.cleanup();}
});

test('a normal reply that mentions the word Superseded is delivered untouched', async () => {
  const f = await rawFixture(scripted([assistant('The earlier plan was Superseded by the new one.'), closing()]));
  try {
    const handle = f.app.ensemble.dispatch('techne', 'answer');
    await handle.done;
    assert.equal(f.app.store.activities.get('test', handle.activityId)!.summary?.report, 'The earlier plan was Superseded by the new one.');
  } finally {await f.cleanup();}
});

test('three echoes in a row stop the step with a clear error', async () => {
  const f = await rawFixture(scripted([assistant(tombstone), assistant(persisted), assistant(reminderText)]));
  try {
    const handle = f.app.ensemble.dispatch('techne', 'answer');
    await handle.done;
    assert.equal(f.app.store.activities.get('test', handle.activityId)?.status, 'failed');
    const snapshot = f.app.store.getSnapshot();
    assert.ok(JSON.stringify(snapshot).includes(ECHO_STOP_ERROR), 'the error is visible');
  } finally {await f.cleanup();}
});

test('an Automa worker treats an echo as a silent turn, and three in a row stall it with the error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-worker-echo-'));
  const seen: ModelRequest[] = [];
  const turns: ModelTurn[] = [assistant(tombstone), assistant(persisted), assistant(reminderText)];
  const run: WorkerRun<string> = {
    provider: {async respond(req) {seen.push(req); return turns.shift()!;}}, model: 'mock/worker', system: 'sys', tools: [{name: 'Finish', description: 'f', parameters: {type: 'object'}}],
    messages: [{role: 'user', text: 'go'}], signal: new AbortController().signal, cwd, sessionId: 's', workerId: 'w2', cacheKey: 'k', retries: 0,
    terminal: {name: 'Finish', reminder: 'call Finish', alone: 'alone', accepted: 'accepted', settle: () => ({ok: false, text: 'no'})},
    async executeCall() {return {text: '', isError: false};},
  };
  try {
    const end = await runWorker(run);
    assert.equal(end.kind, 'stalled');
    assert.equal(end.kind === 'stalled' && end.lastText, ECHO_STOP_ERROR);
    assert.deepEqual(reminders(seen[1]!), [ECHO_REMINDER]);
  } finally {await rm(cwd, {recursive: true, force: true});}
});
