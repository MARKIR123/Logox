import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {PeerWait} from '../src/kernel/peer-wait.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {Collaboration} from '../src/actors/collaboration.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {AskBoard, asksFor} from '../src/runtime/asks.js';
import type {ModelRequest, ModelTurn, Provider, ToolCall} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import {sendMessageTool} from '../src/tools/coordination/SendMessageTool/SendMessageTool.js';
import type {ActorContext} from '../src/actors/ensemble.js';

const call = (id: string, name: string, args: unknown): ToolCall => ({id, name, arguments: JSON.stringify(args)});
const tools = (...calls: ToolCall[]): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: calls}, stop: 'tools'});
const closing = (text: string, id = 'finish-' + Math.random()): ModelTurn => ({message: {role: 'assistant', text, toolCalls: [call(id, '_FinishRound', {title: 'Done', summary: 'Round outcome.'})]}, stop: 'tools'});
const send = (id: string, to: string, type: string, message = 'text') => call(id, 'SendMessage', {to, type, message});

async function fixture(respond: (request: ModelRequest, index: number) => ModelTurn, ownerId = 'techne') {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-ask-'));
  const store = new RuntimeStore();
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request, delta, signal) {
    signal.throwIfAborted();
    requests.push(request);
    const turn = respond(request, requests.length);
    if (turn.message.text) delta({kind: 'text', text: turn.message.text});
    return turn;
  }};
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    extraTools: [sendMessageTool], extraApprovalHandled: ['SendMessage'], executeExtra: async () => ({text: 'Delivered.', isError: false}),
    requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId, builtinPrompt: 'Test'}), tools: [...toolDefinitions, sendMessageTool]})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(cwd, 'sessions')), execute, {handoff: async () => {}, concurrency: 'actor'});
  const peer = (id: string, activityId = id) => store.activities.create({sessionId: 's', activityId, ownerId: id, kind: 'actor', title: id, status: 'running', stage: 'x', detail: ''});
  const status = (activityId: string) => store.activities.get('s', activityId)?.status;
  return {cwd, store, requests, ensemble, peer, status, board: asksFor(store), cleanup: async () => { await ensemble.close(); await rm(cwd, {recursive: true, force: true}); }};
}
const said = (request: ModelRequest, pattern: RegExp) => request.messages.some(message => (message.role === 'context' || message.role === 'tool') && pattern.test(message.text));

test('an ask does not stop work; closing parks with no requests; only a reply lets the task finish', async () => {
  const f = await fixture((_request, index) => [
    tools(send('a', 'kalon', 'ask', 'Tell me when the art is ready')),
    tools(call('g', 'Glob', {pattern: '*'})),
    closing('Everything else is done.'),
    closing('Rig finished with the art.'),
  ][index - 1]!);
  try {
    f.peer('kalon');
    const task = f.ensemble.dispatch('techne', 'Build the rig', 'direct');
    while (f.requests.length < 3) await delay(10);
    assert.ok(!said(f.requests[1]!, /Your question is open/), 'the sent ask result carries no runtime note');
    assert.ok(f.requests[1]!.tools.some(tool => tool.name === 'Glob'), 'asking takes no tools away');
    await delay(1200);
    assert.equal(f.requests.length, 3, 'no model requests while parked');
    assert.equal(f.status(task.activityId), 'running', 'the task cannot finish without the answer');
    assert.equal(f.board.owed('s', 'kalon').length, 1);
    f.board.answer('s', 'kalon', 'techne');
    await task.done;
    assert.equal(f.status(task.activityId), 'completed');
    assert.equal(f.requests.length, 4);
  } finally { await f.cleanup(); }
});

test('an inform needs no answer and never holds the task open', async () => {
  const f = await fixture((_request, index) => index === 1 ? tools(send('i', 'kalon', 'inform')) : closing('Done.'));
  try {
    f.peer('kalon');
    const task = f.ensemble.dispatch('techne', 'Tell Kalon', 'direct');
    await task.done;
    assert.equal(f.status(task.activityId), 'completed');
    assert.equal(f.requests.length, 2);
  } finally { await f.cleanup(); }
});

