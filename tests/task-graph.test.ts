import test from 'node:test';
import assert from 'node:assert/strict';
import type {Delegation} from '../src/runtime/delegations.js';
import {derivePlan, type Plan, type PlanNode} from '../src/runtime/plan.js';
import {TASKS_PLAN_ID, taskGraph} from '../src/runtime/task-graph.js';

const d = (id: string, extra: Partial<Delegation> = {}): Delegation => ({id, kind: 'actor', ownerId: 'techne', title: id, status: 'completed', rootId: id, children: [], blockedBy: [],
  assignment: {title: extra.title ?? id, owns: [], acceptance: []}, ...extra});
const job = (activity: string, jobId: string, extra: Partial<Delegation> = {}): Delegation => d(activity + '/' + jobId, {kind: 'automa', ownerId: 'techne', jobId, parentId: activity, rootId: 'R', status: 'done', ...extra});
const node = (id: string, extra: Partial<PlanNode> = {}): PlanNode => ({id, title: 'Node ' + id, owner: 'techne', after: [], acceptance: [], links: [], ...extra});
const plan = (nodes: PlanNode[]): Plan => ({id: 'p1', title: 'Theme', status: 'active', createdAt: 0, updatedAt: 1, sessionId: 's', nodes});
const ids = (graph: ReturnType<typeof taskGraph>) => graph!.plan.nodes.map(item => item.id);
const by = (graph: ReturnType<typeof taskGraph>, id: string) => graph!.plan.nodes.find(item => item.id === id)!;

/** A Director round that dispatched Techne (with two workers, one a fork) and Kalon after it; a second round that dispatched nothing. */
function round(): Delegation[] {
  return [
    d('R', {kind: 'director', ownerId: 'logox', title: 'Fix the parser\nand its tests', status: 'completed'}),
    d('tech', {title: 'Build the parser', status: 'running', parentId: 'R', rootId: 'R', startedAt: 1000}),
    d('kal', {ownerId: 'kalon', title: 'Polish the output', status: 'queued', parentId: 'R', rootId: 'R', after: ['tech'], blockedBy: ['tech']}),
    d('R2', {kind: 'director', ownerId: 'logox', title: 'Say hello'}),
    job('tech', 'T1', {title: 'Find the callers', result: {summary: 'three callers', stopReason: 'completed', reportRef: 'tech/T1'}}),
    job('tech', 'T2', {title: 'Try the hard part', status: 'running', fork: true, startedAt: 2000, after: ['tech/T1']}),
  ];
}

test('no plan and no work: there is no graph; a round that dispatched nothing is not a phase', () => {
  assert.equal(taskGraph(undefined, [], 's'), undefined);
  assert.equal(taskGraph(undefined, [d('R', {kind: 'director', ownerId: 'logox'})], 's'), undefined);
});

