import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPlanOp, applyPlanOps, derivePlan, nodeSignature, pathAndSubtree, planChanges, planDigest, renderOutline, workPhase, type Plan, type PlanEnv, type PlanOp} from '../src/runtime/plan.js';
import {PLAN_ACCEPT_NEEDS_EVIDENCE} from '../src/prompts/runtime/plan.js';

const env = (extra: Partial<PlanEnv> = {}): PlanEnv => ({now: 1000, sessionId: 's', planId: () => 'p1', knownOwners: ['logox', 'techne', 'kalon', 'aletheia'], ...extra});
const ok = (result: ReturnType<typeof applyPlanOp>): Plan => {assert.ok(result.ok, result.ok ? '' : result.error); return result.plan;};
const refused = (result: ReturnType<typeof applyPlanOp>): string => {assert.equal(result.ok, false, 'the op should be refused'); return result.ok ? '' : result.error;};

/** 1 Design (logox) { 1.1 Palette (kalon), 1.2 Contrast (aletheia) after 1.1 { 1.2.1 Check pairs (automa) } }, 2 Ship (techne). */
function sample(): Plan {
  let plan = ok(applyPlanOp(undefined, {op: 'create', title: 'Theme preview', nodes: [
    {title: 'Design', owner: 'logox', nodes: [{title: 'Palette', owner: 'kalon'}, {title: 'Contrast', owner: 'aletheia', after: ['1.1'], acceptance: ['ratio >= 4.5'], nodes: [{title: 'Check pairs', owner: 'automa'}]}]},
    {title: 'Ship', owner: 'techne'}]}, 'logox', env()));
  assert.equal(plan.nodes.length, 5);
  plan = {...plan};
  return plan;
}
const ids = (plan: Plan) => plan.nodes.map(node => node.id);

test('ids are assigned by the runtime in document order and never exceed three levels', () => {
  const plan = sample();
  assert.deepEqual(ids(plan), ['1', '1.1', '1.2', '1.2.1', '2']);
  assert.equal(plan.id, 'p1'); assert.equal(plan.status, 'active'); assert.equal(plan.sessionId, 's');
  const deep = refused(applyPlanOp(plan, {op: 'add', parent: '1.2.1', nodes: [{title: 'Too deep', owner: 'logox'}]}, 'logox', env()));
  assert.match(deep, /deeper than 3 levels/); assert.match(deep, /Fix:/);
  // A removed id is not reused while a later sibling exists; new siblings continue after the highest.
  const removed = ok(applyPlanOp(plan, {op: 'remove', id: '1.1'}, 'logox', env()));
  const added = ok(applyPlanOp(removed, {op: 'add', parent: '1', nodes: [{title: 'Again', owner: 'kalon'}]}, 'logox', env()));
  assert.ok(ids(added).includes('1.3') && !ids(added).includes('1.1'));
  // `after` entries naming a removed node are dropped with it.
  assert.deepEqual(added.nodes.find(node => node.id === '1.2')!.after, []);
  // Nested nodes deeper than three levels in one create are refused too.
  assert.match(refused(applyPlanOp(undefined, {op: 'create', title: 'x', nodes: [{title: 'a', owner: 'logox', nodes: [{title: 'b', owner: 'logox', nodes: [{title: 'c', owner: 'logox', nodes: [{title: 'd', owner: 'logox'}]}]}]}]}, 'logox', env())), /too deep|deeper/);
});

