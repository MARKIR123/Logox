import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {applyPlanOp, derivePlan, type NewNode, type PlanWork} from '../src/runtime/plan.js';
import {buildFlow, fit, flowHit, flowStats, rowWidth, type FlowLayout} from '../src/tui/panels/plan-flow.js';
import {DOCK_MIN_COLUMNS, flowOptionsFor, paintSidebar, planProgress, sidebarGeometry, sidebarWidth, stepKey, stepMouse, emptyView, followTarget} from '../src/tui/panels/plan-sidebar.js';
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

test('layers: a node sits one layer below its deepest sibling prerequisite, in id order', () => {
  const flow = flowAt(plan(diamond), 36);
  assert.deepEqual(flow.order, ['1', '1.1', '1.2', '1.3', '1.4']);
  const lines = text(flow);
  const at = (needle: string) => lines.findIndex(line => line.includes(needle));
  assert.ok(at('1.1 Palette') < at('1.2 Contrast') && at('1.2 Contrast') < at('1.3 Tokens') && at('1.3 Tokens') < at('1.4 Preview'));
  assert.ok(lines.every(line => stringWidth(line) <= 33), 'no row is wider than the flow');
});

test('stacked at 36 columns: a parallel marker between nodes of one layer and a connector with an arrow into the next layer', () => {
  const lines = text(flowAt(plan(diamond), 36));
  assert.equal(lines.filter(line => line.includes('∥ parallel')).length, 1);
  assert.ok(lines.some(line => line.includes('▼')), 'an arrow enters a layer');
  assert.ok(!lines.some(line => line.includes('1.2') && line.includes('1.3')), 'never side by side at 36');
  // 1.4 waits for 1.2 and 1.3; only the last chunk of the previous layer (1.3) is drawn, 1.2 is a note.
  assert.ok(lines.some(line => line.includes('↳ after 1.2')));
  assert.ok(!lines.some(line => line.includes('↳ after 1.3')));
});

