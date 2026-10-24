import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-delivery-'));
  const journal = new Journal(directory), store = new RuntimeStore();
  const started = gate(), release = gate();
  let current!: ActorContext;
  const seen: string[] = [];
  const ensemble = new DynamicEnsemble('s', store, journal, async (prompt, context) => {
    seen.push(prompt);
    if (prompt === 'active') {current = context; started.resolve(); await release.promise;}
    context.say('Done.');
  }, {member: owner => ({name: owner, title: 'Actor'})});
  const task = ensemble.dispatch('logox', 'active', 'logox', {inputKind: 'human'});
  await started.promise;
  return {journal, store, ensemble, task, current, seen, release, async close() {
    release.resolve(); await ensemble.close(); await rm(directory, {recursive: true, force: true});
  }};
}
function inject(ensemble: DynamicEnsemble, text: string, options: {activityId?: string; inputKind?: 'human'; kind?: 'human_steer'}) {
  return Reflect.apply(ensemble.injectTaskMessage, ensemble, ['logox', text, 'direct', undefined, 'queue', options]) as Promise<boolean>;
}

test('later human work stays out of the active journal and executes only after the current activity', async () => {
  const f = await fixture();
  try {
    const later = f.ensemble.dispatch('logox', 'later human task', 'logox', {inputKind: 'human'});
    assert.equal(f.store.activities.get('s', later.activityId)?.status, 'queued');
    assert.deepEqual(await f.current.drainInbox?.(), []);
    assert.ok(!(await f.journal.load('s', 'logox')).some(entry => entry.text === 'later human task'));
    assert.deepEqual(f.seen, ['active']);
    f.release.resolve(); await Promise.all([f.task.done, later.done]);
    assert.deepEqual(f.seen, ['active', 'later human task']);
  } finally {await f.close();}
});

test('equally urgent activities preserve FIFO instead of reversing queue order', async () => {
  const f = await fixture();
  try {
    const older = f.ensemble.dispatch('logox', 'older urgent', 'techne', {priority: true});
    const newer = f.ensemble.dispatch('logox', 'newer urgent', 'kalon', {priority: true});
    f.release.resolve(); await Promise.all([f.task.done, older.done, newer.done]);
    assert.deepEqual(f.seen, ['active', 'older urgent', 'newer urgent']);
  } finally {await f.close();}
});

test('queued human work precedes background coordination without being inserted into the active task', async () => {
  const f = await fixture();
  try {
    const event = f.ensemble.dispatch('logox', 'older notification', 'techne', {inputKind: 'actor', coordinationWake: true, priority: true});
    const human = f.ensemble.dispatch('logox', 'new human work', 'logox', {inputKind: 'human'});
    assert.deepEqual(await f.current.drainInbox?.(), []);
    f.release.resolve(); await Promise.all([f.task.done, event.done, human.done]);
    assert.deepEqual(f.seen, ['active', 'new human work', 'older notification']);
  } finally {await f.close();}
});

test('explicit steering rejects a stale activity instead of targeting the latest running activity', async () => {
  const f = await fixture();
  try {
    assert.equal(await inject(f.ensemble, 'do not retarget', {activityId: 'closed-activity', inputKind: 'human', kind: 'human_steer'}), false);
    assert.deepEqual(await f.current.drainInbox?.(), []);
    assert.equal(f.current.signal.aborted, false);
  } finally {await f.close();}
});

