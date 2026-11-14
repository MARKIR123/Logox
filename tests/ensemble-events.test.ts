import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext, type TaskHandle} from '../src/actors/ensemble.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {waitForSnapshot} from './runtime-fixture.js';

// Coordination is event driven: the Actor receipt, the teammates block of an assignment and the outstanding-work line of an early wake.

function gate() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
const dispatch = (tasks: object[]) => ({id: 'assign', name: 'Actor', arguments: JSON.stringify({tasks})});
async function fixture(execute: (prompt: string, context: ActorContext, services: ActorServices) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-events-'));
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

test('the Actor result is a receipt: one line per task with activity id, owner, title, owns and after', {timeout: 10000}, async () => {
  const release = gate(); let receipt = '';
  const f = await fixture(async (_prompt, context, services) => {
    if (context.ownerId === 'logox') {
      receipt = (await services.execute(dispatch([
        {ownerId: 'techne', title: 'Build the parser', prompt: 'Build it.', owns: ['src/parser.ts', 'src/lexer.ts']},
        {ownerId: 'kalon', title: 'Style the panel', prompt: 'Style it.', after: ['techne']},
        {ownerId: 'aletheia', prompt: 'Review it.\nSecond line.'}]), context)).text;
      return;
    }
    await release.promise; context.say('done');
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    const id = (owner: string) => f.store.activities.list().find(activity => activity.ownerId === owner)!.activityId;
    const lines = receipt.split('\n');
    assert.match(lines[0]!, /^Dispatched to techne, kalon, aletheia \(Batch [^)]+\):$/);
    assert.ok(lines.includes('- ' + id('techne') + ' techne: Build the parser | owns: src/parser.ts, src/lexer.ts'), receipt);
    assert.ok(lines.includes('- ' + id('kalon') + ' kalon: Style the panel | after: ' + id('techne')), receipt);
    assert.ok(lines.includes('- ' + id('aletheia') + ' aletheia: Review it.'), receipt);
    assert.match(receipt, /They work in the background/);
  } finally {release.resolve(); await f.close();}
});

test('a companion assignment ends with the teammates of the same batch, never itself, and none means no block', {timeout: 10000}, async () => {
  const release = gate(); const prompts = new Map<string, string>(); let second = '';
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'logox') {
      await services.execute(dispatch([{ownerId: 'techne', title: 'Build the parser', prompt: 'Build it.', owns: ['src/parser.ts']},
        {ownerId: 'kalon', title: 'Style the panel', prompt: 'Style it.'}]), context);
      // Later on the same root: aletheia joins while techne and kalon are still working.
      await new Promise(resolve => setTimeout(resolve, 100));
      second = (await services.execute(dispatch([{ownerId: 'aletheia', title: 'Review it', prompt: 'Review.'}]), context)).text;
      return;
    }
    prompts.set(context.ownerId, prompt); await release.promise; context.say('done');
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    await waitForSnapshot(f.store, snapshot => ['techne', 'kalon', 'aletheia'].every(owner => snapshot.activities.some(activity => activity.ownerId === owner && activity.status === 'running')));
    for (let waited = 0; prompts.size < 3 && waited < 200; waited++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(second.startsWith('Dispatched to aletheia'), true);
    const techne = prompts.get('techne')!, kalon = prompts.get('kalon')!, aletheia = prompts.get('aletheia')!;
    assert.match(techne, /\[Teammates on this task right now; ones dispatched later are not announced\]\n- kalon: Style the panel\nUse ListActors for the current state\.$/);
    assert.ok(!techne.includes('- techne:'), 'excludes itself');
    assert.match(kalon, /\n- techne: Build the parser \| owns: src\/parser\.ts\nUse ListActors for the current state\.$/);
    assert.match(aletheia, /\n- techne: Build the parser \| owns: src\/parser\.ts\n- kalon: Style the panel\nUse ListActors/, 'active teammates on the same root: ' + JSON.stringify(aletheia));
    assert.ok(!techne.includes('aletheia'), 'a teammate dispatched later is not announced to the earlier ones');
  } finally {release.resolve(); await f.close();}
});

test('a lone companion gets no teammates block', {timeout: 10000}, async () => {
  const prompts = new Map<string, string>();
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'logox') {await services.execute(dispatch([{ownerId: 'techne', title: 'Alone', prompt: 'Do it.'}]), context); return;}
    prompts.set(context.ownerId, prompt); context.say('done');
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'completed'));
    assert.equal(prompts.get('techne'), 'Do it.');
  } finally {await f.close();}
});

test('an early Director wake still says which reports are outstanding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-wake-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore(), deliveries = new DeliveryQueue('s', journal);
  const wakes: string[] = [];
  const services = new ActorServices({sessionId: 's', catalog, config, journal, deliveries, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), getSnapshot: () => store.getSnapshot(), requireIdle() {}, approve: async () => false,
    enqueue: (_owner, prompt) => {wakes.push(prompt); return {activityId: 'wake-' + wakes.length, done: new Promise<void>(() => {}), cancel() {}} satisfies TaskHandle;}});
  try {
    const activity = (id: string, owner: string, status: 'running' | 'completed') => store.activities.create({sessionId: 's', activityId: id, ownerId: owner, kind: 'actor', title: id,
      status, stage: 'x', detail: '', inputKind: 'director', rootActivityId: 'rootA', parentActivityId: 'rootA'});
    activity('a1', 'techne', 'completed'); activity('a2', 'kalon', 'running');
    await deliveries.enqueue({ownerId: 'logox', source: 'techne', sourceActivityId: 'a1', rootActivityId: 'rootA', kind: 'report', inputKind: 'actor', text: 'techne done', hold: 'root'});
    await deliveries.enqueue({ownerId: 'logox', source: 'aletheia', sourceActivityId: 'b1', rootActivityId: 'rootB', kind: 'report', inputKind: 'actor', text: 'aletheia done'});
    Reflect.apply(Reflect.get(services, 'wakeDirector') as () => void, services, []);
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!, /Process the coordination events below/);
    assert.match(wakes[0]!, /\nReported 1\/2; still running: Kalon$/);
    assert.equal(deliveries.held('logox').length, 1, 'the held report stays held');
  } finally {services.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}
});

test('a wake with nothing held carries no outstanding line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-wake-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore(), deliveries = new DeliveryQueue('s', journal);
  const wakes: string[] = [];
  const services = new ActorServices({sessionId: 's', catalog, config, journal, deliveries, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), getSnapshot: () => store.getSnapshot(), requireIdle() {}, approve: async () => false,
    enqueue: (_owner, prompt) => {wakes.push(prompt); return {activityId: 'wake', done: new Promise<void>(() => {}), cancel() {}};}});
  try {
    await deliveries.enqueue({ownerId: 'logox', source: 'aletheia', sourceActivityId: 'b1', rootActivityId: 'rootB', kind: 'report', inputKind: 'actor', text: 'aletheia done'});
    Reflect.apply(Reflect.get(services, 'wakeDirector') as () => void, services, []);
    assert.equal(wakes.length, 1);
    assert.doesNotMatch(wakes[0]!, /Reported \d/);
  } finally {services.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}
});
