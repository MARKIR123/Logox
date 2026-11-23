import test from 'node:test';
import assert from 'node:assert/strict';
import type {Delegation} from '../src/runtime/delegations.js';
import type {Plan, PlanNode} from '../src/runtime/plan.js';
import {taskGraph} from '../src/runtime/task-graph.js';
import {actIndexAt, actModel, actProgress, actStatus, computeActs, directorCloses, eventsOfAct, finalScene, firstEventOf, plannedWork, programme, sceneAt, stepTarget} from '../src/runtime/team-acts.js';
import type {TeamEvent} from '../src/runtime/team-events.js';
import type {Activity, RuntimeSnapshot} from '../src/runtime/contracts.js';

const d = (id: string, extra: Partial<Delegation> = {}): Delegation => ({id, kind: 'actor', ownerId: 'techne', title: id, status: 'completed', rootId: id, children: [], blockedBy: [],
  assignment: {title: extra.title ?? id, owns: [], acceptance: []}, ...extra});
const job = (activity: string, jobId: string, extra: Partial<Delegation> = {}): Delegation => d(activity + '/' + jobId, {kind: 'automa', ownerId: 'techne', jobId, parentId: activity, rootId: 'R', status: 'done', ...extra});
const node = (id: string, extra: Partial<PlanNode> = {}): PlanNode => ({id, title: 'Node ' + id, owner: 'techne', after: [], acceptance: [], links: [], ...extra});

const T0 = Date.UTC(2026, 10, 20, 8, 0, 0);
/** The time of the n-th event of a story, and a moment halfway between it and the next. */
const time = (n: number): number => T0 + n * 60_000;
const between = (n: number): number => time(n) + 30_000;
let n = 0;
const ev = (event: Omit<TeamEvent, 'id' | 'at' | 'ref'> & {ref: string}): TeamEvent => ({id: 'e' + n, at: time(n++), ...event});
const user = (ref = 'm' + n): TeamEvent => ev({from: 'user', to: ['logox'], kind: 'user', text: 'words', ref});
const assign = (ref: string, ...to: string[]): TeamEvent => ev({from: 'logox', to, kind: 'assign', text: ref.toUpperCase() + ' ／ other', ref});
const message = (from: string, to: string): TeamEvent => ev({from, to: [to], kind: 'message', text: 'hi', ref: 'm' + n});
const report = (ref: string, from: string, status: 'done' | 'failed' | 'interrupted' = 'done'): TeamEvent => ev({from, to: ['logox'], kind: 'report', status, text: 'finished', ref});
const wait = (ref: string, from: string, on: string): TeamEvent => ev({from, to: [on], kind: 'waiting', text: 'waiting on ' + on, ref});
const workers = (ref: string, from: string): TeamEvent => ev({from, to: [], kind: 'workers', text: '1 worker', ref, items: [{title: 'scout', fork: false}]});
const result = (ref: string, dispatcher: string): TeamEvent => ev({from: 'automa', to: [dispatcher], kind: 'result', status: 'done', dispatcher, text: 'ok', ref});
const start = () => {n = 0;};
const actOf = (events: readonly TeamEvent[], closes: readonly number[]) => computeActs(events, closes).actOf;

// ---------------------------------------------------------------------------------------------------------------------------------- the acts
test('an act opens at the first dispatch after the person\'s request and closes with the Director\'s normal close once its work ended; the next dispatch opens act 2; a discussion in between belongs to none', () => {
  start();
  const events = [user(), assign('k1', 'kalon'), report('k1', 'kalon'), user(), message('kalon', 'techne'), user(), assign('t2', 'techne'), report('t2', 'techne')];
  const {spans, actOf: acts} = computeActs(events, [between(2), between(7)]);
  assert.deepEqual(spans.map(span => [span.first, span.dispatch, span.last, span.closedAt, span.works, span.seed]),
    [[0, 1, 2, between(2), ['k1'], 'K1'], [5, 6, 7, between(7), ['t2'], 'T2']]);
  assert.deepEqual(acts, [0, 0, 0, -1, -1, 1, 1, 1], 'the discussion (a person\'s post and a message) is in no act; the last request before the dispatch opens act 2');
});