test('one active plan at a time, titles are cleaned, unknown ids and owners are refused with the fix', () => {
  const plan = sample();
  assert.match(refused(applyPlanOp(plan, {op: 'create', title: 'Another'}, 'logox', env())), /already active.*Fix:/);
  assert.match(refused(applyPlanOp(undefined, {op: 'add', nodes: [{title: 'x', owner: 'logox'}]}, 'logox', env())), /no active plan.*Fix:/i);
  assert.match(refused(applyPlanOp(plan, {op: 'update', id: '9'}, 'logox', env())), /Unknown node "9".*1, 1\.1/);
  assert.match(refused(applyPlanOp(plan, {op: 'add', parent: '1', nodes: [{title: 'x', owner: 'nobody'}]}, 'logox', env())), /Unknown owner "nobody"/);
  const cleaned = ok(applyPlanOp(plan, {op: 'update', id: '2', title: 'Ship <!-- n:9 -->\nit  now'}, 'logox', env()));
  assert.equal(cleaned.nodes.find(node => node.id === '2')!.title, 'Ship n:9 it now');
  assert.match(refused(applyPlanOp(plan, {op: 'update', id: '1.1', after: ['1.2']}, 'logox', env())), /wait for each other/);
  assert.match(refused(applyPlanOp(plan, {op: 'update', id: '1.1', after: ['1.1']}, 'logox', env())), /cannot wait for itself/);
  assert.match(refused(applyPlanOp(plan, {op: 'update', id: '1.1', after: ['7']}, 'logox', env())), /unknown node "7"/);
  assert.match(refused(applyPlanOp(plan, {op: 'create', title: ''}, 'logox', env({}))), /already active/);
});

test('permission matrix: Director and user do anything; a companion works only under a node it owns', () => {
  const plan = sample();
  // The Director and the person.
  for (const actor of ['logox', 'user']) ok(applyPlanOp(plan, {op: 'update', id: '1.1', owner: 'techne', title: 'Palette v2'}, actor, env()));
  // A companion may split its own node for itself or automa.
  const mine = ok(applyPlanOp(plan, {op: 'add', parent: '1.1', nodes: [{title: 'Sample rows', owner: 'kalon'}, {title: 'Scan colours', owner: 'automa'}]}, 'kalon', env()));
  assert.deepEqual(ids(mine), ['1', '1.1', '1.1.1', '1.1.2', '1.2', '1.2.1', '2']);
  assert.match(refused(applyPlanOp(plan, {op: 'add', parent: '1.1', nodes: [{title: 'x', owner: 'techne'}]}, 'kalon', env())), /can belong to you or to automa/);
  // ...but not under another companion's node or at the top.
  assert.match(refused(applyPlanOp(plan, {op: 'add', parent: '1.2', nodes: [{title: 'x', owner: 'kalon'}]}, 'kalon', env())), /not under a node you own/);
  assert.match(refused(applyPlanOp(plan, {op: 'add', nodes: [{title: 'x', owner: 'kalon'}]}, 'kalon', env())), /Only the Director/);
  assert.match(refused(applyPlanOp(plan, {op: 'create', title: 'x'}, 'kalon', env())), /Only the Director creates/);
  // A node under one it owns may be changed and removed; its own node only gets a note.
  const sub = ok(applyPlanOp(plan, {op: 'add', parent: '1.2', nodes: [{title: 'Gamma', owner: 'aletheia'}]}, 'aletheia', env()));
  ok(applyPlanOp(sub, {op: 'update', id: '1.2.2', title: 'Gamma check', owner: 'automa'}, 'aletheia', env()));
  ok(applyPlanOp(sub, {op: 'remove', id: '1.2.2'}, 'aletheia', env()));
  ok(applyPlanOp(plan, {op: 'update', id: '1.2', note: 'half done'}, 'aletheia', env()));
  assert.match(refused(applyPlanOp(plan, {op: 'update', id: '1.2', title: 'Mine'}, 'aletheia', env())), /Only your own note/);
  assert.match(refused(applyPlanOp(plan, {op: 'remove', id: '1.2'}, 'aletheia', env())), /not under a node you own/);
  // Another companion's nodes, and owners it does not own.
  assert.match(refused(applyPlanOp(plan, {op: 'update', id: '1.1', title: 'Hijack'}, 'aletheia', env())), /not under a node you own/);
  assert.match(refused(applyPlanOp(plan, {op: 'update', id: '2', owner: 'aletheia'}, 'aletheia', env())), /not under a node you own/);
  assert.match(refused(applyPlanOp(plan, {op: 'abandon'}, 'kalon', env())), /Only the Director changes the whole plan/);
  assert.match(refused(applyPlanOp(plan, {op: 'abandon', id: '2'}, 'kalon', env())), /not under a node you own/);
});