test('work only: phases, steps and tasks with owners, after edges, fork marking and statuses; empty rounds are dropped', () => {
  const graph = taskGraph(undefined, round(), 's')!;
  assert.equal(graph.plan.id, TASKS_PLAN_ID);
  assert.equal(graph.planned, false);
  assert.equal(graph.plan.status, 'active');
  assert.deepEqual(ids(graph), ['1', '1.1', '1.1.1', '1.1.2', '1.2']);
  assert.deepEqual(graph.plan.nodes.map(item => [item.id, item.owner, item.depth]), [['1', 'logox', 1], ['1.1', 'techne', 2], ['1.1.1', 'automa', 3], ['1.1.2', 'techne', 3], ['1.2', 'kalon', 2]]);
  assert.equal(by(graph, '1').title, 'Fix the parser', 'the title of a phase is the first line of the round');
  assert.deepEqual(by(graph, '1.2').after, ['1.1']);
  assert.deepEqual(by(graph, '1.1.2').after, ['1.1.1']);
  assert.equal(by(graph, '1.1.2').forked, true, 'a fork keeps its dispatcher as owner and the fork marking');
  assert.equal(by(graph, '1.1.1').forked, undefined);
  assert.deepEqual(graph.plan.nodes.map(item => [item.id, item.status]), [['1', 'running'], ['1.1', 'running'], ['1.1.1', 'done'], ['1.1.2', 'running'], ['1.2', 'waiting']]);
  assert.equal(by(graph, '1.1.2').runningSince, 2000);
  assert.equal(by(graph, '1.1.1').note, 'three callers');
  assert.deepEqual([...graph.synthetic].sort(), ids(graph).slice().sort(), 'every node is synthesized');
  assert.deepEqual([...graph.delegationOf].sort(), [['1', 'R'], ['1.1', 'tech'], ['1.1.1', 'tech/T1'], ['1.1.2', 'tech/T2'], ['1.2', 'kal']]);
  // Settled work reads done or failed, never accepted.
  const settled = round().map(item => item.id === 'tech' ? {...item, status: 'completed' as const} : item.id === 'tech/T2' ? {...item, status: 'failed' as const} : item.id === 'kal' ? {...item, status: 'completed' as const} : item);
  const after = taskGraph(undefined, settled, 's')!;
  assert.deepEqual(after.plan.nodes.map(item => item.status), ['done', 'done', 'done', 'failed', 'done'], 'result-oriented: the failed worker stays failed, its dispatcher and the phase are done');
  assert.deepEqual(by(after, '1').leaves, {done: 2, failed: 1, interrupted: 0, total: 3});
  assert.ok(after.plan.nodes.every(item => item.status !== 'accepted'));
  assert.equal(after.plan.status, 'done');
});

test('plan only: the graph is the plan, nothing is synthesized', () => {
  const given = plan([node('1'), node('1.1', {links: [{activityId: 'tech'}]}), node('2', {after: ['1']})]);
  const graph = taskGraph(given, [d('tech', {status: 'running'})], 's')!;
  assert.equal(graph.planned, true);
  assert.equal(graph.synthetic.size, 0);
  assert.equal(graph.plan.id, 'p1');
  assert.deepEqual(graph.plan, derivePlan(given, [{id: 'tech', status: 'running', startedAt: undefined}]));
  assert.deepEqual(ids(graph), ['1', '1.1', '2']);
});

test('mixed: unlinked work joins the node of its dispatcher or the phase of its round; other rounds get a phase of their own; the plan is untouched', () => {
  const given = plan([node('1'), node('1.1', {links: [{activityId: 'tech'}]}), node('1.2'), node('2', {after: ['1']})]);
  const frozen = JSON.stringify(given);
  const work = [
    d('R', {kind: 'director', ownerId: 'logox', title: 'Round one'}),
    d('tech', {status: 'running', parentId: 'R', rootId: 'R'}),
    d('kal', {ownerId: 'kalon', title: 'Unplanned polish', status: 'running', parentId: 'R', rootId: 'R'}),
    d('R3', {kind: 'director', ownerId: 'logox', title: 'A different request'}),
    d('aleth', {ownerId: 'aletheia', title: 'Check it', status: 'completed', parentId: 'R3', rootId: 'R3'}),
    job('tech', 'T1', {title: 'Worker of the planned step', status: 'running'}),
    job('kal', 'T1', {title: 'Worker of the unplanned step', status: 'failed'}),
  ];
  const graph = taskGraph(given, work, 's')!;
  assert.equal(JSON.stringify(given), frozen, 'the plan is not changed');
  assert.deepEqual(ids(graph), ['1', '1.1', '1.1.1', '1.2', '1.3', '1.3.1', '2', '3', '3.1']);
  assert.deepEqual([...graph.synthetic].sort(), ['1.1.1', '1.3', '1.3.1', '3', '3.1']);
  assert.equal(by(graph, '1.1.1').title, 'Worker of the planned step', 'a worker of a planned step is a child of that step');
  assert.equal(by(graph, '1.3').title, 'Unplanned polish', 'unlinked work of a round with planned work joins the planned phase');
  assert.equal(by(graph, '1.3.1').owner, 'automa');
  assert.equal(by(graph, '3').title, 'A different request', 'another round gets a phase of its own, after the plan\'s');
  assert.equal(by(graph, '3.1').owner, 'aletheia');
  assert.deepEqual(by(graph, '2').after, ['1'], 'the plan\'s own prerequisites stay');
  assert.deepEqual([...graph.delegationOf].sort(), [['1.1.1', 'tech/T1'], ['1.3', 'kal'], ['1.3.1', 'kal/T1'], ['3', 'R3'], ['3.1', 'aleth']].sort());
  // Statuses follow the work: the planned step runs, the unplanned step failed through its worker, the finished phase is done.
  assert.equal(by(graph, '1.1').status, 'running');
  assert.equal(by(graph, '1.3').status, 'running', 'the unplanned step is itself running');
  assert.equal(by(graph, '1.3.1').status, 'failed');
  assert.equal(by(graph, '3.1').status, 'done');
});

