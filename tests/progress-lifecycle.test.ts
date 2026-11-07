import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';

test('independent and parent-linked Actor turns start without the previous label', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-actor-label-'));
  const journal = new Journal(directory), store = new RuntimeStore();
  const seen: Array<ActorContext['progress']> = [];
  const ensemble = new Ensemble('s', store, journal, async (prompt, context) => {
    seen.push(context.progress);
    if (prompt === 'first') await context.saveProgress?.({label: 'Inspecting layout'});
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

test('resuming a persisted legacy checkpoint keeps its old milestones untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-legacy-label-'));
  const journal = new Journal(directory), store = new RuntimeStore();
  const progress = {planned: true, revision: 2, activeStageId: 'verify', revisions: [], stages: [
    {id: 'build', title: 'Build', purpose: 'Create layout', activeForm: 'Building', status: 'completed' as const, result: 'UNVERIFIED_OLD_CLAIM'},
    {id: 'verify', title: 'Verify', purpose: 'Compare images', activeForm: 'Comparing screenshots', status: 'in_progress' as const},
  ]};
  await journal.checkpoint('s', {activityId: 'old', ownerId: 'techne', prompt: 'Inspect layout', source: 'logox', status: 'failed', time: Date.now(), progress});
  const ensemble = new Ensemble('s', store, journal, async (_prompt, context) => {
    assert.deepEqual(context.progress, progress, 'the context carries the persisted checkpoint as stored');
    context.say('Verification is still pending.');
  });
  try {
    const resumed = ensemble.dispatch('techne', 'Continue', 'logox', {resumeTaskId: 'old'}); await resumed.done;
    const tasks = await journal.tasks('s');
    assert.deepEqual(tasks.find(task => task.activityId === 'old')?.progress, progress);
  } finally {await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});