test('accept: only the owner of the parent (the Director for top-level nodes), and only on evidence', () => {
  const plan = sample();
  // A companion cannot accept its own node, nor a top-level one; the Director can.
  assert.match(refused(applyPlanOp(plan, {op: 'accept', id: '1.1', evidence: ['done']}, 'kalon', env())), /cannot accept your own node 1\.1.*logox/);
  assert.match(refused(applyPlanOp(plan, {op: 'accept', id: '2', evidence: ['done']}, 'techne', env())), /Only the Director accepts top-level node 2/);
  assert.match(refused(applyPlanOp(plan, {op: 'accept', id: '1.1', evidence: ['done']}, 'aletheia', env())), /Only the owner of 1/);
  // The owner of a node accepts its children.
  const second = ok(applyPlanOp(plan, {op: 'accept', id: '1.2.1', evidence: ['pairs checked']}, 'aletheia', env()));
  assert.deepEqual(second.nodes.find(node => node.id === '1.2.1')!.accepted, {by: 'aletheia', at: 1000, evidence: ['pairs checked']});
  // Evidence: given, else read from the linked work, else refused with the exact sentence.
  assert.equal(refused(applyPlanOp(plan, {op: 'accept', id: '1.1'}, 'logox', env())), PLAN_ACCEPT_NEEDS_EVIDENCE);
  assert.equal(refused(applyPlanOp(plan, {op: 'accept', id: '1.1', evidence: ['  ', '']}, 'logox', env())), PLAN_ACCEPT_NEEDS_EVIDENCE);
  const filled = ok(applyPlanOp(plan, {op: 'accept', id: '1.1'}, 'logox', env({evidence: id => id === '1.1' ? ['Changed by Kalon: theme.ts', 'Ran: npm run check (exit 0)'] : undefined})));
  assert.deepEqual(filled.nodes.find(node => node.id === '1.1')!.accepted!.evidence, ['Changed by Kalon: theme.ts', 'Ran: npm run check (exit 0)']);
  // Reopening needs the same standing; an abandoned node cannot be accepted before it is reopened.
  const accepted = ok(applyPlanOp(plan, {op: 'accept', id: '1.1', evidence: ['x']}, 'logox', env()));
  assert.match(refused(applyPlanOp(accepted, {op: 'reopen', id: '1.1'}, 'kalon', env())), /Only the owner of 1/);
  assert.equal(ok(applyPlanOp(accepted, {op: 'reopen', id: '1.1'}, 'logox', env())).nodes.find(node => node.id === '1.1')!.accepted, undefined);
  const abandoned = ok(applyPlanOp(plan, {op: 'abandon', id: '1.1'}, 'logox', env()));
  assert.match(refused(applyPlanOp(abandoned, {op: 'accept', id: '1.1', evidence: ['x']}, 'logox', env())), /abandoned.*reopen/);
});

test('a plan completes when every live top-level node is accepted, and reopening revives it; abandon ends it', () => {
  let plan = sample();
  const accept = (id: string, actor = 'logox') => {plan = ok(applyPlanOp(plan, {op: 'accept', id, evidence: ['ok']}, actor, env()));};
  accept('1'); assert.equal(plan.status, 'active');
  accept('2'); assert.equal(plan.status, 'done');
  plan = ok(applyPlanOp(plan, {op: 'reopen', id: '2'}, 'logox', env()));
  assert.equal(plan.status, 'active');
  // A node counts as accepted when every live child is, so accepting the children completes it.
  let tree = sample();
  for (const id of ['1.1', '1.2.1']) tree = ok(applyPlanOp(tree, {op: 'accept', id, evidence: ['ok']}, id === '1.1' ? 'logox' : 'aletheia', env()));
  tree = ok(applyPlanOp(tree, {op: 'abandon', id: '2'}, 'logox', env()));
  tree = ok(applyPlanOp(tree, {op: 'accept', id: '1.2', evidence: ['ok']}, 'logox', env()));
  assert.equal(tree.status, 'done');
  const ended = ok(applyPlanOp(plan, {op: 'abandon'}, 'logox', env()));
  assert.equal(ended.status, 'abandoned');
  assert.match(refused(applyPlanOp(ended, {op: 'update', id: '1', title: 'x'}, 'logox', env())), /abandoned/);
});