for (const [how, end] of [['finishes', 'completed'], ['fails', 'failed'], ['is cancelled', 'cancelled']] as const) {
  test(`the asker is told to stop waiting when the recipient ${how} without replying`, async () => {
    const f = await fixture((_request, index) => index === 1 ? tools(send('a', 'kalon', 'ask')) : closing(index === 2 ? 'Waiting.' : 'Continued without it.'));
    try {
      f.peer('kalon');
      const task = f.ensemble.dispatch('techne', 'Build', 'direct');
      while (f.requests.length < 2) await delay(10);
      await delay(30);
      f.store.activities.update('s', 'kalon', {status: end});
      await task.done;
      assert.equal(f.status(task.activityId), 'completed');
      assert.ok(said(f.requests.at(-1)!, /kalon ended its work without replying.*stop waiting/));
    } finally { await f.cleanup(); }
  });
}

test('a recipient is reminded twice at closing, can answer, and may finish anyway after that', async () => {
  const answering = await fixture((_request, index) => index === 1 ? closing('Done.') : index === 2 ? tools(send('r', 'techne', 'reply')) : closing('Now done.'), 'kalon');
  try {
    answering.board.open({sessionId: 's', from: 'techne', fromActivityId: 'asker', to: 'kalon', label: 'Where is the art?'});
    const task = answering.ensemble.dispatch('kalon', 'Draw', 'direct');
    await task.done;
    assert.equal(answering.requests.length, 3);
    assert.ok(said(answering.requests[1]!, /Do not finish yet.*techne.*Where is the art/));
    assert.equal(answering.board.owed('s', 'kalon').length, 0, 'the reply closed it');
    assert.equal(answering.board.awaited('asker').length, 0);
  } finally { await answering.cleanup(); }

  const ignoring = await fixture(() => closing('Done.'), 'kalon');
  try {
    ignoring.board.open({sessionId: 's', from: 'techne', fromActivityId: 'asker', to: 'kalon', label: 'Where is the art?'});
    const task = ignoring.ensemble.dispatch('kalon', 'Draw', 'direct');
    await task.done;
    assert.equal(ignoring.requests.length, 3, 'two reminders, then it may finish');
    assert.equal(ignoring.status(task.activityId), 'completed');
    assert.equal(ignoring.board.awaited('asker')[0]?.ended, true, 'its run ended, which releases the asker');
  } finally { await ignoring.cleanup(); }
});

test('a working recipient is reminded once, and an inform does not close the question', async () => {
  const f = await fixture((_request, index) => {
    if (index === 1) return tools(send('s', 'techne', 'inform', 'Still drawing; I need the rig size'));
    if (index <= 7) return tools(call('g' + index, 'Glob', {pattern: index + '*'}));
    if (index === 8) return tools(send('r', 'techne', 'reply', 'Ready'));
    return closing('Done.');
  }, 'kalon');
  try {
    f.board.open({sessionId: 's', from: 'techne', fromActivityId: 'asker', to: 'kalon', label: 'Art ready?'});
    const task = f.ensemble.dispatch('kalon', 'Draw', 'direct');
    await task.done;
    const reminders = f.requests.at(-1)!.messages.filter(message => message.role === 'context' && /You still owe techne/.test(message.text));
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!.role === 'context' ? reminders[0]!.text : '', /If you cannot answer yet, carry on/);
    assert.ok(!said(f.requests.at(-1)!, /Do not finish yet/), 'it replied, so closing was not stopped');
  } finally { await f.cleanup(); }
});

test('two actors asking each other: owing a reply comes first, and a real cycle releases exactly one', async () => {
  const store = new RuntimeStore();
  const board = asksFor(store);
  const controller = new AbortController();
  const peer = (ownerId: string, activityId: string) => store.activities.create({sessionId: 's', activityId, ownerId, kind: 'actor', title: ownerId, status: 'running', stage: 'x', detail: ''});
  peer('techne', 'a'); peer('kalon', 'b');
  const env = (ownerId: string, activityId: string) => ({store, sessionId: 's', activityId, ownerId, signal: controller.signal, pollMs: 5});
  board.open({sessionId: 's', from: 'techne', fromActivityId: 'a', to: 'kalon', label: 'q1'});
  board.open({sessionId: 's', from: 'kalon', fromActivityId: 'b', to: 'techne', label: 'q2'});
  const techne = new PeerWait(env('techne', 'a')), kalon = new PeerWait(env('kalon', 'b'));
  let techneDone = false;
  const first = techne.park().then(() => { techneDone = true; });
  await delay(30);
  assert.equal(techneDone, false, 'one parked actor is not a deadlock while the other can still act');
  const second = kalon.park();
  await first;
  assert.match(techne.take()[0]!.text, /waiting on each other.*Answer what you have been asked/);
  assert.equal(board.awaited('a').length, 0, 'the lowest id is released');
  assert.equal(board.awaited('b').length, 1, 'the other keeps waiting for the released one to answer');
  board.answer('s', 'techne', 'kalon');
  await second;
  assert.equal(board.awaited('b').length, 0);
});