test('ids are stable while work is added: earlier synthesized nodes keep their ids and later ones continue after them', () => {
  const first = taskGraph(undefined, round(), 's')!;
  const more = [...round(), d('aleth', {ownerId: 'aletheia', title: 'Review', status: 'running', parentId: 'R', rootId: 'R'}), job('aleth', 'T1', {title: 'Read the diff', status: 'running'}), d('R4', {kind: 'director', ownerId: 'logox', title: 'Next request'}),
    d('tech2', {title: 'Next build', status: 'running', parentId: 'R4', rootId: 'R4'})];
  const next = taskGraph(undefined, more, 's')!;
  for (const [id, delegation] of first.delegationOf) assert.equal(next.delegationOf.get(id), delegation, id + ' keeps its delegation');
  assert.deepEqual(ids(next), ['1', '1.1', '1.1.1', '1.1.2', '1.2', '1.3', '1.3.1', '2', '2.1']);
  assert.equal(by(next, '2').title, 'Next request');
  // The same input gives the same graph.
  assert.deepEqual(taskGraph(undefined, more, 's'), next);
});

test('three levels at most: work below a level-3 node is linked to it as its work, the node follows it and shows its workers', () => {
  const given = plan([node('1'), node('1.1'), node('1.1.1', {links: [{activityId: 'deep'}]})]);
  const work = [d('R', {kind: 'director', ownerId: 'logox'}), d('deep', {status: 'completed', parentId: 'R', rootId: 'R'}),
    job('deep', 'T1', {status: 'failed', title: 'Extra'}), job('deep', 'T2', {status: 'running', title: 'More', startedAt: 5})];
  const graph = taskGraph(given, work, 's')!;
  assert.deepEqual(ids(graph), ['1', '1.1', '1.1.1'], 'no fourth level');
  assert.equal(graph.synthetic.size, 0);
  const deep = by(graph, '1.1.1');
  assert.deepEqual(deep.links, [{activityId: 'deep'}, {automaJob: 'deep/T1'}, {automaJob: 'deep/T2'}]);
  assert.equal(deep.status, 'running');
  assert.deepEqual(deep.work.map(item => item.id), ['deep', 'deep/T1', 'deep/T2']);
  // A synthesized level-3 task folds its own descendants the same way.
  const free = taskGraph(undefined, [d('R', {kind: 'director', ownerId: 'logox'}), d('a', {parentId: 'R', rootId: 'R'}), job('a', 'T1'), d('b', {parentId: 'a', rootId: 'R', title: 'Nested'}), job('b', 'T1', {title: 'Below'})], 's')!;
  assert.deepEqual(ids(free), ['1', '1.1', '1.1.1', '1.1.2']);
  assert.ok(ids(free).every(id => id.split('.').length <= 3));
  assert.ok(by(free, '1.1.2').links.some(link => link.automaJob === 'b/T1'), 'the job below the third level is linked to its level-3 task');
});

test('a delegation whose root has no record stands as a phase of its own', () => {
  const graph = taskGraph(undefined, [d('lone', {rootId: 'gone', title: 'Old task', status: 'completed'})], 's')!;
  assert.deepEqual(graph.plan.nodes.map(item => [item.id, item.title, item.status]), [['1', 'Old task', 'done']]);
});
