import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {LOOP_EXEMPT_TOOLS, LOOP_STREAK, READ_MEMORY_LIMIT, RepeatGuard} from '../src/kernel/repeat-guard.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {ModelRequest, ModelTurn, Provider, ToolCall} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import {READ_UNCHANGED_NOTE} from '../src/tools/ReadTool/prompt.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const call = (name: string, args: object, id = 'c'): ToolCall => ({id, name, arguments: JSON.stringify(args)});
const ok = (text: string) => ({text, isError: false});

test('a read that returns what the previous read of the same range returned says so, until the file is edited', () => {
  const guard = new RepeatGuard(CWD);
  const read = call('Read', {file_path: 'a.ts', offset: 1, limit: 10});
  assert.equal(guard.readNote(read, ok('1: x')), undefined, 'the first read');
  assert.equal(guard.readNote(read, ok('1: x')), READ_UNCHANGED_NOTE);
  assert.equal(guard.readNote(call('Read', {file_path: 'a.ts', offset: 2, limit: 10}), ok('1: x')), undefined, 'another range is another selector');
  assert.equal(guard.readNote(call('Read', {file_path: join(CWD, 'a.ts'), offset: 1, limit: 10}), ok('1: x')), READ_UNCHANGED_NOTE, 'a relative and an absolute path are one file');
  assert.equal(guard.readNote(read, ok('1: y')), undefined, 'different output');
  assert.equal(guard.readNote(read, ok('1: y')), READ_UNCHANGED_NOTE);
  assert.equal(guard.readNote(call('Edit', {file_path: 'a.ts', old_string: 'y', new_string: 'z'}), ok('edited')), undefined);
  assert.equal(guard.readNote(read, ok('1: y')), undefined, 'an edit in between: no claim');
  assert.equal(guard.readNote(read, ok('1: y')), READ_UNCHANGED_NOTE);
  assert.equal(guard.readNote(call('Write', {file_path: 'a.ts', content: 'q'}), ok('written')), undefined);
  assert.equal(guard.readNote(read, ok('1: y')), undefined, 'a write too');
  assert.equal(guard.readNote(call('Read', {file_path: 'b.ts'}), {text: 'Error', isError: true}), undefined);
  assert.equal(guard.readNote(call('Read', {file_path: 'b.ts'}), {text: 'Error', isError: true}), undefined, 'failures never claim anything');
  const image = {text: '[Image]', isError: false, images: [{}]};
  assert.equal(guard.readNote(call('Read', {file_path: 'i.png'}), image), undefined);
  assert.equal(guard.readNote(call('Read', {file_path: 'i.png'}), image), undefined, 'images are left alone');
});

test('the read memory is capped and forgets the least recently read selector first', () => {
  const guard = new RepeatGuard(CWD);
  for (let index = 0; index < READ_MEMORY_LIMIT + 5; index++) guard.readNote(call('Read', {file_path: 'f' + index + '.ts'}), ok('content ' + index));
  assert.equal(guard.readNote(call('Read', {file_path: 'f0.ts'}), ok('content 0')), undefined, 'forgotten');
  assert.equal(guard.readNote(call('Read', {file_path: 'f' + (READ_MEMORY_LIMIT + 4) + '.ts'}), ok('content ' + (READ_MEMORY_LIMIT + 4))), READ_UNCHANGED_NOTE, 'remembered');
});

test('the third identical call with an unchanged result earns one reminder per streak', () => {
  const guard = new RepeatGuard(CWD);
  const grep = call('Grep', {pattern: 'a', path: 'src'});
  const notes = Array.from({length: 7}, () => guard.loopNote(grep, ok('same'), false));
  assert.deepEqual(notes.map(note => note !== undefined), [false, false, true, false, false, false, false]);
  assert.equal(notes[2], `You called Grep ${LOOP_STREAK} times in a row with identical arguments and got the same result. Do not repeat it: change the arguments, use another tool, or report what you have.`);
  // Key order and spacing of the arguments do not matter; a new streak may remind again.
  assert.equal(guard.loopNote({id: 'x', name: 'grep', arguments: '{"path": "src",  "pattern": "a"}'}, ok('same'), false), undefined, 'still the old streak');
  guard.loopNote(call('Glob', {pattern: '*'}), ok('g'), false);
  const again = [guard.loopNote(grep, ok('same'), false), guard.loopNote(grep, ok('same'), false), guard.loopNote(grep, ok('same'), false)];
  assert.ok(again[2], 'a streak after a different call is a new streak');
});

