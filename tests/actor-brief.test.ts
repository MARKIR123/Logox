import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext} from '../src/actors/ensemble.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {waitForSnapshot} from './runtime-fixture.js';
import {actorSchema} from '../src/tools/orchestration/ActorTool/ActorTool.js';
import {ACTOR_DESCRIPTION} from '../src/tools/orchestration/ActorTool/prompt.js';
import {renderBrief, BRIEF_LABELS} from '../src/tools/orchestration/ActorTool/brief.js';

function gate() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
const call = (tasks: unknown[]) => ({id: 'assign', name: 'Actor', arguments: JSON.stringify({tasks})});
const parse = (task: Record<string, unknown>) => actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'Build', ...task}]});

async function fixture(execute: (prompt: string, context: ActorContext, services: ActorServices) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-brief-'));
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
  return {ensemble, services, store, async close() {await ensemble.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}};
}
test('Actor schema accepts the structured brief fields and rejects malformed ones', () => {
  const ok = parse({deliverables: ['art.svg'], owns: ['src/**'], interfaces: 'ids: #wheel, #crank; size 800x600', acceptance: ['renders'], verified: ['unit tests'], after: ['kalon']});
  assert.ok(ok.success);
  assert.ok(parse({}).success, 'every brief field is optional');
  for (const bad of [{deliverables: 'art.svg'}, {owns: ['']}, {interfaces: ''}, {acceptance: [1]}, {verified: 'x'}, {after: 'kalon'}, {after: ['']}, {after: Array(9).fill('a')}, {unknown: 1}]) {
    assert.ok(!parse(bad).success, JSON.stringify(bad));
  }
  assert.match(ACTOR_DESCRIPTION, /`after`/);
});

test('renderBrief renders a compact labelled block and nothing for a bare task', () => {
  assert.equal(renderBrief({}), '');
  const block = renderBrief({deliverables: ['logo.svg'], owns: ['assets/**'], files: ['assets/**', 'a.css'], interfaces: 'ids: #a', acceptance: ['opens in browser'], verified: ['lint']});
  assert.ok(block.startsWith('Brief\n'));
  for (const label of Object.values(BRIEF_LABELS)) assert.ok(block.includes(label + ':'), label);
  assert.equal(block.match(/assets\/\*\*/g)?.length, 1, 'owns and legacy files merge without duplicates');
  assert.match(block, /- a\.css/);
});

test('the brief is appended to the assignment and owns feeds the ownership notes', {timeout: 8000}, async () => {
  const prompts: string[] = [];
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') await services.execute(call([{ownerId: 'techne', prompt: 'Build the page', owns: ['index.html'], acceptance: ['loads without console errors']}]), context);
    else {prompts.push(prompt); context.say('done');}
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'completed'));
    assert.match(prompts[0]!, /^Build the page\n\nBrief\n/);
    assert.match(prompts[0]!, /Acceptance:\n- loads without console errors/);
    assert.deepEqual(f.store.activities.list().find(activity => activity.ownerId === 'techne')?.ownedFiles, ['index.html']);
  } finally {await f.close();}
});

test('after holds the dependent task as waiting and releases it with the dependency report', {timeout: 8000}, async () => {
  const kalonRelease = gate();
  const prompts: Record<string, string> = {};
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') await services.execute(call([
      {ownerId: 'techne', prompt: 'Wire the animation', after: ['kalon'], interfaces: 'ids: #wheel'},
      {ownerId: 'kalon', prompt: 'Draw the wheel'}]), context);
    else {
      prompts[context.ownerId] = prompt;
      if (context.ownerId === 'kalon') {await kalonRelease.promise; context.say('Wheel drawn with ids #wheel and #crank.');} else context.say('Wired.');
    }
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'kalon' && activity.status === 'running'));
    const waiting = f.store.activities.list().find(activity => activity.ownerId === 'techne')!;
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.stage, 'Waiting on Kalon');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(prompts.techne, undefined, 'dependent task must not start before its dependency completes');
    kalonRelease.resolve();
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'completed'));
    assert.match(prompts.techne!, /^Reports from the work this task was waiting for:/);
    assert.match(prompts.techne!, /Wheel drawn with ids #wheel and #crank\./);
    assert.match(prompts.techne!, /Wire the animation[\s\S]*Interfaces \(shared contract\):\nids: #wheel/);
  } finally {kalonRelease.resolve(); await f.close();}
});

test('a task whose dependency fails never starts: the failed batch pauses it and a resume cancels it', {timeout: 8000}, async () => {
  const ran: string[] = [];
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') await services.execute(call([{ownerId: 'kalon', prompt: 'Draw'}, {ownerId: 'techne', prompt: 'Wire', after: ['kalon']}]), context);
    else {ran.push(context.ownerId); if (context.ownerId === 'kalon') throw new Error('boom');}
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'paused'));
    assert.ok(!ran.includes('techne'));
    f.ensemble.resumeBatch(f.store.activities.list().find(activity => activity.ownerId === 'techne')!.batchId!);
    await waitForSnapshot(f.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'techne' && activity.status === 'cancelled'));
    assert.ok(!ran.includes('techne'));
  } finally {await f.close();}
});

test('after rejects unknown references, self references and cycles', {timeout: 8000}, async () => {
  const f = await fixture(async () => {});
  try {
    const ctx = {sessionId: 's', ownerId: 'logox', activityId: 'root', history: [], signal: new AbortController().signal, report() {}, say() {}, async record() {},
      async ask() {return {status: 'cancelled' as const, reason: 'test'};}, async permission() {return true;}} as unknown as ActorContext;
    const run = (tasks: unknown[]) => f.services.execute(call(tasks), ctx);
    assert.equal((await run([{ownerId: 'techne', prompt: 'x', after: ['nobody']}])).isError, true);
    assert.equal((await run([{ownerId: 'techne', prompt: 'x', after: ['techne']}])).isError, true);
    const cycle = await run([{ownerId: 'techne', prompt: 'x', after: ['kalon']}, {ownerId: 'kalon', prompt: 'y', after: ['techne']}]);
    assert.equal(cycle.isError, true); assert.match(cycle.text, /Circular/);
    assert.equal(f.store.activities.list().length, 0);
  } finally {await f.close();}
});
