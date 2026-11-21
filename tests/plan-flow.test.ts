import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {applyPlanOp, derivePlan, type NewNode, type PlanWork} from '../src/runtime/plan.js';
import {taskGraph} from '../src/runtime/task-graph.js';
import type {Delegation} from '../src/runtime/delegations.js';
import {buildFlow, fit, flowHit, flowStats, rowWidth, type FlowLayout} from '../src/tui/panels/plan-flow.js';
import {DOCK_MIN_COLUMNS, flowOptionsFor, paintSidebar, planProgress, sidebarGeometry, sidebarWidth, stepKey, stepMouse, emptyView, followTarget, clampSidebarWidth, dragWidth, maxSidebarWidth, SIDEBAR_MIN, TIMELINE_MIN} from '../src/tui/panels/plan-sidebar.js';
import {formatClock} from '../src/tui/terminal/text.js';

const names: Record<string, {symbol: string; name: string}> = {logox: {symbol: '◈', name: 'logox'}, techne: {symbol: '◎', name: 'techne'}, aletheia: {symbol: '✦', name: 'aletheia'},
  kalon: {symbol: '❖', name: 'kalon'}, automa: {symbol: '◦', name: 'automa'}};
const owners = (id: string) => names[id] ?? {symbol: '◇', name: id};

function plan(nodes: NewNode[], work: PlanWork[] = [], link?: Record<string, string[]>) {
  const created = applyPlanOp(undefined, {op: 'create', title: 'Theme preview', nodes}, 'logox', {now: 1, sessionId: 's', planId: () => 'p1'});
  assert.ok(created.ok);
  const linked = link ? {...created.plan, nodes: created.plan.nodes.map(node => link[node.id] ? {...node, links: link[node.id]!.map(id => id.includes('/') ? {automaJob: id} : {activityId: id})} : node)} : created.plan;
  return derivePlan(linked, work);
}
/** The screen width a sidebar of `total` columns gives the flow. */
const flowAt = (derived: ReturnType<typeof plan>, total: number, expanded = new Map<string, boolean>()): FlowLayout => buildFlow(derived, {...flowOptionsFor(total), expanded, owners});
const text = (flow: FlowLayout) => flow.rows.map(row => row.map(cell => cell.text).join(''));
const diamond: NewNode[] = [{title: 'Design', owner: 'logox', nodes: [
  {title: 'Palette', owner: 'kalon'},
  {title: 'Contrast algorithm', owner: 'aletheia', after: ['1.1']},
  {title: 'Tokens', owner: 'techne', after: ['1.1']},
  {title: 'Preview', owner: 'techne', after: ['1.2', '1.3']}]}];

const wide: NewNode[] = [{title: 'Design', owner: 'logox', nodes: Array.from({length: 6}, (_, index) => ({title: 'Step ' + (index + 1), owner: index % 2 ? 'techne' : 'kalon'}))}];

test('perRow: as many boxes of at least 22 cells as fit, 1 below 48 columns, 2 at the sidebar widths, more on a wide panel; the same input gives the same layout', () => {
  assert.deepEqual([36, 40, 47, 48, 56, 68, 71, 120].map(total => flowOptionsFor(total).perRow), [1, 1, 1, 2, 2, 2, 3, 5]);
  const rowsOf = (total: number) => {
    const flow = flowAt(plan(wide), total);
    const lines = text(flow);
    return {flow, lines, perLine: Math.max(...flow.boxes.filter(box => box.parent === '1').map(box => flow.boxes.filter(other => other.parent === '1' && other.y0 === box.y0).length))};
  };
  assert.equal(rowsOf(40).perLine, 1); assert.equal(rowsOf(56).perLine, 2); assert.equal(rowsOf(120).perLine, 5);
  for (const total of [40, 56, 120]) {
    const {flow, lines} = rowsOf(total);
    assert.ok(lines.every(line => stringWidth(line) <= total - 3), 'inside the panel at ' + total);
    const boxes = flow.boxes.filter(box => box.parent === '1');
    assert.ok(boxes.every(box => box.x1 - box.x0 >= 22), 'no box is narrower than 22 cells at ' + total);
    assert.deepEqual(text(flowAt(plan(wide), total)), lines, 'deterministic at ' + total);
  }
  // A group narrower than the cap holds fewer: 6 siblings across 120 columns sit 5 and 1.
  const flow120 = rowsOf(120).flow;
  assert.equal(new Set(flow120.boxes.filter(box => box.parent === '1').map(box => box.y0)).size, 2);
});

