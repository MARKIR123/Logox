import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {applyPlanOp, derivePlan, type NewNode, type PlanWork} from '../src/runtime/plan.js';
import {taskGraph} from '../src/runtime/task-graph.js';
import type {Delegation} from '../src/runtime/delegations.js';
import {buildFlow, fit, flowHit, flowStats, rowWidth, type FlowLayout} from '../src/tui/panels/plan-flow.js';
import {DOCK_MIN_COLUMNS, flowOptionsFor, paintSidebar, tooltipFor, planProgress, sidebarGeometry, sidebarWidth, stepKey, stepMouse, emptyView, followTarget, clampSidebarWidth, dragWidth, maxSidebarWidth, SIDEBAR_MIN, TIMELINE_MIN} from '../src/tui/panels/plan-sidebar.js';
import {formatClock} from '../src/tui/terminal/text.js';
import {palette} from '../src/tui/appearance/theme.js';
import {faintColor} from '../src/tui/appearance/colors.js';

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

/** The row index of the top border of a node with this title: the title sits in the row below (`│ ◉ Title │`), the bottom border is two rows below. */
const cardRow = (lines: readonly string[], title: string) => lines.findIndex(line => new RegExp('│ \\S ' + title + '( |$)').test(line)) - 1;

test('perRow: as many cards of at least 15 cells (2 cells between) as fit, 2 from 36 columns, 3 from 52, more on a wide panel; the same input gives the same layout', () => {
  assert.deepEqual([36, 40, 47, 48, 50, 51, 52, 56, 68, 71, 120].map(total => flowOptionsFor(total).perRow), [2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 7]);
  const rowsOf = (total: number) => {
    const flow = flowAt(plan(wide), total);
    const lines = text(flow);
    return {flow, lines, perLine: Math.max(...flow.boxes.filter(box => box.parent === '1').map(box => flow.boxes.filter(other => other.parent === '1' && other.y0 === box.y0).length))};
  };
  assert.equal(rowsOf(40).perLine, 2); assert.equal(rowsOf(50).perLine, 2); assert.equal(rowsOf(56).perLine, 3); assert.equal(rowsOf(120).perLine, 6);
  for (const total of [36, 40, 50, 56, 120]) {
    const {flow, lines} = rowsOf(total);
    assert.ok(lines.every(line => stringWidth(line) <= total - 3), 'inside the panel at ' + total);
    const boxes = flow.boxes.filter(box => box.parent === '1');
    assert.ok(boxes.every(box => box.x1 - box.x0 >= 15), 'no card is narrower than 15 cells at ' + total);
    assert.deepEqual(text(flowAt(plan(wide), total)), lines, 'deterministic at ' + total);
  }
  // Six siblings sit 3 + 3 at 56 columns, the wrapped rows directly below each other (the borders separate the cards), and all in one row at 120.
  const flow56 = rowsOf(56).flow;
  const tops = [...new Set(flow56.boxes.filter(box => box.parent === '1').map(box => box.y0))];
  assert.equal(tops.length, 2);
  assert.equal(tops[1]! - tops[0]!, 3, 'no blank row between the wrapped rows');
  assert.equal(new Set(rowsOf(120).flow.boxes.filter(box => box.parent === '1').map(box => box.y0)).size, 1);
  // Cards of a row are two cells apart.
  const first = flow56.boxes.filter(box => box.parent === '1' && box.y0 === tops[0]);
  assert.deepEqual(first.slice(1).map((box, at) => box.x0 - first[at]!.x1), [2, 2]);
});

test('layers: a node sits one layer below its deepest sibling prerequisite, in id order', () => {
  const flow = flowAt(plan(diamond), 36);
  assert.deepEqual(flow.order, ['1', '1.1', '1.2', '1.3', '1.4']);
  const lines = text(flow);
  const at = (needle: string) => lines.findIndex(line => line.includes(needle));
  assert.ok(at('Palette') < at('Contra') && at('Contra') <= at('Tokens') && at('Tokens') < at('Preview'));
  assert.ok(lines.every(line => stringWidth(line) <= 33), 'no row is wider than the flow');
});

test('at 36 columns: two cards share a row, a layer that does not fit wraps directly below, an arrow enters the next layer, no label rows', () => {
  const flow = flowAt(plan(diamond), 36);
  const lines = text(flow);
  assert.ok(!lines.some(line => /parallel|steps?$/.test(line)), 'no parallel label and no step note rows');
  assert.ok(lines.some(line => line.includes('▼')), 'an arrow enters a layer');
  assert.ok(lines.some(line => line.includes('Contra') && line.includes('Tokens')), 'two per row at 36');
  // Three siblings of one layer: two share a row, the third wraps under the first with nothing between.
  const three = flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'kalon'}, {title: 'B', owner: 'techne'}, {title: 'C', owner: 'techne'}]}]), 36);
  const rows = text(three);
  assert.equal(cardRow(rows, 'A'), cardRow(rows, 'B'));
  assert.equal(cardRow(rows, 'C'), cardRow(rows, 'A') + 3, 'three card rows, then the wrapped card right below');
  assert.match(rows[cardRow(rows, 'A')]!, /^╭─+ kalon ─╮ {2}╭─+ techne ─╮$/);
  // 1.4 waits for 1.2 and 1.3, both in the layer above: the arrow says so, no note.
  assert.ok(!lines.some(line => line.includes('↳ after')));
});

