import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import type {Activity, Step} from '../src/runtime/contracts.js';
import {Prosoche, advanceWork, callsOf, checkActivity, firstCheckMs, workStateOf, type ProsocheDeps, type WorkClock} from '../src/actors/prosoche.js';
import {parseExpectMinutes} from '../src/tools/orchestration/ActorTool/expect.js';
import {taskSpecSchema} from '../src/tools/orchestration/ActorTool/ActorTool.js';

const S = 'session', MIN = 60_000;

function setup(options: {minutes?: number; expectMinutes?: number; owner?: string; kind?: Activity['kind']; pending?: () => boolean; parked?: () => boolean; jobs?: string[]} = {}) {
  const store = new RuntimeStore();
  const clock = {now: 1_000_000};
  const notices: Array<{text: string; source: string}> = [];
  let calls = 0;
  const deps: ProsocheDeps = {store, sessionId: S, minutes: () => options.minutes ?? 20, parked: () => options.parked?.() ?? false, jobs: () => options.jobs ?? [],
    shellFiles: () => [], nameOf: id => id[0]!.toUpperCase() + id.slice(1), pending: () => options.pending?.() ?? false,
    notify: async (text, source) => {notices.push({text, source});}, now: () => clock.now};
  const prosoche = new Prosoche(deps);
  store.activities.create({sessionId: S, activityId: 'a1', ownerId: options.owner ?? 'techne', kind: options.kind ?? 'actor', title: 'Techne · Fix parser', status: 'running',
    stage: '', detail: '', taskTitle: 'Fix the parser', ...(options.expectMinutes ? {expectMinutes: options.expectMinutes} : {})});
  const call = (name: string, args: Record<string, unknown>, state: 'completed' | 'failed' = 'completed', result = 'ok') => {
    const id = 'c' + ++calls;
    const step: Step = {title: name, callId: id, call: {id, name, arguments: JSON.stringify(args)}, state, elapsedMs: 0};
    store.message(S, options.owner ?? 'techne', 'notice', name + '\n' + result, {activityId: 'a1', kind: 'tool', step});
  };
  /** Advances the fake clock in coarse ticks so a long wait is sampled like the real timer would. */
  const advance = (ms: number) => {
    for (let left = ms; left > 0;) {const step = Math.min(left, 30_000); clock.now += step; left -= step; prosoche.evaluate();}
  };
  prosoche.evaluate();
  return {store, clock, notices, prosoche, call, advance};
}

test('work time counts only the time spent working', () => {
  let clock: WorkClock = {at: 0, state: 'working', workMs: 0};
  clock = advanceWork(clock, 10 * MIN, 'waiting');
  clock = advanceWork(clock, 25 * MIN, 'working');
  clock = advanceWork(clock, 30 * MIN, 'idle');
  clock = advanceWork(clock, 90 * MIN, 'working');
  assert.equal(clock.workMs, 15 * MIN);
  assert.equal(workStateOf({status: 'running'}, false), 'working');
  assert.equal(workStateOf({status: 'waiting_input'}, false), 'waiting');
  assert.equal(workStateOf({status: 'running', phase: 'approval'}, false), 'waiting');
  assert.equal(workStateOf({status: 'running', phase: 'question'}, false), 'waiting');
  assert.equal(workStateOf({status: 'running'}, true), 'waiting');
  assert.equal(workStateOf({status: 'paused'}, false), 'idle');
  assert.equal(workStateOf({status: 'queued'}, false), 'idle');
});

test('a wait on the human or on another actor is not work time', () => {
  let parked = false;
  const {store, advance, prosoche} = setup({parked: () => parked});
  advance(5 * MIN);
  store.activities.update(S, 'a1', {status: 'waiting_input'}); prosoche.evaluate();
  advance(30 * MIN);
  store.activities.update(S, 'a1', {status: 'running'}); prosoche.evaluate();
  parked = true; prosoche.evaluate(); advance(30 * MIN);
  parked = false; prosoche.evaluate(); advance(5 * MIN);
  assert.equal(prosoche.workMs('a1'), 10 * MIN);
});

test('checkpoints fall at 20, 40 and 80 minutes of work and each sends one notice with the template', () => {
  const {notices, advance, call} = setup();
  advance(19 * MIN); assert.equal(notices.length, 0);
  call('Read', {file_path: 'a.ts'}); call('Read', {file_path: 'b.ts'});
  advance(2 * MIN);
  assert.equal(notices.length, 1);
  const first = notices[0]!;
  assert.equal(first.source, 'techne');
  assert.match(first.text, /^\[Prosoche\] Techne has worked 20m on "Fix the parser" \(activity a1\)\. Since the last check: 2 calls, no files changed, no progress signal\. Recent calls: Read a\.ts \| Read b\.ts\. You may let it continue \(next check in 20m\), steer it with SendMessage, or stop it\.$/);
  advance(18 * MIN); assert.equal(notices.length, 1);
  advance(2 * MIN); assert.equal(notices.length, 2);
  advance(38 * MIN); assert.equal(notices.length, 2);
  advance(2 * MIN); assert.equal(notices.length, 3);
  advance(200 * MIN); assert.equal(notices.length, 4, 'the next check is at 160 minutes');
});