test('layers: a node sits one layer below its deepest sibling prerequisite, in id order', () => {
  const flow = flowAt(plan(diamond), 36);
  assert.deepEqual(flow.order, ['1', '1.1', '1.2', '1.3', '1.4']);
  const lines = text(flow);
  const at = (needle: string) => lines.findIndex(line => line.includes(needle));
  assert.ok(at('Palette') < at('Contrast') && at('Contrast') < at('Tokens') && at('Tokens') < at('Preview'));
  assert.ok(lines.every(line => stringWidth(line) <= 33), 'no row is wider than the flow');
});

test('stacked at 36 columns: a layer that does not fit wraps with nothing between its rows, an arrow enters the next layer, no label rows', () => {
  const flow = flowAt(plan(diamond), 36);
  const lines = text(flow);
  assert.ok(!lines.some(line => /parallel|steps?$/.test(line)), 'no parallel label and no step note rows');
  assert.ok(lines.some(line => line.includes('▼')), 'an arrow enters a layer');
  assert.ok(!lines.some(line => line.includes('Contrast') && line.includes('Tokens')), 'never side by side at 36');
  // 1.2 and 1.3 are one layer wrapped onto two rows: the second box starts right under the first.
  const second = flow.boxes.find(box => box.id === '1.2')!, third = flow.boxes.find(box => box.id === '1.3')!;
  assert.equal(third.y0, second.y1 + 1, 'nothing between the rows of one layer');
  // 1.4 waits for 1.2 and 1.3, both in the layer above: the arrow says so, no note.
  assert.ok(!lines.some(line => line.includes('↳ after')));
});

test('layers are rows, arrows mean then: parallel boxes share a row without an arrow, a layer boundary has one, a lone layer gets a centred arrow', () => {
  const chain = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'kalon'}, {title: 'B', owner: 'techne'}, {title: 'C', owner: 'techne', after: ['1.1', '1.2']}, {title: 'D', owner: 'kalon', after: ['1.3']}]}]);
  const lines = text(flowAt(chain, 56));
  const row = (needle: string) => lines.findIndex(line => line.includes(needle));
  assert.equal(row('╭ A '), row('╭ B '), 'A and B run in parallel on one row');
  assert.ok(lines.slice(row('╭ A '), row('╭ C ')).filter(line => line.includes('▼')).length === 1, 'one arrow row between layer 0 and layer 1');
  assert.ok(row('╭ C ') < row('╭ D '));
  // Where no edge can be drawn between the two rows (the prerequisite sits in another chunk) one arrow is centred.
  const flow = flowAt(plan(wide), 120);
  assert.ok(!text(flow).some(line => line.includes('▼')), 'siblings with no prerequisites have no arrows');
  const stacked = text(flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'kalon'}, {title: 'B', owner: 'kalon'}, {title: 'C', owner: 'techne', after: ['1.1']}]}]), 36));
  const between = stacked.slice(stacked.findIndex(line => line.includes('╭ A ')), stacked.findIndex(line => line.includes('╭ C ')));
  const arrows = between.filter(line => line.includes('▼'));
  assert.equal(arrows.length, 1, 'A is in the first of two wrapped rows, so no bus fits: one centred arrow marks the layer boundary');
  assert.equal(arrows[0]!.trim(), '▼');
  assert.ok(!between.some(line => /[┌┬┐├┼┤└┴┘]/.test(line.replace(/[╭╮╰╯]/g, ''))));
});

