import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext, type TaskResult} from '../src/actors/ensemble.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {waitForSnapshot} from './runtime-fixture.js';
import {createAgent} from '../src/kernel/agent.js';
import {Tools} from '../src/tools/tools.js';

function gate() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
const dispatch = (owners: string[]) => ({id: 'assign', name: 'Actor', arguments: JSON.stringify({tasks: owners.map(ownerId => ({ownerId, prompt: 'child work'}))})});
async function fixture(execute: (prompt: string, context: ActorContext, services: ActorServices) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-coordination-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore(), deliveries = new DeliveryQueue('s', journal);
  let services!: ActorServices;
  const ensemble = new DynamicEnsemble('s', store, journal, async (prompt, context) => {
    services.definition(context); await execute(prompt, context, services);
  }, {concurrency: 'actor', deliveries, member: owner => catalog.find(owner), handoff: result => services.handoff(result),
    settled: (activity, status) => services.settled(activity, status)});
  services = new ActorServices({sessionId: 's', catalog, config, journal, deliveries, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), getSnapshot: () => store.getSnapshot(),
    getActiveTask: owner => ensemble.getActiveTask(owner), canReceiveMessage: owner => ensemble.canReceiveMessage(owner),
    requireIdle() {}, approve: async () => false, enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    pauseBatch: id => ensemble.pauseBatch(id), resumeBatch: id => ensemble.resumeBatch(id), coordinationPath: join(directory, 'coordination.json')});
  await services.recover();
  return {ensemble, services, deliveries, journal, store, async close() {await ensemble.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}};
}
async function allIdle(ensemble: DynamicEnsemble) {
  const end = Date.now() + 5000;
  while (ensemble.isBusy()) {if (Date.now() > end) throw new Error('Coordination did not settle'); await new Promise(resolve => setTimeout(resolve, 5));}
}

test('formal child delivery reaches a busy Director boundary without a redundant Director activity', {timeout: 8000}, async () => {
  const assigned = gate(), childRelease = gate(), parentRelease = gate();
  let director!: ActorContext;
  const report = 'Complete untruncated report. ' + 'evidence '.repeat(1000);
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') {director = context; await services.execute(dispatch(['techne']), context); assigned.resolve(); await parentRelease.promise; context.say('Director completed.');}
    else if (context.ownerId === 'techne') {await childRelease.promise; context.say(report);}
    else {await context.drainInbox?.(); context.say('Unexpected duplicate coordination.');}
  });
  try {
    const parent = f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'});
    await assigned.promise; childRelease.resolve();
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'completed'));
    assert.equal(f.store.activities.list().filter(activity => activity.ownerId === 'logox').length, 1);
    const incoming = await director.drainInbox?.();
    assert.equal(incoming?.length, 1); assert.ok(incoming?.[0]?.text.includes(report));
    assert.match(incoming![0]!.text, /not new human authorization/);
    assert.equal(director.signal.aborted, false);
    parentRelease.resolve(); await parent.done; await allIdle(f.ensemble);
  } finally {childRelease.resolve(); parentRelease.resolve(); await f.close();}
});

test('a completed batch member reports promptly without waiting for its unfinished sibling', {timeout: 8000}, async () => {
  const assigned = gate(), firstRelease = gate(), secondRelease = gate(), parentRelease = gate(); let director!: ActorContext;
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') {director = context; await services.execute(dispatch(['techne', 'kalon']), context); assigned.resolve(); await parentRelease.promise; context.say('Done.');}
    else if (context.ownerId === 'techne') {await firstRelease.promise; context.say('First child full report.');}
    else if (context.ownerId === 'kalon') {await secondRelease.promise; context.say('Second child full report.');}
    else {await context.drainInbox?.(); context.say('Coordinated.');}
  });
  try {
    const parent = f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'});
    await assigned.promise; firstRelease.resolve();
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'completed'));
    const first = await director.drainInbox?.(); assert.ok(first?.[0]?.text.includes('First child full report.'));
    assert.equal(f.store.activities.list().find(activity => activity.ownerId === 'kalon')?.status, 'running');
    secondRelease.resolve();
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'kalon' && activity.status === 'completed'));
    const second = await director.drainInbox?.();
    assert.ok(second?.[0]?.text.includes('Second child full report.'));
    assert.ok(second?.every(message => !message.text.includes('First child full report.')));
    parentRelease.resolve(); await parent.done; await allIdle(f.ensemble);
  } finally {firstRelease.resolve(); secondRelease.resolve(); parentRelease.resolve(); await f.close();}
});

