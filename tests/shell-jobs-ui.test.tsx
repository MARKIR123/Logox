import test from 'node:test';
import assert from 'node:assert/strict';
import {computeActivePills, JOBS_PILL_ID, shortDuration} from '../src/tui/status/actor-pills.js';
import {jobsHoverDetail} from '../src/tui/status/notification-line.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {createJobsCommand, jobItems, JOBS_TITLE} from '../src/commands/jobs-page.js';
import {lastLines, type ShellJobs, type ShellJobView} from '../src/app/shell-jobs.js';
import {commandCatalog} from '../src/commands.js';
import {settingDefinition} from '../src/config/settings-definitions.js';
import {settingsFixture} from './settings-fixture.js';

const view = (patch: Partial<ShellJobView> & {id: string}): ShellJobView => ({sessionId: 's', ownerId: 'techne', actor: 'Techne', command: 'python train.py', startedAt: Date.now() - 5000,
  endedAt: undefined, state: 'running', exitCode: undefined, tail: 'epoch 1\nepoch 2', logPath: '/tmp/job.log', autoBackgrounded: false, ...patch});

function fakeJobs(initial: ShellJobView[]) {
  let jobs = initial;
  const listeners = new Set<() => void>();
  const api: ShellJobs & {set(next: ShellJobView[]): void; stopped: string[]} = {
    stopped: [], set(next) {jobs = next; for (const listener of [...listeners]) listener();},
    list: () => jobs, subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};},
    stop(id) {const job = jobs.find(item => item.id === id); if (!job || job.state !== 'running') return false; api.stopped.push(id); api.set(jobs.map(item => item.id === id ? {...item, state: 'stopped' as const} : item)); return true;},
    log: async id => id === 'job-1' ? 'epoch 1\nepoch 2\nepoch 3\n' : undefined, running: () => jobs.filter(job => job.state === 'running').length, dispose() {listeners.clear();},
  };
  return api;
}

test('the jobs pill docks first, shows the count and the oldest run time, compacts, and is hit-testable', () => {
  const roles = {kalon: {name: 'Kalon', color: '#e8a8dc'}};
  const activities = [{activityId: 'a1', ownerId: 'kalon', status: 'running', sessionId: 's'}];
  const pills = computeActivePills(activities as any, 's', roles as any, 0, 100, ['kalon'], {jobs: {count: 2, oldestMs: 12 * 60_000 + 5000}});
  assert.deepEqual(pills.map(pill => pill.ownerId), [JOBS_PILL_ID, 'kalon']);
  assert.equal(pills[0]!.name, '2 jobs 12m');
  assert.equal(pills[0]!.state, 'jobs');
  assert.equal(pills[1]!.endX, 100);
  assert.ok(pills[0]!.endX <= pills[1]!.startX + 1);
  // Jobs alone still make a pill; one job reads singular; no running job, no pill.
  assert.equal(computeActivePills([], 's', {}, 0, 80, [], {jobs: {count: 1, oldestMs: 4000}})[0]!.name, '1 job 4s');
  assert.deepEqual(computeActivePills([], 's', {}, 0, 80, [], {}), []);
  // A narrow footer compacts it to the glyph.
  const narrow = computeActivePills([], 's', {}, 0, 80, [], {jobs: {count: 3, oldestMs: 4000}, maxWidth: 6});
  assert.equal(narrow[0]?.compact, true);
  assert.equal(shortDuration(3_725_000), '1h 2m');
});

test('the jobs hover detail lists the running jobs and says what a click does', () => {
  const jobs = [view({id: 'job-1'}), view({id: 'job-2', actor: 'Kalon', startedAt: Date.now() - 90_000}), view({id: 'job-3', state: 'exited', exitCode: 0})];
  const text = jobsHoverDetail(jobs, Date.now()).map(segment => segment.text).join('');
  assert.match(text, /2 background jobs/);
  assert.match(text, /Techne job-1/);
  assert.match(text, /Kalon job-2/);
  assert.doesNotMatch(text, /job-3/);
  assert.match(text, /click to open/);
});

test('/jobs lists running jobs first, Enter shows the whole log, Stop job stops a running one, and the list follows the jobs', async () => {
  const done: string[] = [];
  const surfaces = new CommandSurfaces(result => {if (result.message) done.push(result.message);});
  const jobs = fakeJobs([view({id: 'job-1'}), view({id: 'job-2', state: 'failed', exitCode: 2, endedAt: Date.now(), startedAt: Date.now() - 9000})]);
  const command = createJobsCommand({surfaces, shellJobs: jobs});
  await command.open();
  let picker = surfaces.getSnapshot();
  assert.equal(picker?.kind, 'picker');
  if (picker?.kind !== 'picker') return;
  assert.equal(picker.title, JOBS_TITLE);
  assert.deepEqual(picker.items.map(item => item.id), ['job-1', 'job-2']);
  assert.match(picker.items[0]!.description!, /^running/);
  assert.match(picker.items[1]!.description!, /^failed \(2\)/);
  assert.equal(picker.items[0]!.deletable, true);
  assert.equal(picker.items[1]!.deletable, false);
  assert.match(picker.items[0]!.detail!, /python train\.py/);
  assert.equal(picker.deleteLabel, 'Stop job');

  await surfaces.deleteItem(picker.id, 'job-1');
  assert.deepEqual(jobs.stopped, ['job-1']);
  picker = surfaces.getSnapshot();
  assert.equal(picker?.kind === 'picker' && picker.items.find(item => item.id === 'job-1')!.deletable, false, 'the row followed the job');

  jobs.set([...jobs.list(), view({id: 'job-4', startedAt: Date.now() - 1000})]);
  picker = surfaces.getSnapshot();
  assert.equal(picker?.kind === 'picker' && picker.items[0]!.id, 'job-4', 'a new running job joins at the top while the page is open');

  if (picker?.kind !== 'picker') return;
  await surfaces.choose(picker.id, 'job-1');
  const result = surfaces.getSnapshot();
  assert.equal(result?.kind, 'result');
  if (result?.kind !== 'result') return;
  assert.match(result.title, /job-1/);
  assert.match(result.text, /epoch 3/);
  assert.match(result.text, /\/tmp\/job\.log/);
});

test('jobItems words a finished job with its exit and the last output line', () => {
  const items = jobItems([view({id: 'job-9', state: 'exited', exitCode: 0, endedAt: Date.now(), startedAt: Date.now() - 3000, tail: 'done\nall good'})]);
  assert.match(items[0]!.description!, /^exited 0 · 3s/);
  assert.match(items[0]!.detail!, /all good/);
  assert.equal(lastLines('a\n\nb\x1b[31m\nc', 2), 'b\nc');
});

test('/jobs is a catalog command and /settings carries the auto-background row', async () => {
  assert.ok(commandCatalog.some(command => command.name === 'jobs'));
  const definition = settingDefinition('shellAutoBackground');
  assert.ok(definition);
  assert.match(definition!.description, /\[kernel\] shell_auto_background_seconds$/);
  const fixture = await settingsFixture();
  try {
    assert.equal(definition!.read(fixture.env), 120);
    await definition!.write(fixture.env, 30);
    assert.equal(definition!.read(fixture.env), 30);
    assert.equal(fixture.state.kernel.shellAutoBackgroundSeconds, 30);
  } finally {await fixture.close();}
});