test('a changed result, changed arguments or a failure-to-success change break the streak', () => {
  const guard = new RepeatGuard(CWD);
  const shell = call('Shell', {command: 'npm test'});
  assert.equal(guard.loopNote(shell, ok('1 failing'), false), undefined);
  assert.equal(guard.loopNote(shell, ok('1 failing'), false), undefined);
  assert.equal(guard.loopNote(shell, ok('0 failing'), false), undefined, 'the result changed');
  assert.equal(guard.loopNote(shell, ok('0 failing'), false), undefined);
  assert.equal(guard.loopNote(shell, {text: '0 failing', isError: true}, false), undefined, 'the same text as an error is a change');
  assert.equal(guard.loopNote(call('Shell', {command: 'npm run build'}), ok('0 failing'), false), undefined);
  const steady = call('Read', {file_path: 'a.ts'});
  assert.equal(guard.loopNote(steady, ok('x'), false), undefined);
  assert.equal(guard.loopNote(call('Edit', {file_path: 'a.ts'}), ok('e'), false), undefined);
  assert.equal(guard.loopNote(steady, ok('x'), false), undefined);
  assert.equal(guard.loopNote(steady, ok('x'), false), undefined, 'a call in between restarts the count');
});

test('polling tools, coordination and MCP calls are exempt, and a waiting Director is left alone', () => {
  assert.deepEqual([...LOOP_EXEMPT_TOOLS].sort(), ['AskUserQuestion', 'ListActors', 'LoadTools', 'ReadActor', 'SendMessage', 'ShellJob', '_FinishRound']);
  for (const polled of [call('ShellJob', {job_id: 'j1'}), call('ReadActor', {actor: 'techne'}), call('ListActors', {}), call('mcp__playwright__browser_snapshot', {}), call('mcp', {server: 'x'})]) {
    const guard = new RepeatGuard(CWD);
    for (let index = 0; index < LOOP_STREAK * 3; index++) assert.equal(guard.loopNote(polled, ok('still running'), false), undefined, polled.name);
  }
  const waiting = new RepeatGuard(CWD);
  for (let index = 0; index < LOOP_STREAK * 3; index++) assert.equal(waiting.loopNote(call('Glob', {pattern: '*'}), ok('same'), true), undefined);
});

// The whole path: a model that repeats itself gets the facts and the reminder in its next requests.
const reply = (text: string, calls: ToolCall[] = []): ModelTurn => ({message: {role: 'assistant', text, ...(calls.length ? {toolCalls: calls} : {})}, stop: calls.length ? 'tools' : 'complete'});
const finish = call('_FinishRound', {title: 'Done', summary: 'Round outcome.'}, 'finish');

async function run(script: (index: number, cwd: string) => ModelTurn | Promise<ModelTurn>) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-repeat-'));
  await writeFile(join(cwd, 'notes.txt'), 'alpha\nbeta\n');
  const store = new RuntimeStore();
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request, delta, signal) {
    signal.throwIfAborted();
    requests.push(request);
    const value = await script(requests.length, cwd);
    if (value.message.text) delta({kind: 'text', text: value.message.text});
    return value;
  }};
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(cwd, 'sessions')), execute, {handoff: async () => {}});
  const task = ensemble.dispatch('logox', 'Go', 'direct');
  await task.done;
  return {requests, status: store.activities.get('s', task.activityId)?.status, cleanup: async () => {await ensemble.close(); await rm(cwd, {recursive: true, force: true});}};
}
const toolResults = (request: ModelRequest) => request.messages.flatMap(message => message.role === 'tool' && message.name === 'Read' ? [message.text] : []);
const reminders = (request: ModelRequest) => request.messages.flatMap(message => message.role === 'context' && message.kind === 'reminder' ? [message.text] : []);

test('an agent that re-reads an unchanged range is told so in the result, and not after the file changed', async () => {
  const f = await run(async (index, cwd) => {
    if (index === 3) await writeFile(join(cwd, 'notes.txt'), 'alpha\ngamma\n');
    return index <= 4 ? reply('', [call('Read', {file_path: 'notes.txt'}, 'r' + index)]) : reply('Done.', [finish]);
  });
  try {
    assert.equal(f.status, 'completed');
    const results = toolResults(f.requests.at(-1)!);
    assert.equal(results.length, 4);
    assert.ok(!results[0]!.includes(READ_UNCHANGED_NOTE), 'the first read');
    assert.equal(results[1], results[0] + '\n' + READ_UNCHANGED_NOTE, 'the second read returned the same bytes');
    assert.ok(!results[2]!.includes(READ_UNCHANGED_NOTE), 'the file changed');
    assert.equal(results[3], results[2] + '\n' + READ_UNCHANGED_NOTE, 'and then it did not');
  } finally {await f.cleanup();}
});

test('an agent that repeats an identical call with an identical result gets one reminder, after the third', async () => {
  const f = await run(index => index <= 5 ? reply('', [call('Glob', {pattern: '*.txt'}, 'g' + index)]) : reply('Done.', [finish]));
  try {
    assert.equal(f.status, 'completed');
    assert.deepEqual(f.requests.map(request => reminders(request).length), [0, 0, 0, 1, 0, 0], 'present only in the request that follows the third call, gone once answered');
    assert.match(reminders(f.requests[3]!)[0]!, /^You called Glob 3 times in a row with identical arguments and got the same result\./);
    assert.ok(!toolResults(f.requests[3]!).length);
  } finally {await f.cleanup();}
});
