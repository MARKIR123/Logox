import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import {endedWithoutResult, projectDelegations, withoutStatusLine, type Delegation} from '../src/runtime/delegations.js';
import {foldAttempts, taskGraph} from '../src/runtime/task-graph.js';

const d = (id: string, extra: Partial<Delegation> = {}): Delegation => ({id, kind: 'actor', ownerId: 'techne', title: id, status: 'completed', rootId: 'R', parentId: 'R', children: [], blockedBy: [],
  assignment: {title: extra.title ?? id, owns: [], acceptance: []}, ...extra});
const root = (): Delegation => d('R', {kind: 'director', ownerId: 'logox', title: 'Build the show', parentId: undefined as never});
/** Work that ended without a result: what an interrupt, a quota stop or an error leaves. */
const cut = (id: string, extra: Partial<Delegation> = {}): Delegation => d(id, {status: 'failed', stopReason: 'error', unfinished: true, ...extra});
const ids = (graph: ReturnType<typeof taskGraph>) => graph!.plan.nodes.map(item => item.id);
const by = (graph: ReturnType<typeof taskGraph>, id: string) => graph!.plan.nodes.find(item => item.id === id)!;

test('an actor re-dispatched after an unfinished attempt is one node: the earlier attempts fold into the last, its work stays linked', () => {
  const graph = taskGraph(undefined, [root(),
    cut('k1', {ownerId: 'kalon', title: 'Draw the scenes'}), cut('t1', {title: 'Build the page'}),
    d('t2', {title: 'Resume the page', resumes: 't1'}), d('k2', {ownerId: 'kalon', title: 'Resume the drawing', resumes: 'k1'}),
    d('a1', {ownerId: 'aletheia', title: 'Check it'})], 's')!;
  assert.deepEqual(ids(graph), ['1', '1.1', '1.2', '1.3'], 'one node per task, in the order the last attempts were made');
  assert.deepEqual(graph.plan.nodes.map(node => [node.id, node.owner, node.status]), [['1', 'logox', 'done'], ['1.1', 'techne', 'done'], ['1.2', 'kalon', 'done'], ['1.3', 'aletheia', 'done']]);
  assert.equal(graph.delegationOf.get('1.1'), 't2'); assert.equal(graph.delegationOf.get('1.2'), 'k2');
  assert.deepEqual(Object.fromEntries(graph.attempts), {'1.1': ['t1'], '1.2': ['k1']});
  assert.deepEqual(by(graph, '1.1').links, [{activityId: 't1'}, {activityId: 't2'}], 'the earlier attempt is linked before the last so the latest outcome decides');
  assert.deepEqual(by(graph, '1').leaves, {done: 3, failed: 0, interrupted: 0, total: 3}, 'the phase is complete and not failed');
});

test('without a resume link the next delegation of the same actor under the same root takes over an unfinished one; others never fold', () => {
  const graph = taskGraph(undefined, [root(), cut('t1', {stopReason: 'interrupted', status: 'cancelled'}), d('k', {ownerId: 'kalon'}), d('t2')], 's')!;
  assert.deepEqual(ids(graph), ['1', '1.1', '1.2'], 'the kalon task stands, the two techne attempts are one');
  assert.deepEqual([...graph.attempts], [['1.2', ['t1']]]);
  // A later delegation that resumes something else is not an attempt of this one; a completed or genuinely failed one keeps its node.
  assert.deepEqual(ids(taskGraph(undefined, [root(), cut('t1'), d('t2', {resumes: 'other'})], 's')), ['1', '1.1', '1.2']);
  assert.deepEqual(ids(taskGraph(undefined, [root(), d('t1'), d('t2')], 's')), ['1', '1.1', '1.2']);
  assert.deepEqual(ids(taskGraph(undefined, [root(), d('t1', {status: 'failed', stopReason: 'completed'}), d('t2')], 's')), ['1', '1.1', '1.2'], 'a failure that reported is a result');
  assert.deepEqual(ids(taskGraph(undefined, [root(), cut('t1', {ownerId: 'kalon'}), d('t2')], 's')), ['1', '1.1', '1.2'], 'another actor does not continue it');
  assert.deepEqual(ids(taskGraph(undefined, [root(), cut('t1'), d('t2', {rootId: 'R2', parentId: 'R2'}), d('R2', {kind: 'director', ownerId: 'logox', rootId: 'R2', parentId: undefined as never})], 's')).slice(0, 3), ['1', '1.1', '2'],
    'a later request of the same actor is not a continuation');
});