test('layers are rows, arrows mean then: parallel boxes share a row without an arrow, a layer boundary has one, a lone layer gets a centred arrow', () => {
  const chain = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'kalon'}, {title: 'B', owner: 'techne'}, {title: 'C', owner: 'techne', after: ['1.1', '1.2']}, {title: 'D', owner: 'kalon', after: ['1.3']}]}]);
  const lines = text(flowAt(chain, 56));
  const row = (title: string) => cardRow(lines, title);
  assert.equal(row('A'), row('B'), 'A and B run in parallel on one row');
  assert.ok(lines.slice(row('A'), row('C')).filter(line => line.includes('▼')).length === 1, 'one arrow row between layer 0 and layer 1');
  assert.ok(row('C') < row('D'));
  // The bus has rounded corners: both prerequisites join above the target.
  const bus = lines[row('A') + 3]!;
  assert.match(lines[row('A') + 2]!, /^╰─+╯ +╰─+╯$/, 'the cards end in their bottom borders right above the bus');
  assert.match(bus, /^ +╰─+┬─+╯$/, 'both prerequisites join above the target, on the centres of the cards: ' + bus);
  // Where no edge can be drawn between the two rows (the prerequisite sits in another chunk) one arrow is centred.
  const flow = flowAt(plan(wide), 120);
  assert.ok(!text(flow).some(line => line.includes('▼')), 'siblings with no prerequisites have no arrows');
  const stacked = text(flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'kalon'}, {title: 'B', owner: 'kalon'}, {title: 'D', owner: 'techne'}, {title: 'C', owner: 'techne', after: ['1.1']}]}]), 36));
  const between = stacked.slice(cardRow(stacked, 'A'), cardRow(stacked, 'C'));
  const arrows = between.filter(line => line.includes('▼'));
  assert.equal(arrows.length, 1, 'A is in the first of two wrapped rows, so no bus fits: one centred arrow marks the layer boundary');
  assert.equal(arrows[0]!.trim(), '▼');
  assert.ok(!between.some(line => /[├┼┤┬┴]/.test(line)), 'no bus row (a card border never holds a junction mark)');
});

test('connectors are drawn in the faint line tone with rounded corners, and light up with the hovered node', () => {
  const flow = flowAt(plan(diamond), 56);
  const marks = flow.rows.flat().filter(cell => /[▼─│┬┴├┼┤╭╮╰╯]/.test(cell.text) && cell.links);
  assert.ok(marks.length >= 6 && marks.every(cell => cell.tone === 'line'), 'every connector cell is the line tone');
  assert.ok(marks.some(cell => cell.text === '╯' || cell.text === '╮'));
  assert.ok(!flow.rows.flat().some(cell => /[┌┐└┘]/.test(cell.text)), 'no square corners');
  const derived = plan(diamond);
  const paint = (hovered?: string) => paintSidebar({plan: derived, flow: flowAt(derived, 56), view: {...emptyView, hovered}, width: 56, height: 30, focused: false, ownerColor: () => '#336699'}).flat();
  const arrow = (hovered?: string) => paint(hovered).find(segment => segment.text.includes('▼'))!.color;
  assert.equal(arrow(), palette.line, 'faint at rest');
  assert.equal(arrow('1.2'), palette.accent, 'accent while a node it joins is hovered');
});

test('a phase is one line: fold glyph, title, then a thin progress bar and the count; the status glyph only while not done; the owner only when it is not the Director', () => {
  const derived = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'techne'}, {title: 'B', owner: 'techne'}, {title: 'C', owner: 'techne'}]}, {title: 'Techne phase', owner: 'techne', nodes: [{title: 'X', owner: 'kalon'}]}],
    [{id: 'a', status: 'completed'}, {id: 'b', status: 'failed'}, {id: 'c', status: 'running'}], {'1.1': ['a'], '1.2': ['b'], '1.3': ['c']});
  const flow = flowAt(derived, 56);
  const lines = text(flow);
  const phase = flow.boxes.find(box => box.id === '1')!;
  assert.equal(phase.y1, phase.y0, 'one line, no owner line and no step note');
  assert.match(lines[phase.y0]!, /^▾ ● Phase {2,}━{6} 1\/3 · 1 failed$/, 'running: glyph shown; bar, count and failures at the right');
  assert.ok(!lines[phase.y0]!.includes('logox'), 'the Director is not named');
  assert.equal(stringWidth(lines[phase.y0]!), 53, 'the line fills the flow width');
  const other = flow.boxes.find(box => box.id === '2')!;
  assert.match(lines[other.y0]!, /^▾ Techne phase {2,}techne {2}━{6} 0\/1$/, 'not started: no status glyph; the owner by name');
  assert.ok(other.owner.x1 > other.owner.x0 && other.owner.y === other.y0, 'the owner of a phase is a click target on its header');
  assert.equal(phase.owner.x1, phase.owner.x0, 'none for the Director');
  // The bar: accent for the finished part, faint for the rest; a done phase shows no glyph and a full bar.
  const cells = flow.rows[phase.y0]!.filter(cell => cell.text.startsWith('━'));
  assert.deepEqual(cells.map(cell => [cell.text.length, cell.tone]), [[2, 'accent'], [4, 'faint']], '1 of 3 leaves done fills 2 of 6 cells');
  const done = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'techne'}]}], [{id: 'a', status: 'completed'}], {'1.1': ['a']});
  const doneFlow = flowAt(done, 56);
  assert.match(text(doneFlow)[0]!, /^▾ Phase {2,}━{6} 1\/1$/);
  assert.deepEqual(doneFlow.rows[0]!.filter(cell => cell.text.startsWith('━')).map(cell => cell.tone), ['accent']);
});