test('a phase is one line: glyph, title, progress; the owner only when it is not the Director; a failed leaf is told next to the count', () => {
  const derived = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'techne'}, {title: 'B', owner: 'techne'}, {title: 'C', owner: 'techne'}]}, {title: 'Techne phase', owner: 'techne', nodes: [{title: 'X', owner: 'kalon'}]}],
    [{id: 'a', status: 'completed'}, {id: 'b', status: 'failed'}, {id: 'c', status: 'running'}], {'1.1': ['a'], '1.2': ['b'], '1.3': ['c']});
  const flow = flowAt(derived, 56);
  const lines = text(flow);
  const phase = flow.boxes.find(box => box.id === '1')!;
  assert.equal(phase.y1, phase.y0, 'one line, no owner line and no step note');
  assert.match(lines[phase.y0]!, /▾ ● Phase ━+ 1\/3 · 1 failed$/);
  assert.ok(!lines[phase.y0]!.includes('logox'), 'the Director is not named');
  const other = flow.boxes.find(box => box.id === '2')!;
  assert.match(lines[other.y0]!, /^[━▾▸] \S Techne phase ━+ ◎ techne {2}0\/1$/);
  assert.ok(other.owner.x1 > other.owner.x0 && other.owner.y === other.y0, 'the owner of a phase is a click target on its header');
  assert.equal(phase.owner.x1, phase.owner.x0, 'none for the Director');
});

test('side by side from 48 columns: two per row, a bus connector joins the layers and nothing exceeds the width', () => {
  for (const total of [48, 56]) {
    const flow = flowAt(plan(diamond), total);
    const lines = text(flow);
    assert.ok(lines.some(line => line.includes('Contrast') && line.includes('Tokens')), 'two nodes share a row at ' + total);
    assert.ok(!lines.some(line => line.includes('∥ parallel')), 'no marker needed when they share a row');
    const bus = lines.filter(line => /[┌┬┐├┼┤└┴┘]/.test(line.replace(/[╭╮╰╯]/g, '')));
    assert.ok(bus.length >= 2, 'bus rows at ' + total + ':\n' + lines.join('\n'));
    assert.ok(lines.every(line => stringWidth(line) <= total - 3), 'inside the sidebar at ' + total);
    // Both boxes of the row are exactly the slot width and the two prerequisites of 1.4 are drawn: no `after` note.
    assert.ok(!lines.some(line => line.includes('↳ after')));
  }
});

test('a prerequisite that skips a layer is a note under the node, not a line', () => {
  const flow = flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [
    {title: 'A', owner: 'techne'}, {title: 'B', owner: 'techne', after: ['1.1']}, {title: 'C', owner: 'techne', after: ['1.1', '1.2']}]}]), 36);
  const lines = text(flow);
  assert.ok(lines.some(line => line.includes('↳ after A')) && !lines.some(line => /\d\.\d/.test(line)), lines.join('\n'));
  assert.equal(lines.filter(line => line.includes('▼')).length, 2, 'one arrow per drawn edge: A to B, B to C');
});

