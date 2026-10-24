import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeStore} from '../src/runtime/store.js';
import {executeListActors} from '../src/tools/ListActorsTool/ListActorsTool.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import type {ActorContext} from '../src/actors/ensemble.js';

function activity(store: RuntimeStore, id: string, owner: string, status: 'running' | 'waiting_input' | 'queued' | 'paused' | 'completed', formal = true) {
  store.activities.create({sessionId: 's', activityId: id, ownerId: owner, kind: owner === 'logox' ? 'director' : 'actor',
    title: id, status, stage: 'Current operation', detail: 'Private task instructions',
    inputKind: formal ? 'director' : 'human', rootActivityId: formal ? 'root' : 'direct-root', ...(formal ? {parentActivityId: 'root'} : {})});
}
function context(activityId = 'root', ownerId = 'logox'): ActorContext {
  return {sessionId: 's', activityId, ownerId, rootActivityId: activityId, history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {return false;}};
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-facts-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const store = new RuntimeStore();
  const services = new ActorServices({sessionId: 's', catalog, config, journal: new Journal(join(directory, 'journal')),
    registry: new ProviderRegistry(config, {}), resources: new Resources(directory, {home: directory, boundary: directory}),
    requireIdle() {}, approve: async () => false, enqueue() {throw new Error('Facts must not schedule work');}, getSnapshot: () => store.getSnapshot()});
  const facts = (ctx = context()): string => {
    const project = Reflect.get(services, 'facts');
    assert.equal(typeof project, 'function', 'ActorServices must expose the same resident facts used in requests');
    return Reflect.apply(project, services, [ctx]) as string;
  };
  return {store, services, facts, async close() {await services.flush(); await rm(directory, {recursive: true, force: true});}};
}

test('ListActors discovers dynamic roles and reports waiting, queued and paused work as non-idle', () => {
  const store = new RuntimeStore();
  activity(store, 'waiting', 'scout', 'waiting_input'); activity(store, 'queued', 'techne', 'queued'); activity(store, 'paused', 'kalon', 'paused');
  const data = JSON.parse(executeListActors({}, {caller: 'logox', getSnapshot: () => store.getSnapshot(), roles: {scout: {name: 'Scout'}}}).text);
  assert.equal(data.actors.find((item: {id: string}) => item.id === 'scout')?.activityStatus, 'waiting_input');
  assert.equal(data.actors.find((item: {id: string}) => item.id === 'techne')?.activityStatus, 'queued');
  assert.equal(data.actors.find((item: {id: string}) => item.id === 'kalon')?.activityStatus, 'paused');
  assert.ok(data.actors.every((item: {status: string}) => item.status !== 'idle'));
});

test('ListActors includes recent completed tool outcomes while peer detail remains sanitized', () => {
  const store = new RuntimeStore(); activity(store, 'child', 'techne', 'running');
  store.message('s', 'techne', 'assistant', 'Private output', {activityId: 'child', kind: 'tool',
    step: {title: 'Read', callId: 'read-1', state: 'completed', elapsedMs: 3}});
  const director = JSON.parse(executeListActors({}, {caller: 'logox', getSnapshot: () => store.getSnapshot()}).text).actors.find((item: {id: string}) => item.id === 'techne');
  assert.equal(director.recentTools?.[0]?.callId, 'read-1');
  assert.equal(director.recentTools?.[0]?.state, 'completed');
  assert.ok(!JSON.stringify(director).includes('Private output'));
  const peer = JSON.parse(executeListActors({}, {caller: 'kalon', getSnapshot: () => store.getSnapshot()}).text).actors.find((item: {id: string}) => item.id === 'techne');
  assert.equal(peer.recentTools, undefined); assert.equal(peer.activityId, undefined);
});

test('ListActors retains terminal tool evidence without presenting a completed task as executing', () => {
  const store = new RuntimeStore(); activity(store, 'finished', 'techne', 'completed');
  store.message('s', 'techne', 'assistant', 'Recorded result', {activityId: 'finished', kind: 'tool',
    step: {title: 'Read', callId: 'completed-read', state: 'completed', elapsedMs: 2}});
  store.message('s', 'techne', 'assistant', 'Old incomplete step', {activityId: 'finished', kind: 'tool',
    step: {title: 'Shell', callId: 'stale-shell', state: 'running', elapsedMs: 0}});
  const actor = JSON.parse(executeListActors({}, {caller: 'logox', getSnapshot: () => store.getSnapshot()}).text).actors.find((item: {id: string}) => item.id === 'techne');
  assert.equal(actor.status, 'idle'); assert.equal(actor.activityStatus, 'completed');
  assert.equal(actor.activityId, 'finished'); assert.equal(actor.currentTool, undefined);
  assert.equal(actor.recentTools[0].callId, 'completed-read');
});

test('solo Director and direct Actor conversations produce no resident roster or empty-section notice', async () => {
  const f = await fixture();
  try {
    assert.equal(f.facts(), '');
    activity(f.store, 'direct', 'techne', 'running', false);
    assert.equal(f.facts(), '');
    activity(f.store, 'closed-old', 'kalon', 'completed');
    assert.equal(f.facts(context('new-human-root')), '');
    assert.equal(f.facts(context('root', 'techne')), '');
  } finally {await f.close();}
});

test('resident facts distinguish self-reported labels and tool completion from task acceptance', async () => {
  const f = await fixture();
  try {
    activity(f.store, 'child', 'techne', 'running');
    f.store.activities.update('s', 'child', {progress: {label: 'Tests passed according to Actor'}});
    for (let index = 0; index < 6; index++) f.store.message('s', 'techne', 'assistant', 'Large private result body', {activityId: 'child', kind: 'tool',
      step: {title: 'Read', callId: 'read-' + index, state: 'completed', elapsedMs: index}});
    const text = f.facts();
    const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
    const child = data.tasks.find((item: {activityId: string}) => item.activityId === 'child');
    assert.equal(child.status, 'running'); assert.equal(child.rootActivityId, 'root');
    assert.equal(child.selfReportedLabel, 'Tests passed according to Actor');
    assert.deepEqual(child.recentTools.map((item: {callId: string}) => item.callId), ['read-3', 'read-4', 'read-5']);
    assert.equal(child.accepted, undefined); assert.equal(child.verified, undefined);
    assert.equal(child.evidenceSource, 'runtime');
    assert.ok(!text.includes('Large private result body')); assert.ok(!text.includes('Private task instructions'));
    assert.equal(typeof data.observedAt, 'number');
    f.store.activities.update('s', 'child', {status: 'completed'});
    const terminal = f.facts();
    assert.ok(!terminal.includes('Tests passed according to Actor'));
  } finally {await f.close();}
});

test('resident facts bound large ensembles without hiding the count of additional relevant work', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 12; index++) activity(f.store, 'child-' + index, 'dynamic-' + index, 'queued');
    const text = f.facts(); const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
    assert.equal(data.tasks.length, 8); assert.equal(data.additionalTasks, 4);
    assert.equal(data.tasks[0].status, 'queued');
  } finally {await f.close();}
});