test('chains of attempts fold into the last; the prerequisites and dependents of every attempt follow the node', () => {
  const graph = taskGraph(undefined, [root(), d('prep', {ownerId: 'kalon', title: 'Prepare'}),
    cut('t1', {after: ['prep']}), cut('t2', {resumes: 't1'}), d('t3', {resumes: 't2'}),
    d('after', {ownerId: 'aletheia', after: ['t1']})], 's')!;
  assert.deepEqual(ids(graph), ['1', '1.1', '1.2', '1.3']);
  assert.deepEqual([...graph.attempts], [['1.2', ['t1', 't2']]]);
  assert.equal(graph.delegationOf.get('1.2'), 't3');
  assert.deepEqual(by(graph, '1.2').after, ['1.1'], 'the prerequisite of the first attempt is the node\'s');
  assert.deepEqual(by(graph, '1.3').after, ['1.2'], 'a dependent of an earlier attempt waits for the node');
  assert.equal(foldAttempts([root(), cut('t1'), cut('t2'), d('t3')]).get('t1'), 't3');
});

test('unfinished work nobody took up again stays, read as interrupted and counted apart from failures; a failure with a result stays failed', () => {
  const graph = taskGraph(undefined, [root(), cut('t1', {stopReason: 'max_tokens'}), d('k', {ownerId: 'kalon', status: 'failed', stopReason: 'completed'}), d('a', {ownerId: 'aletheia'})], 's')!;
  assert.deepEqual(graph.plan.nodes.map(node => [node.id, node.status]), [['1', 'done'], ['1.1', 'interrupted'], ['1.2', 'failed'], ['1.3', 'done']]);
  assert.deepEqual(by(graph, '1').leaves, {done: 1, failed: 1, interrupted: 1, total: 3});
  // A phase whose every task was interrupted is itself unfinished; a failed round is the only way a phase fails.
  assert.equal(by(taskGraph(undefined, [root(), cut('t1')], 's')!, '1').status, 'interrupted');
  assert.equal(by(taskGraph(undefined, [{...root(), status: 'failed', stopReason: 'error'}, d('t1')], 's')!, '1').status, 'failed');
  assert.equal(by(taskGraph(undefined, [{...root(), status: 'cancelled', stopReason: 'interrupted', unfinished: true}, d('t1')], 's')!, '1').status, 'interrupted');
});

test('an earlier attempt that a plan node is linked to keeps its node (the plan owns the link); a live attempt is never folded', () => {
  assert.deepEqual([...foldAttempts([root(), cut('t1'), d('t2')], new Set(['t1']))], []);
  assert.deepEqual([...foldAttempts([root(), d('t1', {status: 'running'}), d('t2')])], []);
});