test('ops are atomic: the first refusal applies nothing and names the op', () => {
  const plan = sample();
  const ops: PlanOp[] = [{op: 'update', id: '2', title: 'Ship it'}, {op: 'remove', id: '42'}];
  const result = applyPlanOps(plan, ops, 'logox', env());
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /^Op 2 \(remove\) was refused: Unknown node "42".*Nothing was applied\.$/);
  assert.equal(plan.nodes.find(node => node.id === '2')!.title, 'Ship');
  const both = applyPlanOps(plan, [{op: 'update', id: '2', title: 'Ship it'}, {op: 'accept', id: '2', evidence: ['x']}], 'logox', env());
  assert.ok(both.ok && both.touched.includes('2') && both.lines.length === 2);
});

test('remove is refused while linked work is in progress', () => {
  const plan = ok(applyPlanOp(sample(), {op: 'update', id: '1.1', note: 'x'}, 'logox', env()));
  const linked: Plan = {...plan, nodes: plan.nodes.map(node => node.id === '1.1' ? {...node, links: [{activityId: 'act_1'}]} : node)};
  const derived = derivePlan(linked, [{id: 'act_1', status: 'running'}]);
  const byId = new Map(derived.nodes.map(node => [node.id, node] as const));
  const status = (id: string) => byId.get(id)?.status;
  const text = refused(applyPlanOp(linked, {op: 'remove', id: '1'}, 'logox', env({status, active: id => byId.get(id)?.work.map(item => item.id) ?? []})));
  assert.match(text, /linked work in progress \(act_1\).*Fix:/);
  ok(applyPlanOp(linked, {op: 'remove', id: '2'}, 'logox', env({status})));
});

