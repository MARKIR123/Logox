import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AUTOMA_RETAINED_INPUT_LIMIT, type AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import {Tools, type AutomaEnvironment} from '../src/tools/index.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {ModelMessage, ModelTurn} from '../src/runtime/messages.js';
import type {AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';

const writer: AutomaProfile = {name: 'work crew', default_style: 'scout', write_style: 'edit', exclusive: [], styles: {scout: {flavor: 'Scout style.'}, edit: {flavor: 'Edit style.', model: 'edit-model'}}};
function principal(overrides: Partial<ActorContext> = {}): ActorContext {
  return {sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}, ...overrides};
}
const finished = (summary = 'ok', extra: Record<string, unknown> = {}, usage?: ModelTurn['usage']): ModelTurn => ({
  message: {role: 'assistant', text: '', toolCalls: [{id: 'fin', name: 'Finish', arguments: JSON.stringify({status: 'done', summary, ...extra})}]}, stop: 'tools', ...(usage ? {usage} : {})});
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-record-'));
  await writeFile(join(cwd, 'a.txt'), 'one\n');
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
  return {cwd, tools, done: async () => {await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});}};
}
const parkedRoot = join(tmpdir(), 'logox-automa-record-parked-' + process.pid);
let environments = 0;
const parkedDirectory = () => {const id = String(++environments); return (sessionId: string) => join(parkedRoot, id, sessionId);};
after(() => rm(parkedRoot, {recursive: true, force: true}));
function environment(provider: AutomaProvider, overrides: Partial<AutomaEnvironment> = {}): AutomaEnvironment {
  return {resolveModel: () => ({provider, model: 'mock/worker'}), profile: () => writer, workerDir: parkedDirectory(), ...overrides};
}
const job = (brief: string, extra: Record<string, unknown> = {}) => ({title: brief, brief, scope: 'bounded', ...extra});
const dispatch = (args: unknown) => ({id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)});
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('a result block shows stop only when the run did not complete, and the swarm state carries route, model and outcome', async () => {
  const {tools, done} = await project();
  try {
    const seen: AutomaSwarm[] = [];
    tools.setAutomaEnvironment(environment({async respond({messages}) {
      const first = messages[0]!.text;
      if (first.startsWith('boom')) throw new Error('worker exploded');
      if (first.startsWith('quiet')) return {message: {role: 'assistant', text: ''}, stop: 'complete'};
      if (first.startsWith('ask')) return finished('cannot go on', {status: 'blocked', question: 'Which file?'}) as ModelTurn;
      return finished('all good');
    }}));
    const result = await tools.execute(dispatch({jobs: [job('fine'), job('boom'), job('quiet'), job('ask')], parallel: 4}), principal({reportSwarm: swarm => seen.push(swarm)}));
    const block = (title: string) => new RegExp(`<automa-result id="\\w+" title="${title}" status="([a-z]+)"( stop="[a-z_]+")? took=`).exec(result.text)!;
    assert.deepEqual([block('fine')[1], block('fine')[2]], ['done', undefined], 'an ordinary completion shows no stop');
    assert.deepEqual([block('boom')[1], block('boom')[2]], ['failed', ' stop="error"']);
    assert.deepEqual([block('quiet')[1], block('quiet')[2]], ['failed', ' stop="stalled"']);
    assert.deepEqual([block('ask')[1], block('ask')[2]], ['blocked', undefined], 'a worker that finished and asked completed');
    const last = seen.at(-1)!.jobs;
    const state = (title: string) => last.find(item => item.title === title)!;
    assert.deepEqual([state('fine').stopReason, state('fine').route, state('fine').model, state('fine').summary], ['completed', 'read', 'mock/worker', 'all good']);
    assert.deepEqual([state('boom').stopReason, state('quiet').stopReason, state('ask').stopReason, state('ask').question], ['error', 'stalled', 'completed', 'Which file?']);
  } finally {await done();}
});

test('a job cancelled with the dispatcher reports who stopped it', async () => {
  const {tools, done} = await project();
  try {
    const controller = new AbortController();
    tools.setAutomaEnvironment(environment({async respond({messages}) {
      void messages; controller.abort(); await sleep(5); throw new Error('aborted');
    }}));
    const result = await tools.execute(dispatch({jobs: [job('stopped')]}), principal({signal: controller.signal, stopReason: () => 'user'}));
    assert.match(result.text, /status="cancelled" stop="cancelled_by_user" took=/);
    const director = new AbortController();
    tools.setAutomaEnvironment(environment({async respond() {director.abort(); await sleep(5); throw new Error('aborted');}}));
    const second = await tools.execute(dispatch({jobs: [job('stopped again')]}), principal({signal: director.signal, stopReason: () => 'director_cancel'}));
    assert.match(second.text, /status="cancelled" stop="cancelled_by_director" took=/);
  } finally {await done();}
});

