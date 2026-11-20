import test from 'node:test';
import assert from 'node:assert/strict';
import {definitionChangeNote, definitionChanges, definitionFingerprint} from '../src/runtime/definition-fingerprint.js';
import {actorCall, barrier, delegationFixture} from './delegation-fixture.js';

const NOTE = /Note: Techne's definition changed since this work started \(([a-z, ]+)\); it continues under the current definition\./;

test('fingerprints compare by part: unchanged, changed, missing on either side', () => {
  const a = definitionFingerprint({prompt: ['persona', 'rules'], model: 'p/m', grant: ['x']});
  assert.deepEqual(definitionChanges(a, a), []);
  assert.deepEqual(definitionChanges(a, definitionFingerprint({prompt: ['persona', 'rules v2'], model: 'p/m', grant: ['x']})), ['prompt']);
  assert.deepEqual(definitionChanges(a, definitionFingerprint({prompt: ['persona', 'rules'], model: 'p/other', grant: ['y']})), ['model', 'grant']);
  assert.deepEqual(definitionChanges(undefined, a), [], 'an old record stores nothing and is never compared');
  assert.deepEqual(definitionChanges('not json', a), []);
  assert.deepEqual(definitionChanges(definitionFingerprint({model: 'p/m'}), a), [], 'a part recorded on one side only is not a change');
  assert.equal(definitionChangeNote('Techne', []), undefined);
  assert.equal(definitionChangeNote('Techne', ['prompt', 'model']), "Note: Techne's definition changed since this work started (prompt, model); it continues under the current definition.");
});

/** Techne fails on its first task; the Director then resumes it with `resumeTask`. */
async function resumed(change: (model: {current: string}) => void, edit?: (store: Awaited<ReturnType<typeof delegationFixture>>) => Promise<void>) {
  const model = {current: 'model-a'}, prompts: string[] = [];
  let receipt = '';
  const f = await delegationFixture(async (prompt, context, services) => {
    if (prompt === 'start') {await services.execute(actorCall([{ownerId: 'techne', prompt: 'build it', title: 'Build'}]), context); return;}
    if (prompt.startsWith('resume ')) {
      const failed = prompt.slice('resume '.length);
      receipt = (await services.execute(actorCall([{ownerId: 'techne', prompt: 'carry on', resumeTask: failed}]), context)).text;
      return;
    }
    prompts.push(prompt);
    if (prompt.startsWith('build it')) throw new Error('tool transport broke');
  }, {modelResolver: () => ({provider: 'prov', model: model.current})});
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    await f.idle();
    const failed = f.store.getSnapshot().activities.find(activity => activity.ownerId === 'techne')!;
    assert.equal(failed.status, 'failed');
    assert.equal(typeof failed.fingerprint, 'string', 'the definition is stored on the activity when the work is dispatched');
    assert.equal((await f.journal.tasks('s')).find(task => task.activityId === failed.activityId)?.fingerprint, failed.fingerprint, 'and on its checkpoint');
    await edit?.(f);
    change(model);
    await f.ensemble.dispatch('logox', 'resume ' + failed.activityId, 'direct').done;
    await f.idle();
    return {receipt, prompts, f, failed};
  } catch (error) {await f.close(); throw error;}
}

test('resuming a companion whose definition did not change adds no note', async () => {
  const {receipt, prompts, f} = await resumed(() => {});
  try {
    assert.match(receipt, /^Dispatched to techne/);
    assert.doesNotMatch(receipt, /definition changed/);
    const resumedPrompt = prompts.find(prompt => prompt.startsWith('[Resuming interrupted Actor task]'))!;
    assert.ok(resumedPrompt);
    assert.doesNotMatch(resumedPrompt, /definition changed/);
  } finally {await f.close();}
});

test('resuming a companion whose bound model changed still resumes, names the model in the receipt and in the first message, and the new activity stores the current definition', async () => {
  const {receipt, prompts, f, failed} = await resumed(model => {model.current = 'model-b';});
  try {
    assert.match(receipt, /^Dispatched to techne/);
    assert.deepEqual(NOTE.exec(receipt)?.[1], 'model');
    assert.equal(receipt.match(/definition changed/g)?.length, 1, 'once');
    const resumedPrompt = prompts.find(prompt => prompt.startsWith('[Resuming interrupted Actor task]'))!;
    assert.match(resumedPrompt, /^\[Resuming interrupted Actor task\]\nNote: Techne's definition changed since this work started \(model\); it continues under the current definition\.\nOriginal activity: /);
    const second = f.store.getSnapshot().activities.filter(activity => activity.ownerId === 'techne').at(-1)!;
    assert.notEqual(second.activityId, failed.activityId);
    assert.notEqual(second.fingerprint, failed.fingerprint, 'the resumed activity carries the current definition');
  } finally {await f.close();}
});

test('resuming from a record that stored no definition adds no note, even though the model differs', async () => {
  const {receipt, prompts, f} = await resumed(model => {model.current = 'model-b';}, async fixture => {
    const task = (await fixture.journal.tasks('s')).find(item => item.ownerId === 'techne')!;
    const {fingerprint: _removed, ...old} = task;
    await fixture.journal.checkpoint('s', old);
  });
  try {
    assert.match(receipt, /^Dispatched to techne/);
    assert.doesNotMatch(receipt, /definition changed/);
    assert.doesNotMatch(prompts.find(prompt => prompt.startsWith('[Resuming interrupted Actor task]'))!, /definition changed/);
  } finally {await f.close();}
});

test('a dispatch that queues behind a running task says which task it waits behind, one line each', async () => {
  const running = barrier(), release = barrier();
  let receipt = '';
  const f = await delegationFixture(async (prompt, context, services) => {
    if (prompt === 'start') {await services.execute(actorCall([{ownerId: 'techne', prompt: 'long work', title: 'Long job'}]), context); return;}
    if (prompt === 'second') {
      receipt = (await services.execute(actorCall([{ownerId: 'techne', prompt: 'more work', title: 'Next task'}, {ownerId: 'kalon', prompt: 'free work', title: 'Free task'}]), context)).text;
      return;
    }
    if (prompt.startsWith('long work')) {running.resolve(); await release.promise;}
  }, {}, 'actor');
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    await running.promise;
    await f.ensemble.dispatch('logox', 'second', 'direct').done;
    const first = f.store.getSnapshot().activities.find(activity => activity.ownerId === 'techne' && activity.status === 'running')!;
    const queued = f.store.getSnapshot().activities.find(activity => activity.ownerId === 'techne' && activity.taskTitle === 'Next task')!;
    const lines = receipt.split('\n').filter(line => line.startsWith('Queued:'));
    assert.deepEqual(lines, [`Queued: Next task (${queued.activityId}) waits behind Techne's running task "Long job" (${first.activityId}); it starts when that ends.`]);
    assert.doesNotMatch(receipt, /Free task \(.*waits behind/, 'a free companion is not queued');
    release.resolve(); await f.idle();
    // Nothing is running now: no line.
    receipt = '';
    await f.ensemble.dispatch('logox', 'second', 'direct').done;
    assert.doesNotMatch(receipt, /^Queued:/m);
  } finally {release.resolve(); await f.close();}
});