test('children: accepted subtrees start collapsed, others expanded, and a click state overrides both', () => {
  const nodes: NewNode[] = [{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf a', owner: 'automa'}, {title: 'Leaf b', owner: 'automa'}]}]}, {title: 'Two', owner: 'logox', nodes: [{title: 'Other', owner: 'techne'}]}];
  const open = plan(nodes);
  let lines = text(flowAt(open, 36));
  assert.ok(lines.some(line => line.includes('Leaf a')), 'open by default');
  assert.ok(lines.some(line => /^▾ .* One/.test(line)) && lines.some(line => /^╭ Inner .*▾ ╮$/.test(line)), 'the fold glyph sits in the header of a phase and in the top border of a box');
  assert.ok(!lines.some(line => /steps?$/.test(line)), 'no step note rows');
  lines = text(flowAt(open, 36, new Map([['1.1', false]])));
  assert.ok(!lines.some(line => line.includes('Leaf a')) && lines.some(line => /^╭ Inner .*▸ ╮$/.test(line)));
  // A fully accepted phase starts collapsed; opening it shows the children again.
  const accepted = derivePlan({...open, nodes: open.nodes.map(node => ['1.1.1', '1.1.2'].includes(node.id) ? {...node, accepted: {by: 'logox', at: 1, evidence: ['x']}} : node)}, []);
  assert.equal(accepted.nodes.find(node => node.id === '1')!.status, 'accepted');
  lines = text(flowAt(accepted, 36));
  assert.ok(!lines.some(line => line.includes('Inner')) && lines.some(line => /^▸ .* One/.test(line)));
  assert.ok(text(flowAt(accepted, 36, new Map([['1', true]]))).some(line => line.includes('Inner')));
  // Nested children are indented by two cells.
  const inner = text(flowAt(open, 36)).find(line => line.includes('Leaf a'))!;
  const outer = text(flowAt(open, 36)).find(line => line.includes('Inner'))!;
  assert.equal(inner.indexOf('╭') - outer.indexOf('╭'), 2);
});

test('CJK titles are cut on cell boundaries with an ellipsis and every box row has the same width', () => {
  const flow = flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: '对比度算法与调色板预览的完整实现方案说明文档', owner: 'techne'}, {title: 'Plain', owner: 'kalon'}]}]), 36);
  const lines = text(flow);
  const top = lines.find(line => line.includes('对比度'))!;
  assert.ok(top.includes('…'), top);
  const boxRows = lines.filter(line => /^[╭│╰]/.test(line));
  assert.ok(boxRows.length >= 6);
  assert.deepEqual([...new Set(boxRows.map(line => stringWidth(line)))], [33], 'every box row is exactly the flow width');
  assert.equal(fit('对比度算法', 7), '对比度…');
  assert.equal(fit('abc', 3), 'abc');
});

test('elapsed time: a running node carries a clock slot and the plan model derives it from the linked work', () => {
  const derived = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Build', owner: 'techne'}, {title: 'Done', owner: 'kalon'}]}],
    [{id: 'act-1', status: 'running', startedAt: 5000}, {id: 'act-2', status: 'completed', startedAt: 1000}], {'1.1': ['act-1'], '1.2': ['act-2']});
  assert.equal(derived.nodes.find(node => node.id === '1.1')!.runningSince, 5000);
  assert.equal(derived.nodes.find(node => node.id === '1')!.runningSince, 5000, 'a parent takes the earliest running work below it');
  assert.equal(derived.nodes.find(node => node.id === '1.2')!.runningSince, undefined);
  const clocks = flowAt(derived, 36).rows.flat().filter(cell => cell.clock !== undefined);
  assert.deepEqual(clocks.map(cell => cell.clock), [5000], 'the running box carries the clock; a phase header is one line without one');
  assert.ok(clocks.every(cell => cell.text.length === 5));
  assert.deepEqual([0, 65_000, 3_725_000].map(formatClock), ['0:00', '1:05', '1h02']);
});

test('workers: linked Automa jobs are not nodes but a count line', () => {
  const derived = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Scan', owner: 'techne'}]}],
    [{id: 'a/T1', status: 'completed'}, {id: 'a/T2', status: 'running'}, {id: 'a/T3', status: 'completed'}], {'1.1': ['a/T1', 'a/T2', 'a/T3']});
  const lines = text(flowAt(derived, 36));
  assert.ok(lines.some(line => line.includes('◦3')), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('workers')), 'no note row for workers');
  assert.equal(flowAt(derived, 36).order.length, 2);
});

