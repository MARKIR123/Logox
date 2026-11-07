import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {currentTaskProgress, taskProgressSchema} from '../src/runtime/contracts.js';
import {Journal, type HistoryStore} from '../src/store/journal.js';

const legacyStage = {id: 'verify', title: 'Verify layout', purpose: 'Inspect screenshots', activeForm: 'Comparing screenshots', status: 'in_progress' as const};
const legacy = {planned: true, revision: 1, activeStageId: 'verify', stages: [legacyStage], revisions: []};

test('legacy milestone checkpoints remain readable and read as a current label without being rewritten', () => {
  const parsed = taskProgressSchema.parse(legacy);
  assert.deepEqual(parsed, legacy, 'Do not rewrite old history during schema parsing');
  assert.deepEqual(currentTaskProgress(parsed), {label: 'Comparing screenshots', detail: 'Inspect screenshots'});
  assert.deepEqual(parsed, legacy);
  assert.deepEqual(currentTaskProgress(taskProgressSchema.parse({label: 'Reading layout', stageHistory: ['Reading layout']})), {label: 'Reading layout', stageHistory: ['Reading layout']});
  assert.equal(currentTaskProgress(undefined), undefined);
});

test('new turns and parent-linked follow-ups do not inherit progress; explicit resume does', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-task-progress-'));
  const history = new Journal(directory), store = new RuntimeStore();
  const seen: Array<ActorContext['progress']> = [];
  const ensemble = new Ensemble('s', store, history, async (prompt, context) => {
    seen.push(context.progress);
    if (prompt === 'first') await context.saveProgress?.({label: 'Comparing screenshots'});
    context.say('Report delivered.');
  });
  try {
    const first = ensemble.dispatch('logox', 'first', 'direct'); await first.done;
    await ensemble.dispatch('logox', 'A separate question', 'direct').done;
    await ensemble.dispatch('logox', 'A related follow-up', 'direct', {parentActivityId: first.activityId}).done;
    const resumed = ensemble.dispatch('logox', 'Continue the task', 'direct', {resumeTaskId: first.activityId}); await resumed.done;
    assert.deepEqual(seen, [undefined, undefined, undefined, {label: 'Comparing screenshots'}]);
    const tasks = await history.tasks('s');
    assert.deepEqual(tasks.find(task => task.activityId === first.activityId)?.progress, {label: 'Comparing screenshots'});
    assert.deepEqual(tasks.find(task => task.activityId === resumed.activityId)?.progress, {label: 'Comparing screenshots'});
    assert.equal(await history.progress('s', 'kalon', first.activityId), undefined);
  } finally {await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});

test('cancellation during progress persistence preserves history without publishing a live label', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-progress-cancel-')), journal = new Journal(directory), store = new RuntimeStore();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;}), blocked = new Promise<void>(resolve => {entered = resolve;});
  const history: HistoryStore = {
    load: (session, owner) => journal.load(session, owner), append: entry => journal.append(entry),
    finish: (session, owner, activity, status) => journal.finish(session, owner, activity, status),
    checkpoint: async (session, task) => {if (task.progress && task.status === 'running') {entered(); await pending;} await journal.checkpoint(session, task);},
  };
  const ensemble = new Ensemble('s', store, history, async (_prompt, context) => {
    await context.saveProgress?.({label: 'Reading layout'});
    assert.fail('Cancelled work must not continue');
  });
  try {
    const task = ensemble.dispatch('techne', 'build');
    await blocked; ensemble.cancel(task.activityId); release(); await task.done;
    const checkpoint = (await journal.tasks('s')).find(entry => entry.activityId === task.activityId)!;
    assert.equal(checkpoint.status, 'cancelled');
    assert.equal(checkpoint.stopReason, 'user');
    assert.deepEqual(checkpoint.progress, {label: 'Reading layout'});
    assert.equal(store.activities.get('s', task.activityId)?.status, 'cancelled');
    assert.equal(store.activities.get('s', task.activityId)?.progress, undefined);
  } finally {release(); await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});