test('jobs that wait for a running slot are counted in one line for the dispatch, never per job', async () => {
  const {tools, done} = await project();
  try {
    let limit = 2;
    tools.setAutomaEnvironment(environment({async respond() {await sleep(30); return finished();}}, {maxRunning: () => limit}));
    const queued = await tools.execute(dispatch({jobs: [job('one'), job('two'), job('three')]}), principal());
    assert.match(queued.text, /3\/3 done/);
    assert.equal(queued.text.match(/^Queued \d+ of \d+ jobs: .*$/gm)?.length, 1, 'once per dispatch');
    assert.match(queued.text, /^Queued 1 of 3 jobs: the session runs at most 2 workers at once\.$/m);
    // Within the limit nothing is queued and nothing is said.
    const fits = await tools.execute(dispatch({jobs: [job('four'), job('five')]}), principal());
    assert.doesNotMatch(fits.text, /Queued \d+ of/);
    // The limit is the configured one.
    limit = 1;
    const narrow = await tools.execute(dispatch({jobs: [job('six'), job('seven'), job('eight')]}), principal());
    assert.match(narrow.text, /^Queued 2 of 3 jobs: the session runs at most 1 workers at once\.$/m);
  } finally {await done();}
});

test('a dispatch over max_per_dispatch is refused and the refusal still states the fix', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment({async respond() {return finished();}}, {maxPerDispatch: () => 2}));
    const refused = await tools.execute(dispatch({jobs: [job('a'), job('b'), job('c')]}), principal());
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Too many jobs: 3\. This setup allows 2 per call \(`\[automa\] max_per_dispatch`\)\. Send the first 2 now and the rest in a second call/);
  } finally {await done();}
});

/** A model name that can change between dispatches, to stand for a changed worker model binding. */
function changing() {
  const state = {model: 'mock/worker', rules: [] as {path: string; text: string}[], input: 10, requests: [] as ModelMessage[][]};
  const provider: AutomaProvider = {async respond(request) {state.requests.push([...request.messages]); return finished('ok', {}, {input: state.input, output: 1});}};
  const env = (dir = parkedDirectory()) => ({...environment(provider, {workerDir: dir, guidelines: () => state.rules}), resolveModel: () => ({provider, model: state.model})});
  return {state, provider, env};
}
const noteIn = (text: string) => /^Note: (\S+)'s definition changed since this work started \(([a-z, ]+)\); it continues under the current definition\.$/m.exec(text);

test('continuing a worker whose definition did not change adds no note', async () => {
  const {tools, done} = await project();
  try {
    const f = changing();
    tools.setAutomaEnvironment(f.env());
    await tools.execute(dispatch({jobs: [job('first')]}), principal());
    const again = await tools.execute(dispatch({jobs: [{title: 'x', brief: 'next', continue: 'T1'}]}), principal());
    assert.match(again.text, /<automa-result id="T1" /);
    assert.equal(noteIn(again.text), null);
    assert.doesNotMatch(f.state.requests.at(-1)!.at(-1)!.text, /definition changed/);
  } finally {await done();}
});

test('continuing a worker after its model or the project rules changed still continues, and says so once in the brief and the result', async () => {
  const {tools, done} = await project();
  try {
    const f = changing();
    tools.setAutomaEnvironment(f.env());
    await tools.execute(dispatch({jobs: [job('first')]}), principal());
    f.state.model = 'mock/newer';
    const changedModel = await tools.execute(dispatch({jobs: [{title: 'x', brief: 'next', continue: 'T1'}]}), principal());
    assert.deepEqual(noteIn(changedModel.text)?.slice(1), ['T1', 'model']);
    assert.match(changedModel.text, /model="mock\/newer"/, 'it runs on the current model');
    const brief = f.state.requests.at(-1)!.findLast(message => message.role === 'user')!.text;
    assert.match(brief, /^Note: T1's definition changed since this work started \(model\); it continues under the current definition\.\n\nnext/);
    // The note is said once: the stored definition is renewed by the continue.
    const quiet = await tools.execute(dispatch({jobs: [{title: 'x', brief: 'again', continue: 'T1'}]}), principal());
    assert.equal(noteIn(quiet.text), null);
    f.state.rules = [{path: 'AGENTS.md', text: 'New project rule.'}];
    const changedRules = await tools.execute(dispatch({jobs: [{title: 'x', brief: 'once more', continue: 'T1'}]}), principal());
    assert.deepEqual(noteIn(changedRules.text)?.slice(1), ['T1', 'prompt']);
  } finally {await done();}
});

test('a worker parked by an older version has no stored definition: a continue after a change adds no note', async () => {
  const {cwd, tools, done} = await project();
  try {
    const f = changing(), dir = parkedDirectory();
    f.state.input = AUTOMA_RETAINED_INPUT_LIMIT;
    tools.setAutomaEnvironment(f.env(dir));
    await tools.execute(dispatch({jobs: [job('first')]}), principal());
    const file = join(dir('s'), 'act', 'T1.json');
    const parked = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(typeof parked.fingerprint, 'string', 'new workers store their definition');
    delete parked.fingerprint;
    await writeFile(file, JSON.stringify(parked));
    // A fresh process: the worker is read back from disk.
    const restarted = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
    f.state.model = 'mock/newer'; f.state.input = 10;
    restarted.setAutomaEnvironment(f.env(dir));
    const again = await restarted.execute(dispatch({jobs: [{title: 'x', brief: 'next', continue: 'T1'}]}), principal());
    assert.match(again.text, /<automa-result id="T1" /);
    assert.equal(noteIn(again.text), null, again.text);
  } finally {await done();}
});
