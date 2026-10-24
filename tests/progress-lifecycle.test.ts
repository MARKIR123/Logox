import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {TaskProgress} from '../src/runtime/task-progress.js';
import type {TaskProgressSnapshot} from '../src/runtime/contracts.js';
import {Journal} from '../src/store/journal.js';

test('independent and parent-linked Actor turns start without the previous label', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-actor-label-'));
  const journal = new Journal(directory), store = new RuntimeStore();
  const seen: Array<TaskProgressSnapshot | undefined> = [];
  const ensemble = new Ensemble('s', store, journal, async (prompt, context) => {
    const progress = new TaskProgress(store, context);
    seen.push(progress.snapshot());
    if (prompt === 'first') await progress.update({label: 'Inspecting layout'});
    context.say('Report delivered.');
  });
  try {
    const first = ensemble.dispatch('techne', 'first'); await first.done;
    await ensemble.dispatch('techne', 'independent').done;
    await ensemble.dispatch('techne', 'related', 'logox', {parentActivityId: first.activityId}).done;
    await ensemble.dispatch('techne', 'resume', 'logox', {resumeTaskId: first.activityId}).done;
    assert.deepEqual(seen, [undefined, undefined, undefined, {label: 'Inspecting layout'}]);
  } finally {await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});

test('resuming and replacing a persisted legacy label never rewrites old milestones or promotes claims', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-legacy-label-'));
  const journal = new Journal(directory), store = new RuntimeStore();
  const progress = {planned: true, revision: 2, activeStageId: 'verify', revisions: [], stages: [
    {id: 'build', title: 'Build', purpose: 'Create layout', activeForm: 'Building', status: 'completed' as const, result: 'UNVERIFIED_OLD_CLAIM'},
    {id: 'verify', title: 'Verify', purpose: 'Compare images', activeForm: 'Comparing screenshots', status: 'in_progress' as const},
  ]};
  await journal.checkpoint('s', {activityId: 'old', ownerId: 'techne', prompt: 'Inspect layout', source: 'logox', status: 'failed', time: Date.now(), progress});
  const ensemble = new Ensemble('s', store, journal, async (_prompt, context) => {
    const current = new TaskProgress(store, context);
    assert.deepEqual(current.snapshot(), {label: 'Comparing screenshots', detail: 'Compare images'});
    assert.doesNotMatch(current.instruction(), /UNVERIFIED_OLD_CLAIM/);
    assert.equal((await current.update({label: 'Preparing report'})).isError, false);
    context.say('Verification is still pending.');
  });
  try {
    const resumed = ensemble.dispatch('techne', 'Continue', 'logox', {resumeTaskId: 'old'}); await resumed.done;
    const tasks = await journal.tasks('s');
    assert.deepEqual(tasks.find(task => task.activityId === 'old')?.progress, progress);
    assert.deepEqual(tasks.find(task => task.activityId === resumed.activityId)?.progress, {label: 'Preparing report'});
  } finally {await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});

test('a terminal transition during persistence cannot publish a late live label without an abort', async () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: 'Task', status: 'running', stage: 'Working', detail: ''});
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;}), saving = new Promise<void>(resolve => {entered = resolve;});
  const context: ActorContext = {sessionId: 's', activityId: 'a', ownerId: 'techne', history: [], signal: new AbortController().signal,
    say() {}, report() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'fixture'};}, async permission() {return true;},
    async saveProgress() {entered(); await pending;}};
  const progress = new TaskProgress(store, context);
  const update = progress.update({label: 'Comparing screenshots'});
  await saving;
  store.activities.update('s', 'a', {status: 'completed'});
  release();
  const result = await update;
  assert.equal(context.signal.aborted, false);
  assert.equal(result.isError, true);
  assert.match(result.text, /Activity has ended/);
  assert.equal(progress.snapshot(), undefined);
  assert.equal(store.activities.get('s', 'a')?.progress, undefined);
  assert.equal(store.activities.get('s', 'a')?.status, 'completed');
});
