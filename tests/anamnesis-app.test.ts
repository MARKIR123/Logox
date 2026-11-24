import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {MemoryStore} from '../src/anamnesis/memory.js';
import {loadConfig} from '../src/config/config.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {Tools} from '../src/tools/index.js';
import {AUTOMA_SYSTEM_PROMPT} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {agentRequestBase} from '../src/kernel/agent.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';
import {createTestApplication as createApplication, waitForSnapshot} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

type App = Awaited<ReturnType<typeof createApplication>>;
const isAnamnesis = (request: ModelRequest) => request.tools.length === 0 && request.system.startsWith('You are Anamnesis');
const DREAM_ANSWER = JSON.stringify({operations: [
  {op: 'save', scope: 'project', type: 'feedback', name: 'prefers-tabs', description: 'The user wants tabs, not spaces', content: 'Why: said so.\nHow to apply: every file.'},
  {op: 'save', scope: 'project', type: 'user', name: 'role', description: 'The user is a staff engineer', content: 'Staff engineer.'},
]});

async function fixture(options: {hold?: boolean; auto?: Record<string, unknown>} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-anamnesis-app-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(home, {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const seen: ModelRequest[] = [];
  const control = {answer: DREAM_ANSWER, recap: 'Uploader retries done\n\nDone: retries\nOpen: nothing\nNext: ship', hold: options.hold ?? false, aborted: 0};
  const provider: Provider = {async respond(request, _delta, signal) {
    seen.push(request);
    if (isAnamnesis(request)) {
      if (control.hold) await new Promise((_, reject) => signal.addEventListener('abort', () => {control.aborted++; reject(signal.reason);}, {once: true}));
      return {message: {role: 'assistant', text: request.system.includes('memory keeper of the LOGOX ensemble. While') ? control.answer : control.recap}, stop: 'complete', usage: {input: 400, output: 60}};
    }
    return {message: {role: 'assistant', text: 'Understood, noted.'}, stop: 'complete'};
  }};
  const apps: App[] = [];
  const open = async (extra: Record<string, unknown> = {}, sessionId = 'anamnesis-app'): Promise<App> => {
    const app = await createApplication({cwd, config, provider, sessionId, resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json'), ...extra});
    apps.push(app); return app;
  };
  return {root, cwd, home, seen, control, open, memory: new MemoryStore(cwd, home),
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true});}};
}
async function speak(app: App, text: string) {
  const before = app.store.getSnapshot().activities.filter(activity => activity.status === 'completed').length;
  await app.submit(text);
  await waitForSnapshot(app.store, snapshot => snapshot.activities.filter(activity => activity.status === 'completed').length > before && !app.ensemble.isBusy());
}
const systems = (seen: readonly ModelRequest[]) => seen.filter(request => !isAnamnesis(request)).map(request => request.system);
/** The memory section of a system prompt: from its heading to the next topic heading. */
const memoryBlock = (system: string) => {const at = system.indexOf('## Memory'); return system.slice(at, system.indexOf('\n\n# ', at));};

test('the memory section reaches every actor, stays byte-identical for the session, and a later record waits for the next session or /reload', async () => {
  const f = await fixture();
  try {
    await f.memory.save({name: 'prefers-tabs', description: 'The user wants tabs', type: 'feedback', content: 'Tabs.'}, 'project');
    await f.memory.save({name: 'role', description: 'Staff engineer', type: 'user', content: 'Staff.'}, 'user');
    const app = await f.open();
    await speak(app, 'first question');
    await speak(app, '@techne look at the parser');
    const [director, companion] = systems(f.seen);
    assert.ok(director && companion);
    for (const system of [director, companion]) {
      assert.match(system, /## Memory\n\nLong-term memory is two folders of Markdown records: `[^`]*\.logox[\\/]memory` \(this project\) and `[^`]*\.logox[\\/]memory` \(every project of this user\)\./);
      assert.ok(system.includes('- project/prefers-tabs.md (feedback): The user wants tabs\n- user/role.md (user): Staff engineer'), system.slice(system.indexOf('## Memory')));
      assert.ok(system.indexOf('## Memory') > system.indexOf('# Project Guidelines') && system.indexOf('## Memory') < system.indexOf('# Tools & Skills'), 'after the project rules, before tools');
    }
    assert.equal(memoryBlock(director), memoryBlock(companion), 'the same bytes for every actor');
    assert.ok(director.includes(join(f.cwd, '.logox', 'memory')) && director.includes(join(f.home, '.logox', 'memory')));

    await f.memory.save({name: 'late-fact', description: 'Saved mid-session', type: 'project', content: 'Late.'}, 'project');
    await speak(app, 'second question');
    const second = systems(f.seen).at(-1)!;
    assert.equal(memoryBlock(second), memoryBlock(director), 'byte-identical after a record was saved mid-session');
    assert.ok(!second.includes('late-fact'));
    const requestsBefore = f.seen.length;
    await app.submit('/reload');
    app.surfaces.cancel();
    await speak(app, 'third question');
    assert.ok(systems(f.seen.slice(requestsBefore)).at(-1)!.includes('- project/late-fact.md (project): Saved mid-session'), '/reload reads the records again');

    assert.equal(f.seen.filter(isAnamnesis).length, 0, 'without a started interval nothing asks the model on its own');
    await app.close();
    const next = await f.open({}, 'second-session');
    await speak(next, 'hello again');
    assert.ok(systems(f.seen).at(-1)!.includes('late-fact.md'), 'a new session starts with the records');
  } finally {await f.close();}
});

test('with no records the section ends with "No records yet."; Automa workers carry no memory section', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await speak(app, 'hello');
    const system = systems(f.seen)[0]!;
    assert.ok(system.includes('The user removes records under `/anamnesis`.\n\nNo records yet.'), system.slice(system.indexOf('## Memory')));
    assert.ok(!AUTOMA_SYSTEM_PROMPT.includes('Memory') && !AUTOMA_SYSTEM_PROMPT.includes('/anamnesis'));
    const bare = await agentRequestBase(f.cwd, 'logox', [], undefined, {prompt: 'You are a test persona.', visibility: {actorId: 'logox'}}, true, undefined, 'Environment.');
    assert.ok(!bare.system.includes('Long-term memory'), 'a request that carries no section has none');
  } finally {await f.close();}
});