test('a continued Automa worker is one job: its id is the same, so the record holds one delegation with the latest state', () => {
  const store = new RuntimeStore();
  const base = {sessionId: 's', stage: '', detail: ''};
  store.activities.create({...base, activityId: 'R', ownerId: 'logox', kind: 'director', title: 'Scan', status: 'completed', rootActivityId: 'R'});
  store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne', status: 'completed', rootActivityId: 'R', parentActivityId: 'R'});
  const swarm = (state: 'failed' | 'done', summary: string): AutomaSwarm => ({name: 'crew', jobs: [{id: 'T1', title: 'Look', state, elapsedMs: 5, calls: [], summary, stopReason: state === 'done' ? 'completed' : 'interrupted'}]});
  store.message('s', 'techne', 'assistant', '', {activityId: 'tech', kind: 'tool', step: {title: 'Automa', state: 'completed', elapsedMs: 0, swarm: swarm('failed', '')}});
  store.message('s', 'techne', 'assistant', '', {activityId: 'tech', kind: 'tool', step: {title: 'Automa', state: 'completed', elapsedMs: 0, swarm: swarm('done', '⏵ working\nfound it')}});
  const rows = projectDelegations({snapshot: store.getSnapshot(), sessionId: 's'});
  assert.deepEqual(rows.filter(row => row.kind === 'automa').map(row => [row.id, row.status, row.result?.summary, row.unfinished]), [['tech/T1', 'done', 'found it', undefined]]);
  assert.equal(taskGraph(undefined, rows, 's')!.plan.nodes.filter(node => node.owner === 'automa').length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------- summaries
test('a leading status line is stripped from any text used as a summary', () => {
  assert.equal(withoutStatusLine('`⏵ Submitting the report`\nSir, the work is done.\nMore.'), 'Sir, the work is done.\nMore.');
  assert.equal(withoutStatusLine('⏵ one\n⏵ two\n\nBody'), 'Body');
  assert.equal(withoutStatusLine('Body ⏵ not leading'), 'Body ⏵ not leading');
  assert.equal(withoutStatusLine('⏵ only'), '');
});

function summaries() {
  const store = new RuntimeStore();
  const base = {sessionId: 's', stage: '', detail: ''};
  store.activities.create({...base, activityId: 'R', ownerId: 'logox', kind: 'director', title: 'Show', status: 'completed', rootActivityId: 'R'});
  store.activities.create({...base, activityId: 'W', ownerId: 'logox', kind: 'director', title: 'Wake', status: 'completed', rootActivityId: 'R', parentActivityId: 'R',
    summary: {title: 'The show is delivered', report: 'Kurios, the show is delivered.\nDetails.', source: 'model'}});
  const actor = (id: string, extra: Record<string, unknown> = {}) => store.activities.create({...base, activityId: id, ownerId: 'kalon', kind: 'actor', title: id, taskTitle: id, status: 'completed', rootActivityId: 'R', parentActivityId: 'R', ...extra} as never);
  actor('model', {summary: {title: 'Painted the scenes and checked them', report: '`⏵ Submitting`\nSir, a long report that opens like speech.', source: 'model'}});
  actor('local', {status: 'failed', stopReason: 'error', summary: {title: 'Failed; needs further handling', report: '`⏵ Waiting`\nSir, partial notes.', source: 'local'}});
  actor('none');
  store.message('s', 'kalon', 'assistant', 'Thinking about it', {activityId: 'none', kind: 'thinking'});
  store.message('s', 'kalon', 'assistant', '⏵ Closing\nThe patch is in place.', {activityId: 'none'});
  actor('mute');
  return projectDelegations({snapshot: store.getSnapshot(), sessionId: 's'});
}

test('the delegation summary is the structured round summary, else the report without its status line, else what the activity last said; never empty for a task that spoke', () => {
  const rows = summaries();
  const text = (id: string) => rows.find(row => row.id === id)?.result?.summary;
  assert.equal(text('model'), 'Painted the scenes and checked them', 'the structured summary line, not the status line or the opening of the raw report');
  assert.equal(rows.find(row => row.id === 'model')!.result?.final, true);
  assert.equal(text('local'), 'Sir, partial notes.', 'a runtime fallback title is not a summary');
  assert.equal(text('none'), 'The patch is in place.', 'no round summary: the last words, without reasoning or the status line');
  assert.equal(text('mute'), '', 'nothing at all was recorded');
  assert.equal(text('R'), 'The show is delivered', 'a Director round reads the summary of its latest continuation');
  assert.ok(![...rows].some(row => row.result?.summary.includes('⏵')));
});

test('unfinished and resumes are projected: a local fallback of a failed task is no result, a model summary is', () => {
  const rows = summaries();
  assert.equal(rows.find(row => row.id === 'local')!.unfinished, true);
  assert.equal(rows.find(row => row.id === 'model')!.unfinished, undefined);
  assert.equal(endedWithoutResult({status: 'failed', stopReason: 'completed'}), false);
  assert.equal(endedWithoutResult({status: 'cancelled'}), true);
  assert.equal(endedWithoutResult({status: 'running'}), false);
  assert.equal(endedWithoutResult({status: 'failed', stopReason: 'refusal'}), false);
});

test('every node of the work graph opens: a synthesized node names a delegation the record holds (a phase opens its Director round)', () => {
  const rows = summaries();
  const graph = taskGraph(undefined, rows, 's')!;
  assert.ok(graph.synthetic.size > 0);
  for (const id of graph.synthetic) {
    const target = graph.delegationOf.get(id);
    assert.ok(target && rows.some(row => row.id === target), 'node ' + id + ' opens ' + target);
  }
  assert.equal(graph.delegationOf.get('1'), 'R');
});
