import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {TaskProgress, taskProgressTool} from '../src/runtime/task-progress.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {taskProgressSchema, type TaskProgressSnapshot} from '../src/runtime/contracts.js';
import {Journal, type HistoryStore} from '../src/store/journal.js';

function fixture(saveProgress?: (value: TaskProgressSnapshot) => Promise<void>) {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', ownerId: 'techne', activityId: 'a', kind: 'actor', title: 'Techne', stage: 'Working', detail: '', status: 'running'});
  const context: ActorContext = {sessionId: 's', ownerId: 'techne', activityId: 'a', history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'fixture'};}, async permission() {return true;},
    ...(saveProgress ? {saveProgress} : {})};
  return {store, context, progress: new TaskProgress(store, context)};
}

const legacyStage = {id: 'verify', title: 'Verify layout', purpose: 'Inspect screenshots', activeForm: 'Comparing screenshots', status: 'in_progress' as const};
const legacy = {planned: true, revision: 1, activeStageId: 'verify', stages: [legacyStage], revisions: []};

test('progress is an optional current label, not a mandatory phase plan', async () => {
  const {store, progress} = fixture();
  assert.equal(taskProgressTool.name, 'UpdateTaskProgress');
  assert.deepEqual(taskProgressTool.parameters.required, ['label']);
  assert.equal(progress.snapshot(), undefined);
  assert.equal(progress.instruction(), '');
  for (const input of [{}, {label: ' '}, {label: 'x'.repeat(161)}, {label: 'Reading', result: 'Done'}, {stages: [{title: 'Reading'}]}]) {
    assert.equal((await progress.update(input)).isError, true);
    assert.equal(progress.snapshot(), undefined);
  }
  const first = {label: 'Reading layout', detail: 'Inspecting the current stylesheet.'};
  assert.equal((await progress.update(first)).isError, false);
  const snapshot = progress.snapshot();
  assert.deepEqual(snapshot, first);
  assert.deepEqual(store.activities.get('s', 'a')?.progress, first);
  assert.match(progress.instruction(), /Reading layout/);
  assert.equal((await progress.update({label: 'Comparing screenshots'})).isError, false);
  assert.deepEqual(progress.snapshot(), {label: 'Comparing screenshots'});
  assert.deepEqual(snapshot, first, 'Earlier immutable snapshots do not change');
  assert.equal(Object.isFrozen(snapshot), true);
});

test('failed persistence does not publish a label or corrupt the previous snapshot', async () => {
  let reject = false;
  const {store, progress} = fixture(async () => {if (reject) throw new Error('disk full');});
  await progress.update({label: 'Reading layout'});
  const before = progress.snapshot(); reject = true;
  const result = await progress.update({label: 'Comparing screenshots'});
  assert.equal(result.isError, true);
  assert.match(result.text, /disk full/);
  assert.equal(progress.snapshot(), before);
  assert.deepEqual(store.activities.get('s', 'a')?.progress, before);
});

test('terminal activities reject late label updates without persisting or reviving them', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    let writes = 0;
    const {store, progress} = fixture(async () => {writes++;});
    store.activities.update('s', 'a', {status});
    const result = await progress.update({label: 'Still working'});
    assert.equal(result.isError, true);
    assert.equal(writes, 0);
    assert.equal(progress.snapshot(), undefined);
    assert.equal(store.activities.get('s', 'a')?.status, status);
    assert.equal(store.activities.get('s', 'a')?.progress, undefined);
  }
});

test('legacy milestone checkpoints remain readable while resumed work uses only the current label', () => {
  const {store, context} = fixture();
  const parsed = taskProgressSchema.parse(legacy);
  assert.deepEqual(parsed, legacy, 'Do not rewrite old history during schema parsing');
  const progress = new TaskProgress(store, {...context, progress: parsed});
  assert.deepEqual(progress.snapshot(), {label: 'Comparing screenshots', detail: 'Inspect screenshots'});
  assert.deepEqual(parsed, legacy);
});

test('new turns and parent-linked follow-ups do not inherit progress; explicit resume does', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-task-progress-'));
  const history = new Journal(directory), store = new RuntimeStore();
  const seen: Array<TaskProgressSnapshot | undefined> = [];
  const ensemble = new Ensemble('s', store, history, async (prompt, context) => {
    const progress = new TaskProgress(store, context);
    seen.push(progress.snapshot());
    if (prompt === 'first') await progress.update({label: 'Comparing screenshots'});
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
    assert.equal((await history.tasks('s')).filter(task => task.progress).length, 2);
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
    await new TaskProgress(store, context).update({label: 'Reading layout'});
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