test('a manual dream reads the session, saves records in the right folders, charges its usage to anamnesis and shows the card', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await speak(app, 'Please always use tabs. I am a staff engineer.');
    const {done} = app.anamnesis.runNow('dream');
    const card = app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!;
    assert.equal(card.stage, 'Reviewing the session');
    const result = await done;
    assert.equal(result.status, 'completed');
    const finished = app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!;
    assert.deepEqual([finished.status, finished.stage], ['completed', 'Saved 2 memory records']);
    assert.equal(finished.detail, "Remembered in your memory (all projects)\n• role (about you): The user is a staff engineer\n\nRemembered in this project's memory\n• prefers-tabs (preference): The user wants tabs, not spaces");
    assert.deepEqual((await app.anamnesis.memories()).map(record => record.scope + '/' + record.name), ['project/prefers-tabs', 'user/role']);
    assert.match(await readFile(join(f.home, '.logox', 'memory', 'role.md'), 'utf8'), /type: user/);
    assert.equal(await readFile(join(f.cwd, '.logox', 'memory', 'MEMORY.md'), 'utf8'), '- [prefers-tabs](prefers-tabs.md) — The user wants tabs, not spaces\n');
    const request = f.seen.find(isAnamnesis)!;
    assert.deepEqual(request.tools, []);
    assert.match(request.messages[0]!.text, /Unreviewed transcript:\n\[logox · user\] Please always use tabs\. I am a staff engineer\.\n\[logox · assistant\] Understood, noted\./);
    assert.ok(f.seen.some(item => !isAnamnesis(item)));
    const meter = app.contexts.sessionMeters(app.sessionId).get('anamnesis')!;
    assert.deepEqual(meter.usageRecords().map(record => [record.category, record.model, record.input, record.output]), [['anamnesis', '["openai","fixture"]', 400, 60]]);
    // Nothing new since: the same dream finds nothing and, being manual, keeps a card that says so.
    const again = await app.anamnesis.runNow('dream').done;
    assert.equal(again.status, 'completed');
    assert.equal(f.seen.filter(isAnamnesis).length, 1, 'no second request for an empty transcript');
    // Forget removes the file but the session's prompt keeps its list.
    assert.equal(await app.anamnesis.forget('project', 'prefers-tabs'), true);
    assert.equal(await app.anamnesis.forget('project', 'prefers-tabs'), false);
  } finally {await f.close();}
});

test('runNow refuses while the ensemble works; the model follows the Director until one is chosen; a vanished provider is a clear failure', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    assert.deepEqual(app.anamnesis.anamnesisModel(), {provider: 'openai', model: 'fixture', inherited: true});
    await speak(app, 'something to remember');
    await app.anamnesis.setAnamnesisModel({provider: 'vanished', model: 'gone-1'});
    assert.deepEqual(app.anamnesis.anamnesisModel(), {provider: 'vanished', model: 'gone-1', inherited: false});
    assert.ok(!app.actors.list().some(actor => actor.id === 'anamnesis'), 'a binding does not make an actor');
    const result = await app.anamnesis.runNow('recap').done;
    assert.deepEqual(result, {kind: 'recap', status: 'failed', error: 'Anamnesis has no usable model (vanished/gone-1). Choose one under /anamnesis.'});
    const card = app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!;
    assert.deepEqual([card.status, card.stage, card.detail], ['failed', 'Recap failed', 'Anamnesis has no usable model (vanished/gone-1). Choose one under /anamnesis.']);
    assert.equal(f.seen.filter(isAnamnesis).length, 0, 'no request went to another model');
    await app.anamnesis.setAnamnesisModel(undefined);
    assert.equal(app.anamnesis.anamnesisModel().inherited, true);

    await app.close();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const slow: Provider = {async respond() {await blocked; return {message: {role: 'assistant', text: 'late'}, stop: 'complete'};}};
    const working = await f.open({provider: slow}, 'busy-session');
    await working.submit('slow work');
    await waitForSnapshot(working.store, snapshot => snapshot.activities.some(activity => activity.status === 'running'));
    assert.throws(() => working.anamnesis.runNow('dream'), /cannot run while tasks are running/);
    release();
    await waitForSnapshot(working.store, snapshot => snapshot.activities.every(activity => activity.status !== 'running'));
  } finally {await f.close();}
});