test('work phases map every activity and job status', () => {
  assert.deepEqual(['running', 'queued', 'waiting_input', 'paused', 'waiting', 'blocked', 'completed', 'done', 'failed', 'cancelled', 'denied', 'skipped', 'interrupted'].map(workPhase),
    ['running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'completed', 'completed', 'failed', 'failed', 'failed', 'failed', 'failed']);
});

test('statuses are derived from linked work and roll up through parents', () => {
  const base = sample();
  const link = (...pairs: [string, string][]): Plan => ({...base, nodes: base.nodes.map(node => ({...node, links: pairs.filter(([id]) => id === node.id).map(([, work]) => work.includes('/') ? {automaJob: work} : {activityId: work})}))});
  const status = (plan: Plan, work: {id: string; status: string}[]) => Object.fromEntries(derivePlan(plan, work).nodes.map(node => [node.id, node.status]));

  // Nothing linked: a node whose prerequisites are open is pending, the rest are ready; parents are ready while nothing runs.
  assert.deepEqual(status(base, []), {'1': 'ready', '1.1': 'ready', '1.2': 'pending', '1.2.1': 'ready', '2': 'ready'});
  // Live work: running wins over waiting; a parent runs when a child runs.
  assert.deepEqual(status(link(['1.1', 'a1']), [{id: 'a1', status: 'running'}]), {'1': 'running', '1.1': 'running', '1.2': 'pending', '1.2.1': 'ready', '2': 'ready'});
  assert.equal(status(link(['1.1', 'a1']), [{id: 'a1', status: 'waiting_input'}])['1.1'], 'waiting');
  assert.equal(status(link(['1.1', 'a1']), [{id: 'a1', status: 'queued'}])['1'], 'waiting');
  // Done work makes the prerequisite satisfied: 1.2 becomes ready, 1.1 is done (not accepted).
  const done = status(link(['1.1', 'a1']), [{id: 'a1', status: 'completed'}]);
  assert.equal(done['1.1'], 'done'); assert.equal(done['1.2'], 'ready');
  // Failure: a failed activity with nothing newer is failed; a newer completed link replaces it; a newer running one shows running.
  assert.equal(status(link(['1.1', 'a1']), [{id: 'a1', status: 'failed'}])['1.1'], 'failed');
  assert.equal(status(link(['1.1', 'a1']), [{id: 'a1', status: 'cancelled'}])['1'], 'failed');
  assert.equal(status(link(['1.1', 'a1'], ['1.1', 'a2']), [{id: 'a1', status: 'failed'}, {id: 'a2', status: 'completed'}])['1.1'], 'done');
  assert.equal(status(link(['1.1', 'a1'], ['1.1', 'a2']), [{id: 'a1', status: 'failed'}, {id: 'a2', status: 'running'}])['1.1'], 'running');
  assert.equal(status(link(['1.1', 'a1'], ['1.1', 'a2']), [{id: 'a1', status: 'completed'}, {id: 'a2', status: 'failed'}])['1.1'], 'failed');
  // Automa jobs link by `<activity>/<job>`; unknown links count for nothing.
  assert.equal(status(link(['1.2.1', 'a9/T1']), [{id: 'a9/T1', status: 'done'}])['1.2.1'], 'done');
  assert.equal(status(link(['1.2.1', 'gone']), [])['1.2.1'], 'ready');
  // Roll-up: all children accepted -> accepted; all done -> done; a failed child with none running fails the parent; running beats failed.
  const accepted: Plan = {...base, nodes: base.nodes.map(node => ['1.1', '1.2.1'].includes(node.id) ? {...node, accepted: {by: 'logox', at: 1, evidence: ['x']}} : node)};
  const rolled = Object.fromEntries(derivePlan(accepted, []).nodes.map(node => [node.id, node.status]));
  assert.equal(rolled['1.2'], 'accepted'); assert.equal(rolled['1'], 'accepted'); assert.equal(rolled['2'], 'ready');
  const mixed = status(link(['1.1', 'a1'], ['1.2.1', 'j1/T1']), [{id: 'a1', status: 'failed'}, {id: 'j1/T1', status: 'running'}]);
  assert.equal(mixed['1'], 'running');
  assert.equal(status(link(['1.1', 'a1'], ['1.2.1', 'j1/T1']), [{id: 'a1', status: 'failed'}, {id: 'j1/T1', status: 'done'}])['1'], 'failed');
  assert.equal(status(link(['1.1', 'a1'], ['1.2.1', 'j1/T1']), [{id: 'a1', status: 'completed'}, {id: 'j1/T1', status: 'done'}])['1'], 'done');
  // Abandoned nodes leave their parent's roll-up and count as satisfied prerequisites.
  const dropped = ok(applyPlanOp(base, {op: 'abandon', id: '1.1'}, 'logox', env()));
  assert.equal(derivePlan(dropped, []).nodes.find(node => node.id === '1.2')!.status, 'ready');
  assert.equal(derivePlan(dropped, []).nodes.find(node => node.id === '1.1')!.status, 'abandoned');
});

test('progress counts and the outline', () => {
  const base = sample();
  const plan: Plan = {...base, nodes: base.nodes.map(node => node.id === '1.1' ? {...node, accepted: {by: 'logox', at: 1, evidence: ['x']}} : node)};
  const derived = derivePlan(plan, [{id: 'a1', status: 'running'}]);
  assert.deepEqual(derived.nodes.find(node => node.id === '1')!.progress, {accepted: 1, done: 1, total: 2});
  assert.deepEqual(derived.nodes.find(node => node.id === '1.2')!.progress, {accepted: 0, done: 0, total: 1});
  assert.equal(derived.nodes.find(node => node.id === '1.1')!.progress, undefined);
  assert.deepEqual(derived.progress, {accepted: 0, done: 0, total: 2});
  assert.deepEqual(derived.nodes.find(node => node.id === '1.2')!.blockedBy, []);
  const outline = renderOutline(derived);
  assert.match(outline, /^Plan p1 "Theme preview" \[active\] 0\/2 accepted/);
  assert.match(outline, /\n {2}1 Design \[ready\] logox 1\/2/);
  assert.match(outline, /\n {4}1\.1 Palette \[accepted\] kalon\n {6}- accepted by logox: x/);
  assert.match(outline, /- acceptance: ratio >= 4\.5/);
});

test('a companion is told its node path and subtree, nothing else', () => {
  const derived = derivePlan(sample(), []);
  const text = pathAndSubtree(derived, '1.2');
  assert.equal(text, ['Plan context:', '1 Design [ready] logox 0/2', '  1.2 Contrast [pending] aletheia after 1.1 0/1  <- your task', '    1.2.1 Check pairs [ready] automa'].join('\n').replace('0/2', '0/2'));
  assert.doesNotMatch(text, /Palette|Ship/);
  assert.equal(pathAndSubtree(derived, '2'), 'Plan context:\n2 Ship [ready] techne  <- your task');
});

test('the change feed lists only what others changed and ignores progress that is not news', () => {
  const plan = sample();
  const derived = (p: Plan, work: {id: string; status: string}[] = []) => derivePlan(p, work);
  const seen = planDigest(derived(plan));
  assert.deepEqual(planChanges(derived(plan), seen), []);
  // Progress between ready, running and waiting is not news; done, failed and accepted are.
  const linked: Plan = {...plan, nodes: plan.nodes.map(node => node.id === '1.1' ? {...node, links: [{activityId: 'a1'}]} : node)};
  assert.deepEqual(planChanges(derived(linked, [{id: 'a1', status: 'running'}]), seen), []);
  assert.deepEqual(planChanges(derived(linked, [{id: 'a1', status: 'completed'}]), seen), ['~ 1.1 Palette: done']);
  assert.deepEqual(planChanges(derived(linked, [{id: 'a1', status: 'failed'}]), seen), ['~ 1 Design: failed', '~ 1.1 Palette: failed']);
  // A companion adding a sub-step, retitling and removing.
  const grown = ok(applyPlanOp(plan, {op: 'add', parent: '1.1', nodes: [{title: 'Sample rows', owner: 'automa'}]}, 'kalon', env()));
  assert.deepEqual(planChanges(derived(grown), seen), ['+ 1.1.1 Sample rows [ready] automa (under 1.1)']);
  const renamed = ok(applyPlanOp(plan, {op: 'update', id: '1.1', title: 'Palette v2', owner: 'techne'}, 'logox', env()));
  assert.deepEqual(planChanges(derived(renamed), seen), ['~ 1.1 Palette v2: now "Palette v2", now techne\'s']);
  const shrunk = ok(applyPlanOp(plan, {op: 'remove', id: '2'}, 'logox', env()));
  assert.deepEqual(planChanges(derived(shrunk), seen), ['- 2 removed']);
  assert.notEqual(nodeSignature(derived(plan).nodes[0]!), nodeSignature(derived(renamed).nodes[1]!));
  // A long list is cut with a count.
  const many = ok(applyPlanOp(plan, {op: 'add', parent: '1.1', nodes: Array.from({length: 12}, (_, index) => ({title: 'S' + index, owner: 'automa'}))}, 'kalon', env()));
  const crowd = ok(applyPlanOp(many, {op: 'add', parent: '2', nodes: Array.from({length: 12}, (_, index) => ({title: 'T' + index, owner: 'techne'}))}, 'logox', env()));
  const lines = planChanges(derived(crowd), seen);
  assert.equal(lines.length, 21); assert.match(lines.at(-1)!, /^\.\.\. and 4 more changed nodes\.$/);
});
