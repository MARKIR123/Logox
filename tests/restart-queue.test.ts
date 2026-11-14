import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext} from '../src/actors/ensemble.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {planRestart, restartDependencies, restartStopped} from '../src/actors/restart.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {inputKind} from '../src/runtime/provenance.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {pendingRowLayout} from '../src/tui/input/input-delivery.js';
import {createTestApplication, waitForSnapshot} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';

const call = (tasks: unknown[], resumeBatch?: string) => ({id: 'assign', name: 'Actor', arguments: JSON.stringify({tasks, ...(resumeBatch ? {resumeBatch} : {})})});
/** Blocks until the run is stopped, like a long task that a quit or a crash cuts short. */
const hang = (context: ActorContext) => new Promise<void>((_, reject) => {context.signal.addEventListener('abort', () => reject(new Error('stopped')));});

type Driver = (context: ActorContext, services: ActorServices) => Promise<void>;
/** One process lifetime over a shared state directory; `restore()` repeats what `createApplication` does for the checkpoints a previous process left. */
async function lifetime(directory: string, behave: (prompt: string, context: ActorContext, services: ActorServices) => Promise<void>) {
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore(), deliveries = new DeliveryQueue('s', journal);
  let services!: ActorServices, driver: Driver = async () => {};
  const ensemble = new DynamicEnsemble('s', store, journal, async (prompt, context) => {
    services.definition(context);
    if (prompt === 'drive') await driver(context, services); else await behave(prompt, context, services);
  }, {concurrency: 'actor', deliveries, member: owner => catalog.find(owner), handoff: result => services.handoff(result),
    settled: (activity, status) => services.settled(activity, status)});
  services = new ActorServices({sessionId: 's', catalog, config, journal, deliveries, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), getSnapshot: () => store.getSnapshot(),
    getActiveTask: owner => ensemble.getActiveTask(owner), canReceiveMessage: owner => ensemble.canReceiveMessage(owner),
    requireIdle() {}, approve: async () => false, enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    pauseBatch: id => ensemble.pauseBatch(id), resumeBatch: id => ensemble.resumeBatch(id), coordinationPath: join(directory, 'coordination.json')});
  return {ensemble, services, store, journal,
    async restore() {
      const checkpoints = await journal.activeTasks('s');
      await services.recover(new Set(checkpoints.map(task => task.activityId)));
      const plan = planRestart(checkpoints, owner => !!catalog.find(owner));
      for (const task of plan.cancel) {await journal.checkpoint('s', {...task, status: 'cancelled', stopReason: 'interrupted'}); task.status = 'cancelled'; task.stopReason = 'interrupted';}
      for (const task of plan.restore) task.status = 'paused';
      const dependencies = restartDependencies(plan.restore, checkpoints);
      ensemble.restoreQueued(plan.restore, dependencies);
      services.restoreRestart(plan.restore, dependencies.interrupted, checkpoints.filter(task => restartStopped(task) && task.ownerId !== 'logox' && inputKind(task) === 'director').map(task => task.activityId));
      return plan;
    },
    /** Runs `run` as the Director's new human round, the way a request after `--resume` would. */
    async drive(run: Driver) {driver = run; await ensemble.dispatch('logox', 'drive', 'logox', {inputKind: 'human'}).done;},
    async close() {await ensemble.close(); await services.flush();}};
}
type Lifetime = Awaited<ReturnType<typeof lifetime>>;
const activity = (l: Lifetime, owner: string) => l.store.activities.list().find(item => item.ownerId === owner)!;