test('an expected duration defers the first check to the longer of it and the configured minutes', () => {
  const {notices, advance} = setup({expectMinutes: 45});
  advance(44 * MIN); assert.equal(notices.length, 0);
  advance(2 * MIN); assert.equal(notices.length, 1);
  assert.equal(firstCheckMs(20, 10), 20 * MIN);
  assert.equal(firstCheckMs(20, 45), 45 * MIN);
  assert.equal(firstCheckMs(20), 20 * MIN);
});

test('a progressing activity stays silent', () => {
  const {notices, advance, call} = setup();
  advance(10 * MIN);
  call('Read', {file_path: 'a.ts'}); call('Edit', {file_path: 'a.ts', old_string: 'x', new_string: 'y'});
  advance(11 * MIN);
  assert.equal(notices.length, 0);
});

test('the same error three times is a loop signal', () => {
  const {notices, advance, call} = setup();
  call('Edit', {file_path: 'a.ts'}); // a write, so progress is not what makes it suspect
  for (const n of [3, 5, 9]) call('Shell', {command: 'npm test ' + n}, 'failed', `Error at /tmp/run-${n}/x.ts:${n}: cannot find module`);
  advance(21 * MIN);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /the same error 3 times/);
  assert.match(notices[0]!.text, /Recent calls: Edit a\.ts \| Shell npm test 3 \(failed\)/);
});

test('near-duplicate calls are a loop signal and a pending notice is not repeated', () => {
  let pending = false;
  const {notices, advance, call} = setup({pending: () => pending});
  call('Edit', {file_path: 'a.ts'});
  for (let n = 0; n < 12; n++) call('Shell', {command: 'sleep ' + (n + 1) + ' && cat /tmp/job-' + (1000 + n) + '.log'});
  advance(21 * MIN);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /12 of its last 13 calls are near-duplicates/);
  pending = true;
  advance(40 * MIN);
  assert.equal(notices.length, 1, 'the Director has not read the first notice yet');
});

test('many calls with no write and no new file read are a loop signal; a running job is context', () => {
  const window = Array.from({length: 30}, (_, n) => ({tool: 'Grep', target: 'needle' + String.fromCharCode(97 + n % 26) + n, failed: false, error: ''}));
  const result = checkActivity({window, before: [], shellFiles: [], jobs: ['job-1']});
  assert.equal(result.verdict, 'suspect');
  assert.ok(result.signals.some(signal => /no file written/.test(signal)));
  assert.ok(result.signals.some(signal => /background job job-1 still running/.test(signal)));
  const withRead = checkActivity({window: [...window.slice(0, 5), {tool: 'Read', target: 'new.ts', failed: false, error: ''}, ...window.slice(5)], before: [], shellFiles: [], jobs: []});
  assert.ok(!withRead.signals.some(signal => /no file written/.test(signal)));
  assert.equal(checkActivity({window: [], before: [], shellFiles: ['out.txt'], jobs: []}).verdict, 'progressing');
});

test('0 turns the prosoche off, and the Director and other kinds are never watched', () => {
  const off = setup({minutes: 0});
  off.advance(300 * MIN);
  assert.equal(off.notices.length, 0);
  assert.equal(off.prosoche.workMs('a1'), undefined);
  const director = setup({owner: 'logox', kind: 'director'});
  director.advance(300 * MIN);
  assert.equal(director.notices.length, 0);
  assert.equal(director.prosoche.workMs('a1'), undefined);
  const dream = setup({kind: 'anamnesis'});
  dream.advance(300 * MIN);
  assert.equal(dream.notices.length, 0);
});

test('nothing is cancelled: a flagged activity keeps running', () => {
  const {store, notices, advance} = setup();
  advance(100 * MIN);
  assert.ok(notices.length >= 2);
  assert.equal(store.activities.get(S, 'a1')?.status, 'running');
});

test('a finished activity is dropped and the service disposes cleanly', () => {
  const {store, prosoche, advance} = setup();
  advance(5 * MIN);
  store.activities.update(S, 'a1', {status: 'completed'}); prosoche.evaluate();
  assert.equal(prosoche.workMs('a1'), undefined);
  prosoche.start(); prosoche.dispose();
});

test('callsOf reads finished tool steps of one activity and flags failed Shell exits', () => {
  const {store, call} = setup();
  call('Shell', {command: 'make'}, 'completed', 'Exit code: 2\nboom');
  call('Read', {file_path: 'x'});
  const calls = callsOf(store.getSnapshot().messages, 'a1');
  assert.deepEqual(calls.map(item => [item.tool, item.failed]), [['Shell', true], ['Read', false]]);
  assert.deepEqual(callsOf(store.getSnapshot().messages, 'other'), []);
});

test('Actor tasks take an optional expect duration in minutes or hours', () => {
  assert.equal(parseExpectMinutes('45m'), 45);
  assert.equal(parseExpectMinutes('2h'), 120);
  assert.equal(parseExpectMinutes('1h30m'), 90);
  assert.equal(parseExpectMinutes('90 min'), 90);
  assert.equal(parseExpectMinutes('soon'), undefined);
  assert.equal(parseExpectMinutes('0m'), undefined);
  assert.equal(parseExpectMinutes(''), undefined);
  assert.ok(taskSpecSchema.safeParse({ownerId: 'techne', prompt: 'x', expect: '2h'}).success);
  assert.ok(!taskSpecSchema.safeParse({ownerId: 'techne', prompt: 'x', expect: 'later'}).success);
});
