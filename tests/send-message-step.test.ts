import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, appendFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {settleStep, type Message, type Step} from '../src/runtime/contracts.js';
import {stepElapsed} from '../src/runtime/steps.js';
import {asksFor} from '../src/runtime/asks.js';
import type {ModelRequest, ModelTurn, Provider, ToolCall} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import {sendMessageTool} from '../src/tools/coordination/SendMessageTool/SendMessageTool.js';
import {pairSendMessages} from '../src/tools/coordination/SendMessageTool/pairing.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {loadConfig} from '../src/config/config.js';

const call = (id: string, name: string, args: unknown): ToolCall => ({id, name, arguments: JSON.stringify(args)});
const tools = (...calls: ToolCall[]): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: calls}, stop: 'tools'});
const closing = (text: string): ModelTurn => ({message: {role: 'assistant', text, toolCalls: [call('finish', '_FinishRound', {title: 'Done', outcome: 'Round outcome.', verification: null, carry_forward: []})]}, stop: 'tools'});

async function fixture(respond: (request: ModelRequest, index: number) => ModelTurn, ownerId: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-send-step-'));
  const store = new RuntimeStore(), requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request, delta, signal) {
    signal.throwIfAborted(); requests.push(request);
    const turn = respond(request, requests.length);
    if (turn.message.text) delta({kind: 'text', text: turn.message.text});
    return turn;
  }};
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    extraTools: [sendMessageTool], extraApprovalHandled: ['SendMessage'], executeExtra: async () => ({text: 'Delivered message.', isError: false}),
    requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId, builtinPrompt: 'Test'}), tools: [...toolDefinitions, sendMessageTool]})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(cwd, 'sessions')), execute, {handoff: async () => {}, concurrency: 'actor'});
  const peer = (id: string) => store.activities.create({sessionId: 's', activityId: id, ownerId: id, kind: 'actor', title: id, status: 'running', stage: 'x', detail: ''});
  const sends = () => store.getSnapshot().messages.filter(message => message.step?.call?.name === 'SendMessage');
  return {store, requests, ensemble, peer, sends, board: asksFor(store), cleanup: async () => { await ensemble.close(); await rm(cwd, {recursive: true, force: true}); }};
}

test('an ask finishes the moment it is delivered, even while its sender stays parked on the reply', async () => {
  const f = await fixture((_request, index) => [
    tools(call('a', 'SendMessage', {to: 'kalon', type: 'ask', message: 'Ready?', wake: true})),
    closing('Nothing else to do.'),
  ][index - 1]!, 'techne');
  try {
    f.peer('kalon');
    const task = f.ensemble.dispatch('techne', 'Build', 'direct');
    while (f.requests.length < 2) await delay(10);
    await delay(100);
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'running', 'parked on the open ask');
    const [step] = f.sends().map(message => message.step!);
    assert.equal(step?.state, 'completed');
    assert.equal(step?.runningSince, undefined);
    assert.equal(stepElapsed(step!, Date.now() + 3_600_000), step!.elapsedMs, 'no live clock');
    f.board.answer('s', 'kalon', 'techne');
    await task.done;
  } finally { await f.cleanup(); }
});

test('a Director ask records a finished step, so a restored session never shows it running', async () => {
  const f = await fixture((_request, index) => index === 1 ? tools(call('a', 'SendMessage', {to: 'techne', type: 'ask', message: 'Verify', wake: true})) : closing('Waiting.'), 'logox');
  try {
    f.peer('techne');
    const task = f.ensemble.dispatch('logox', 'Plan', 'direct');
    await task.done;
    assert.deepEqual(f.sends().map(message => message.step!.state), ['completed']);
  } finally { await f.cleanup(); }
});

test('a finished activity settles its open steps so no clock outlives it', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: 't', status: 'running', stage: 'x', detail: ''});
  const open = store.message('s', 'techne', 'notice', 'SendMessage', {activityId: 'a', kind: 'tool', step: {title: 'SendMessage', state: 'running', elapsedMs: 5, runningSince: Date.now() - 1000}});
  const other = store.message('s', 'kalon', 'notice', 'Read', {activityId: 'b', kind: 'tool', step: {title: 'Read', state: 'running', elapsedMs: 0, runningSince: 1}});
  store.activities.update('s', 'a', {status: 'completed'});
  const step = store.getSnapshot().messages.find(message => message.id === open)!.step!;
  assert.equal(step.state, 'completed'); assert.equal(step.runningSince, undefined); assert.ok(step.elapsedMs >= 1000);
  assert.equal(store.getSnapshot().messages.find(message => message.id === other)!.step!.state, 'running', 'other activities are untouched');
  assert.equal(settleStep(step, 'cancelled'), step, 'terminal steps are left alone');
});