test('a discussion that dispatches nothing opens no act, whatever the Director closes', () => {
  start();
  const events = [user(), user(), message('kalon', 'techne'), user()];
  const {spans, actOf: acts} = computeActs(events, [between(0), between(3)]);
  assert.deepEqual([spans.length, acts], [0, [-1, -1, -1, -1]]);
});

test('the person\'s interjection and a Director close while work still runs do not end the act; the close after the last report does', () => {
  start();
  const events = [user(), assign('k1', 'kalon'), user('steer'), report('k1', 'kalon'), assign('t2', 'techne'), report('t2', 'techne')];
  // The Director answered the interjection and ended its round at 2.5 while Kalon still worked; it closed again at 3.5 after the report, then t2 was dispatched.
  const {spans, actOf: acts} = computeActs(events, [between(2), between(3)]);
  assert.deepEqual(spans.map(span => [span.first, span.last, span.closedAt]), [[0, 3, between(3)], [4, 5, undefined]]);
  assert.deepEqual(acts, [0, 0, 0, 0, 1, 1], 'the interjection is in the act; the close at 2.5 is not one');
  // With no later close the first act simply stays open and the next dispatch joins it.
  assert.deepEqual(actOf(events, [between(2)]), [0, 0, 0, 0, 0, 0]);
});

test('a question to the person and the answer are part of the act', () => {
  start();
  const events = [user(), assign('k1', 'kalon'), wait('k1', 'kalon', 'user'), user('answer'), report('k1', 'kalon'), assign('t2', 'techne')];
  assert.deepEqual(actOf(events, [between(4)]), [0, 0, 0, 0, 0, 1]);
});