test('hit testing: a box owns its rows and columns, the owner name is its own target, notes belong to the node', () => {
  const flow = flowAt(plan(diamond), 48);
  const palette = flow.boxes.find(box => box.id === '1.1')!;
  const second = flow.boxes.find(box => box.id === '1.2')!, third = flow.boxes.find(box => box.id === '1.3')!;
  assert.equal(second.y0, third.y0, 'side by side');
  assert.ok(second.x1 <= third.x0);
  assert.equal(flowHit(flow, palette.x0 + 1, palette.y0)?.box.id, '1.1');
  assert.equal(flowHit(flow, palette.owner.x0, palette.owner.y)?.onOwner, true);
  assert.equal(flowHit(flow, palette.x0 + 1, palette.y0)?.onOwner, false);
  assert.equal(flowHit(flow, third.x0 + 1, third.y1)?.box.id, '1.3');
  assert.equal(flowHit(flow, 0, 999), undefined);
});

test('the layout is rebuilt only for a different plan, width or fold state; the sidebar width and dock threshold', () => {
  const derived = plan(diamond);
  const before = flowStats.builds;
  const flow = flowAt(derived, 36);
  assert.equal(flowStats.builds, before + 1);
  assert.deepEqual([110, 120, 200].map(columns => sidebarWidth(columns - 1)), [37, 40, 56], '34% of the usable width, clamped');
  assert.equal(sidebarWidth(60), 36); assert.equal(DOCK_MIN_COLUMNS, 110);
  assert.deepEqual(sidebarGeometry(30), {height: 30, header: 3, footer: 2, body: 25});
  assert.equal(sidebarGeometry(6).body, 3);
  void flow;
});

test('paint: header, progress, fixed width lines, scrolling, hover and selection colours', () => {
  const derived = plan(diamond, [{id: 'act-1', status: 'running', startedAt: 1}], {'1.2': ['act-1']});
  const width = 40, height = 24;
  const flow = flowAt(derived, width);
  const paint = (view = emptyView, focused = false) => paintSidebar({plan: derived, flow, view, width, height, focused, ownerColor: id => id});
  const lines = paint();
  assert.equal(lines.length, height);
  assert.ok(lines.every(line => line.reduce((sum, segment) => sum + stringWidth(segment.text), 0) === width), 'every line is exactly the sidebar width');
  assert.match(lines[0]!.map(segment => segment.text).join(''), /Tasks Theme preview/);
  assert.match(lines[1]!.map(segment => segment.text).join(''), /active · 0\/4 /);
  assert.deepEqual(planProgress(derived), {done: 0, failed: 0, interrupted: 0, total: 4});
  const border = (view: Parameters<typeof paint>[0]) => paint(view)[3]!.find(segment => segment.text.includes('━'))!.color;
  const plainBorder = border(emptyView);
  assert.notEqual(border({...emptyView, hovered: '1'}), plainBorder, 'hover highlights the rule of a phase');
  assert.notEqual(border({...emptyView, selected: '1'}), plainBorder, 'selection marks it too');
  const boxBorder = (view: Parameters<typeof paint>[0]) => paint(view).flat().find(segment => segment.text.includes('╭'))!.color;
  assert.notEqual(boxBorder({...emptyView, hovered: '1.1'}), boxBorder(emptyView), 'hover highlights the border of a node box');
  // The tooltip shows the hovered node's first check, else its note, else a hint.
  assert.match(paint({...emptyView, hovered: '1.2'}).at(-1)!.map(segment => segment.text).join(''), /No check or note yet/);
  assert.match(paint(emptyView, true).at(-1)!.map(segment => segment.text).join(''), /Enter open/);
  // Scrolled content starts later and the header rule marks it.
  const scrolled = paint({...emptyView, scroll: 4});
  assert.ok(scrolled[2]!.some(segment => segment.text === '▲'));
  assert.equal(followTarget(derived, flow), '1.2');
});