test('an unanswered ask reads "no reply" once its sender is done and the recipient has nothing running', () => {
  const step = (id: string): Step => ({title: 'SendMessage', callId: id, call: call(id, 'SendMessage', {to: 'techne', type: 'ask', message: 'Verify'}), state: 'completed', elapsedMs: 1});
  const ask: Message = {id: 'm1', sessionId: 's', ownerId: 'logox', role: 'notice', kind: 'tool', text: '', activityId: 'D', step: step('c1')};
  const activity = (activityId: string, ownerId: string, status: 'running' | 'completed') => ({sessionId: 's', activityId, ownerId, status});
  assert.equal(pairSendMessages([ask]).get('m1')?.ended, undefined, 'no activity facts, nothing claimed');
  assert.equal(pairSendMessages([ask], [activity('D', 'logox', 'completed'), activity('T', 'techne', 'running')]).get('m1')?.ended, undefined, 'recipient still working');
  assert.equal(pairSendMessages([ask], [activity('D', 'logox', 'running')]).get('m1')?.ended, undefined, 'asker still working');
  assert.equal(pairSendMessages([ask], [activity('D', 'logox', 'completed'), activity('T', 'techne', 'completed')]).get('m1')?.ended, true);
  const reply: Message = {id: 'm2', sessionId: 's', ownerId: 'techne', role: 'notice', kind: 'tool', text: '', activityId: 'T',
    step: {...step('c2'), call: call('c2', 'SendMessage', {to: 'logox', type: 'reply', message: 'Passed'})}};
  const answered = pairSendMessages([ask, reply], [activity('D', 'logox', 'completed'), activity('T', 'techne', 'completed')]).get('m1');
  assert.equal(answered?.answered, true); assert.equal(answered?.ended, undefined);
});

test('resume closes a step the ledger left running (an old ask, an unfinished thinking step) instead of reviving its clock', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-send-step-resume-')));
  await mkdir(join(cwd, '.logox'), {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'local', model: 'first'}, providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}},
    models: {'local/first': {context_window: 131072, thinking_protocol: 'deepseek'}}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 'first', config, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd},
    provider: {async respond() { return {message: {role: 'assistant', text: 'ok'}, stop: 'complete', usage: {input: 1, output: 1}}; }}});
  try {
    await app.submit('hello');
    while (app.ensemble.isBusy()) await delay(10);
    const root = join(cwd, '.logox', 'state', 'sessions');
    const base = {version: 1, sessionId: 'first', ownerId: 'logox', activityId: 'old-activity', source: 'logox'};
    const askCall = call('call_old', 'SendMessage', {to: 'techne', type: 'ask', message: 'Verify', wake: true});
    const startedAt = Date.now() - 318 * 60_000;
    const line = (entry: object) => JSON.stringify({...base, ...entry}) + '\n';
    await appendFile(new Journal(root).path('first', 'logox'),
      line({role: 'user', text: 'Deliver', time: startedAt, message: {role: 'user', text: 'Deliver'}, inputKind: 'human'}) +
      line({role: 'assistant', text: '', time: startedAt + 1, message: {role: 'assistant', text: '', toolCalls: [askCall]},
        step: {title: 'Thinking', groupId: 'g', state: 'running', elapsedMs: 0, runningSince: startedAt}}) +
      line({role: 'tool', text: 'Delivered message to techne.', time: startedAt + 2, message: {role: 'tool', callId: 'call_old', name: 'SendMessage', text: 'Delivered message to techne.', isError: false},
        step: {title: 'SendMessage', callId: 'call_old', call: askCall, state: 'running', elapsedMs: 0, runningSince: startedAt + 2}}));
    await app.submit('/new'); await app.submit('/resume first');
    const steps = app.store.getSnapshot().messages.filter(message => message.activityId === 'old-activity' && message.step).map(message => message.step!);
    assert.ok(steps.some(step => step.title === 'SendMessage'), 'the old tool row is restored');
    for (const step of steps) {
      assert.notEqual(step.state, 'running'); assert.equal(step.runningSince, undefined);
      assert.equal(stepElapsed(step, Date.now()), step.elapsedMs, 'no live clock');
    }
    assert.equal(steps.find(step => step.title === 'SendMessage')!.state, 'completed');
    assert.equal(steps.find(step => step.title === 'Thinking')!.state, 'cancelled');
  } finally { await app.close(); await rm(cwd, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); }
});
