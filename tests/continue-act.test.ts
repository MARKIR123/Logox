import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tools, type AutomaEnvironment} from '../src/tools/index.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {teamEvents} from '../src/runtime/team-events.js';
import {actorSchema} from '../src/tools/orchestration/ActorTool/ActorTool.js';
import {automaSchema, normalizeAutomaInput, type AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import type {AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {ModelTurn} from '../src/runtime/messages.js';

// `continueAct` is the Director's way to say that a new round continues the previous act of the team stage. The pure act function that reads it is tested in team-acts.test.ts;
// here are the dispatch inputs and the records it travels through.
const profile: AutomaProfile = {name: 'work crew', default_style: 'scout', styles: {scout: {flavor: 'Scout.'}}};
const root = join(tmpdir(), 'logox-continue-act-' + process.pid);
after(() => rm(root, {recursive: true, force: true}));
let environments = 0;

const finished: ModelTurn = {message: {role: 'assistant', text: '', toolCalls: [{id: 'fin', name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'ok'})}]}, stop: 'tools', usage: {input: 10, output: 1}};
const workers: AutomaProvider = {async respond() {return finished;}};
const environment = (): AutomaEnvironment => {const id = String(++environments); return {resolveModel: () => ({provider: workers, model: 'mock/worker'}), profile: () => profile, workerDir: (sessionId: string) => join(root, id, sessionId)};};
const call = (args: unknown) => ({id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)});
const job = (brief: string) => ({title: brief, brief, scope: 'bounded'});

/** Runs one Automa dispatch for `ownerId` and returns the swarms it reported. */
async function dispatch(ownerId: string, args: unknown): Promise<AutomaSwarm[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-continue-act-cwd-'));
  try {
    const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
    tools.setAutomaEnvironment(environment());
    const swarms: AutomaSwarm[] = [];
    const context: ActorContext = {sessionId: 's', activityId: 'act', ownerId, history: [], signal: new AbortController().signal, report() {}, say() {}, async record() {}, reportSwarm: swarm => {swarms.push(swarm);},
      async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}};
    const result = await tools.execute(call(args), context);
    assert.ok(!result.isError, result.text);
    return swarms;
  } finally {
    await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true});
    await rm(cwd, {recursive: true, force: true});
  }
}

test('the dispatch tools accept `continueAct` as an optional boolean and say what it does; anything but true is dropped', () => {
  assert.equal(actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'x'}], continueAct: true}).success, true);
  assert.equal(actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'x'}]}).success, true, 'optional');
  assert.equal(actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'x'}], continueAct: 'yes'}).success, false);
  assert.equal(automaSchema.safeParse({jobs: [job('a')], continueAct: true}).success, true);
  const keep = (value: unknown) => (normalizeAutomaInput({jobs: [job('a')], continueAct: value}) as {continueAct?: unknown}).continueAct;
  assert.deepEqual([keep(true), keep('true'), keep(false), keep('false'), keep('maybe'), keep(1)], [true, true, undefined, undefined, undefined, undefined]);
  const described = (schema: unknown) => JSON.stringify(schema).includes('same piece of work as the last act');
  assert.equal(described(actorSchema.toJSONSchema()), true);
  assert.equal(described(automaSchema.toJSONSchema()), true);
});

test('an Automa dispatch of the Director publishes `continueAct` on its swarm; the same call from a companion, or without the flag, publishes nothing', async () => {
  const asDirector = await dispatch('logox', {jobs: [job('a')], continueAct: true});
  assert.ok(asDirector.length > 0 && asDirector.every(swarm => swarm.continueAct === true), 'the swarm of the Director carries it');
  const plain = await dispatch('logox', {jobs: [job('a')]});
  assert.ok(plain.length > 0 && plain.every(swarm => swarm.continueAct === undefined), 'absent when not asked');
  const asCompanion = await dispatch('techne', {jobs: [job('a')], continueAct: true});
  assert.ok(asCompanion.length > 0 && asCompanion.every(swarm => swarm.continueAct === undefined), 'a companion\'s flag is ignored silently');
});

const base = {sessionId: 's', stage: '', detail: ''};
test('the team stream marks the dispatches that carry it: an assignment whose activity has it, a worker dispatch whose swarm has it', () => {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Fix', status: 'running', rootActivityId: 'root', inputKind: 'human'});
  store.activities.create({...base, activityId: 'k1', ownerId: 'kalon', kind: 'actor', title: 'Kalon', taskTitle: 'Draw', status: 'running', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director', continueAct: true, startedAt: 1000});
  store.activities.create({...base, activityId: 't1', ownerId: 'techne', kind: 'actor', title: 'Techne', taskTitle: 'Build', status: 'running', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director', startedAt: 90_000});
  const swarm = (continueAct: boolean): AutomaSwarm => ({name: 'crew', ...(continueAct ? {continueAct: true} : {}), jobs: [{id: 'T1', title: 'Find', state: 'running', elapsedMs: 0, calls: []}]});
  store.message('s', 'techne', 'assistant', '', {activityId: 't1', kind: 'tool', time: 100_000, step: {title: 'Automa', state: 'running', elapsedMs: 0, swarm: swarm(true)}});
  store.message('s', 'kalon', 'assistant', '', {activityId: 'k1', kind: 'tool', time: 200_000, step: {title: 'Automa', state: 'running', elapsedMs: 0, swarm: swarm(false)}});
  const events = teamEvents({snapshot: store.getSnapshot(), sessionId: 's'});
  assert.deepEqual(events.filter(event => event.kind === 'assign').map(event => [event.ref, event.continueAct]).sort(), [['k1', true], ['t1', undefined]]);
  assert.deepEqual(events.filter(event => event.kind === 'workers').map(event => [event.from, event.continueAct]).sort(), [['kalon', undefined], ['techne', true]]);
});