test('the automatic switches persist in the user home, override the config, and never block a manual run', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    assert.deepEqual(app.anamnesis.settings(), {recap: true, dream: true, recapIdleMinutes: 5, dreamIdleMinutes: 30});
    await app.anamnesis.setAuto('dream', false);
    assert.deepEqual(JSON.parse(await readFile(join(f.home, '.logox', 'anamnesis.json'), 'utf8')), {version: 1, dream: false});
    await app.anamnesis.setAuto('recap', false);
    assert.equal(app.anamnesis.settings().recap, false);
    await app.close();
    const again = await f.open({}, 'again');
    assert.deepEqual(again.anamnesis.settings(), {recap: false, dream: false, recapIdleMinutes: 5, dreamIdleMinutes: 30});
    await speak(again, 'material for a manual run');
    assert.equal((await again.anamnesis.runNow('recap').done).status, 'completed');
    await again.anamnesis.setAuto('recap', true);
    assert.equal(again.anamnesis.settings().recap, true);
  } finally {await f.close();}
});

test('the idle interval starts only when asked: an injected clock and interval run the recap after idle time and submitting stops it', async () => {
  const f = await fixture();
  try {
    let now = 0;
    // The application activates itself when it opens, which is when the interval starts.
    const app = await f.open({anamnesis: {clock: () => now, tickMs: 5, recapIdleMs: 1000, dreamIdleMs: 5000}});
    await speak(app, 'what is the plan for the uploader');
    now = 500; await delay(30);
    assert.equal(f.seen.filter(isAnamnesis).length, 0, 'not idle long enough');
    app.noteDraft();
    now = 1400; await delay(30);
    assert.equal(f.seen.filter(isAnamnesis).length, 0, 'a keystroke restarted the idle clock');
    now = 1600;
    await waitFor(() => app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis'), card => card?.status === 'completed', {label: 'recap card'});
    const card = app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!;
    assert.deepEqual([card.stage, card.detail], ['Uploader retries done', 'Done: retries\n\nOpen: nothing\n\nNext: ship']);
    assert.equal(f.seen.filter(isAnamnesis).length, 1);
    now = 6000; await delay(30);
    await waitFor(() => app.anamnesis.memories(), records => records.length === 2, {label: 'the dream on its own clock'});
    assert.equal(f.seen.filter(isAnamnesis).length, 2);

    // A held run is aborted by the next submit and applies nothing.
    f.control.hold = true;
    await speak(app, 'one more thing to do');
    now = 20_000;
    await waitFor(() => f.seen.filter(isAnamnesis).length, count => count >= 3, {label: 'held request'});
    const before = (await app.anamnesis.memories()).length;
    await app.submit('stop that');
    assert.equal(f.control.aborted >= 1, true, 'the in-flight request was aborted');
    assert.equal((await app.anamnesis.memories()).length, before);
    assert.deepEqual(app.store.getSnapshot().activities.filter(activity => activity.kind === 'anamnesis' && activity.status === 'running'), [], 'the interrupted run left no card');
  } finally {await f.close();}
});

test('an Automa worker request carries no memory section even when records exist', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-anamnesis-automa-'));
  try {
    await new MemoryStore(cwd, cwd).save({name: 'prefers-tabs', description: 'The user wants tabs', type: 'feedback', content: 'Tabs.'}, 'project');
    const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
    const requests: {system: string; text: string}[] = [];
    const worker: Provider = {async respond(request) {
      requests.push({system: request.system, text: request.messages.map(message => message.text).join('\n')});
      return {message: {role: 'assistant', text: 'Verdict: done'}, stop: 'complete', usage: {input: 10, output: 5}};
    }};
    tools.setAutomaEnvironment({resolveModel: () => ({provider: worker, model: 'mock/worker'}), profile: () => ({name: 'crew', default_style: 'scout', styles: {scout: {flavor: 'Scout.'}}})});
    const context = {sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal: new AbortController().signal, report() {}, say() {}, async record() {},
      async ask() {return {status: 'cancelled' as const, reason: 'Unused'};}, async permission() {return false;}};
    await tools.execute({id: 'd', name: 'Automa', arguments: JSON.stringify({jobs: [{title: 'look', brief: 'look around'}]})}, context);
    assert.ok(requests.length > 0, 'the worker was asked');
    for (const request of requests) {
      assert.ok(request.system.startsWith(AUTOMA_SYSTEM_PROMPT));
      assert.ok(!/Long-term memory|## Memory|prefers-tabs/.test(request.system + '\n' + request.text), 'no memory section in the worker request');
    }
  } finally {await rm(cwd, {recursive: true, force: true});}
});