/** Process 1 dispatches A (kalon, running) and B (techne, after A); `how` ends it by a quit or by a crash that leaves the checkpoints as they were. */
async function interruptedChain(root: string, how: 'quit' | 'crash') {
  await mkdir(join(root, 'one'));
  const first = await lifetime(join(root, 'one'), async (prompt, context, services) => {
    if (prompt === 'start') await services.execute(call([{ownerId: 'kalon', prompt: 'A work', title: 'A'}, {ownerId: 'techne', prompt: 'B work', title: 'B', after: ['kalon']}]), context);
    else if (context.ownerId === 'kalon') await hang(context);
  });
  await first.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
  await waitForSnapshot(first.store, snapshot => snapshot.activities.some(item => item.ownerId === 'kalon' && item.status === 'running'));
  await waitFor(() => first.journal.activeTasks('s'), tasks => tasks.some(task => task.ownerId === 'techne' && task.status === 'queued') && tasks.some(task => task.ownerId === 'kalon' && task.status === 'running'), {label: 'A running, B queued'});
  const aId = activity(first, 'kalon').activityId, bId = activity(first, 'techne').activityId, batchId = activity(first, 'techne').batchId!;
  const directory = join(root, 'two');
  if (how === 'quit') {await first.close(); await cp(join(root, 'one'), directory, {recursive: true});}
  else {await first.journal.flush(); await cp(join(root, 'one'), directory, {recursive: true}); await first.close();}
  const runs: Record<string, string> = {};
  const second = await lifetime(directory, async (prompt, context) => {
    runs[context.ownerId] = prompt;
    if (context.ownerId === 'kalon') context.say('A finished after the restart.'); else context.say('B done.');
  });
  const plan = await second.restore();
  return {second, aId, bId, batchId, plan, runs};
}