test('side by side: two per row at 48 columns, a bus connector joins the layers and nothing exceeds the width', () => {
  for (const total of [48, 56]) {
    const flow = flowAt(plan(diamond), total);
    const lines = text(flow);
    assert.ok(lines.some(line => line.includes('Contrast') && line.includes('Tokens')), 'two nodes share a row at ' + total);
    assert.ok(!lines.some(line => line.includes('∥ parallel')), 'no marker needed when they share a row');
    const bus = lines.filter(line => /[├┼┤┬┴╭╮╰╯]/.test(line));
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
  assert.ok(lines.some(line => /^▾ One/.test(line)) && lines.some(line => /^╭─ ▾ ─+ techne ─╮$/.test(line)), 'the fold glyph sits in the header of a phase and at the left of the top border of a card');
  assert.ok(!lines.some(line => /steps?$/.test(line)), 'no step note rows');
  lines = text(flowAt(open, 36, new Map([['1.1', false]])));
  assert.ok(!lines.some(line => line.includes('Leaf a')) && lines.some(line => /^╭─ ▸ ─+ techne ─╮$/.test(line)));
  // A fully accepted phase starts collapsed; opening it shows the children again.
  const accepted = derivePlan({...open, nodes: open.nodes.map(node => ['1.1.1', '1.1.2'].includes(node.id) ? {...node, accepted: {by: 'logox', at: 1, evidence: ['x']}} : node)}, []);
  assert.equal(accepted.nodes.find(node => node.id === '1')!.status, 'accepted');
  lines = text(flowAt(accepted, 36));
  assert.ok(!lines.some(line => line.includes('Inner')) && lines.some(line => /^▸ One/.test(line)));
  assert.ok(text(flowAt(accepted, 36, new Map([['1', true]]))).some(line => line.includes('Inner')));
  // Nested children are indented by two cells.
  const inner = text(flowAt(open, 36)).find(line => line.includes('Leaf a'))!;
  const outer = text(flowAt(open, 36)).find(line => line.includes('Inner'))!;
  assert.equal(inner.indexOf('│') - outer.indexOf('│'), 2);
});

test('CJK titles are cut on cell boundaries with an ellipsis and every card row has the same width', () => {
  const flow = flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: '对比度算法与调色板预览的完整实现方案说明文档', owner: 'techne'}, {title: 'Plain', owner: 'kalon'}]}]), 36);
  const lines = text(flow);
  const top = lines.find(line => line.includes('对比度'))!;
  assert.ok(top.includes('…'), top);
  const cardRows = lines.filter(line => /^[╭│╰]/.test(line));
  assert.equal(cardRows.length, 3, 'three rows, both cards side by side');
  assert.deepEqual([...new Set(cardRows.map(line => stringWidth(line)))], [33], 'every row of two cards is the whole width (16 + 2 + 15), CJK title included');
  assert.equal(fit('对比度算法', 7), '对比度…');
  assert.equal(fit('abc', 3), 'abc');
});