test('idle Director wakes once for available reports and a repeated terminal handoff is deduplicated', {timeout: 8000}, async () => {
  const childRelease = gate(), wakeStarted = gate(), wakeRelease = gate(); let directorRuns = 0;
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId !== 'logox') {await childRelease.promise; context.say('Saved report.'); return;}
    directorRuns++;
    if (prompt === 'start') await services.execute(dispatch(['techne']), context);
    else {wakeStarted.resolve(); await wakeRelease.promise; await context.drainInbox?.();}
    context.say('Director result.');
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    childRelease.resolve(); await wakeStarted.promise;
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'completed'));
    const child = f.store.activities.list().find(activity => activity.ownerId === 'techne')!;
    await f.services.handoff({sessionId: 's', ownerId: 'techne', activityId: child.activityId, source: 'logox', rootActivityId: child.rootActivityId,
      inputKind: 'director', status: 'completed', summary: {title: 'Saved report.', report: 'Saved report.', source: 'local'}} as TaskResult);
    wakeRelease.resolve(); await allIdle(f.ensemble);
    assert.equal(directorRuns, 2);
    assert.equal(f.deliveries.snapshot().filter(item => item.kind === 'report').length, 1);
  } finally {childRelease.resolve(); wakeRelease.resolve(); await f.close();}
});

test('late child results cannot undo explicit human stop and remain pending for new human work', {timeout: 8000}, async () => {
  const assigned = gate(), release = gate(); let directorRuns = 0;
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'logox') {directorRuns++; await services.execute(dispatch(['techne']), context); assigned.resolve(); await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), {once: true}));}
    else {await release.promise; context.say('Late full report.');}
  });
  try {
    const parent = f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}); await assigned.promise;
    f.services.stopDirector(parent.activityId); parent.cancel(); await parent.done;
    release.resolve(); await allIdle(f.ensemble);
    assert.equal(directorRuns, 1); assert.equal(f.services.recovery.stopped(), true);
    assert.ok(f.deliveries.pending('logox').some(item => item.text.includes('Late full report.')));
  } finally {release.resolve(); await f.close();}
});

for (const stopTarget of ['active', 'queued-wake'] as const) test(`stopping ${stopTarget} invalidates a wake queued behind a sealed Director`, {timeout: 8000}, async () => {
  const sealed = gate(), release = gate(); let requests = 0;
  const f = await fixture(async (prompt, context) => {
    if (prompt === 'finishing') {await context.closeInbox?.(); sealed.resolve(); await release.promise; return;}
    const agent = createAgent({cwd: '.', store: f.store, tools: new Tools('.'), iterations: 1, retries: 0,
      requestBase: async () => ({system: 'fixture', tools: []}),
      provider: () => ({async respond() {requests++; return {message: {role: 'assistant', text: 'Unexpected wake.'}, stop: 'complete'};}})});
    await agent(prompt, context);
  });
  try {
    const parent = f.ensemble.dispatch('logox', 'finishing', 'logox', {inputKind: 'human'}); await sealed.promise;
    await f.services.handoff({ownerId: 'techne', activityId: 'finished-child', rootActivityId: parent.activityId, source: 'logox',
      inputKind: 'director', status: 'completed', summary: {title: 'Saved report', report: 'Report survives stop.', source: 'local'}});
    const wake = f.store.activities.list().find(activity => activity.ownerId === 'logox' && activity.status === 'queued')!;
    assert.ok(wake, 'A report admitted after sealing queues a successor');
    f.services.stopDirector(stopTarget === 'active' ? parent.activityId : wake.activityId);
    if (stopTarget === 'active') parent.cancel(); else f.ensemble.cancel(wake.activityId);
    release.resolve(); await parent.done; await allIdle(f.ensemble);
    assert.equal(requests, 0, 'Explicit stop prevents queued notification work from making a model request');
    assert.equal(f.services.recovery.stopped(), true);
    assert.ok(f.deliveries.pending('logox').some(item => item.text.includes('Report survives stop.')));
  } finally {release.resolve(); await f.close();}
});

test('direct Actor failure stays in the direct conversation rather than silently transferring its transcript to Director', {timeout: 8000}, async () => {
  let directorRuns = 0;
  const f = await fixture(async (_prompt, context) => {if (context.ownerId === 'techne') throw new Error('Direct private failure'); directorRuns++; context.say('Should not run.');});
  try {
    await f.ensemble.dispatch('techne', 'private task', 'direct', {inputKind: 'human'}).done; await allIdle(f.ensemble);
    assert.equal(directorRuns, 0); assert.equal(f.deliveries.pending('logox').length, 0);
    assert.equal((await f.journal.load('s', 'logox')).length, 0);
  } finally {await f.close();}
});

