import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPlanOp, type Plan, type PlanEnv} from '../src/runtime/plan.js';
import {mergePlans, parsePlan, renderPlan} from '../src/runtime/plan-file.js';
import {PlanBoard} from '../src/store/plans.js';

const env: PlanEnv = {now: Date.parse('2026-11-20T10:00:00.000Z'), sessionId: 'sess 1', planId: () => 'p7', knownOwners: ['logox', 'kalon', 'aletheia', 'techne']};
function sample(): Plan {
  let result = applyPlanOp(undefined, {op: 'create', title: 'Add a theme preview page', nodes: [
    {title: 'Design — a "quoted" step', owner: 'logox', nodes: [{title: 'Sample rows and palette', owner: 'kalon', acceptance: ['contrast of every text pair ≥ 4.5', 'rows render in a terminal'],
      nodes: [{title: 'Scan colours', owner: 'automa'}]}, {title: 'Contrast algorithm', owner: 'aletheia', after: ['1.1']}]}, {title: 'Ship', owner: 'techne'}]}, 'logox', env);
  assert.ok(result.ok);
  let plan = result.plan;
  plan = {...plan, note: 'Remember the dark theme.', nodes: plan.nodes.map(node => node.id === '1.1' ? {...node, links: [{activityId: 'act_123'}, {automaJob: 'act_9/T1'}], note: 'palette first\nthen rows'} : node)};
  result = applyPlanOp(plan, {op: 'accept', id: '1.1', evidence: ['src/tui/panels/theme-sample.ts (+84 −12)', 'npm run check (exit 0)']}, 'logox', {...env, now: env.now + 5000});
  assert.ok(result.ok);
  result = applyPlanOp(result.plan, {op: 'accept', id: '1', evidence: ['all accepted']}, 'logox', {...env, now: env.now + 6000});
  assert.ok(result.ok);
  result = applyPlanOp(result.plan, {op: 'abandon', id: '2'}, 'logox', env);
  assert.ok(result.ok);
  return result.plan;
}