test('an Esc and the resume that follows stay in the act: an interrupted round has no normal close', () => {
  start();
  // Esc: Kalon is interrupted (a report with `interrupted`), the Director's round was cancelled (no close). The person says to continue; the same task is dispatched again.
  const events = [user(), assign('k1', 'kalon'), report('k1', 'kalon', 'interrupted'), user('continue'), assign('k1b', 'kalon'), report('k1b', 'kalon'), assign('t2', 'techne')];
  const {spans, actOf: acts} = computeActs(events, [between(5)]);
  assert.deepEqual(acts, [0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(spans[0]!.works, ['k1', 'k1b']);
  // Without any close after the resume the act is still open.
  assert.deepEqual(actOf(events, []), [0, 0, 0, 0, 0, 0, 0]);
});

test('background work keeps the act open past the Director\'s close; the Director\'s follow-up on its result is the same act', () => {
  start();
  const events = [user(), workers('t1/J1', 'techne'), assign('k3', 'kalon'), report('k3', 'kalon'), result('t1/J1', 'techne'), user('thanks'), assign('t9', 'techne')];
  // Closes: while the job ran (at 1.5 and 3.5), and after its result and the Director's reply to it (at 5.5). t9 is dispatched at 6.
  const {spans, actOf: acts} = computeActs(events, [between(1), between(3), between(5)]);
  assert.deepEqual(spans.map(span => [span.first, span.last, span.closedAt]), [[0, 5, between(5)], [6, 6, undefined]]);
  assert.deepEqual(acts, [0, 0, 0, 0, 0, 0, 1]);
  // A dispatch while the job still runs joins the act (k3 above was dispatched after the first close, before the job ended).
  assert.deepEqual(spans[0]!.works, ['t1/J1', 'k3']);
});

test('a close before the last dispatch or before the work ended is no close; an act whose work never reports never closes', () => {
  start();
  const events = [assign('k1', 'kalon'), report('k1', 'kalon'), assign('t2', 'techne'), report('t2', 'techne')];
  assert.deepEqual(actOf(events, [time(1) - 1]), [0, 0, 0, 0], 'the close came before the report');
  start();
  const never = [assign('k1', 'kalon'), assign('t2', 'techne')];
  assert.deepEqual(actOf(never, [between(1)]), [0, 0], 'k1 has no report: still running');
  // A batch names every delegation of the dispatch.
  start();
  const batch = [{...assign('k1', 'kalon', 'techne'), refs: ['k1', 't1']}, report('k1', 'kalon'), assign('t3', 'techne')];
  assert.deepEqual(actOf(batch, [between(1)]), [0, 0, 0], 't1 has no report yet');
});

test('continueAct: the first dispatch of a round that follows a natural close reopens that act instead of opening a new one; without the flag it is a new act', () => {
  start();
  const flagged = (event: TeamEvent): TeamEvent => ({...event, continueAct: true});
  const events = [user(), assign('k1', 'kalon'), report('k1', 'kalon'), user('follow-up'), flagged(assign('k2', 'kalon')), report('k2', 'kalon'), user(), assign('t3', 'techne')];
  const closes = [between(2), between(5)];
  const {spans, actOf: acts} = computeActs(events, closes);
  assert.deepEqual(acts, [0, 0, 0, 0, 0, 0, 1, 1], 'the follow-up request and its dispatch are act 1 again; the next round without the flag is act 2');
  assert.deepEqual(spans.map(span => [span.first, span.last, span.closedAt, span.works]), [[0, 5, between(5), ['k1', 'k2']], [6, 7, undefined, ['t3']]]);
  // The same story without the flag: two acts, and the follow-up request belongs to the second.
  const plain = events.map(({continueAct: _flag, ...event}): TeamEvent => event);
  assert.deepEqual(actOf(plain, closes), [0, 0, 0, 1, 1, 1, 2, 2]);
});

test('continueAct is ignored mid-act, on the very first dispatch, and for any dispatch that is not the first of its round; only the act that just closed reopens', () => {
  start();
  const flagged = (event: TeamEvent): TeamEvent => ({...event, continueAct: true});
  // Mid-act: the flagged dispatch joins the open act like any other.
  const mid = [assign('k1', 'kalon'), flagged(assign('t2', 'techne')), report('k1', 'kalon'), report('t2', 'techne'), assign('k3', 'kalon')];
  assert.deepEqual(actOf(mid, [between(3)]), [0, 0, 0, 0, 1]);
  // Nothing to continue: the first dispatch of the session opens act 1.
  start();
  assert.deepEqual(actOf([flagged(assign('k1', 'kalon')), report('k1', 'kalon')], [between(1)]), [0, 0]);
  // Only the previous act reopens: with three acts the flag on the third's first dispatch continues the second.
  start();
  const three = [assign('a', 'kalon'), report('a', 'kalon'), assign('b', 'kalon'), report('b', 'kalon'), flagged(assign('c', 'kalon')), report('c', 'kalon')];
  assert.deepEqual(actOf(three, [between(1), between(3), between(5)]), [0, 0, 1, 1, 1, 1]);
  // A flag on a workers dispatch counts the same.
  start();
  const jobs = [assign('a', 'kalon'), report('a', 'kalon'), {...workers('t1/J1', 'logox'), continueAct: true} as TeamEvent, result('t1/J1', 'logox')];
  assert.deepEqual(actOf(jobs, [between(1), between(3)]), [0, 0, 0, 0]);
});

test('the Director\'s normal closes are the finish times of its completed activities, interrupted or failed ones left out', () => {
  const base = {sessionId: 's', title: 't', stage: '', detail: '', version: 0, kind: 'director' as const, ownerId: 'logox'};
  const activity = (activityId: string, extra: Partial<Activity>): Activity => ({...base, activityId, status: 'completed', ...extra} as Activity);
  const snapshot = {revision: 1, pending: [], interactions: [], messages: [], activities: [
    activity('a', {finishedAt: 300}), activity('b', {finishedAt: 100, stopReason: 'completed'}), activity('c', {status: 'cancelled', finishedAt: 200, stopReason: 'cancelled_by_user'}),
    activity('d', {status: 'failed', finishedAt: 250}), activity('e', {status: 'running'}), activity('f', {finishedAt: 400, stopReason: 'interrupted'}),
    activity('g', {finishedAt: 500, sessionId: 'other'}), activity('h', {kind: 'actor', ownerId: 'techne', finishedAt: 600})]} as unknown as RuntimeSnapshot;
  assert.deepEqual(directorCloses(snapshot, 's'), [100, 300]);
});

// ---------------------------------------------------------------------------------------------------------------------------------- the model
/** A plan made inside the first act, worked in two acts; the last tasks have not started. */
function planned() {
  const plan: Plan = {id: 'p1', title: 'Pelican', status: 'active', createdAt: 0, updatedAt: 1, sessionId: 's', nodes: [
    node('1', {title: 'Draw', owner: 'logox'}), node('1.1', {title: 'Sketch pelican', owner: 'kalon', links: [{activityId: 'k1'}]}), node('1.2', {title: 'Build rider', links: [{activityId: 't1'}]}),
    node('2', {title: 'Animate', owner: 'logox'}), node('2.1', {title: 'Pedal loop', links: [{activityId: 't2'}, {automaJob: 't2/J1'}]}),
    node('2.2', {title: 'Review', owner: 'aletheia', after: ['2.1'], links: [{activityId: 'al'}]}), node('2.3', {title: 'Final check', owner: 'aletheia'}),
    node('3', {title: 'Ship', owner: 'logox'})]};
  const delegations = [d('R', {kind: 'director', ownerId: 'logox', title: 'Go'}),
    d('k1', {ownerId: 'kalon', parentId: 'R', rootId: 'R'}), d('t1', {parentId: 'R', rootId: 'R'}), d('t2', {parentId: 'R', rootId: 'R'}),
    d('al', {ownerId: 'aletheia', parentId: 'R', rootId: 'R', status: 'queued', after: ['t2']}), job('t2', 'J1', {title: 'scout'})];
  start();
  const events = [user('m0'), {...assign('k1', 'kalon', 'techne'), refs: ['k1', 't1']}, message('techne', 'kalon'), report('k1', 'kalon'), report('t1', 'techne'),
    user('m5'), assign('t2', 'techne'), workers('t2/J1', 'techne'), wait('al', 'aletheia', 'techne'), result('t2/J1', 'techne'), report('t2', 'techne')];
  const closes = [between(4)];
  const graph = taskGraph(plan, delegations, 's');
  return {events, graph, closes, model: actModel(graph, events, closes)};
}

test('a plan inside an act gives it its tasks: its phases are tasks, not acts; its title is the act\'s; a task with no work yet is in the act the plan is progressing in', () => {
  const {model} = planned();
  assert.deepEqual(model.acts.map(act => [act.index, act.title]), [[0, 'Pelican'], [1, 'Pelican']]);
  assert.deepEqual(model.actOf, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual([...model.nodeAct].sort(), [['1', 0], ['1.1', 0], ['1.2', 0], ['2', 1], ['2.1', 1], ['2.2', 1], ['2.3', 1], ['3', 1]]);
  assert.deepEqual(model.acts.map(act => act.leaves), [['1.1', '1.2'], ['2.1', '2.2', '2.3', '3']]);
  assert.deepEqual(eventsOfAct(model, 1).map(event => event.id), ['e5', 'e6', 'e7', 'e8', 'e9', 'e10']);
  assert.equal(eventsOfAct(model, 1), eventsOfAct(model, 1), 'the same array while the model is the same');
  assert.equal(plannedWork(model), true);
});

test('with no plan an act is titled by the Director\'s first assignment and its tasks are the delegations; the phase synthesized for a Director round is no task', () => {
  const delegations = [d('R', {kind: 'director', ownerId: 'logox', title: 'Fix the parser\nand its tests'}), d('a1', {ownerId: 'kalon', parentId: 'R', rootId: 'R', title: 'Draw'}),
    d('b1', {parentId: 'R', rootId: 'R', title: 'Code'}), d('R2', {kind: 'director', ownerId: 'logox', title: 'Polish it'}), d('c1', {ownerId: 'kalon', parentId: 'R2', rootId: 'R2', title: 'Polish'})];
  start();
  const events = [user(), {...assign('a1', 'kalon', 'techne'), refs: ['a1', 'b1']}, report('a1', 'kalon'), report('b1', 'techne'), message('techne', 'kalon'), user(), assign('c1', 'kalon'), report('c1', 'kalon')];
  const model = actModel(taskGraph(undefined, delegations, 's'), events, [between(3)]);
  assert.deepEqual(model.acts.map(act => act.title), ['A1', 'C1'], 'the first title of the first dispatch (the test\'s assign text is the upper-cased ref)');
  assert.deepEqual(model.actOf, [0, 0, 0, 0, -1, 1, 1, 1], 'the message after the close is a discussion in no act');
  assert.deepEqual([...model.nodeAct].sort(), [['1.1', 0], ['1.2', 0], ['2.1', 1]], 'no node for the Director\'s own round');
  assert.deepEqual(model.acts.map(act => act.leaves), [['1.1', '1.2'], ['2.1']]);
  assert.deepEqual(actProgress(model, model.acts[0]!, 3), {done: 2, failed: 0, interrupted: 0, total: 2});
  assert.equal(plannedWork(model), false);
  assert.deepEqual(programme(model).map(act => act.tasks.map(task => [task.title, task.depth, task.delegation])), [[['Draw', 0, 'a1'], ['Code', 0, 'b1']], [['Polish', 0, 'c1']]]);
});

test('no dispatch at all: no acts and nothing on stage', () => {
  start();
  const events = [user(), message('kalon', 'techne')];
  const model = actModel(undefined, events, []);
  assert.deepEqual([model.acts.length, model.actOf, actIndexAt(model, 1), sceneAt(model, 1).snapshot.actors.length], [0, [-1, -1], -1, 0]);
  assert.deepEqual(actModel(undefined, []).acts, []);
});

test('the act follows the replay point; an event in no act shows the last act at rest; stepping lands on the first event of the nearest act', () => {
  start();
  const events = [user(), assign('k1', 'kalon'), report('k1', 'kalon'), user(), user(), assign('t2', 'techne'), report('t2', 'techne'), user()];
  const delegations = [d('R', {kind: 'director', ownerId: 'logox'}), d('k1', {ownerId: 'kalon', parentId: 'R', rootId: 'R'}), d('t2', {parentId: 'R', rootId: 'R'})];
  const model = actModel(taskGraph(undefined, delegations, 's'), events, [between(2), between(6)]);
  assert.deepEqual(model.actOf, [0, 0, 0, -1, 1, 1, 1, -1]);
  assert.deepEqual([0, 2, 3, 4, 6, 7].map(index => actIndexAt(model, index)), [0, 0, 0, 1, 1, 1], 'the discussion after act 1 shows act 1 at rest; after act 2, act 2');
  assert.equal(actIndexAt(model, -1), 1);
  assert.deepEqual([stepTarget(model, 0, 1), stepTarget(model, 1, 1), stepTarget(model, 1, -1), stepTarget(model, 0, -1)], [4, undefined, 0, undefined]);
  assert.deepEqual([firstEventOf(model, 0), firstEventOf(model, 1)], [0, 4]);
  // At rest: the scene of act 1 as it ended (Kalon done), with the discussion event on top of nothing.
  const rest = sceneAt(model, 3);
  assert.deepEqual([rest.act, rest.at, rest.snapshot.actors.map(actor => [actor.id, actor.state])], [0, 2, [['kalon', 'done']]]);
});

test('an act\'s progress and status follow the replay point, not the present', () => {
  const {model} = planned();
  const [draw, animate] = model.acts as [typeof model.acts[number], typeof model.acts[number]];
  assert.deepEqual(actProgress(model, draw, 2), {done: 0, failed: 0, interrupted: 0, total: 2});
  assert.deepEqual(actProgress(model, draw, 3), {done: 1, failed: 0, interrupted: 0, total: 2});
  assert.deepEqual(actProgress(model, draw, 4), {done: 2, failed: 0, interrupted: 0, total: 2});
  assert.equal(actStatus(model, draw, 4), 'done');
  assert.equal(actStatus(model, draw, 3), 'running');
  assert.deepEqual(actProgress(model, animate, 9), {done: 0, failed: 0, interrupted: 0, total: 4});
  assert.deepEqual(actProgress(model, animate, 10), {done: 1, failed: 0, interrupted: 0, total: 4});
  // A failed report colours the act.
  const events = planned().events.map(event => event.id === 'e4' ? {...event, status: 'failed' as const} : event);
  const failed = actModel(planned().graph, events, planned().closes);
  assert.deepEqual(actProgress(failed, failed.acts[0]!, 4), {done: 1, failed: 1, interrupted: 0, total: 2});
  assert.equal(actStatus(failed, failed.acts[0]!, 4), 'failed');
});

test('each act is its own scene: only the actors of that act up to the replay point are on stage', () => {
  const {model} = planned();
  assert.deepEqual(sceneAt(model, 2).snapshot.actors.map(actor => actor.id), ['kalon', 'techne']);
  assert.deepEqual(sceneAt(model, 5).snapshot.actors.map(actor => actor.id), [], 'the person only: nobody of the new act yet');
  assert.deepEqual(sceneAt(model, 6).snapshot.actors.map(actor => actor.id), ['techne'], 'kalon of the first act has left the stage');
  assert.deepEqual(sceneAt(model, 8).snapshot.actors.map(actor => actor.id), ['techne', 'aletheia']);
  assert.equal(sceneAt(model, 8).act, 1);
  assert.equal(sceneAt(model, 2).snapshot.hasUser, true);
  assert.deepEqual(finalScene(model, 0).actors.map(actor => actor.id), ['kalon', 'techne']);
});

test('cards: the actor\'s task with n/m, the wait reason, done or failed, and the next task that has no work yet', () => {
  const {model} = planned();
  const card = (index: number, id: string) => sceneAt(model, index).snapshot.actors.find(actor => actor.id === id)!.card!;
  assert.deepEqual(card(1, 'kalon'), {title: 'Sketch pelican'});
  assert.deepEqual(card(3, 'kalon'), {title: 'Sketch pelican', outcome: 'done'}, 'its report settled the task');
  assert.deepEqual(card(3, 'techne'), {title: 'Build rider'});
  assert.deepEqual(card(4, 'techne'), {title: 'Build rider', outcome: 'done'});
  // Act 2 at the wait: Techne has a worker out (0 of 1 settled), Aletheia waits and has a task it has not started.
  assert.deepEqual(card(8, 'techne'), {title: 'Pedal loop', n: 0, m: 1});
  assert.deepEqual(card(8, 'aletheia'), {title: 'Review', wait: 'waits techne', next: 'Final check'});
  assert.deepEqual(card(9, 'techne'), {title: 'Pedal loop', n: 1, m: 1});
  assert.deepEqual(card(10, 'techne'), {title: 'Pedal loop', outcome: 'done'});
  assert.equal(card(10, 'aletheia').wait, undefined, 'the wait ended with the report');
  assert.equal(card(10, 'aletheia').next, 'Final check');
  // Failed work reads failed.
  const events = planned().events.map(event => event.id === 'e10' ? {...event, status: 'failed' as const} : event);
  const failed = actModel(planned().graph, events, planned().closes);
  assert.equal(sceneAt(failed, 10).snapshot.actors.find(actor => actor.id === 'techne')!.card!.outcome, 'failed');
});

test('the Programme: every act with its tasks, prerequisites by title, workers and the delegation behind unplanned work; an open act is marked', () => {
  const {model} = planned();
  const acts = programme(model);
  assert.deepEqual(acts.map(act => [act.index, act.title, act.status, act.open]), [[0, 'Pelican', 'done', false], [1, 'Pelican', 'running', true]]);
  assert.deepEqual(acts[0]!.tasks.map(task => [task.title, task.depth]), [['Draw', 0], ['Sketch pelican', 1], ['Build rider', 1]]);
  assert.deepEqual(acts[1]!.tasks.map(task => [task.title, task.depth, task.after, task.workers]),
    [['Animate', 0, [], 0], ['Pedal loop', 1, [], 1], ['Review', 1, ['Pedal loop'], 0], ['Final check', 1, [], 0], ['Ship', 0, [], 0]]);
  assert.deepEqual(acts[1]!.progress, {done: 1, failed: 0, interrupted: 0, total: 4});
  assert.ok(acts.every(act => act.tasks.every(task => task.delegation === undefined)), 'plan nodes carry no delegation');
});