test('the task graph paints under its own header: work without a plan, an earlier plan, no ids drawn, a header click or p opens the switcher', () => {
  const delegation = (id: string, extra: Partial<Delegation> = {}): Delegation => ({id, kind: 'actor', ownerId: 'techne', title: id, status: 'running', rootId: id, children: [], blockedBy: [], assignment: {title: extra.title ?? id, owns: [], acceptance: []}, ...extra});
  const graph = taskGraph(undefined, [delegation('R', {kind: 'director', ownerId: 'logox', title: 'Fix it', status: 'completed'}), delegation('tech', {title: 'Build', parentId: 'R', rootId: 'R'}),
    delegation('tech/T1', {kind: 'automa', jobId: 'T1', title: 'Look', status: 'done', parentId: 'tech', rootId: 'R'})], 's')!;
  const width = 40, height = 24;
  const flow = buildFlow(graph.plan, {...flowOptionsFor(width), expanded: new Map(), owners});
  const paint = (kind: 'plan' | 'work' | 'earlier', view = emptyView, focused = false) => paintSidebar({plan: graph.plan, flow, view, width, height, focused, kind, synthetic: graph.synthetic, ownerColor: id => id});
  const row = (lines: ReturnType<typeof paint>, at: number) => lines[at]!.map(segment => segment.text).join('');
  const work = paint('work');
  assert.ok(work.every(line => line.reduce((sum, segment) => sum + stringWidth(segment.text), 0) === width));
  assert.match(row(work, 0), /Tasks · no plan/);
  assert.match(row(work, 1), /working · 1\/1 done/, 'a done synthesized leaf counts as finished');
  assert.deepEqual(planProgress(graph.plan), {done: 1, failed: 0, interrupted: 0, total: 1}, 'a done synthesized leaf is complete');
  assert.match(row(work, work.length - 1), /No plan · click selects/);
  assert.match(row(paint('work', {...emptyView, hovered: '1.1.1'}), work.length - 1), /Look · done/);
  assert.match(row(paint('earlier'), 0), /Earlier tasks Tasks/);
  assert.match(row(paint('earlier'), 1), /read-only · active/);
  assert.match(row(paint('earlier'), work.length - 1), /Read-only · re-activate: \/tasks plans/);
  // No node id is drawn, for synthesized nodes either.
  assert.ok(!flow.rows.flat().some(cell => /\b\d+(\.\d+)+\b/.test(cell.text)));
  // Header: hover shows the hint, a click or p asks for the switcher.
  const geometry = sidebarGeometry(height);
  let step = stepMouse(flow, emptyView, geometry, {x: 5, y: 0, action: 'move'}, 0);
  assert.equal(step.view.hoveredHeader, true);
  assert.match(row(paint('work', step.view), work.length - 1), /switch plan or work view/);
  assert.equal(stepMouse(flow, step.view, geometry, {x: 5, y: 0, action: 'move'}, 1).view, step.view, 'the same hover is no change');
  assert.deepEqual(stepMouse(flow, step.view, geometry, {x: 5, y: 1, action: 'press'}, 2).effects, [{kind: 'focus'}, {kind: 'plans'}]);
  step = stepMouse(flow, step.view, geometry, {x: 5, y: geometry.header + 1, action: 'move'}, 3);
  assert.equal(step.view.hoveredHeader, false, 'leaving the header clears the hover');
  assert.deepEqual(stepKey(flow, emptyView, geometry, {plans: true}, 0).effects, [{kind: 'plans'}]);
});

test('keyboard: arrows move in reading order, left and right fold, Enter opens, Esc gives the focus back', () => {
  const derived = plan(diamond);
  const flow = flowAt(derived, 36), geometry = sidebarGeometry(30);
  let view = emptyView;
  const press = (key: Parameters<typeof stepKey>[3]) => {const step = stepKey(flow, view, geometry, key, 0); view = step.view; return step;};
  press({down: true}); assert.equal(view.selected, '1');
  press({down: true}); press({down: true}); assert.equal(view.selected, '1.2');
  press({up: true}); assert.equal(view.selected, '1.1');
  press({left: true}); assert.equal(view.selected, '1', 'left on a leaf selects its parent');
  const folded = press({left: true}); assert.equal(folded.view.expanded.get('1'), false);
  assert.deepEqual(press({enter: true}).effects, [{kind: 'open', id: '1'}]);
  assert.deepEqual(press({escape: true}).effects, [{kind: 'blur'}]);
  assert.equal(press({}).consumed, false);
});