test('notification wake-ups retain the existing no-progress dispatch depth instead of resetting it', {timeout: 8000}, async () => {
  const decisions: boolean[] = [];
  const f = await fixture(async (_prompt, context, services) => {
    if (context.ownerId !== 'logox') {context.say('Child observation.'); return;}
    await context.drainInbox?.();
    if (decisions.length < 5) decisions.push((await services.execute(dispatch(['techne']), context)).isError);
    context.say('Director round.');
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done; await allIdle(f.ensemble);
    assert.deepEqual(decisions, [false, false, false, true]);
  } finally {await f.close();}
});

for (const sameRoot of [false, true]) test(`exhausted recovery cannot be weakened by ${sameRoot ? 'a later sibling report' : 'an unrelated busy Director'}`, {timeout: 8000}, async () => {
  const started = gate(), release = gate(); let director!: ActorContext;
  const f = await fixture(async (_prompt, context) => {director = context; started.resolve(); await release.promise;});
  try {
    const parent = f.ensemble.dispatch('logox', 'current work', 'logox', {inputKind: 'human'}); await started.promise;
    const root = sameRoot ? parent.activityId : 'previous-root';
    await f.journal.checkpoint('s', {activityId: 'failed-child', ownerId: 'techne', rootActivityId: root,
      inputKind: 'director', source: 'logox', prompt: 'Original task', status: 'failed', time: 1});
    await f.deliveries.enqueue({id: 'exhausted', ownerId: 'logox', source: 'techne', sourceActivityId: 'failed-child', rootActivityId: root,
      kind: 'failure', inputKind: 'actor', text: 'Recovery requires a human decision.',
      origin: {rootActivityId: root, recovery: {key: 'interrupted', attempt: 2, exhausted: true}}});
    if (sameRoot) await f.deliveries.enqueue({id: 'older-sibling', ownerId: 'logox', source: 'kalon', rootActivityId: root,
      kind: 'report', inputKind: 'actor', text: 'Sibling finished under an earlier attempt.',
      origin: {rootActivityId: root, recovery: {key: 'interrupted', attempt: 1}}});
    await director.drainInbox?.();
    const inherited = director.inboundRecovery?.();
    const result = await f.services.execute({id: 'resume-exhausted', name: 'Actor', arguments: JSON.stringify({tasks: [
      {ownerId: 'techne', resumeTask: 'failed-child', prompt: 'Continue remaining work'},
    ]})}, {...director, ...(inherited ? {recovery: inherited} : {})});
    assert.equal(result.isError, true, 'Delivery of a report does not grant a new recovery attempt for its root');
    assert.equal(f.store.activities.list().filter(activity => activity.ownerId === 'techne').length, 0);
    if (sameRoot) assert.equal(inherited?.exhausted, true, 'Older reports cannot replace an exhausted failure');
    release.resolve(); await parent.done;
  } finally {release.resolve(); await f.close();}
});

test('a human continuation grant unlocks only its own exhausted root', {timeout: 8000}, async () => {
  const started = gate(), release = gate(); let director!: ActorContext;
  const f = await fixture(async (_prompt, context) => {director = context; started.resolve(); await release.promise;});
  try {
    const parent = f.ensemble.dispatch('logox', 'Explicitly continue this root', 'logox', {inputKind: 'human', grantExecution: true}); await started.promise;
    for (const root of [parent.activityId, 'unrelated-root']) {
      await f.journal.checkpoint('s', {activityId: 'failed-' + root, ownerId: 'techne', rootActivityId: root,
        inputKind: 'director', source: 'logox', prompt: 'Original task', status: 'failed', time: 1});
      await f.deliveries.enqueue({id: 'exhausted-' + root, ownerId: 'logox', source: 'techne', rootActivityId: root,
        kind: 'failure', inputKind: 'actor', text: 'Recovery exhausted.', origin: {recovery: {key: 'interrupted', attempt: 2, exhausted: true}}});
    }
    await f.services.grantExecution(director); await director.drainInbox?.();
    const request = (root: string) => ({id: 'continue-' + root, name: 'Actor', arguments: JSON.stringify({tasks: [
      {ownerId: 'techne', resumeTask: 'failed-' + root, prompt: 'Continue only remaining work'},
    ]})});
    assert.equal((await f.services.execute(request('unrelated-root'), director)).isError, true);
    const inherited = director.inboundRecovery?.();
    assert.equal((await f.services.execute(request(parent.activityId), {...director, ...(inherited ? {recovery: inherited} : {})})).isError, false);
    await f.deliveries.enqueue({id: 'new-exhaustion', ownerId: 'logox', source: 'techne', rootActivityId: parent.activityId,
      kind: 'failure', inputKind: 'actor', text: 'A new failure exhausted the fresh grant.',
      origin: {recovery: {key: 'interrupted', attempt: 2, exhausted: true}}});
    await director.drainInbox?.();
    assert.equal(director.inboundRecovery?.()?.exhausted, true, 'A grant cannot suppress future exhaustion');
    release.resolve(); await parent.done;
  } finally {release.resolve(); await f.close();}
});

for (const recoverAfterRestart of [false, true]) test(`terminal report survives queue persistence failure through ${recoverAfterRestart ? 'restart recovery' : 'settlement retry'}`, {timeout: 8000}, async () => {
  const assigned = gate(), childRelease = gate(), parentRelease = gate();
  const report = 'Full handoff evidence. ' + 'preserved output '.repeat(1000);
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') {await services.execute(dispatch(['techne']), context); assigned.resolve(); await parentRelease.promise;}
    else if (context.ownerId === 'techne') {await childRelease.promise; context.say(report);}
    else await context.drainInbox?.();
  });
  const save = f.journal.saveDeliveries.bind(f.journal); let fail = true;
  f.journal.saveDeliveries = async (session, records) => {
    if (fail && records.some(item => item.kind === 'report')) {
      if (!recoverAfterRestart) fail = false;
      throw new Error('Transient terminal queue write failure');
    }
    await save(session, records);
  };
  try {
    const parent = f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}); await assigned.promise;
    childRelease.resolve();
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'completed'));
    fail = false;
    const queue = recoverAfterRestart ? new DeliveryQueue('s', f.journal) : f.deliveries;
    if (recoverAfterRestart) {
      const restored = new ActorServices({...f.services.options, deliveries: queue}); await restored.recover(); await restored.flush();
    }
    const records = queue.snapshot().filter(item => item.kind === 'report');
    assert.equal(records.length, 1, 'A terminal handoff retains one retry identity until durable admission');
    assert.ok(records[0]!.text.includes(report), 'Recovery retains the complete formal report, not the summary fallback');
    assert.equal(f.store.activities.list().filter(activity => activity.ownerId === 'techne').length, 1, 'Recovering delivery never reruns child work');
    parentRelease.resolve(); await parent.done;
  } finally {childRelease.resolve(); parentRelease.resolve(); await f.close();}
});

