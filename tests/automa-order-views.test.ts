import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import {projectDelegations} from '../src/runtime/delegations.js';
import {statusText} from '../src/commands/tasks-page.js';
import {stopReasonFor, normalizeStopReason} from '../src/runtime/stop-reason.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';

const job = (id: string, state: AutomaSwarm['jobs'][number]['state'], extra: Partial<AutomaSwarm['jobs'][number]> = {}): AutomaSwarm['jobs'][number] =>
  ({id, title: 'Job ' + id, state, elapsedMs: 1200, calls: [], ...extra});
const swarm: AutomaSwarm = {name: 'work crew', background: true, jobs: [
  job('T1', 'running', {startedAt: Date.now() - 3000}),
  job('T2', 'waiting', {after: ['T1']}),
  job('T3', 'done', {delivered: true, summary: 'ok', stopReason: 'completed'}),
  job('T4', 'failed', {delivered: false, summary: 'boom', stopReason: 'error'}),
  job('T5', 'skipped', {delivered: false, summary: 'Not started: T4 ended failed.', stopReason: 'dependency_unmet', after: ['T4']}),
]};

function fixture(value: AutomaSwarm, finish: boolean) {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 'Swarm', taskTitle: 'Swarm', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'a', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'logox'});
  const id = steps.tool({id: 'automa1', name: 'Automa', arguments: JSON.stringify({mode: 'background', jobs: [{title: 'x', brief: 'x'}]})});
  steps.start(id);
  steps.swarm(id, {...value, jobs: value.jobs.slice(0, 1)});
  // The call returned its receipt: the step ended, and the dispatch keeps publishing.
  if (finish) steps.finish(id, 'completed', 'Automa\nL1 Job T1 · running');
  steps.swarm(id, value);
  return {store, id, rows: (folds: Record<string, boolean> = {}) => buildStageRows(store.getSnapshot(), 's', 'logox', 160, folds, null)};
}
const text = (row: SceneRow) => row.displayText ?? row.text;

test('/tasks projects waiting, skipped and delivered background jobs', () => {
  const {store} = fixture(swarm, true);
  const nodes = projectDelegations({snapshot: store.getSnapshot(), sessionId: 's'}).filter(node => node.kind === 'automa');
  const byJob = (id: string) => nodes.find(node => node.jobId === id)!;
  assert.deepEqual(nodes.map(node => node.jobId), ['T1', 'T2', 'T3', 'T4', 'T5'], 'a later publication of a finished step still counts');
  assert.deepEqual([byJob('T2').status, byJob('T2').blockedBy, byJob('T2').waiting], ['waiting', ['a/T1'], {kind: 'blocked', text: 'waiting on T1'}]);
  assert.match(statusText(byJob('T2'), undefined), /^waiting · waiting on T1 · .*background$/);
  assert.match(statusText(byJob('T1'), undefined), /^running · .*background$/);
  assert.match(statusText(byJob('T3'), undefined), /^done · .*delivered$/);
  assert.match(statusText(byJob('T4'), undefined), /^failed \(stop: error\) · .*not delivered yet$/);
  const skipped = byJob('T5');
  assert.deepEqual([skipped.status, skipped.stopReason, skipped.result?.summary], ['skipped', 'dependency_unmet', 'Not started: T4 ended failed.']);
  assert.match(statusText(skipped, undefined), /^skipped \(stop: dependency_unmet\)/);
  assert.equal(byJob('T3').delivered, true);
  assert.equal(byJob('T4').delivered, false);
  // Once the prerequisite settled, nothing blocks the job.
  const settled = fixture({...swarm, jobs: [job('T1', 'done', {stopReason: 'completed'}), job('T2', 'queued', {after: ['T1']})]}, true).store;
  assert.deepEqual(projectDelegations({snapshot: settled.getSnapshot(), sessionId: 's'}).find(node => node.jobId === 'T2')!.blockedBy, []);
});

test('The skipped outcome has its own stop reason, read from old and new records alike', () => {
  assert.equal(stopReasonFor({status: 'skipped'}), 'dependency_unmet');
  assert.equal(normalizeStopReason('dependency_unmet'), 'dependency_unmet');
  const old = projectDelegations({snapshot: fixture({name: 'work crew', jobs: [job('T1', 'skipped', {summary: 'Not started: T0 ended failed.'})]}, true).store.getSnapshot(), sessionId: 's'});
  assert.equal(old.find(node => node.jobId === 'T1')!.stopReason, 'dependency_unmet', 'a job without a stored reason is read from its state');
});

test('The card of a background dispatch keeps counting after its tool step ended: waiting, not delivered, skipped', () => {
  const {rows, id} = fixture(swarm, true);
  const header = rows().find(row => /▸ Work crew/.test(text(row)))!;
  assert.match(text(header), /Work crew · 5 members · background · 3 returned · 1 waiting · 2 not delivered · 1 failed · 1 skipped/);
  const open = rows({[id]: true}).map(text).join('\n');
  assert.match(open, /T2 · Job T2 · waiting/);
  assert.match(open, /T3 · Job T3 · done · delivered/);
  assert.match(open, /T4 · Job T4 · failed · not delivered/);
  assert.match(open, /T5 · Job T5 · skipped · not delivered/);
  assert.doesNotMatch(open, /interrupted/, 'jobs of a background dispatch are not cut off by the step having ended');
});

test('A swarm that is not background still cuts off jobs of an ended step', () => {
  const plain: AutomaSwarm = {name: 'work crew', jobs: [job('T1', 'running', {startedAt: Date.now()}), job('T2', 'waiting', {after: ['T1']})]};
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 'Swarm', taskTitle: 'Swarm', status: 'running', stage: 'x', detail: ''});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'logox'});
  const id = steps.tool({id: 'automa1', name: 'Automa', arguments: JSON.stringify({jobs: [{title: 'x', brief: 'x'}]})});
  steps.start(id); steps.swarm(id, plain); steps.finish(id, 'completed', 'Automa\nok');  steps.swarm(id, {...plain, jobs: []});
  assert.equal(store.getSnapshot().messages.find(message => message.id === id)!.step!.swarm!.jobs.length, 2, 'a finished wait-mode step ignores later publications');
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 160, {[id]: true}, null).map(text).join('\n');
  assert.match(rows, /T1 · Job T1 · interrupted/);
  assert.match(rows, /T2 · Job T2 · interrupted/);
});