test('render and parse round-trip: ids, owners, links, prerequisites, acceptance, evidence, notes, marks', () => {
  const plan = sample();
  const text = renderPlan(plan);
  assert.match(text, /^# Add a theme preview page <!-- plan:p7 status:done session:sess%201 created:2026-11-20T10:00:00\.000Z updated:/);
  assert.match(text, /^## 1 Design — a "quoted" step <!-- n:1 owner:logox accepted:logox@2026-11-20T10:00:06\.000Z -->$/m);
  assert.match(text, /^- \[x\] 1\.1 Sample rows and palette — kalon <!-- n:1\.1 owner:kalon links:act_123,act_9\/T1 accepted:logox@2026-11-20T10:00:05\.000Z -->$/m);
  assert.match(text, /^ {2}- acceptance: contrast of every text pair ≥ 4\.5$/m);
  assert.match(text, /^ {2}- evidence: src\/tui\/panels\/theme-sample\.ts \(\+84 −12\)$/m);
  assert.match(text, /^- \[ \] 1\.2 Contrast algorithm — aletheia <!-- n:1\.2 owner:aletheia after:1\.1 -->$/m);
  assert.match(text, /^ {2}- \[ \] 1\.1\.1 Scan colours — automa <!-- n:1\.1\.1 owner:automa -->$/m);
  assert.match(text, /^## 2 Ship <!-- n:2 owner:techne abandoned:1 -->$/m);
  const parsed = parsePlan(text, 'p7.md');
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.normalized, false);
  assert.deepEqual(parsed.plan, plan);
  assert.equal(renderPlan(parsed.plan!), text, 'rendering what was parsed gives the same file');
});

test('unparseable lines are kept as notes and reported; an unticked box, a ticked box and a new line are honoured', () => {
  const text = [
    '# Plan <!-- plan:p3 status:active session:s created:2026-11-20T10:00:00.000Z -->',
    'A paragraph a person wrote above the nodes.',
    '',
    '## 1 Phase <!-- n:1 owner:logox -->',
    'some stray words',
    '- [x] 1.1 Ticked by a person — kalon <!-- n:1.1 owner:kalon -->',
    '- [ ] 1.2 Unticked by a person — kalon <!-- n:1.2 owner:kalon accepted:logox@2026-11-20T10:00:05.000Z -->',
    '- [ ] A new line without an id — aletheia',
    '  - acceptance: it works',
    '- evidence: stray evidence before any node is ignored gracefully',
  ].join('\n');
  const parsed = parsePlan(text, 'p3.md', 5000);
  assert.equal(parsed.normalized, true);
  assert.equal(parsed.issues.length, 2, parsed.issues.join('\n'));
  assert.match(parsed.issues[0]!, /^Plan file p3\.md line 2 was not understood and is kept as a note: A paragraph/);
  assert.match(parsed.issues[1]!, /line 5 .* some stray words/);
  const plan = parsed.plan!;
  assert.equal(plan.note, 'A paragraph a person wrote above the nodes.');
  assert.equal(plan.nodes.find(node => node.id === '1')!.note, 'some stray words');
  assert.deepEqual(plan.nodes.find(node => node.id === '1.1')!.accepted, {by: 'user', at: 5000, evidence: ['Marked done in the plan file.']});
  assert.equal(plan.nodes.find(node => node.id === '1.2')!.accepted, undefined, 'unticking a box reopens the node');
  const added = plan.nodes.find(node => node.title === 'A new line without an id')!;
  assert.equal(added.id, '1.3'); assert.equal(added.owner, 'aletheia'); assert.deepEqual(added.acceptance, ['it works']);
  // Once written back, the notes are ordinary note lines and nothing is reported again.
  const again = parsePlan(renderPlan(plan), 'p3.md', 5000);
  assert.deepEqual(again.issues, []); assert.equal(again.normalized, false);
  assert.deepEqual(again.plan, plan);
});

test('ids stay fixed: duplicates, orphans and cycles are repaired, not trusted', () => {
  const text = [
    '# Plan <!-- plan:p4 status:active session:s -->',
    '## 1 A <!-- n:1 owner:logox -->',
    '- [ ] 1.1 B — kalon <!-- n:1.1 owner:kalon after:1.2 -->',
    '- [ ] 1.2 C — kalon <!-- n:1.2 owner:kalon after:1.1,9 -->',
    '- [ ] 1.1 Duplicate id — kalon <!-- n:1.1 owner:kalon -->',
    '- [ ] 7.7 Orphan — kalon <!-- n:7.7 owner:kalon -->',
  ].join('\n');
  const {plan, issues, normalized} = parsePlan(text, 'p4.md', 1);
  assert.equal(normalized, true);
  assert.deepEqual(plan!.nodes.map(node => node.id), ['1', '1.1', '1.2', '1.3', '1.4']);
  assert.deepEqual(plan!.nodes.map(node => node.after), [[], [], [], [], []], 'a cycle and an unknown prerequisite lose their `after`');
  assert.ok(issues.some(issue => /lost its parent/.test(issue)) && issues.some(issue => /cycle/.test(issue)));
  assert.equal(parsePlan('no title here', 'x.md').plan, undefined);
});

test('three-way merge: a person edits text, the runtime edits links and marks, both survive', () => {
  const base = sample();
  const memory: Plan = {...base, nodes: base.nodes.map(node => node.id === '1.2' ? {...node, links: [{activityId: 'act_5'}], note: 'runtime note'} : node)};
  const edited = parsePlan(renderPlan(base).replace('Contrast algorithm — aletheia', 'Contrast maths — kalon').replace('- [ ] 1.2', '- [ ] 1.2').replace('rows render in a terminal', 'rows render in a terminal and a pipe'), 'p7.md').plan!;
  const withNew: Plan = {...edited, nodes: [...edited.nodes, {id: '3', title: 'Added by a person', owner: 'logox', after: [], acceptance: [], links: []}]};
  const merged = mergePlans(base, memory, withNew);
  const node = (id: string) => merged.nodes.find(item => item.id === id)!;
  assert.equal(node('1.2').title, 'Contrast maths'); assert.equal(node('1.2').owner, 'kalon');
  assert.deepEqual(node('1.2').links, [{activityId: 'act_5'}], 'the runtime link survives');
  assert.equal(node('1.2').note, 'runtime note');
  assert.deepEqual(node('1.1').acceptance, ['contrast of every text pair ≥ 4.5', 'rows render in a terminal and a pipe']);
  assert.ok(node('3'), 'a node a person added stays');
  // A node the person deleted goes; a node the runtime added stays; one the runtime removed stays gone unless the person edited it.
  const deleted: Plan = {...base, nodes: base.nodes.filter(item => item.id !== '1.1.1')};
  assert.equal(mergePlans(base, memory, deleted).nodes.some(item => item.id === '1.1.1'), false);
  const runtimeAdded: Plan = {...memory, nodes: [...memory.nodes, {id: '4', title: 'Runtime', owner: 'techne', after: [], acceptance: [], links: []}]};
  assert.ok(mergePlans(base, runtimeAdded, base).nodes.some(item => item.id === '4'));
  const runtimeRemoved: Plan = {...memory, nodes: memory.nodes.filter(item => item.id !== '2')};
  assert.equal(mergePlans(base, runtimeRemoved, base).nodes.some(item => item.id === '2'), false);
  // Both changed the same visible field: the file wins; both changed a runtime field: memory wins.
  const both = mergePlans(base, {...memory, nodes: memory.nodes.map(item => item.id === '1.2' ? {...item, title: 'Runtime title'} : item)}, withNew);
  assert.equal(both.nodes.find(item => item.id === '1.2')!.title, 'Contrast maths');
  const links = mergePlans(base, memory, {...withNew, nodes: withNew.nodes.map(item => item.id === '1.2' ? {...item, links: [{activityId: 'act_other'}]} : item)});
  assert.deepEqual(links.nodes.find(item => item.id === '1.2')!.links, [{activityId: 'act_5'}]);
});

async function board(extra: Partial<ConstructorParameters<typeof PlanBoard>[0]> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-plans-'));
  const notices: string[] = [];
  let clock = Date.parse('2026-11-20T10:00:00.000Z');
  const make = () => new PlanBoard({cwd, sessionId: 's1', work: () => [], knownOwners: () => ['logox', 'kalon', 'techne', 'aletheia'], notice: text => notices.push(text), now: () => ++clock, ...extra});
  return {cwd, notices, make, file: (id: string) => join(cwd, '.logox', 'plans', id + '.md'), async close() {await rm(cwd, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}

test('the board writes the file atomically after every change and a new board of the session loads it back', async () => {
  const f = await board();
  try {
    const plans = f.make();
    const created = await plans.apply([{op: 'create', title: 'Theme', nodes: [{title: 'Design', owner: 'logox'}, {title: 'Ship', owner: 'techne'}]}], 'logox');
    assert.ok(created.ok);
    assert.deepEqual(await readdir(join(f.cwd, '.logox', 'plans')), ['p1.md'], 'no temporary file is left behind');
    const first = await readFile(f.file('p1'), 'utf8');
    assert.match(first, /^# Theme <!-- plan:p1 status:active session:s1 /);
    await plans.apply([{op: 'add', parent: '1', nodes: [{title: 'Palette', owner: 'kalon'}]}], 'logox');
    const second = await readFile(f.file('p1'), 'utf8');
    assert.match(second, /1\.1 Palette — kalon/);
    // Every intermediate state of a burst of writes is a complete, parseable plan.
    await Promise.all(Array.from({length: 6}, (_, index) => plans.apply([{op: 'add', parent: '2', nodes: [{title: 'Step ' + index, owner: 'techne'}]}], 'logox')));
    const burst = parsePlan(await readFile(f.file('p1'), 'utf8'), 'p1.md');
    assert.deepEqual(burst.issues, []);
    assert.equal(burst.plan!.nodes.filter(node => node.id.startsWith('2.')).length, 6);
    assert.deepEqual(await readdir(join(f.cwd, '.logox', 'plans')), ['p1.md']);
    // A new board of the same session (a resume) finds the plan; another session's board does not own it but lists it.
    const resumed = f.make(); await resumed.load();
    assert.equal(resumed.active()!.id, 'p1'); assert.equal(resumed.active()!.nodes.length, 9);
    const other = new PlanBoard({cwd: f.cwd, sessionId: 'other', work: () => []}); await other.load();
    assert.equal(other.active(), undefined);
    assert.deepEqual((await other.projectPlans()).map(header => [header.id, header.sessionId, header.current]), [['p1', 's1', false]]);
    assert.equal((await other.view('p1'))!.nodes.length, 9);
  } finally {await f.close();}
});

test('a person editing the file between two uses is honoured; a runtime change after it merges with it', async () => {
  const f = await board();
  try {
    const plans = f.make();
    await plans.apply([{op: 'create', title: 'Theme', nodes: [{title: 'Design', owner: 'logox', acceptance: ['looks right']}, {title: 'Ship', owner: 'techne'}]}], 'logox');
    plans.link('1', {activityId: 'act_1'});
    await plans.flush();
    const text = await readFile(f.file('p1'), 'utf8');
    // The person retitles the plan and a node, rewrites the acceptance line, deletes node 2 and adds a node by typing a line.
    await writeFile(f.file('p1'), text.replace('# Theme', '# Theme preview').replace('1 Design', '1 Visual design').replace('looks right', 'looks right in both themes')
      .replace(/## 2 Ship.*\n/, '') + '\n- [ ] Write docs — aletheia\n');
    const seen = plans.active()!;
    assert.equal(seen.title, 'Theme preview');
    assert.deepEqual(seen.nodes.map(node => [node.id, node.title]), [['1', 'Visual design'], ['1.1', 'Write docs']]);
    assert.deepEqual(seen.nodes[0]!.acceptance, ['looks right in both themes']);
    assert.deepEqual(seen.nodes[0]!.links, [{activityId: 'act_1'}], 'the link in the comment survives the edit');
    await plans.flush();
    // The id-less line was given an id and written back.
    assert.match(await readFile(f.file('p1'), 'utf8'), /1\.1 Write docs — aletheia <!-- n:1\.1 owner:aletheia -->/);
    // A runtime op after another edit merges: the op lands and the person's new edit stays.
    await writeFile(f.file('p1'), (await readFile(f.file('p1'), 'utf8')).replace('Write docs', 'Write the docs'));
    const result = await plans.apply([{op: 'accept', id: '1.1', evidence: ['docs exist']}], 'logox');
    assert.ok(result.ok);
    const final = parsePlan(await readFile(f.file('p1'), 'utf8'), 'p1.md').plan!;
    assert.equal(final.nodes.find(node => node.id === '1.1')!.title, 'Write the docs');
    assert.equal(final.nodes.find(node => node.id === '1.1')!.accepted!.evidence[0], 'docs exist');
    assert.equal(f.notices.length, 0, f.notices.join('\n'));
  } finally {await f.close();}
});

test('a runtime change not yet on disk is merged with an edit made meanwhile, field by field', async () => {
  const f = await board();
  try {
    const plans = f.make();
    await plans.apply([{op: 'create', title: 'Theme', nodes: [{title: 'Design', owner: 'logox'}]}], 'logox');
    await plans.flush();
    const text = await readFile(f.file('p1'), 'utf8');
    // The runtime links work (memory changes, the write is queued) while the person edits the title on disk first.
    await writeFile(f.file('p1'), text.replace('1 Design', '1 Visual design'));
    plans.link('1', {activityId: 'act_1'});
    await plans.flush();
    const final = parsePlan(await readFile(f.file('p1'), 'utf8'), 'p1.md').plan!;
    assert.equal(final.nodes[0]!.title, 'Visual design');
    assert.deepEqual(final.nodes[0]!.links, [{activityId: 'act_1'}]);
  } finally {await f.close();}
});

test('a stray line is reported once as a notice; a deleted file drops the plan and says so', async () => {
  const f = await board();
  try {
    const plans = f.make();
    await plans.apply([{op: 'create', title: 'Theme', nodes: [{title: 'Design', owner: 'logox'}]}], 'logox');
    await writeFile(f.file('p1'), (await readFile(f.file('p1'), 'utf8')) + 'what is this\n');
    plans.refresh(); plans.refresh();
    await plans.flush();
    assert.equal(f.notices.filter(text => /was not understood/.test(text)).length, 1);
    assert.equal(plans.active()!.nodes[0]!.note, 'what is this');
    await rm(f.file('p1'));
    assert.equal(plans.active(), undefined);
    assert.deepEqual(f.notices.filter(text => /deleted on disk/.test(text)), ['Plan p1 was deleted on disk and is no longer tracked.']);
  } finally {await f.close();}
});

test('a plan of an earlier session is read-only until it is re-activated, and only while nothing else is active', async () => {
  const f = await board();
  try {
    const earlier = new PlanBoard({cwd: f.cwd, sessionId: 'old', work: () => []});
    await earlier.apply([{op: 'create', title: 'Old plan', nodes: [{title: 'Step', owner: 'logox'}]}], 'logox');
    const now = f.make(); await now.load();
    assert.equal(now.active(), undefined);
    assert.equal((await now.adopt('p9')).ok, false);
    assert.deepEqual(await now.adopt('p1'), {ok: true});
    assert.equal(now.active()!.sessionId, 's1');
    assert.match(await readFile(f.file('p1'), 'utf8'), /session:s1/);
    const third = new PlanBoard({cwd: f.cwd, sessionId: 'third', work: () => []}); await third.load();
    assert.equal(third.active(), undefined);
    const busy = f.make(); await busy.load();
    await busy.apply([{op: 'abandon'}], 'logox');
    await busy.apply([{op: 'create', title: 'New', nodes: []}], 'logox');
    const adopted = await third.adopt('p2');
    assert.ok(adopted.ok);
    assert.equal((await third.adopt('p1')).ok, false, 'another plan is active in that session');
  } finally {await f.close();}
});
