import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {activitySchema, type AutomaSwarm} from '../src/runtime/contracts.js';
import {activityCosts, delegationRows, isEnvelope, projectDelegations, type Delegation} from '../src/runtime/delegations.js';

const base = {sessionId: 's', stage: '', detail: ''};
/** The two-companion dispatch of one Director round: Techne builds, Kalon runs `after` Techne; Techne also dispatched Automa jobs. */
function dispatch(store: RuntimeStore) {
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Fix the parser', status: 'running', rootActivityId: 'root'});
  store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Build the parser', status: 'running', stage: 'On stage',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'batch-1', ownedFiles: ['src/parser/**'], acceptance: ['tests pass']});
  store.activities.create({...base, activityId: 'kal', ownerId: 'kalon', kind: 'actor', title: 'Kalon · Aesthete', taskTitle: 'Polish the output', status: 'queued', stage: 'Waiting on Techne',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'batch-1', after: ['tech']});
}
const swarm = (jobs: AutomaSwarm['jobs']): AutomaSwarm => ({name: 'work crew', jobs});
const job = (id: string, state: AutomaSwarm['jobs'][number]['state'], extra: Partial<AutomaSwarm['jobs'][number]> = {}): AutomaSwarm['jobs'][number] =>
  ({id, title: 'Job ' + id, state, elapsedMs: 1500, calls: [], ...extra});
const byId = (nodes: readonly Delegation[], id: string) => nodes.find(node => node.id === id)!;
const project = (store: RuntimeStore) => projectDelegations({snapshot: store.getSnapshot(), sessionId: 's'});

test('a two-companion dispatch projects parents, roots, children, batch and what the second waits on', () => {
  const store = new RuntimeStore();
  dispatch(store);
  const nodes = project(store);
  assert.deepEqual(nodes.map(node => node.id), ['root', 'tech', 'kal']);
  const tech = byId(nodes, 'tech'), kal = byId(nodes, 'kal');
  assert.deepEqual([tech.kind, tech.parentId, tech.rootId, tech.batchId, tech.blockedBy], ['actor', 'root', 'root', 'batch-1', []]);
  assert.deepEqual(byId(nodes, 'root').children, ['tech', 'kal']);
  assert.deepEqual(tech.assignment, {title: 'Build the parser', owns: ['src/parser/**'], acceptance: ['tests pass']});
  assert.deepEqual(kal.blockedBy, ['tech']);
  assert.deepEqual(kal.waiting, {kind: 'blocked', text: 'blocked by techne'});
  assert.equal(tech.result, undefined, 'unsettled work has no result');
});

test('blockedBy follows the states: it empties when the blocker ends, and the settled one carries its result and stop reason', () => {
  const store = new RuntimeStore();
  dispatch(store);
  store.activities.update('s', 'tech', {status: 'completed', stage: 'Completed', stopReason: 'completed', title: 'Parser built', summary: {title: 'Parser built', report: 'Built it.\n\nTests pass.', source: 'model'}});
  store.activities.update('s', 'kal', {stage: 'Waiting to enter'});
  const after = project(store);
  assert.deepEqual(byId(after, 'kal').blockedBy, [], 'a finished blocker no longer blocks');
  assert.deepEqual(byId(after, 'kal').waiting, {kind: 'queued', text: 'queued'});
  const tech = byId(after, 'tech');
  assert.equal(tech.stopReason, 'completed');
  assert.deepEqual({summary: tech.result?.summary, stopReason: tech.result?.stopReason, reportRef: tech.result?.reportRef}, {summary: 'Parser built', stopReason: 'completed', reportRef: 'tech'}, 'the structured round summary line');
  assert.equal(typeof tech.result?.finishedAt, 'number');
  assert.equal(typeof tech.durationMs, 'number');
  // The delivery that holds the full report is named instead of the activity id.
  const named = projectDelegations({snapshot: store.getSnapshot(), sessionId: 's', deliveries: [{id: 'terminal:tech:completed', sourceActivityId: 'tech', kind: 'report'}]});
  assert.equal(byId(named, 'tech').result?.reportRef, 'terminal:tech:completed');
});

test('a failure keeps its stop reason and diagnostic; a pending approval and a paused batch say what they wait on', () => {
  const store = new RuntimeStore();
  dispatch(store);
  store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'tech', ownerId: 'techne', title: 'Write', tool: 'Write', arguments: {}, reason: 'ask'});
  store.activities.update('s', 'tech', {status: 'waiting_input', stage: 'Awaiting permission'});
  assert.deepEqual(byId(project(store), 'tech').waiting, {kind: 'approval', text: 'awaiting approval (Write)'});
  store.interactions.close();
  store.activities.update('s', 'tech', {status: 'failed', stage: 'Failed', stopReason: 'max_tokens', diagnostic: 'output cut at the limit'});
  const failed = byId(project(store), 'tech');
  assert.deepEqual([failed.status, failed.stopReason, failed.diagnostic, failed.result?.stopReason], ['failed', 'max_tokens', 'output cut at the limit', 'max_tokens']);
  assert.deepEqual(byId(project(store), 'kal').blockedBy, [], 'a failed blocker is no longer live (the dispatcher decides)');
});

test('Automa jobs appear as children of the dispatching activity with ids, route, model, status and result fields', () => {
  const store = new RuntimeStore();
  dispatch(store);
  const step = (jobs: AutomaSwarm['jobs']) => ({title: 'Automa', state: 'running' as const, elapsedMs: 0, swarm: swarm(jobs)});
  const message = store.message('s', 'techne', 'assistant', '', {activityId: 'tech', kind: 'tool', step: step([job('T1', 'running', {startedAt: Date.now() - 2000}), job('T2', 'queued')])});
  let nodes = project(store);
  assert.deepEqual(byId(nodes, 'tech').children, ['tech/T1', 'tech/T2']);
  assert.deepEqual([byId(nodes, 'tech/T1').kind, byId(nodes, 'tech/T1').jobId, byId(nodes, 'tech/T1').parentId, byId(nodes, 'tech/T1').rootId], ['automa', 'T1', 'tech', 'root']);
  assert.deepEqual(byId(nodes, 'tech/T2').waiting, {kind: 'queued', text: 'queued for a worker slot'});
  assert.equal(byId(nodes, 'tech/T1').result, undefined);
  store.updateMessage(message, {step: step([
    job('T1', 'done', {route: 'read', model: 'mock/reader', stopReason: 'completed', summary: 'found three callers', evidence: ['a.ts:1'], notVerified: ['b.ts']}),
    job('T2', 'failed', {route: 'code', model: 'mock/coder', stopReason: 'stalled', summary: 'The worker stopped without calling Finish.'})])});
  nodes = project(store);
  const done = byId(nodes, 'tech/T1'), stalled = byId(nodes, 'tech/T2');
  assert.deepEqual([done.route, done.model, done.status, done.stopReason, done.result?.summary, done.result?.evidence, done.result?.notVerified],
    ['read', 'mock/reader', 'done', 'completed', 'found three callers', ['a.ts:1'], ['b.ts']]);
  assert.deepEqual([stalled.status, stalled.stopReason, stalled.model], ['failed', 'stalled', 'mock/coder']);
  assert.equal(done.durationMs, 1500);
});

test('rows list the latest root first with children below it, earlier roots after it', () => {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'old', ownerId: 'logox', kind: 'director', title: 'Earlier', status: 'running', rootActivityId: 'old'});
  store.activities.update('s', 'old', {status: 'completed', stage: 'Completed'});
  dispatch(store);
  // A Director wake-up that continues the round is not a delegation of its own; what it dispatched belongs to the root.
  store.activities.create({...base, activityId: 'wake', ownerId: 'logox', kind: 'director', title: 'Wake', status: 'running', rootActivityId: 'root', parentActivityId: 'tech'});
  store.activities.create({...base, activityId: 'late', ownerId: 'aletheia', kind: 'actor', title: 'Aletheia', taskTitle: 'Check it', status: 'running', rootActivityId: 'root', parentActivityId: 'wake'});
  const rows = delegationRows(project(store));
  assert.deepEqual(rows.map(row => [row.node.id, row.depth]), [['root', 0], ['tech', 1], ['kal', 1], ['late', 1], ['old', 0]]);
});

test('older records without the new fields project: no stop reason, no duration, a legacy cause word is read as an outcome', () => {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Old round', status: 'running', rootActivityId: 'root'});
  store.activities.create({...base, activityId: 'a', ownerId: 'techne', kind: 'actor', title: 'Techne', status: 'cancelled', stage: 'Interrupted', stopReason: 'user', rootActivityId: 'root', parentActivityId: 'root'});
  store.activities.create({...base, activityId: 'b', ownerId: 'kalon', kind: 'actor', title: 'Kalon', status: 'failed', stage: 'Failed', rootActivityId: 'root', parentActivityId: 'root'});
  const nodes = project(store);
  assert.equal(byId(nodes, 'a').stopReason, 'cancelled_by_user', 'the old cause word maps to the outcome');
  assert.equal(byId(nodes, 'b').stopReason, 'error', 'a settled activity without the field gets the outcome its status implies');
  assert.equal(byId(nodes, 'b').durationMs, undefined);
  // A stored record with none of the new fields still parses.
  const parsed = activitySchema.parse({sessionId: 's', activityId: 'x', ownerId: 'techne', kind: 'actor', title: 't', status: 'completed', stage: '', detail: '', version: 1});
  assert.equal(parsed.stopReason, undefined);
});

test('a result summary never starts with the echoed input: the Goal line of the fallback report and a message envelope give way to the next candidate, else nothing', () => {
  const store = new RuntimeStore();
  const done = {...base, kind: 'actor' as const, status: 'completed' as const, stage: 'Completed', stopReason: 'completed' as const};
  store.activities.create({...done, activityId: 'a', ownerId: 'techne', title: 'Techne · Builder', taskTitle: 'Echo',
    summary: {title: 'Goal: [Message from aletheia · check the bell]', source: 'local', report:'Goal: [Message from aletheia · check the bell]\nStatus: done'}} as never);
  store.activities.create({...done, activityId: 'b', ownerId: 'kalon', title: 'Kalon · Aesthete', taskTitle: 'Plain',
    summary: {title: '[Message from aletheia · check]', source: 'local', report:'[Message from aletheia · check]\nplease'}} as never);
  store.message('s', 'techne', 'assistant', 'The bell is fixed.', {activityId: 'a'});
  const nodes = project(store);
  assert.equal(byId(nodes, 'a').result?.summary, 'The bell is fixed.', 'the next candidate: what the activity last said');
  assert.equal(byId(nodes, 'b').result?.summary, '', 'nothing when only the envelope is left');
  assert.ok(isEnvelope('Goal: [Message from x]\nhi') && isEnvelope('[Interrupt from x]') && isEnvelope('Goal: fix it') && !isEnvelope('Fixed the bell.'));
});

test('activityCosts sums the priced USD turns of each activity from the ledger', () => {
  const costs = activityCosts([{activityId: 'a', usage: {cost: 0.5, currency: 'USD'}}, {activityId: 'a', usage: {cost: 0.25}}, {activityId: 'b', usage: {cost: 1, currency: 'CNY'}}, {activityId: 'c'}, {usage: {cost: 3}}]);
  assert.deepEqual([...costs], [['a', 0.75]]);
});
