import test from 'node:test';
import assert from 'node:assert/strict';
import {openWork, hasOpenWork} from '../src/actors/facts.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {deliverySchema, type Delivery} from '../src/runtime/delivery.js';
import type {Activity} from '../src/runtime/contracts.js';

function snapshotOf(entries: {id: string; owner: string; status: Activity['status']; root?: string}[]) {
  const store = new RuntimeStore();
  for (const entry of entries) store.activities.create({sessionId: 's', activityId: entry.id, ownerId: entry.owner, kind: entry.owner === 'logox' ? 'director' : 'actor',
    title: entry.id, status: entry.status, stage: '', detail: '', ...(entry.owner !== 'logox' ? {inputKind: 'director' as const} : {}), ...(entry.root ? {rootActivityId: entry.root} : {})});
  return store.getSnapshot();
}
const deferred = (id: string, root: string, over: Partial<Delivery> = {}): Delivery => deliverySchema.parse({id, sessionId: 's', ownerId: 'logox', source: 'techne',
  rootActivityId: root, kind: 'failure', inputKind: 'actor', text: 'stopped', time: 1, status: 'pending', deferredUntilHuman: true, ...over});

test('openWork counts queued, running and waiting companions of the root only', () => {
  const snapshot = snapshotOf([
    {id: 'r', owner: 'logox', status: 'running'},
    {id: 'a', owner: 'techne', status: 'queued', root: 'r'}, {id: 'b', owner: 'kalon', status: 'running', root: 'r'},
    {id: 'c', owner: 'aletheia', status: 'waiting_input', root: 'r'}, {id: 'd', owner: 'techne', status: 'paused', root: 'r'},
    {id: 'e', owner: 'techne', status: 'completed', root: 'r'}, {id: 'f', owner: 'logox', status: 'running', root: 'r'},
    {id: 'g', owner: 'techne', status: 'running', root: 'other'},
  ]);
  assert.deepEqual(openWork(snapshot, 'r').activities.map(a => a.activityId).sort(), ['a', 'b', 'c']);
  assert.deepEqual(openWork(snapshot, 'r', [], 'b').activities.map(a => a.activityId).sort(), ['a', 'c']);
});

test('openWork ignores a paused group but waits for deferred deliveries of the same root', () => {
  const snapshot = snapshotOf([{id: 'r', owner: 'logox', status: 'running'}, {id: 'd', owner: 'techne', status: 'paused', root: 'r'}]);
  assert.equal(hasOpenWork(openWork(snapshot, 'r')), false);
  assert.equal(hasOpenWork(openWork(snapshot, 'r', [deferred('x', 'r')])), true);
  assert.equal(hasOpenWork(openWork(snapshot, 'r', [deferred('y', 'other')])), false);
  assert.equal(hasOpenWork(openWork(snapshot, 'r', [deferred('z', 'r', {status: 'delivered'})])), false);
});

test('openWork gives the same answer whether or not the reporting activity is already terminal', () => {
  for (const status of ['running', 'completed'] as const) {
    const snapshot = snapshotOf([{id: 'r', owner: 'logox', status: 'running'}, {id: 'a', owner: 'techne', status, root: 'r'}]);
    assert.equal(hasOpenWork(openWork(snapshot, 'r', [], 'a')), false);
  }
});

import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {Journal} from '../src/store/journal.js';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const input = (id: string, kind: Delivery['kind'], over: Record<string, unknown> = {}) => ({id, ownerId: 'logox', source: 'techne', rootActivityId: 'r', kind, inputKind: 'actor' as const, text: id, ...over});
async function queue() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-batching-'));
  const journal = new Journal(join(directory, 'journal'));
  return {queue: new DeliveryQueue('s', journal), journal, async close() {await rm(directory, {recursive: true, force: true});}};
}

test('a delivery record without hold still parses', () => {
  assert.equal(deliverySchema.parse({id: 'x', sessionId: 's', ownerId: 'logox', source: 'a', kind: 'report', inputKind: 'actor', text: 't', time: 1, status: 'pending'}).hold, undefined);
});

test('held deliveries are hidden from pending and released explicitly', async () => {
  const f = await queue();
  try {
    await f.queue.enqueue(input('report', 'report', {hold: 'root'}));
    await f.queue.enqueue(input('other', 'report', {hold: 'root', rootActivityId: 'q'}));
    assert.equal(f.queue.pending('logox').length, 0);
    assert.deepEqual(f.queue.held('logox').map(item => item.id), ['report', 'other']);
    assert.deepEqual((await f.queue.drain('logox', 'a')).messages, []);
    assert.equal(await f.queue.release('logox', item => item.rootActivityId === 'r'), true);
    assert.deepEqual(f.queue.pending('logox').map(item => item.id), ['report']);
    assert.equal(await f.queue.release('logox', item => item.rootActivityId === 'r'), false);
  } finally {await f.close();}
});

test('help, failure and human steering release every held report in the same write', async () => {
  for (const kind of ['help', 'failure', 'human_steer'] as const) {
    const f = await queue();
    try {
      await f.queue.enqueue(input('report', 'report', {hold: 'root', rootActivityId: 'elsewhere'}));
      const saves = f.journal.saveDeliveries.bind(f.journal); let writes = 0;
      f.journal.saveDeliveries = async (...args: Parameters<typeof saves>) => {writes++; return saves(...args);};
      await f.queue.enqueue(input('urgent', kind));
      assert.equal(writes, 1);
      assert.equal(f.queue.held('logox').length, 0);
      assert.deepEqual(f.queue.pending('logox').map(item => item.id).sort(), ['report', 'urgent']);
    } finally {await f.close();}
  }
});

test('a deferred failure and another report do not release held reports', async () => {
  const f = await queue();
  try {
    await f.queue.enqueue(input('report', 'report', {hold: 'root'}));
    await f.queue.enqueue(input('stopped', 'failure', {deferredUntilHuman: true}));
    await f.queue.enqueue(input('second', 'report', {hold: 'root'}));
    assert.equal(f.queue.held('logox').length, 2);
  } finally {await f.close();}
});

import {directorFacts} from '../src/actors/facts.js';

test('facts carry one progress line while reports are held and keep their shape otherwise', () => {
  const snapshot = snapshotOf([{id: 'r', owner: 'logox', status: 'running'},
    {id: 'a', owner: 'techne', status: 'completed', root: 'r'}, {id: 'b', owner: 'kalon', status: 'completed', root: 'r'}, {id: 'c', owner: 'aletheia', status: 'running', root: 'r'}]);
  const report = (id: string, source: string, hold?: 'root') => deliverySchema.parse({id, sessionId: 's', ownerId: 'logox', source, sourceActivityId: id === 'x' ? 'a' : 'b', rootActivityId: 'r',
    kind: 'report', inputKind: 'actor', text: 'done', time: 1, status: 'pending', ...(hold ? {hold} : {})});
  const held = [report('x', 'techne', 'root'), report('y', 'kalon', 'root')];
  assert.equal(directorFacts(snapshot, {ownerId: 'logox', activityId: 'r'}, held)?.progress, 'Reported 2/3; still running: Aletheia');
  assert.equal('progress' in directorFacts(snapshot, {ownerId: 'logox', activityId: 'r'}, [report('x', 'techne')])!, false);
  assert.equal('progress' in directorFacts(snapshot, {ownerId: 'logox', activityId: 'r'})!, false);
});