test('elapsed time: a running node carries a clock slot and the plan model derives it from the linked work', () => {
  const derived = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Build', owner: 'techne'}, {title: 'Done', owner: 'kalon'}]}],
    [{id: 'act-1', status: 'running', startedAt: 5000}, {id: 'act-2', status: 'completed', startedAt: 1000}], {'1.1': ['act-1'], '1.2': ['act-2']});
  assert.equal(derived.nodes.find(node => node.id === '1.1')!.runningSince, 5000);
  assert.equal(derived.nodes.find(node => node.id === '1')!.runningSince, 5000, 'a parent takes the earliest running work below it');
  assert.equal(derived.nodes.find(node => node.id === '1.2')!.runningSince, undefined);
  const clocks = flowAt(derived, 56).rows.flat().filter(cell => cell.clock !== undefined);
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
  const paint = (view = emptyView, focused = false) => paintSidebar({plan: derived, flow, view, width, height, focused, ownerColor: () => '#336699'});
  const lines = paint();
  assert.equal(lines.length, height);
  assert.ok(lines.every(line => line.reduce((sum, segment) => sum + stringWidth(segment.text), 0) === width), 'every line is exactly the sidebar width');
  assert.match(lines[0]!.map(segment => segment.text).join(''), /Tasks Theme preview/);
  assert.match(lines[1]!.map(segment => segment.text).join(''), /active · 0\/4 /);
  assert.deepEqual(planProgress(derived), {done: 0, failed: 0, interrupted: 0, total: 4});
  const fold = (view: Parameters<typeof paint>[0]) => paint(view)[3]!.find(segment => segment.text.includes('▾'))!.color;
  const plainFold = fold(emptyView);
  assert.notEqual(fold({...emptyView, hovered: '1'}), plainFold, 'hover highlights the fold glyph of a phase');
  assert.notEqual(fold({...emptyView, selected: '1'}), plainFold, 'selection marks it too');
  const border = (view: Parameters<typeof paint>[0], at = 0) => paint(view).flat().filter(segment => segment.text.startsWith('╭─'))[at]!.color;
  assert.notEqual(border(emptyView), '#336699', 'the border rests at a faint level of the owner colour');
  assert.equal(border({...emptyView, hovered: '1.1'}), '#336699', 'hover brings it to the full owner colour');
  assert.equal(border({...emptyView, selected: '1.1'}), palette.accent, 'selection makes it the accent');
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

// ---------------------------------------------------------------------------------------------------------------------------------- light cards
const pelican: NewNode[] = [{title: 'Draw the coastal pelican', owner: 'kalon'}, {title: 'Build the ride animation', owner: 'techne'}, {title: 'Verify independently', owner: 'aletheia', after: ['1.1', '1.2']}];
const finished: PlanWork[] = [{id: 'a', status: 'completed', durationMs: 192_000}, {id: 'b', status: 'completed', durationMs: 245_000}, {id: 'c', status: 'completed', durationMs: 120_000}];
const links = {'1.1': ['a'], '1.2': ['b'], '1.3': ['c']};
function pelicanPlan(work: PlanWork[] = finished, link: Record<string, string[]> | undefined = links) {
  const base = plan([{title: 'Create the pelican SVG', owner: 'logox', nodes: pelican}], work, link);
  return derivePlan({...base, nodes: base.nodes.map(node => node.id === '1.3' ? {...node, note: 'Both checks pass; the loop is clean'} : node)}, work);
}

test('a node is a three-row rounded card: the owner tag in the top border, the glyph and title inside, the meta tag in the bottom border (the finished duration, never the result), clipped by width', () => {
  const derived = pelicanPlan();
  const at = (total: number) => {
    const lines = text(flowAt(derived, total));
    return {lines, first: cardRow(lines, 'Draw'), last: cardRow(lines, 'Verify')};
  };
  const wideCards = at(120);
  assert.match(wideCards.lines[wideCards.first]!, /^╭─+ kalon ─╮ +╭─+ techne ─╮$/, 'the owner tag is set into the right of the top border');
  assert.match(wideCards.lines[wideCards.first + 1]!, /^│ ◉ Draw the coastal pelican +│ +│ ◉ Build the ride animation +│$/, 'the status glyph and the title are inside the box');
  assert.match(wideCards.lines[wideCards.first + 2]!, /^╰─+ 3m12s ─╯ +╰─+ 4m05s ─╯$/, 'a done card: the finished duration in the bottom border');
  assert.match(wideCards.lines[wideCards.last]!, /^╭─+ aletheia ─╮$/);
  assert.match(wideCards.lines[wideCards.last + 2]!, /^╰─+ 2m ─╯$/, 'the duration, no result');
  for (const total of [36, 50, 56, 120]) {
    const {lines, first, last} = at(total);
    assert.ok(lines.every(line => stringWidth(line) <= total - 3), 'inside the panel at ' + total);
    assert.ok(lines.every(line => !/\d\.\d/.test(line)), 'no node id at ' + total);
    assert.ok(lines.every(line => !/Both checks/.test(line)), 'no result on a card at ' + total);
    assert.ok(lines.filter(line => /^[╭╰]/.test(line)).every(line => /[╮╯]$/.test(line)), 'every border row of a card ends in its corner at ' + total);
    assert.ok(lines.filter(line => /^│/.test(line)).every(line => /│$/.test(line)), 'every interior row ends in its side at ' + total);
    for (const row of [first, last]) assert.equal(new Set([0, 1, 2].map(offset => stringWidth(lines[row + offset]!))).size, 1, 'the three rows of a card are one width at ' + total);
    assert.ok(lines[first]!.includes('kalon') && lines[last]!.includes('aletheia'), 'the owner is intact at ' + total);
  }
  const narrow = at(36);
  assert.match(narrow.lines[narrow.first]!, /^╭─+ kalon ─╮ {2}╭─+ techne ─╮$/, 'two cards, the 2-cell gap: ' + narrow.lines[narrow.first]);
  assert.match(narrow.lines[narrow.first + 1]!, /^│ ◉ Draw the … │ {2}│ ◉ Build th… │$/, 'titles are clipped with an ellipsis inside the box');
  // Waiting: a blocked node names who it waits for; a pending node has the empty glyph.
  const blocked = text(flowAt(pelicanPlan([], undefined), 120));
  assert.match(blocked[cardRow(blocked, 'Verify') + 2]!, /^╰─+ blocked by kalon, techne ─╯$/);
  assert.match(blocked[cardRow(blocked, 'Verify') + 1]!, /^│ ○ /, 'pending glyph');
  // Running: a live clock placeholder in the right of the bottom border.
  const running = flowAt(pelicanPlan([{id: 'a', status: 'running', startedAt: 1}], {'1.1': ['a']}), 120);
  const row2 = running.rows.find(row => row.some(item => item.clock !== undefined))!;
  assert.equal(row2.find(item => item.text !== '')!.text, '╰', 'the clock sits in a bottom border');
  assert.equal(row2.find(item => item.clock !== undefined)!.text.length, 5);
  // A parent shows no child progress on its card (the fold glyph tells it is a parent).
  const nested = text(flowAt(plan([{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf', owner: 'automa'}]}]}]), 50));
  assert.ok(nested.every(line => !/techne.*\d\/\d/.test(line)), 'no 1/1 on the card');
});

test('the bottom border per state: running clock, blocked or waiting reason, finished duration, failed, interrupted; workers after the owner; a fork keeps its mark', () => {
  const bottom = (derived: ReturnType<typeof plan>, title: string, total = 120) => { const lines = text(flowAt(derived, total)); return lines[cardRow(lines, title) + 2]!; };
  const top = (derived: ReturnType<typeof plan>, title: string, total = 120) => { const lines = text(flowAt(derived, total)); return lines[cardRow(lines, title)]!; };
  const base = (work: PlanWork[], link: Record<string, string[]> = {'1.1': ['a']}) => pelicanPlan(work, link);
  assert.match(bottom(base([{id: 'a', status: 'running', startedAt: 1}]), 'Draw'), /^╰─+ {7}─╯/, 'running: a 5-cell clock placeholder, a space either side');
  assert.match(bottom(base([{id: 'a', status: 'completed', durationMs: 45_000}]), 'Draw'), /^╰─+ 45s ─╯/);
  assert.match(bottom(base([{id: 'a', status: 'failed', durationMs: 1000}]), 'Draw'), /^╰─+ failed ─╯/);
  assert.match(bottom(base([{id: 'a', status: 'cancelled', unfinished: true}]), 'Draw'), /^╰─+ interrupted ─╯/);
  assert.match(bottom(base([], {}), 'Draw'), /^╰─+╯ /, 'a ready node has no meta: a plain bottom border');
  const waiting = base([{id: 'a', status: 'running', startedAt: 1}]);
  assert.match(bottom(waiting, 'Verify'), /^╰─+ blocked by kalon, techne ─╯$/);
  const forked = base([{id: 'a', status: 'running', startedAt: 1, fork: true}]);
  assert.match(top(forked, 'Draw'), /^╭─+ kalon ⑂ ─╮/, 'a fork keeps its mark in the owner tag');
  const workers = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Scan', owner: 'techne'}]}], [{id: 'a/T1', status: 'completed'}, {id: 'a/T2', status: 'running'}, {id: 'a/T3', status: 'completed'}], {'1.1': ['a/T1', 'a/T2', 'a/T3']});
  assert.match(top(workers, 'Scan', 56), /^╭─+ techne ◦3 ─╮$/, 'the worker count follows the owner');
  // A card that is narrow drops the meta whole; the owner is only clipped, never dropped.
  for (const total of [36, 50, 56, 120]) {
    const lines = text(flowAt(base([{id: 'a', status: 'completed', durationMs: 192_000}, {id: 'b', status: 'completed', durationMs: 245_000}, {id: 'c', status: 'running', startedAt: 1}], {'1.1': ['a'], '1.2': ['b'], '1.3': ['c']}), total));
    const row = lines[cardRow(lines, 'Verify')]!;
    assert.match(row, /^╭─+ aletheia ─╮$/, 'the owner is intact at ' + total + ': ' + row);
    assert.ok(stringWidth(row) <= total - 3);
  }
  const tight = text(flowAt(base([{id: 'a', status: 'completed', durationMs: 192_000}]), 36));
  assert.match(tight[cardRow(tight, 'Draw') + 2]!, /^╰─+ 3m12s ─╯ {2}╰─+╯$/, 'a 16-cell card still has room for the duration: ' + tight[cardRow(tight, 'Draw') + 2]);
  // A wait that cannot fit is dropped whole (never cut), and a plain bottom border remains.
  const waits = text(flowAt(pelicanPlan([], undefined), 24));
  assert.ok(waits.every(line => !line.includes('blocked b')), 'dropped whole: ' + waits.join('|'));
  assert.ok(waits.some(line => /^╰─+╯$/.test(line)), 'a plain bottom border');
  assert.match(waits[cardRow(waits, 'Verify')]!, /^╭─+ aletheia ─╮$/, 'the owner stays');
  // A very narrow card clips the owner with an ellipsis before it drops it.
  const clipped = text(buildFlow(plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Solo', owner: 'aletheia'}]}]), {width: 11, perRow: 1, expanded: new Map(), owners}));
  assert.equal(clipped[cardRow(clipped, 'Solo')], '╭─ alet… ─╮', 'the owner is clipped, not dropped');
  assert.ok(clipped.every(line => stringWidth(line) <= 11));
});

test('a card carries the fold glyph in its top border: the only fold target, the glyph and a cell either side', () => {
  const nested = plan([{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf', owner: 'kalon'}]}]}]);
  const layout = flowAt(nested, 36);
  const inner = layout.boxes.find(box => box.id === '1.1')!;
  const top = text(layout)[inner.y0]!;
  assert.match(top, /^╭─ ▾ ─+ techne ─╮$/);
  assert.match(text(layout)[inner.y0 + 1]!, /^│ \S Inner +│$/, 'the title is inside the box');
  const glyph = top.indexOf('▾');
  assert.equal(inner.fold!.y, inner.y0, 'on the top border');
  assert.equal(inner.fold!.x0, glyph - 1); assert.equal(inner.fold!.x1, glyph + 2);
  assert.equal(glyph - inner.x0, 3, 'the glyph sits after the corner, a dash and a space, at the left');
  const leaf = layout.boxes.find(box => box.id === '1.1.1')!;
  assert.equal(leaf.fold, undefined, 'a leaf has no fold target');
  assert.ok(!text(layout)[leaf.y0]!.includes('▾'));
});

test('a card: border cells carry the owner and node, the title cell carries the node id; an interrupted node has a faint border and title', () => {
  const flow = flowAt(pelicanPlan(), 56);
  const middle = flow.rows.find(row => row.some(cell => cell.text.includes('Draw')))!.filter(cell => cell.text !== '');
  assert.equal(middle[0]!.text, '│ '); assert.equal(middle[0]!.frame, 'owner'); assert.equal(middle[0]!.owner, 'kalon'); assert.equal(middle[0]!.node, '1.1');
  assert.equal(middle[1]!.tone, 'success'); assert.equal(middle[2]!.text, ' '); assert.equal(middle[3]!.title, '1.1', 'the title cell');
  assert.equal(rowWidth(middle), 53, 'two cards and the gap fill the whole flow width');
  const top = flow.rows.find(row => row.some(cell => cell.text === 'kalon'))!;
  assert.equal(top.find(cell => cell.text === 'kalon')!.tone, 'owner', 'the owner tag wears the owner colour');
  assert.equal(top.find(cell => cell.text === 'kalon')!.owner, 'kalon');
  assert.ok(top.filter(cell => cell.frame).every(cell => cell.node === '1.1' || cell.node === '1.2'));
  assert.equal(rowWidth(top), 53);
  const interrupted = pelicanPlan([{id: 'a', status: 'cancelled', unfinished: true}], {'1.1': ['a']});
  assert.equal(flowAt(interrupted, 56).rows.flat().find(cell => cell.text === '⊘')?.tone, 'muted');
  assert.equal(flowAt(interrupted, 56).rows.flat().find(cell => cell.title === '1.1')?.tone, 'faint', 'the interrupted title recedes');
  assert.equal(flowAt(interrupted, 56).rows.flat().find(cell => cell.text === '╭' && cell.node === '1.1')?.frame, 'faint', 'and so does its border');
});

test('no fill: no painted sidebar row carries a background, at rest, hovered or selected, and hover and selection recolour the border and the title only', () => {
  const derived = plan(diamond);
  const flow = flowAt(derived, 56);
  const paint = (view = emptyView) => paintSidebar({plan: derived, flow, view, width: 56, height: 30, focused: false, ownerColor: () => '#336699'});
  for (const view of [emptyView, {...emptyView, hovered: '1.1'}, {...emptyView, selected: '1.1'}, {...emptyView, hovered: '1.1', selected: '1.2'}]) {
    assert.ok(paint(view).flat().every(segment => segment.bg === undefined), 'no background colour in any segment');
  }
  const seg = (view: Parameters<typeof paint>[0], needle: string) => paint(view).flat().find(segment => segment.text.includes(needle))!;
  const border = (view: Parameters<typeof paint>[0]) => paint(view).flat().find(segment => segment.text.startsWith('╭'))!;
  const bottom = (view: Parameters<typeof paint>[0]) => paint(view).flat().find(segment => segment.text.startsWith('╰'))!;
  // The side of the box (the ` │` after the title) wears the border colour too: hover and selection recolour the whole frame.
  const side = (view: Parameters<typeof paint>[0]) => paint(view).find(line => line.some(segment => segment.text.includes('Palette')))!.find(segment => /^ *│ ?$/.test(segment.text) && segment.text.endsWith('│'))!;
  assert.equal(side({...emptyView, hovered: '1.1'}).color, '#336699', 'the sides of a hovered card');
  assert.equal(side({...emptyView, selected: '1.1'}).color, palette.accent, 'the sides of a selected card');
  assert.equal(seg(emptyView, 'Palette').color, palette.fg);
  assert.equal(seg({...emptyView, hovered: '1.1'}, 'Palette').color, palette.strong, 'hover: the title takes the strong tone');
  assert.notEqual(seg({...emptyView, hovered: '1.1'}, 'Palette').bold, true);
  assert.equal(seg({...emptyView, selected: '1.1'}, 'Palette').color, palette.accent, 'selected: bold accent title');
  assert.equal(seg({...emptyView, selected: '1.1'}, 'Palette').bold, true);
  assert.equal(seg({...emptyView, hovered: '1.1'}, 'Contrast').color, palette.fg, 'another card keeps its colour');
  assert.notEqual(border(emptyView).color, '#336699', 'at rest the border is the owner colour at a faint level');
  assert.notEqual(border(emptyView).color, palette.fg);
  assert.equal(border({...emptyView, hovered: '1.1'}).color, '#336699', 'hover: the full owner colour');
  assert.equal(border({...emptyView, selected: '1.1'}).color, palette.accent, 'selection makes the border accent');
  assert.equal(bottom({...emptyView, selected: '1.1'}).color, palette.accent, 'the bottom border too');
  assert.equal(border({...emptyView, hovered: '1.2'}).color, border(emptyView).color, 'another card keeps its border');
  assert.equal(border({...emptyView, hovered: '1.1', selected: '1.1'}).color, palette.accent, 'selected wins over hovered');
  // An interrupted card's border is faint, not the owner colour.
  const interrupted = pelicanPlan([{id: 'a', status: 'cancelled', unfinished: true}], {'1.1': ['a']});
  const ifl = flowAt(interrupted, 56);
  const faint = paintSidebar({plan: interrupted, flow: ifl, view: emptyView, width: 56, height: 30, focused: false, ownerColor: () => '#336699'}).flat().find(segment => segment.text.startsWith('╭'))!;
  assert.equal(faint.color, faintColor());
  // Between two cards of a row: two bare cells.
  const row = paint().find(line => line.some(segment => segment.text.includes('Contrast')))!;
  assert.match(row.map(segment => segment.text).join(''), /Contrast.*│ {2}│ /);
});

test('the tooltip carries what the card leaves out: title, status, duration and summary', () => {
  const derived = pelicanPlan();
  const tip = (id: string) => tooltipFor(derived, {...emptyView, hovered: id}, false);
  assert.equal(tip('1.3'), 'Verify independently · done · 2m · Both checks pass; the loop is clean');
  assert.equal(tip('1.1'), 'Draw the coastal pelican · done · 3m12s');
  assert.equal(tooltipFor(derived, {...emptyView, selected: '1.3'}, false), tip('1.3'), 'selection shows it too');
  const lines = paintSidebar({plan: derived, flow: flowAt(derived, 120), view: {...emptyView, hovered: '1.3'}, width: 120, height: 20, focused: false, ownerColor: () => '#fff'});
  assert.match(lines.at(-1)!.map(segment => segment.text).join(''), /Verify independently · done · 2m · Both checks pass/);
});

test('a phase header counts in a muted tone, failed and interrupted included', () => {
  const interrupted = pelicanPlan([{id: 'a', status: 'cancelled', unfinished: true}], {'1.1': ['a']});
  const flow = flowAt(interrupted, 56);
  const counts = flow.rows.flat().find(cell => /\d\/\d/.test(cell.text) && cell.tone !== 'accent')!;
  assert.match(counts.text, /^\d\/3 · 1 interrupted$/); assert.equal(counts.tone, 'muted');
});

test('clicks: the owner tag in the top border jumps to the actor, the border and the title select, the fold glyph in the top border of a parent folds; a card hit box covers all three rows', () => {
  const nested = plan([{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf', owner: 'kalon'}]}, {title: 'Side', owner: 'kalon'}]}]);
  const flow = flowAt(nested, 50), geometry = sidebarGeometry(30);
  const inner = flow.boxes.find(box => box.id === '1.1')!;
  const press = (x: number, y: number, time = 0) => stepMouse(flow, emptyView, geometry, {x: x + 2, y: geometry.header + y, action: 'press'}, time);
  assert.equal(inner.y1 - inner.y0, 2, 'three rows');
  assert.equal(inner.owner.y, inner.y0, 'the owner is in the top border');
  assert.equal(inner.owner.x1, inner.x1 - 3, 'the tag ends before a space, a dash and the corner');
  assert.equal(inner.owner.x1 - inner.owner.x0, 'techne'.length);
  assert.deepEqual(press(inner.owner.x0, inner.owner.y).effects, [{kind: 'focus'}, {kind: 'owner', id: '1.1'}]);
  assert.deepEqual(press(inner.owner.x1 - 1, inner.owner.y).effects, [{kind: 'focus'}, {kind: 'owner', id: '1.1'}]);
  assert.deepEqual(press(inner.owner.x0, inner.y0 + 1).effects, [{kind: 'focus'}], 'the interior selects');
  assert.equal(press(inner.owner.x0, inner.y0 + 1).view.selected, '1.1');
  assert.equal(press(inner.x0, inner.y0).view.selected, '1.1', 'the corner belongs to the card');
  assert.equal(press(inner.x0, inner.y1).view.selected, '1.1', 'and so does the bottom border');
  assert.deepEqual(press(inner.owner.x1 + 1, inner.owner.y).effects, [{kind: 'focus'}], 'the rest of the top border selects');
  assert.deepEqual(press(inner.owner.x0, inner.y1).effects, [{kind: 'focus'}], 'the bottom border is no owner target');
  const fold = press(inner.fold!.x0 + 1, inner.y0);
  assert.equal(fold.view.expanded.get('1.1'), false, 'the fold glyph folds');
  assert.equal(fold.view.lastClick, undefined);
  assert.equal(press(inner.fold!.x0 + 8, inner.y0).view.expanded.get('1.1'), undefined, 'the rest of the top border does not');
  assert.equal(press(inner.fold!.x0 + 1, inner.y0 + 1).view.expanded.get('1.1'), undefined, 'nor does the title');
});

test('the cards of a printed row share the full width: a lone card is the whole width, two are halves, three thirds; connectors land on the centres of the actual cards', () => {
  const sizes = (nodes: NewNode[], total: number) => {
    const flow = flowAt(plan([{title: 'Phase', owner: 'logox', nodes}]), total);
    const kids = flow.boxes.filter(box => box.parent === '1');
    return {flow, rows: [...new Set(kids.map(box => box.y0))].map(y => kids.filter(box => box.y0 === y).map(box => box.x1 - box.x0))};
  };
  const n = (count: number): NewNode[] => Array.from({length: count}, (_, i) => ({title: 'Step ' + (i + 1), owner: 'kalon'}));
  assert.deepEqual(sizes(n(1), 56).rows, [[53]]);
  assert.deepEqual(sizes(n(2), 56).rows, [[26, 25]], 'two cards: 53 minus the gap, halves');
  assert.deepEqual(sizes(n(3), 56).rows, [[17, 16, 16]], 'thirds; the remainder goes to the first cards');
  assert.deepEqual(sizes(n(4), 56).rows, [[26, 25], [26, 25]], 'four wrap evenly, 2 + 2');
  // The pelican shape: a layer of two above a layer of three keeps each row full width.
  const after = ['1.1', '1.2'];
  const mixed = sizes([...n(2), {title: 'Third', owner: 'techne', after}, {title: 'Fourth', owner: 'techne', after}, {title: 'Fifth', owner: 'techne', after}], 56);
  assert.deepEqual(mixed.rows, [[26, 25], [17, 16, 16]]);
  // Each connector stem is under the centre of its card.
  const bus = text(mixed.flow).find(line => line.includes('╭') && line.includes('╮') && !/[A-Za-z]/.test(line))!;
  const boxes = mixed.flow.boxes.filter(box => box.parent === '1');
  const centre = (id: string) => { const box = boxes.find(item => item.id === id)!; return box.x0 + Math.floor((box.x1 - box.x0) / 2); };
  assert.equal(bus[centre('1.1')], '┴', 'a source stem under the first card centre'); assert.equal(bus[centre('1.2')], '┴', 'and under the second');
  assert.equal(bus.indexOf('╭'), centre('1.3')); assert.equal(bus.lastIndexOf('╮'), centre('1.5'), 'targets on the centres of the three cards below');
  // The stems leave the bottom border of the source cards and the arrows land on the top border of the targets, both at the card centres.
  const all = text(mixed.flow), busAt = all.indexOf(bus);
  const above = all[busAt - 1]!, arrows = all[busAt + 1]!, below = all[busAt + 2]!;
  for (const id of ['1.1', '1.2']) assert.match(above[centre(id)]!, /[─\s\S]/, 'inside the bottom border of ' + id), assert.ok(above[centre(id)] !== ' ', 'the source card has border under its centre: ' + id);
  for (const id of ['1.3', '1.4', '1.5']) {
    assert.equal(arrows[centre(id)], '▼', 'an arrow over the centre of ' + id);
    assert.ok(below[centre(id)] !== ' ' && below[centre(id)] !== undefined, 'the arrow points at the top border of ' + id);
    assert.ok(below.trimStart().startsWith('╭'), 'the row under the arrows is a top border');
  }
});

test('a result that is only an echoed Goal line or message envelope is never shown on a card', () => {
  const base = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Build', owner: 'techne'}]}], [{id: 'a', status: 'completed'}], {'1.1': ['a']});
  const noted = (note: string) => {
    const derived = derivePlan({...base, nodes: base.nodes.map(node => node.id === '1.1' ? {...node, note} : node)}, [{id: 'a', status: 'completed'}]);
    return text(flowAt(derived, 56)).join('\n') + '\n' + tooltipFor(derived, {...emptyView, hovered: '1.1'}, false);
  };
  assert.match(noted('Everything passes'), /Build · done · Everything passes/, 'the result is in the tooltip');
  assert.doesNotMatch(text(flowAt(derivePlan({...base, nodes: base.nodes.map(node => node.id === '1.1' ? {...node, note: 'Everything passes'} : node)}, [{id: 'a', status: 'completed'}]), 56)).join('\n'), /Everything passes/, 'never on the card');
  assert.doesNotMatch(noted('Goal: [Message from aletheia · check the bell]'), /Goal|Message from/);
  assert.doesNotMatch(noted('[Message from aletheia · check]'), /Message from/);
});
