import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {actorCall, barrier, delegationFixture} from './delegation-fixture.js';
import {projectDelegations} from '../src/runtime/delegations.js';
import {waitFor} from './wait-for.js';
import {PlanBoard} from '../src/store/plans.js';
import {NO_PLAN_NOTE} from '../src/tools/orchestration/ActorTool/prompt.js';
import {renderBriefCheckInput} from '../src/tools/orchestration/ActorTool/brief-check.js';
import type {RuntimeStore} from '../src/runtime/store.js';

const planCall = (args: unknown) => ({id: 'plan', name: 'Plan', arguments: JSON.stringify(args)});

async function fixture(execute: Parameters<typeof delegationFixture>[0], concurrency: 'serial' | 'actor' = 'actor') {
  const project = await mkdtemp(join(tmpdir(), 'logox-plan-link-'));
  const holder: {store?: RuntimeStore} = {};
  const plans = new PlanBoard({cwd: project, sessionId: 's', work: () => holder.store ? projectDelegations({snapshot: holder.store.getSnapshot(), sessionId: 's'}) : [],
    workRevision: () => holder.store?.getSnapshot().revision ?? 0, evidence: async node => ['Reported: ' + node.title], knownOwners: () => ['logox', 'techne', 'kalon', 'aletheia']});
  const f = await delegationFixture(execute, {plans}, concurrency);
  holder.store = f.store;
  return {...f, plans, async close() {await f.close(); await rm(project, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}
const statuses = (plans: PlanBoard) => Object.fromEntries(plans.active()!.nodes.map(node => [node.id, node.status]));

test('an Actor task with node links its activity: the node follows the work, the origin keeps the node, the assignment carries only path and subtree', async () => {
  const prompts: string[] = [];
  const release = barrier(), running = barrier();
  let receipt = '', plans!: PlanBoard;
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') {
      const created = await services.execute(planCall({op: 'create', title: 'Theme', nodes: [
        {title: 'Design', owner: 'techne', nodes: [{title: 'Palette', owner: 'techne'}, {title: 'Contrast', owner: 'techne', after: ['1.1']}]}, {title: 'Ship', owner: 'kalon'}]}), context);
      assert.equal(created.isError, false, created.text);
      receipt = (await services.execute(actorCall([{ownerId: 'techne', title: 'Palette work', prompt: 'build the palette', node: '1.1'}, {ownerId: 'kalon', title: 'Ship work', prompt: 'ship it', node: '2'}],
        {briefCheck: 'skip'}), context)).text;
      return;
    }
    prompts.push(prompt);
    if (prompt.startsWith('build the palette')) {running.resolve(); await release.promise;}
  });
  plans = f.plans;
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    assert.match(receipt, /^Dispatched to/, receipt);
    await running.promise;
    assert.doesNotMatch(receipt, /No plan yet/);
    const activities = f.store.getSnapshot().activities;
    const techne = activities.find(activity => activity.ownerId === 'techne')!, kalon = activities.find(activity => activity.ownerId === 'kalon')!;
    assert.equal(techne.planNode, '1.1'); assert.equal(kalon.planNode, '2');
    assert.deepEqual(plans.active()!.nodes.find(node => node.id === '1.1')!.links, [{activityId: techne.activityId}]);
    assert.equal(statuses(plans)['1.1'], 'running');
    assert.equal(statuses(plans)['1.2'], 'pending');
    // Each companion is told its own node: path from the root, the node and its subtree; nothing else of the plan.
    const techneBrief = prompts.find(prompt => prompt.startsWith('build the palette'))!;
    assert.match(techneBrief, /build the palette\n\nPlan context:\n1 Design \[[a-z]+\] techne 0\/2\n {2}1\.1 Palette \[ready\] techne {2}<- your task/);
    assert.doesNotMatch(techneBrief.split('[Teammates')[0]!, /Contrast|Ship/);
    await waitFor(() => prompts.length, count => count >= 2, {label: 'kalon started'});
    const kalonBrief = prompts.find(prompt => prompt.startsWith('ship it'))!;
    assert.match(kalonBrief, /Plan context:\n2 Ship \[ready\] kalon {2}<- your task/);
    assert.doesNotMatch(kalonBrief.split('[Teammates')[0]!, /Design|Palette/);
    release.resolve();
    await f.idle();
    // Completed work: the node is done (not accepted), its dependent becomes ready, and the file says so after an accept on evidence.
    assert.equal(statuses(plans)['1.1'], 'done'); assert.equal(statuses(plans)['1.2'], 'ready');
    assert.equal(statuses(plans)['2'], 'done');
    const accepted = await plans.apply([{op: 'accept', id: '2'}], 'logox');
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.error);
    assert.ok(accepted.ok && accepted.plan.nodes.find(node => node.id === '2')!.accepted!.evidence.length > 0, 'evidence was read from the linked work');
  } finally {release.resolve(); await f.close();}
});