test('broadcasts cannot bypass the stopped Director gate or create an untracked Director task', {timeout: 8000}, async () => {
  let directorRuns = 0;
  const f = await fixture(async (_prompt, context) => {if (context.ownerId === 'logox') directorRuns++; context.say('Received.');});
  try {
    f.services.stopDirector('stopped-director');
    const context: ActorContext = {sessionId: 's', ownerId: 'techne', activityId: 'broadcast-source', history: [],
      signal: new AbortController().signal, report() {}, say() {}, async record() {},
      async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {return false;}};
    const result = await f.services.execute({id: 'broadcast', name: 'SendMessage', arguments: JSON.stringify({to: 'all', message: 'A shared boundary needs attention.'})}, context);
    assert.equal(result.isError, false); await allIdle(f.ensemble);
    assert.equal(directorRuns, 0); assert.equal(f.services.recovery.stopped(), true);
    assert.ok(f.deliveries.pending('logox').some(item => item.text.includes('A shared boundary needs attention.')));
  } finally {await f.close();}
});

test('explicit assistance reaches a busy Director as a priority event without process interruption', {timeout: 8000}, async () => {
  const started = gate(), release = gate(); let director!: ActorContext;
  const f = await fixture(async (_prompt, context) => {director = context; started.resolve(); await release.promise; context.say('Done.');});
  try {
    const parent = f.ensemble.dispatch('logox', 'active', 'logox', {inputKind: 'human'}); await started.promise;
    const result = await f.services.execute({id: 'help-1', name: 'SendMessage', arguments: JSON.stringify({to: 'logox', message: 'Need a decision on the shared boundary.', summary: 'Boundary help'})},
      {...director, ownerId: 'techne', activityId: 'direct-child', source: 'direct'});
    assert.equal(result.isError, false);
    assert.ok(f.deliveries.pending('logox', parent.activityId).some(item => item.kind === 'help'));
    const incoming = await director.drainInbox?.(); assert.ok(incoming?.[0]?.text.includes('Need a decision on the shared boundary.'));
    assert.equal(f.store.activities.list().filter(activity => activity.ownerId === 'logox').length, 1);
    assert.equal(director.signal.aborted, false);
    release.resolve(); await parent.done;
  } finally {release.resolve(); await f.close();}
});