test('deadlock detection follows chains and treats the Director and running actors as free', () => {
  const board = new AskBoard();
  const ask = (from: string, activity: string, to: string) => board.open({sessionId: 's', from, fromActivityId: activity, to, label: 'x'});
  ask('a', 'A', 'b'); ask('b', 'B', 'c'); ask('c', 'C', 'a');
  board.park('s', 'a', 'A'); board.park('s', 'b', 'B');
  assert.equal(board.deadlock('s', 'A'), undefined, 'c is still running');
  board.park('s', 'c', 'C');
  assert.deepEqual([...board.deadlock('s', 'A')!].sort(), ['A', 'B', 'C']);
  const director = new AskBoard();
  director.open({sessionId: 's', from: 'a', fromActivityId: 'A', to: 'logox', label: 'x'});
  director.park('s', 'a', 'A');
  assert.equal(director.deadlock('s', 'A'), undefined);
});

test('a question that reached the recipient lapses with its run; a later one waits for the next run', () => {
  const board = new AskBoard();
  const early = board.open({sessionId: 's', from: 'a', fromActivityId: 'A', to: 'b', label: 'x'});
  board.endRecipient('s', 'b', early.openedAt);
  assert.equal(board.awaited('A')[0]?.ended, true);
  assert.equal(board.owed('s', 'b').length, 0);
  const late = board.open({sessionId: 's', from: 'c', fromActivityId: 'C', to: 'b', label: 'x'});
  board.endRecipient('s', 'b', late.openedAt - 1);
  assert.equal(board.awaited('C')[0]?.ended, undefined);
});

test('the Director can ask and end its round: it never parks', async () => {
  const f = await fixture((_request, index) => index === 1 ? tools(send('a', 'techne', 'ask')) : closing('Waiting for Techne.'), 'logox');
  try {
    f.peer('techne');
    const task = f.ensemble.dispatch('logox', 'Plan', 'direct');
    await task.done;
    assert.equal(f.status(task.activityId), 'completed');
    assert.ok(!said(f.requests[1]!, /The reply wakes you/), 'the sent ask result carries no runtime note');
    assert.equal(f.board.owed('s', 'techne').length, 1, 'Techne still owes the answer');
  } finally { await f.cleanup(); }
});

function collaboration(over: {active?: boolean; onStage?: boolean} = {}) {
  const injected: string[] = [], enqueued: string[] = [];
  const cooperate = new Collaboration({sessionId: 's', journal: {collaborations: async () => [], saveCollaborations: async () => {}} as unknown as Journal,
    member: () => true, members: () => ['techne', 'kalon'],
    enqueue: (_owner, prompt) => { enqueued.push(prompt); return {activityId: 'new', done: Promise.resolve(), cancel() {}}; },
    getActiveTask: () => over.active ? {activityId: 'x'} : undefined,
    injectMessage: (_to, message) => { injected.push(message); return true; },
    hasOnStageActivity: () => over.onStage ?? false,
    deliverToCompletedPeer: () => true});
  const context = {sessionId: 's', activityId: 'me', ownerId: 'techne', signal: new AbortController().signal} as unknown as ActorContext<string>;
  return {injected, enqueued, send: (to: string, type?: string) => cooperate.execute(call('c', 'SendMessage', {to, message: 'Art ready?', ...(type ? {type} : {})}), context)};
}

test('the recipient sees it must reply; an ask to all, to yourself or to a teammate never dispatched is refused', async () => {
  const running = collaboration({active: true});
  assert.equal((await running.send('kalon', 'ask')).isError, false);
  assert.match(running.injected[0]!, /Question for you.*type "reply" to techne/);
  assert.equal((await running.send('all', 'ask')).isError, true);
  assert.equal((await running.send('techne', 'ask')).isError, true);
  const offstage = await collaboration().send('kalon', 'ask');
  assert.equal(offstage.isError, true);
  assert.match(offstage.text, /has not been dispatched.*Ask Director/);
});

test('an ask wakes a completed teammate; an inform to one stays passive', async () => {
  const asked = collaboration({onStage: true});
  assert.equal((await asked.send('kalon', 'ask')).isError, false);
  assert.equal(asked.enqueued.length, 1);
  const informed = collaboration({onStage: true});
  assert.equal((await informed.send('kalon', 'inform')).isError, false);
  assert.equal(informed.enqueued.length, 0);
});