test('mouse: hover, click selects and folds, double click opens the detail, the owner name jumps, the wheel scrolls', () => {
  const derived = plan(diamond);
  const flow = flowAt(derived, 36), geometry = sidebarGeometry(30);
  const phase = flow.boxes.find(box => box.id === '1')!;
  const x = 8, y = geometry.header + phase.y0;
  let step = stepMouse(flow, emptyView, geometry, {x, y, action: 'move'}, 0);
  assert.equal(step.view.hovered, '1');
  assert.equal(stepMouse(flow, step.view, geometry, {x, y, action: 'move'}, 1).view, step.view, 'the same hover is no change');
  step = stepMouse(flow, step.view, geometry, {x, y, action: 'press'}, 100);
  assert.equal(step.view.selected, '1'); assert.equal(step.view.expanded.get('1'), undefined, 'a click on the title only selects, so the layout stays under the pointer for the second click');
  assert.deepEqual(step.effects, [{kind: 'focus'}]);
  step = stepMouse(flow, step.view, geometry, {x, y, action: 'press'}, 200);
  assert.deepEqual(step.effects, [{kind: 'focus'}, {kind: 'open', id: '1'}], 'the second click within 350 ms opens the detail');
  // The fold glyph folds, and a click on it never starts a double click.
  const fold = stepMouse(flow, emptyView, geometry, {x: 2, y, action: 'press'}, 0);
  assert.equal(fold.view.expanded.get('1'), false, 'the glyph folds an open parent');
  assert.equal(fold.view.lastClick, undefined);
  assert.deepEqual(fold.effects, [{kind: 'focus'}]);
  const owner = flow.boxes.find(box => box.id === '1.1')!.owner;
  step = stepMouse(flow, emptyView, geometry, {x: owner.x0 + 2, y: geometry.header + owner.y, action: 'press'}, 0);
  assert.deepEqual(step.effects, [{kind: 'focus'}, {kind: 'owner', id: '1.1'}]);
  const wheel = stepMouse(flow, emptyView, sidebarGeometry(12), {x: 3, y: 4, action: 'wheel_down'}, 5);
  assert.equal(wheel.view.scroll, 3); assert.equal(wheel.view.scrolledAt, 5);
  assert.equal(stepMouse(flow, emptyView, geometry, {x: 3, y: 0, action: 'wheel_up'}, 0).view.scroll, 0);
  void rowWidth;
});

test('the sidebar width: default 34%, a remembered width re-clamped into 36..min(60% of the width, width - 61), a drag follows the pointer', () => {
  assert.equal(sidebarWidth(119), 40);
  assert.equal(maxSidebarWidth(119), 58, 'the timeline keeps 60 columns and the gap');
  assert.equal(maxSidebarWidth(200), 120, '60% of a wide terminal');
  assert.equal(maxSidebarWidth(110), 49);
  for (const width of [109, 110, 119, 200, 300]) assert.ok(maxSidebarWidth(width) >= SIDEBAR_MIN && width - 1 - maxSidebarWidth(width) >= Math.min(TIMELINE_MIN, width - 1 - SIDEBAR_MIN));
  assert.equal(sidebarWidth(119, 50), 50); assert.equal(sidebarWidth(119, 5), 36); assert.equal(sidebarWidth(119, 90), 58); assert.equal(sidebarWidth(111, 56), 50);
  assert.equal(clampSidebarWidth(40.4, 119), 40);
  assert.equal(dragWidth(119, 79), 40); assert.equal(dragWidth(119, 70), 49); assert.equal(dragWidth(119, 0), 58); assert.equal(dragWidth(119, 118), 36);
});