test('human steering is persisted outside model history until boundary consumption and retains human provenance', async () => {
  const f = await fixture();
  try {
    assert.equal(await inject(f.ensemble, 'correct the current path', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'}), true);
    assert.ok(!(await f.journal.load('s', 'logox')).some(entry => entry.text.includes('correct the current path')));
    assert.equal(f.current.signal.aborted, false);
    const messages = await f.current.drainInbox?.();
    assert.equal(messages?.length, 1);
    assert.equal(messages?.[0]?.text, 'correct the current path');
    const entry = (await f.journal.load('s', 'logox')).find(entry => entry.text === 'correct the current path');
    assert.equal(entry?.inputKind, 'human');
    assert.ok(f.current.authorization?.includes('correct the current path'));
    assert.deepEqual(await f.current.drainInbox?.(), []);
  } finally {await f.close();}
});

test('human steering precedes collaboration while equal-priority messages remain FIFO', async () => {
  const f = await fixture();
  try {
    await f.ensemble.injectTaskMessage('logox', 'peer first', 'techne');
    await f.ensemble.injectTaskMessage('logox', 'peer second', 'kalon');
    await inject(f.ensemble, 'human correction', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'});
    const messages = await f.current.drainInbox?.();
    assert.equal(messages?.[0]?.text, 'human correction');
    assert.ok(messages?.slice(1).map(message => message.text).join('\n').indexOf('peer first')! <
      messages?.slice(1).map(message => message.text).join('\n').indexOf('peer second')!);
    const history = await f.journal.load('s', 'logox');
    const humanIndex = history.findIndex(entry => entry.text === 'human correction');
    assert.ok(humanIndex > 0);
    assert.ok(history.slice(humanIndex + 1).some(entry => entry.text.includes('peer first')));
  } finally {await f.close();}
});

test('waiting-input activities accept bound steering without answering or cancelling the pending interaction', async () => {
  const f = await fixture();
  try {
    const waiting = f.current.ask({kind: 'question', title: 'Choose a path', questions: [{id: 'q', header: 'Path', question: 'Which path?'}]});
    assert.equal(f.store.activities.get('s', f.task.activityId)?.status, 'waiting_input');
    assert.equal(await inject(f.ensemble, 'retain the question and note this constraint', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'}), true);
    assert.equal(f.store.interactions.list()[0]?.status, 'pending');
    assert.equal(f.current.signal.aborted, false);
    f.store.interactions.cancel(f.store.interactions.list()[0]!.requestId, 'Test cleanup'); await waiting;
    assert.equal((await f.current.drainInbox?.())?.length, 1);
  } finally {await f.close();}
});

test('failed durable admission does not publish a message or change the active task', async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.journal, 'saveDeliveries', {value: async () => {throw new Error('disk unavailable');}});
    await assert.rejects(inject(f.ensemble, 'must not be acknowledged', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'}), /disk unavailable/);
    assert.deepEqual(await f.current.drainInbox?.(), []);
    assert.ok(!f.store.getSnapshot().messages.some(message => message.text.includes('must not be acknowledged')));
    assert.equal(f.current.signal.aborted, false);
  } finally {await f.close();}
});

test('durable reports preserve full text, deduplicate stable IDs and do not masquerade as human authority', async () => {
  const f = await fixture();
  try {
    const queue = new DeliveryQueue('s', f.journal);
    const text = 'Full report: ' + 'verified evidence '.repeat(1000);
    const report = {id: 'report:child', ownerId: 'logox', source: 'techne', sourceActivityId: 'child', rootActivityId: 'root',
      kind: 'report' as const, inputKind: 'actor' as const, text};
    await Promise.all([queue.enqueue(report), queue.enqueue(report)]);
    assert.equal(queue.pending('logox').length, 1);
    const restored = new DeliveryQueue('s', f.journal);
    await restored.recover();
    const batch = await restored.drain('logox', f.task.activityId);
    assert.deepEqual(batch.humanInputs, []);
    assert.ok(batch.messages[0]?.text.includes(text));
    assert.match(batch.messages[0]!.text, /not new human authorization/);
    assert.deepEqual((await f.journal.load('s', 'logox')).find(entry => entry.deliveryIds?.includes('report:child'))?.deliveryIds, ['report:child']);
    assert.deepEqual(await restored.drain('logox', f.task.activityId), {messages: [], humanInputs: []});
  } finally {await f.close();}
});

test('admitted steering survives a pending write at the terminal sealing boundary', async () => {
  const f = await fixture();
  const writing = gate(), releaseWrite = gate();
  const save = f.journal.saveDeliveries.bind(f.journal);
  try {
    let first = true;
    f.journal.saveDeliveries = async (session, records) => {if (first) {first = false; writing.resolve(); await releaseWrite.promise;} await save(session, records);};
    const accepted = inject(f.ensemble, 'boundary correction', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'});
    await writing.promise;
    const closing = f.current.closeInbox!();
    assert.equal(await inject(f.ensemble, 'after sealing', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'}), false);
    releaseWrite.resolve();
    assert.equal(await accepted, true);
    assert.equal((await closing)[0]?.text, 'boundary correction');
    assert.equal(f.ensemble.canReceiveMessage('logox'), true);
  } finally {releaseWrite.resolve(); await f.close();}
});

test('failed consumption receipt can retry without appending a second copy to the same activity', async () => {
  const f = await fixture();
  try {
    await inject(f.ensemble, 'receipt correction', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'});
    const save = f.journal.saveDeliveries.bind(f.journal);
    f.journal.saveDeliveries = async () => {throw new Error('receipt unavailable');};
    await assert.rejects(async () => f.current.drainInbox!(), /receipt unavailable/);
    f.journal.saveDeliveries = save;
    await f.current.drainInbox!();
    assert.equal((await f.journal.load('s', 'logox')).filter(entry => entry.text === 'receipt correction').length, 1);
    assert.equal(f.ensemble.deliveries.pending('logox', f.task.activityId).length, 0);
  } finally {await f.close();}
});

test('restart cancels activity-bound inputs and retains unhandled coordination without replaying work', async () => {
  const f = await fixture();
  try {
    await inject(f.ensemble, 'old steering', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'});
    await f.ensemble.deliveries.enqueue({id: 'failure:child', ownerId: 'logox', source: 'techne', rootActivityId: 'root',
      sourceActivityId: 'child', kind: 'failure', inputKind: 'actor', text: 'Saved failure report.'});
    const restored = new DeliveryQueue('s', f.journal);
    await restored.recover(await f.journal.activeTasks('s'));
    assert.equal(restored.snapshot().find(item => item.kind === 'human_steer')?.status, 'cancelled');
    assert.equal(restored.pending('logox').length, 1);
    assert.deepEqual(f.seen, ['active']);
    assert.equal((await restored.drain('logox', 'new-director')).humanInputs.length, 0);
  } finally {await f.close();}
});

test('rewind excludes removed delivery ancestry while retaining unrelated pending reports', async () => {
  const f = await fixture();
  try {
    const queue = new DeliveryQueue('s', f.journal);
    await queue.enqueue({id: 'removed', ownerId: 'logox', source: 'techne', sourceActivityId: 'removed-child', rootActivityId: 'root', kind: 'report', inputKind: 'actor', text: 'Removed result.'});
    await queue.enqueue({id: 'retained', ownerId: 'logox', source: 'kalon', sourceActivityId: 'retained-child', rootActivityId: 'other-root', kind: 'report', inputKind: 'actor', text: 'Retained result.'});
    await f.journal.fork('s', ['logox', 'techne', 'kalon'], ['removed-child']);
    const restored = new DeliveryQueue('s', f.journal);
    await restored.recover();
    assert.deepEqual(restored.pending('logox').map(item => item.id), ['retained']);
  } finally {await f.close();}
});

test('intervention provenance survives boundary consumption without becoming ordinary collaboration', async () => {
  const f = await fixture();
  try {
    await f.ensemble.injectTaskMessage('logox', 'intervention note', 'techne', undefined, 'interrupt');
    await f.current.drainInbox!();
    const entry = (await f.journal.load('s', 'logox')).find(entry => entry.text.includes('intervention note'));
    assert.equal(entry?.inputKind, 'collaboration_interrupt');
  } finally {await f.close();}
});

test('sealed terminal inbox rejects steering without falling back to a later task', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.current.closeInbox?.(), []);
    assert.equal(await inject(f.ensemble, 'too late', {activityId: f.task.activityId, inputKind: 'human', kind: 'human_steer'}), false);
    assert.equal(f.store.activities.list().length, 1);
  } finally {await f.close();}
});