for (const how of ['quit', 'crash'] as const) test(`${how}: a queued dependent returns paused and the interrupted blocker is resumable; B waits for the new A and gets its report`, {timeout: 20000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-test-restart-'));
  try {
    const {second, aId, bId, batchId, plan, runs} = await interruptedChain(root, how);
    try {
      assert.deepEqual(plan.restore.map(task => task.activityId), [bId], 'only the Director dispatch that never started is restored');
      assert.deepEqual(plan.cancel.map(task => task.activityId), how === 'crash' ? [aId] : [], 'a crash leaves the running task to be marked interrupted; a quit already stopped it');
      const b = second.store.activities.list().find(item => item.activityId === bId)!;
      assert.equal(b.status, 'paused'); assert.equal(b.stage, 'Waiting for further instructions'); assert.deepEqual(b.after, [aId]);
      assert.equal(second.store.getSnapshot().messages.filter(message => message.activityId === bId).length, 1, 'one prompt row and one activity, no duplicates');
      assert.equal(second.store.activities.list().filter(item => item.activityId === bId).length, 1);
      const saved = await waitFor(() => second.journal.activeTasks('s'), tasks => tasks.find(task => task.activityId === bId)?.status === 'paused', {label: 'B checkpoint paused'});
      assert.equal(saved.find(task => task.activityId === aId)?.status, 'cancelled');
      assert.equal(second.ensemble.isBusy(), false, 'a restored batch is not work in progress');
      const hint = second.services.resumeDirector('next-human-input');
      assert.ok(hint.includes(batchId) && hint.includes(aId), hint);
      await second.drive(async (context, services) => {
        const result = await services.execute(call([{ownerId: 'kalon', resumeTask: aId, prompt: 'Continue A'}], batchId), context);
        assert.equal(result.isError, false, result.text);
      });
      await waitForSnapshot(second.store, snapshot => snapshot.activities.some(item => item.activityId === bId && item.status === 'completed'));
      assert.match(runs.kalon!, /^\[Resuming interrupted Actor task\]/);
      assert.match(runs.techne!, /^Reports from the work this task was waiting for:[\s\S]*A finished after the restart\.[\s\S]*B work/);
      const resumed = second.store.activities.list().find(item => item.ownerId === 'kalon' && item.resumeTaskId === aId)!;
      assert.equal((await second.journal.activeTasks('s')).find(task => task.activityId === bId)?.after?.[0], resumed.activityId, 'the remapped dependency is persisted');
      assert.ok(!second.services.resumeDirector('again').includes(aId), 'a resumed blocker is no longer listed');
    } finally {await second.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test('resuming the batch without resuming the interrupted blocker cancels the dependent with the restart detail', {timeout: 20000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-test-restart-'));
  try {
    const {second, aId, bId, batchId, runs} = await interruptedChain(root, 'crash');
    try {
      await second.drive(async (context, services) => {
        const result = await services.execute({id: 'resume', name: 'Actor', arguments: JSON.stringify({resumeBatch: batchId})}, context);
        assert.equal(result.isError, false, result.text);
      });
      await waitForSnapshot(second.store, snapshot => snapshot.activities.some(item => item.activityId === bId && item.status === 'cancelled'));
      const b = second.store.activities.list().find(item => item.activityId === bId)!;
      assert.equal(b.detail, `Not started: the task it waited for (kalon, ${aId}) was interrupted by a restart.`);
      assert.equal(runs.techne, undefined, 'the dependent never ran');
    } finally {await second.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test('a user stop is never resumable, and neither is any other cancellation', {timeout: 10000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-test-restart-'));
  try {
    const l = await lifetime(root, async () => {});
    try {
      const base = {ownerId: 'kalon', prompt: 'x', source: 'logox', inputKind: 'director' as const, rootActivityId: 'old-root', time: 1};
      await l.journal.checkpoint('s', {...base, activityId: 'stopped-by-user', status: 'cancelled', stopReason: 'user'});
      await l.journal.checkpoint('s', {...base, activityId: 'stopped-by-director', status: 'cancelled', stopReason: 'director_cancel'});
      await l.journal.checkpoint('s', {...base, activityId: 'cut-by-restart', status: 'cancelled', stopReason: 'interrupted'});
      const results: string[] = [];
      await l.drive(async (context, services) => {
        await services.restoreRestart([], new Map(), ['cut-by-restart']);
        for (const resumeTask of ['stopped-by-user', 'stopped-by-director', 'cut-by-restart']) {
          const result = await services.execute(call([{ownerId: 'kalon', resumeTask, prompt: 'go'}]), context);
          results.push(result.isError ? result.text : 'dispatched');
        }
      });
      assert.match(results[0]!, /stopped by the user/); assert.match(results[1]!, /Only failed or restart-interrupted/); assert.equal(results[2], 'dispatched');
    } finally {await l.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test('only never-started Director dispatches are restored; human requests become held input; everything else is interrupted', () => {
  const base = {prompt: 'p', time: 1};
  const task = (activityId: string, status: 'queued' | 'running' | 'waiting_input' | 'paused' | 'completed', inputKind: 'human' | 'director' | 'collaboration' | 'actor', extra: object = {}) =>
    ({activityId, ownerId: 'kalon', source: inputKind === 'human' ? 'direct' : 'logox', status, inputKind, ...base, ...extra});
  const plan = planRestart([task('q', 'queued', 'director', {batchId: 'b'}), task('p', 'paused', 'director', {batchId: 'b'}), task('r', 'running', 'director', {batchId: 'b'}),
    task('w', 'waiting_input', 'director', {batchId: 'b'}), task('h', 'queued', 'human'), task('hr', 'running', 'human'), task('c', 'queued', 'collaboration'),
    task('nb', 'queued', 'director'), task('done', 'completed', 'director', {batchId: 'b'}), task('gone', 'queued', 'actor')].map(item => ({...item, source: item.source})), owner => owner === 'kalon');
  assert.deepEqual(plan.restore.map(item => item.activityId), ['q', 'p']);
  assert.deepEqual(plan.held.map(item => item.activityId), ['h']);
  assert.deepEqual(plan.cancel.map(item => item.activityId), ['r', 'w', 'h', 'hr', 'c', 'nb', 'gone']);
});

// ---- held human messages ----
const gate = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};
const done = () => ({stop: 'complete' as const, message: {role: 'assistant' as const, text: 'Completed the requested work.'}});
const label = () => ({stop: 'tools' as const, message: {role: 'assistant' as const, text: '', toolCalls: [{id: 'label', name: 'Glob', arguments: '{"pattern":"*.logox-none"}'}]}});
async function open(cwd: string, respond: Provider['respond']) {
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}, kernel: {max_retries: 0}, permissions: {mode: 'creative'}}, {}, cwd, cwd);
  return createTestApplication({cwd, config, sessionId: 's', provider: {respond}, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, 'auth.json')});
}
/** A first process that holds one message while its round runs, then quits. */
async function quitWithHeldMessage(cwd: string) {
  const started = gate();
  const app = await open(cwd, async (_request, _delta, signal) => {started.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); signal.throwIfAborted(); return done();});
  await app.submit('first goal'); await started.promise;
  await app.submit('held for later');
  const [held] = app.store.getSnapshot().pending;
  assert.equal(held?.text, 'held for later'); assert.equal(held?.restored, undefined);
  await app.close();
  return held!;
}

const ensembleRecords = (request: ModelRequest) => request.messages.filter(message => message.role === 'context' && message.kind === 'task-state' && message.data?.slot === 'ensemble');

test('after a restart with open dispatched work the Director gets one ensemble record, once; with no open work it gets none', {timeout: 40000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-test-record-'));
  try {
    // Process 1: the Director dispatches kalon (hangs) and techne (after kalon, never starts), then the process quits.
    const dispatched = JSON.stringify({tasks: [{ownerId: 'kalon', prompt: 'A work', title: 'Task A'}, {ownerId: 'techne', prompt: 'B work', title: 'Task B', after: ['kalon']}]});
    const first = await open(cwd, async (request, _delta, signal) => {
      const prompt = request.messages.find(message => message.role === 'user')?.text ?? '';
      if (prompt.includes('A work')) {await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); signal.throwIfAborted(); return done();}
      const answered = request.messages.some(message => message.role === 'tool');
      return answered ? done() : {stop: 'tools' as const, message: {role: 'assistant' as const, text: '', toolCalls: [{id: 'assign', name: 'Actor', arguments: dispatched}]}};
    });
    await first.submit('please build it');
    await waitFor(() => first.journal.activeTasks('s'), tasks => tasks.some(task => task.ownerId === 'techne' && task.status === 'queued') && tasks.some(task => task.ownerId === 'kalon' && task.status === 'running'), {label: 'A running, B queued'});
    await first.close();
    // Process 2: --resume. The next Director request carries the record once; a later one does not repeat it.
    const requests: ModelRequest[] = [];
    const second = await open(cwd, async request => {requests.push(structuredClone(request)); return done();});
    try {
      await second.submit('what is going on?'); await waitFor(() => second.ensemble.isBusy(), busy => !busy, {label: 'round ends'});
      assert.ok(requests.length > 0);
      const records = ensembleRecords(requests.at(-1)!);
      assert.equal(records.length, 1, 'one record');
      assert.match(records[0]!.text, /Task B/); assert.match(records[0]!.text, /"status":"paused"/);
      const before = requests.length;
      await second.submit('and now?'); await waitFor(() => second.ensemble.isBusy(), busy => !busy, {label: 'second round ends'});
      assert.ok(requests.length > before);
      for (const request of requests.slice(before)) assert.equal(ensembleRecords(request).length, 1, 'still the same single record, never appended again');
    } finally {await second.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a restart with no open dispatched work appends no ensemble record', {timeout: 20000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-test-norecord-'));
  try {
    await quitWithHeldMessage(cwd);
    const requests: ModelRequest[] = [];
    const app = await open(cwd, async request => {requests.push(structuredClone(request)); return done();});
    try {
      await app.submit('a fresh request'); await waitFor(() => app.ensemble.isBusy(), busy => !busy, {label: 'fresh round ends'});
      assert.ok(requests.length > 0);
      for (const request of requests) assert.equal(ensembleRecords(request).length, 0);
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a held message persists across a restart, comes back restored and is never delivered automatically', {timeout: 20000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-test-held-'));
  try {
    const held = await quitWithHeldMessage(cwd);
    const requests: ModelRequest[] = [];
    const app = await open(cwd, async request => {requests.push(request); return done();});
    try {
      const [restored] = app.store.getSnapshot().pending;
      assert.deepEqual([restored?.id, restored?.text, restored?.ownerId, restored?.windowId, restored?.restored], [held.id, 'held for later', 'logox', 'logox', true]);
      await app.submit('a fresh request'); await waitFor(() => app.ensemble.isBusy(), busy => !busy, {label: 'fresh round ends'});
      assert.equal(app.store.getSnapshot().pending.length, 1, 'an idle owner does not release a restored message');
      assert.ok(!requests.some(request => request.messages.some(message => message.text === 'held for later')));
      assert.equal(app.discardPending(restored!.id), 'held for later');
      await app.close();
      assert.deepEqual(await app.journal.loadHeld('s'), [], 'discarding is saved too');
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('Send on a restored message dispatches it when its owner is idle', {timeout: 20000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-test-held-'));
  try {
    const held = await quitWithHeldMessage(cwd);
    const requests: ModelRequest[] = [];
    const app = await open(cwd, async request => {requests.push(request); return done();});
    try {
      await app.sendPendingNow(held.id);
      assert.equal(app.store.getSnapshot().pending.length, 0);
      await waitFor(() => requests.length, count => count > 0, {label: 'request after Send'});
      assert.ok(requests[0]!.messages.some(message => message.text === 'held for later'));
      await waitFor(() => app.ensemble.isBusy(), busy => !busy);
      await app.close();
      assert.deepEqual(await app.journal.loadHeld('s'), []);
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('Send on a restored message steers it into the running round when its owner is busy', {timeout: 20000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-test-held-'));
  try {
    const held = await quitWithHeldMessage(cwd);
    const started = gate(), release = gate(); const requests: ModelRequest[] = [];
    const app = await open(cwd, async request => {
      requests.push(request);
      if (requests.length === 1) {started.resolve(); await release.promise; return label();}
      return done();
    });
    try {
      await app.submit('new work'); await started.promise;
      assert.equal(app.store.getSnapshot().pending.length, 1, 'still held while the owner runs');
      await app.sendPendingNow(held.id);
      assert.equal(app.store.getSnapshot().pending.length, 0);
      const row = app.store.getSnapshot().messages.find(message => message.text === 'held for later');
      assert.equal(row?.source, 'steered');
      release.resolve(); await waitFor(() => app.ensemble.isBusy(), busy => !busy);
      assert.ok(requests[1]!.messages.some(message => message.text.includes('held for later')), 'the same round sees it at the next boundary');
      assert.equal(app.store.activities.list().filter(item => item.ownerId === 'logox' && item.status !== 'cancelled').length, 1, 'no second round was opened');
    } finally {release.resolve(); await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a human request that was queued but never started becomes a restored held message', {timeout: 20000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-test-held-'));
  try {
    const first = await open(cwd, async () => done());
    await first.journal.checkpoint('s', {activityId: 'queued-human', ownerId: 'logox', prompt: 'typed before the crash', source: 'logox', inputKind: 'human', status: 'queued', time: Date.now()});
    await first.close();
    const app = await open(cwd, async () => done());
    try {
      const pending = app.store.getSnapshot().pending;
      assert.deepEqual(pending.map(item => [item.ownerId, item.windowId, item.text, item.restored]), [['logox', 'logox', 'typed before the crash', true]]);
      const saved = (await app.journal.activeTasks('s')).find(task => task.activityId === 'queued-human');
      assert.deepEqual([saved?.status, saved?.stopReason], ['cancelled', 'interrupted']);
      await app.close();
      assert.deepEqual((await app.journal.loadHeld('s')).map(item => item.text), ['typed before the crash']);
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a restored row says Restored and Send; hit regions come from the same layout', () => {
  const live = pendingRowLayout(60, 'hello'), restored = pendingRowLayout(60, 'hello', undefined, true);
  assert.equal(live.badge, 'Queued · '); assert.equal(live.send?.text, 'Send now');
  assert.equal(restored.badge, 'Restored · '); assert.equal(restored.send?.text, 'Send');
  assert.equal(restored.send!.x1 - restored.send!.x0, 4);
  assert.ok(restored.discard!.x0 > restored.send!.x1 - 1);
});