test('the border column: the first row is the collapse button, below it the resize handle (docked only); double click resets, other columns keep their behaviour', () => {
  const graph = taskGraph(plan([{title: 'A', owner: 'techne'}]), [], 's')!;
  const flow = buildFlow(graph.plan, {...flowOptionsFor(40), expanded: new Map(), owners});
  const geometry = sidebarGeometry(30);
  const hover = stepMouse(flow, emptyView, geometry, {x: 0, y: 0, action: 'move', draggable: true}, 0);
  assert.equal(hover.view.hoveredEdge, 'collapse');
  const paint = (view = hover.view, dragging = false, focused = false) => paintSidebar({plan: graph.plan, flow, view, width: 40, height: 30, focused, ownerColor: () => '#fff', dragging});
  const text = (lines: ReturnType<typeof paint>) => lines.map(line => line.map(segment => segment.text).join(''));
  assert.ok(text(paint())[0]!.startsWith('› '), 'the glyph sits in the border of the header row');
  assert.ok(text(paint())[5]!.startsWith('│'), 'the border continues below');
  assert.match(text(paint())[29]!, /^│ Collapse/);
  assert.deepEqual(stepMouse(flow, emptyView, geometry, {x: 0, y: 0, action: 'press'}, 1).effects, [{kind: 'close'}], 'one click collapses, in the overlay too');
  const handle = stepMouse(flow, emptyView, geometry, {x: 0, y: 8, action: 'move', draggable: true}, 2);
  assert.equal(handle.view.hoveredEdge, 'handle');
  assert.match(text(paint(handle.view))[29]!, /Drag to resize · › to collapse/);
  assert.equal(stepMouse(flow, handle.view, geometry, {x: 5, y: 8, action: 'move', draggable: true}, 3).view.hoveredEdge, undefined, 'leaving the border clears the hover');
  const first = stepMouse(flow, emptyView, geometry, {x: 0, y: 8, action: 'press', draggable: true}, 10);
  assert.deepEqual(first.effects, [{kind: 'drag'}]);
  assert.deepEqual(stepMouse(flow, first.view, geometry, {x: 0, y: 8, action: 'press', draggable: true}, 200).effects, [{kind: 'reset-width'}], 'a second press within 350 ms resets');
  assert.deepEqual(stepMouse(flow, first.view, geometry, {x: 0, y: 8, action: 'press', draggable: true}, 900).effects, [{kind: 'drag'}], 'a slow second press drags again');
  assert.equal(stepMouse(flow, emptyView, geometry, {x: 0, y: 8, action: 'press'}, 0).effects.some(effect => effect.kind === 'drag'), false, 'no handle without draggable');
  assert.equal(paint(emptyView, true)[8]![0]!.color, paint(emptyView, false, true)[8]![0]!.color, 'the handle keeps the accent colour while dragged');
  assert.equal(stringWidth('›'), 1);
});

test('node ids are never drawn: no sidebar row, tooltip or phase line holds a dotted id, at any width and with folds open or shut', () => {
  const nested: NewNode[] = [{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf a', owner: 'automa'}, {title: 'Leaf b', owner: 'automa', after: ['1.1.1']}]}, {title: 'Sibling', owner: 'kalon', after: ['1.1']}]},
    {title: 'Two', owner: 'logox', after: ['1'], nodes: [{title: 'Other', owner: 'techne'}]}];
  const derived = plan(nested);
  const idPattern = /\b\d+(\.\d+)+\b/;
  for (const total of [36, 40, 56, 120]) {
    for (const hovered of [undefined, '1', '1.1', '1.1.2', '2.1']) {
      const flow = flowAt(derived, total, new Map([['1.1', true]]));
      const lines = paintSidebar({plan: derived, flow, view: {...emptyView, hovered, selected: hovered}, width: total, height: 40, focused: true, ownerColor: () => '#fff'});
      for (const line of lines) assert.doesNotMatch(line.map(segment => segment.text).join(''), idPattern);
    }
  }
  const flow = flowAt(derived, 36);
  assert.ok(text(flow).some(line => line.includes('↳ after One')), 'a prerequisite in another group is named by its title');
});