test('side by side from 48 columns: two per row, a bus connector joins the layers and nothing exceeds the width', () => {
  for (const total of [48, 56]) {
    const flow = flowAt(plan(diamond), total);
    const lines = text(flow);
    assert.ok(lines.some(line => line.includes('1.2') && line.includes('1.3')), 'two nodes share a row at ' + total);
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
  assert.ok(lines.some(line => line.includes('↳ after 1.1')), lines.join('\n'));
  assert.equal(lines.filter(line => line.includes('▼')).length, 2, 'one arrow per drawn edge: A to B, B to C');
});

test('children: accepted subtrees start collapsed, others expanded, and a click state overrides both', () => {
  const nodes: NewNode[] = [{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf a', owner: 'automa'}, {title: 'Leaf b', owner: 'automa'}]}]}, {title: 'Two', owner: 'logox', nodes: [{title: 'Other', owner: 'techne'}]}];
  const open = plan(nodes);
  let lines = text(flowAt(open, 36));
  assert.ok(lines.some(line => line.includes('1.1.1 Leaf a')), 'open by default');
  assert.ok(lines.some(line => line.includes('▾ 1 step')) && lines.some(line => line.includes('▾ 2 steps')));
  lines = text(flowAt(open, 36, new Map([['1.1', false]])));
  assert.ok(!lines.some(line => line.includes('Leaf a')) && lines.some(line => line.includes('▸ 2 steps')));
  // A fully accepted phase starts collapsed; opening it shows the children again.
  const accepted = derivePlan({...open, nodes: open.nodes.map(node => ['1.1.1', '1.1.2'].includes(node.id) ? {...node, accepted: {by: 'logox', at: 1, evidence: ['x']}} : node)}, []);
  assert.equal(accepted.nodes.find(node => node.id === '1')!.status, 'accepted');
  lines = text(flowAt(accepted, 36));
  assert.ok(!lines.some(line => line.includes('1.1 Inner')) && lines.some(line => line.includes('▸ 1 step')));
  assert.ok(text(flowAt(accepted, 36, new Map([['1', true]]))).some(line => line.includes('1.1 Inner')));
  // Nested children are indented by two cells.
  const inner = text(flowAt(open, 36)).find(line => line.includes('1.1.1 Leaf a'))!;
  const outer = text(flowAt(open, 36)).find(line => line.includes('1.1 Inner'))!;
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
  assert.deepEqual(clocks.map(cell => cell.clock), [5000, 5000]);
  assert.ok(clocks.every(cell => cell.text.length === 5));
  assert.deepEqual([0, 65_000, 3_725_000].map(formatClock), ['0:00', '1:05', '1h02']);
});

test('workers: linked Automa jobs are not nodes but a count line', () => {
  const derived = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Scan', owner: 'techne'}]}],
    [{id: 'a/T1', status: 'completed'}, {id: 'a/T2', status: 'running'}, {id: 'a/T3', status: 'completed'}], {'1.1': ['a/T1', 'a/T2', 'a/T3']});
  const lines = text(flowAt(derived, 36));
  assert.ok(lines.some(line => line.includes('◦ 3 workers · 2 done')), lines.join('\n'));
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
  assert.match(lines[0]!.map(segment => segment.text).join(''), /Plan Theme preview/);
  assert.match(lines[1]!.map(segment => segment.text).join(''), /active · 0\/4 /);
  assert.deepEqual(planProgress(derived), {accepted: 0, total: 4});
  const border = (view: Parameters<typeof paint>[0]) => paint(view)[3]!.find(segment => segment.text.includes('━'))!.color;
  const plainBorder = border(emptyView);
  assert.notEqual(border({...emptyView, hovered: '1'}), plainBorder, 'hover highlights the rule of a phase');
  assert.notEqual(border({...emptyView, selected: '1'}), plainBorder, 'selection marks it too');
  const boxBorder = (view: Parameters<typeof paint>[0]) => paint(view).flat().find(segment => segment.text.includes('╭'))!.color;
  assert.notEqual(boxBorder({...emptyView, hovered: '1.1'}), boxBorder(emptyView), 'hover highlights the border of a node box');
  // The tooltip shows the hovered node's first check, else its note, else a hint.
  assert.match(paint({...emptyView, hovered: '1.2'}).at(-1)!.map(segment => segment.text).join(''), /1\.2 has no check or note yet/);
  assert.match(paint(emptyView, true).at(-1)!.map(segment => segment.text).join(''), /Enter open/);
  // Scrolled content starts later and the header rule marks it.
  const scrolled = paint({...emptyView, scroll: 4});
  assert.ok(scrolled[2]!.some(segment => segment.text === '▲'));
  assert.equal(followTarget(derived, flow), '1.2');
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
  const x = 4, y = geometry.header + phase.y0;
  let step = stepMouse(flow, emptyView, geometry, {x, y, action: 'move'}, 0);
  assert.equal(step.view.hovered, '1');
  assert.equal(stepMouse(flow, step.view, geometry, {x, y, action: 'move'}, 1).view, step.view, 'the same hover is no change');
  step = stepMouse(flow, step.view, geometry, {x, y, action: 'press'}, 100);
  assert.equal(step.view.selected, '1'); assert.equal(step.view.expanded.get('1'), false, 'the click folds an open parent');
  assert.deepEqual(step.effects, [{kind: 'focus'}]);
  step = stepMouse(flow, step.view, geometry, {x, y, action: 'press'}, 200);
  assert.deepEqual(step.effects, [{kind: 'focus'}, {kind: 'open', id: '1'}], 'the second click within 350 ms opens the detail');
  const owner = flow.boxes.find(box => box.id === '1.1')!.owner;
  step = stepMouse(flow, emptyView, geometry, {x: owner.x0 + 2, y: geometry.header + owner.y, action: 'press'}, 0);
  assert.deepEqual(step.effects, [{kind: 'focus'}, {kind: 'owner', id: '1.1'}]);
  const wheel = stepMouse(flow, emptyView, sidebarGeometry(12), {x: 3, y: 4, action: 'wheel_down'}, 5);
  assert.equal(wheel.view.scroll, 3); assert.equal(wheel.view.scrolledAt, 5);
  assert.equal(stepMouse(flow, emptyView, geometry, {x: 3, y: 0, action: 'wheel_up'}, 0).view.scroll, 0);
  void rowWidth;
});