test('a node the plan does not have is refused with the fix, and so is any node without a plan; two tasks without a plan get the advisory line once', async () => {
  const seen: string[] = [];
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') {
      seen.push((await services.execute(actorCall([{ownerId: 'techne', prompt: 'a', node: '3'}], {briefCheck: 'skip'}), context)).text);
      seen.push((await services.execute(actorCall([{ownerId: 'techne', prompt: 'one', title: 'One'}, {ownerId: 'kalon', prompt: 'two', title: 'Two'}], {briefCheck: 'skip'}), context)).text);
      seen.push((await services.execute(actorCall([{ownerId: 'techne', prompt: 'solo', title: 'Solo'}], {briefCheck: 'skip'}), context)).text);
      await services.execute(planCall({op: 'create', title: 'P', nodes: [{title: 'Only', owner: 'techne'}]}), context);
      seen.push((await services.execute(actorCall([{ownerId: 'techne', prompt: 'b', node: '4'}], {briefCheck: 'skip'}), context)).text);
      seen.push((await services.execute(actorCall([{ownerId: 'techne', prompt: 'c', title: 'C'}, {ownerId: 'kalon', prompt: 'd', title: 'D'}], {briefCheck: 'skip'}), context)).text);
    }
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    await f.idle();
    assert.equal(seen[0], 'Unknown plan node "3": there is no active plan. Fix: create one with Plan first, or omit node.');
    assert.ok(seen[1]!.endsWith('\n' + NO_PLAN_NOTE), seen[1]);
    assert.equal(seen[1]!.split(NO_PLAN_NOTE).length, 2);
    assert.doesNotMatch(seen[2]!, /No plan yet/, 'one task is not work in several parts');
    assert.match(seen[3]!, /^Unknown plan node "4"\. Fix: pass a node id of the active plan \(1\)/);
    assert.doesNotMatch(seen[4]!, /No plan yet/, 'a plan exists now');
    assert.equal(f.plans.active()!.nodes[0]!.links.length, 0, 'a refused dispatch links nothing');
  } finally {await f.close();}
});

test('a companion splits the node it owns; it cannot touch the others, accept its own node, or create a plan; a worker never sees Plan', async () => {
  const out: string[] = [];
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === 'start') {
      await services.execute(planCall({op: 'create', title: 'P', nodes: [{title: 'Build', owner: 'techne'}, {title: 'Paint', owner: 'kalon'}]}), context);
      await services.execute(actorCall([{ownerId: 'techne', prompt: 'build', title: 'Build', node: '1'}], {briefCheck: 'skip'}), context);
    }
    if (prompt.startsWith('build')) {
      out.push((await services.execute(planCall({op: 'add', parent: '1', nodes: [{title: 'Parser', owner: 'techne'}, {title: 'Scan', owner: 'automa'}]}), context)).text);
      out.push((await services.execute(planCall({op: 'update', id: '2', title: 'Mine now'}), context)).text);
      out.push((await services.execute(planCall({op: 'accept', id: '1', evidence: ['x']}), context)).text);
      out.push((await services.execute(planCall({op: 'create', title: 'Other'}), context)).text);
      out.push((await services.execute(planCall({op: 'accept', id: '1.1', evidence: ['parser written']}), context)).text);
    }
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    await f.idle();
    assert.match(out[0]!, /^Added 1\.1 Parser \(techne\); 1\.2 Scan \(automa\)\./);
    assert.match(out[1]!, /not under a node you own/);
    assert.match(out[2]!, /Only the Director accepts top-level node 1/);
    assert.match(out[3]!, /Only the Director creates/);
    assert.match(out[4]!, /^Accepted 1\.1/);
    const plan = f.plans.active()!;
    assert.deepEqual(plan.nodes.map(node => node.id), ['1', '1.1', '1.2', '2']);
    assert.equal(plan.nodes.find(node => node.id === '1.1')!.accepted!.by, 'techne');
    // The Director reads the plan with no arguments; a companion's sub-step is part of it.
    // `Plan` with no arguments is the one place the whole plan is returned.
    assert.match(f.plans.describe(), /^Plan p1 "P" \[active\]/);
    assert.match(f.plans.describe(), /\n {4}1\.1 Parser \[accepted\] techne/);
  } finally {await f.close();}
});

test('the brief check reads the node a task names', () => {
  const text = renderBriefCheckInput({companions: ['Techne'], tasks: [{ownerId: 'techne', title: 'T', prompt: 'p', owns: [], acceptance: [], after: [],
    node: {id: '1.2', title: 'Contrast', owner: 'aletheia', acceptance: ['ratio >= 4.5']}}]});
  assert.match(text, /Plan node 1\.2: Contrast \(owner aletheia\)\nPlan acceptance:\n- ratio >= 4\.5/);
});
