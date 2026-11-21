import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {applyPlanOp, derivePlan, type NewNode, type PlanWork} from '../src/runtime/plan.js';
import {taskGraph} from '../src/runtime/task-graph.js';
import type {Delegation} from '../src/runtime/delegations.js';
import {buildFlow, fit, flowHit, flowStats, rowWidth, type FlowLayout} from '../src/tui/panels/plan-flow.js';
import {DOCK_MIN_COLUMNS, flowOptionsFor, paintSidebar, planProgress, sidebarGeometry, sidebarWidth, stepKey, stepMouse, emptyView, followTarget, clampSidebarWidth, dragWidth, maxSidebarWidth, SIDEBAR_MIN, TIMELINE_MIN} from '../src/tui/panels/plan-sidebar.js';
import {formatClock} from '../src/tui/terminal/text.js';
import {palette} from '../src/tui/appearance/theme.js';
import {cardTint} from '../src/tui/appearance/colors.js';
import {applyUiSettings} from '../src/config/ui-settings.js';

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

/** The row index of the first card row (`▌◉ Title`) of a node with this title. */
const cardRow = (lines: readonly string[], title: string) => lines.findIndex(line => new RegExp('▌\\S ' + title + '( |$)').test(line));

test('perRow: as many cards of at least 14 cells (2 cells between) as fit, 2 from 36 columns, 3 from 50, more on a wide panel; the same input gives the same layout', () => {
  assert.deepEqual([36, 40, 47, 48, 50, 56, 68, 71, 120].map(total => flowOptionsFor(total).perRow), [2, 2, 2, 2, 3, 3, 4, 4, 7]);
  const rowsOf = (total: number) => {
    const flow = flowAt(plan(wide), total);
    const lines = text(flow);
    return {flow, lines, perLine: Math.max(...flow.boxes.filter(box => box.parent === '1').map(box => flow.boxes.filter(other => other.parent === '1' && other.y0 === box.y0).length))};
  };
  assert.equal(rowsOf(40).perLine, 2); assert.equal(rowsOf(50).perLine, 3); assert.equal(rowsOf(56).perLine, 3); assert.equal(rowsOf(120).perLine, 6);
  for (const total of [36, 40, 50, 56, 120]) {
    const {flow, lines} = rowsOf(total);
    assert.ok(lines.every(line => stringWidth(line) <= total - 3), 'inside the panel at ' + total);
    const boxes = flow.boxes.filter(box => box.parent === '1');
    assert.ok(boxes.every(box => box.x1 - box.x0 >= 14), 'no card is narrower than 14 cells at ' + total);
    assert.deepEqual(text(flowAt(plan(wide), total)), lines, 'deterministic at ' + total);
  }
  // Six siblings sit 3 + 3 at 50 columns with a blank row between the wrapped rows, and all in one row at 120.
  const flow50 = rowsOf(50).flow;
  const tops = [...new Set(flow50.boxes.filter(box => box.parent === '1').map(box => box.y0))];
  assert.equal(tops.length, 2);
  assert.equal(text(flow50)[tops[1]! - 1], '', 'one blank row between the wrapped rows');
  assert.equal(new Set(rowsOf(120).flow.boxes.filter(box => box.parent === '1').map(box => box.y0)).size, 1);
  // Cards of a row are two cells apart.
  const first = flow50.boxes.filter(box => box.parent === '1' && box.y0 === tops[0]);
  assert.deepEqual(first.slice(1).map((box, at) => box.x0 - first[at]!.x1), [2, 2]);
});

test('layers: a node sits one layer below its deepest sibling prerequisite, in id order', () => {
  const flow = flowAt(plan(diamond), 36);
  assert.deepEqual(flow.order, ['1', '1.1', '1.2', '1.3', '1.4']);
  const lines = text(flow);
  const at = (needle: string) => lines.findIndex(line => line.includes(needle));
  assert.ok(at('Palette') < at('Contrast') && at('Contrast') <= at('Tokens') && at('Tokens') < at('Preview'));
  assert.ok(lines.every(line => stringWidth(line) <= 33), 'no row is wider than the flow');
});

test('at 36 columns: two cards share a row, a layer that does not fit wraps with a blank row between, an arrow enters the next layer, no label rows', () => {
  const flow = flowAt(plan(diamond), 36);
  const lines = text(flow);
  assert.ok(!lines.some(line => /parallel|steps?$/.test(line)), 'no parallel label and no step note rows');
  assert.ok(lines.some(line => line.includes('▼')), 'an arrow enters a layer');
  assert.ok(lines.some(line => line.includes('Contrast') && line.includes('Tokens')), 'two per row at 36');
  // Three siblings of one layer: two share a row, the third wraps under the first with one blank row between.
  const three = flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'kalon'}, {title: 'B', owner: 'techne'}, {title: 'C', owner: 'techne'}]}]), 36);
  const rows = text(three);
  assert.equal(cardRow(rows, 'A'), cardRow(rows, 'B'));
  assert.equal(cardRow(rows, 'C'), cardRow(rows, 'A') + 3, 'two card rows, one blank row, then the wrapped card');
  assert.equal(rows[cardRow(rows, 'A') + 2], '');
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
  const bus = lines[row('A') + 2]!;
  assert.match(bus, /^ +╰─+┬─+╯$/, 'both prerequisites join above the target, on the centres of the cards: ' + bus);
  // Where no edge can be drawn between the two rows (the prerequisite sits in another chunk) one arrow is centred.
  const flow = flowAt(plan(wide), 120);
  assert.ok(!text(flow).some(line => line.includes('▼')), 'siblings with no prerequisites have no arrows');
  const stacked = text(flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'A', owner: 'kalon'}, {title: 'B', owner: 'kalon'}, {title: 'D', owner: 'techne'}, {title: 'C', owner: 'techne', after: ['1.1']}]}]), 36));
  const between = stacked.slice(cardRow(stacked, 'A'), cardRow(stacked, 'C'));
  const arrows = between.filter(line => line.includes('▼'));
  assert.equal(arrows.length, 1, 'A is in the first of two wrapped rows, so no bus fits: one centred arrow marks the layer boundary');
  assert.equal(arrows[0]!.trim(), '▼');
  assert.ok(!between.some(line => /[├┼┤┬┴╭╮╰╯]/.test(line)));
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
  assert.ok(lines.some(line => /^▾ One/.test(line)) && lines.some(line => /▌\S Inner +▾ $/.test(line)), 'the fold glyph sits in the header of a phase and at the right end of the title row of a card');
  assert.ok(!lines.some(line => /steps?$/.test(line)), 'no step note rows');
  lines = text(flowAt(open, 36, new Map([['1.1', false]])));
  assert.ok(!lines.some(line => line.includes('Leaf a')) && lines.some(line => /▌\S Inner +▸ $/.test(line)));
  // A fully accepted phase starts collapsed; opening it shows the children again.
  const accepted = derivePlan({...open, nodes: open.nodes.map(node => ['1.1.1', '1.1.2'].includes(node.id) ? {...node, accepted: {by: 'logox', at: 1, evidence: ['x']}} : node)}, []);
  assert.equal(accepted.nodes.find(node => node.id === '1')!.status, 'accepted');
  lines = text(flowAt(accepted, 36));
  assert.ok(!lines.some(line => line.includes('Inner')) && lines.some(line => /^▸ One/.test(line)));
  assert.ok(text(flowAt(accepted, 36, new Map([['1', true]]))).some(line => line.includes('Inner')));
  // Nested children are indented by two cells.
  const inner = text(flowAt(open, 36)).find(line => line.includes('Leaf a'))!;
  const outer = text(flowAt(open, 36)).find(line => line.includes('Inner'))!;
  assert.equal(inner.indexOf('▌') - outer.indexOf('▌'), 2);
});

test('CJK titles are cut on cell boundaries with an ellipsis and every card row has the same width', () => {
  const flow = flowAt(plan([{title: 'Phase', owner: 'logox', nodes: [{title: '对比度算法与调色板预览的完整实现方案说明文档', owner: 'techne'}, {title: 'Plain', owner: 'kalon'}]}]), 36);
  const lines = text(flow);
  const top = lines.find(line => line.includes('对比度'))!;
  assert.ok(top.includes('…'), top);
  const cardRows = lines.filter(line => line.startsWith('▌'));
  assert.equal(cardRows.length, 2);
  assert.deepEqual([...new Set(cardRows.map(line => stringWidth(line)))], [33], 'two cards share the whole width (16 + 2 + 15)');
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
  const bar = (view: Parameters<typeof paint>[0], at = 0) => paint(view).flat().filter(segment => segment.text === '▌')[at]!.color;
  assert.equal(bar(emptyView), '#336699', 'the bar wears the owner colour');
  assert.notEqual(bar({...emptyView, hovered: '1.1'}), bar(emptyView), 'hover brightens the bar of a card');
  assert.equal(bar({...emptyView, selected: '1.1'}), palette.accent, 'selection makes it the accent');
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

test('a node is a two-row card: bar, glyph and title over owner, duration and result, clipped by width', () => {
  const derived = pelicanPlan();
  const at = (total: number) => {
    const lines = text(flowAt(derived, total));
    return {lines, first: cardRow(lines, 'Draw'), last: cardRow(lines, 'Verify')};
  };
  const wideCards = at(120);
  assert.match(wideCards.lines[wideCards.first]!, /^▌◉ Draw the coastal pelican/);
  assert.match(wideCards.lines[wideCards.first + 1]!, /^▌ kalon · 3m12s/);
  assert.match(wideCards.lines[wideCards.first + 1]!, /▌ techne · 4m05s/, 'the second card of the row');
  assert.match(wideCards.lines[wideCards.last + 1]!, /^▌ aletheia · 2m · Both checks pass; the loop is clean/, 'the result follows when there is room');
  // The same cards at the sidebar widths: the result is clipped, then dropped; a part that does not fit whole is dropped; the title ends with an ellipsis.
  const mid = at(56), narrow = at(36), fifty = at(50);
  assert.match(mid.lines[mid.last + 1]!, /^▌ aletheia · 2m · Both checks pass; the loop is clean/, 'a lone card is the full width');
  assert.match(fifty.lines[fifty.last + 1]!, /^▌ aletheia · 2m · Both checks pass; the loop i…$/, 'clipped last, with an ellipsis, at 50');
  assert.match(narrow.lines[narrow.last + 1]!, /^▌ aletheia · 2m · Both checks pa…$/, 'clipped last, with an ellipsis, at 36');
  assert.match(narrow.lines[narrow.first + 1]!, /^▌ kalon · 3m12s {3}▌ techne +$/, 'techne · 4m05s needs one cell more than a 15-cell card has: the duration is dropped whole');
  assert.match(narrow.lines[narrow.first]!, /^▌◉ Draw the co… {3}▌◉ Build the … $/, 'a trailing cell, the 2-cell gap');
  for (const total of [36, 50, 56, 120]) {
    const {lines} = at(total);
    assert.ok(lines.every(line => stringWidth(line) <= total - 3), 'inside the panel at ' + total);
    assert.ok(lines.every(line => !/\d\.\d/.test(line)), 'no node id at ' + total);
  }
  // Waiting: a blocked node names who it waits for instead of a duration.
  const blocked = text(flowAt(pelicanPlan([], undefined), 120));
  assert.match(blocked[cardRow(blocked, 'Verify') + 1]!, /^▌ aletheia · blocked by kalon, techne/);
  assert.match(blocked[cardRow(blocked, 'Verify')]!, /^▌○ /, 'pending glyph');
});

test('a card: the bar wears the owner colour and no tint, the cards cells carry the node id; an interrupted node stays muted; a parent has its fold glyph at the right end; a fork keeps its mark', () => {
  const flow = flowAt(pelicanPlan(), 56);
  const first = flow.rows.find(row => row.some(cell => cell.text.includes('Draw')))!.filter(cell => cell.text !== '');
  assert.equal(first[0]!.text, '▌'); assert.equal(first[0]!.bar, true); assert.equal(first[0]!.owner, 'kalon'); assert.equal(first[0]!.tint, undefined);
  assert.ok(first.slice(1, 5).every(cell => cell.tint === '1.1'), 'glyph, space, title and padding of the first card are tinted');
  assert.equal(first[1]!.tone, 'success');
  assert.equal(rowWidth(first), 53, 'two cards and the gap fill the whole flow width');
  const interrupted = pelicanPlan([{id: 'a', status: 'cancelled', unfinished: true}], {'1.1': ['a']});
  assert.equal(flowAt(interrupted, 56).rows.flat().find(cell => cell.text === '⊘')?.tone, 'muted');
  const forked = pelicanPlan([{id: 'a', status: 'running', startedAt: 1, fork: true}], {'1.1': ['a']});
  assert.ok(text(flowAt(forked, 120)).some(line => /^▌ kalon ⑂ · /.test(line)), 'owner ⑂ for a fork');
  const nested = plan([{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf', owner: 'automa'}]}]}]);
  const layout = flowAt(nested, 36);
  const inner = layout.boxes.find(box => box.id === '1.1')!;
  const row = layout.rows[inner.y0]!.filter(cell => cell.text !== '');
  assert.equal(row.at(-2)!.text, '▾'); assert.equal(row.at(-1)!.text, ' ');
  assert.equal(inner.fold!.x0, inner.x1 - 3, 'the fold target is the glyph (and a cell either side)');
});

test('tint: card cells get a background derived from the theme, deeper on hover and deeper still when selected; the bar, the gap and the connectors stay bare; Tool card tint none removes only the resting fill', () => {
  const derived = plan(diamond);
  const flow = flowAt(derived, 56);
  const paint = (view = emptyView) => paintSidebar({plan: derived, flow, view, width: 56, height: 30, focused: false, ownerColor: () => '#336699'});
  const bgOf = (view: Parameters<typeof paint>[0], needle: string) => paint(view).flat().find(segment => segment.text.includes(needle))?.bg;
  const distance = (hex: string | undefined) => {
    assert.ok(hex, 'a tint');
    const channels = (value: string) => [1, 3, 5].map(at => Number.parseInt(value.slice(at, at + 2), 16));
    return Math.hypot(...channels(hex).map((value, at) => value - channels(palette.bg)[at]!));
  };
  const rest = bgOf(emptyView, 'Palette'), hover = bgOf({...emptyView, hovered: '1.1'}, 'Palette'), selected = bgOf({...emptyView, selected: '1.1'}, 'Palette');
  assert.equal(rest, cardTint('rest')); assert.equal(hover, cardTint('hover')); assert.equal(selected, cardTint('selected'));
  assert.ok(distance(rest) > 0 && distance(rest) < distance(hover) && distance(hover) < distance(selected), `${rest} < ${hover} < ${selected} away from ${palette.bg}`);
  assert.equal(bgOf({...emptyView, hovered: '1.1'}, 'Contrast'), rest, 'another card keeps the resting tint');
  const segments = paint().flat();
  assert.ok(segments.filter(segment => segment.text === '▌').every(segment => !segment.bg), 'the bar is bare');
  assert.ok(segments.filter(segment => /^[▼─┬┴├┼┤╭╮╰╯]+$/.test(segment.text)).every(segment => !segment.bg), 'connectors are bare');
  const sideBySide = segments.filter(segment => segment.text.includes('Contrast') || segment.text.includes('Tokens'));
  assert.ok(sideBySide.length === 2 && sideBySide.every(segment => segment.bg === rest));
  // The two-cell gap between two cards of a row has no fill.
  const row = paint().find(line => line.some(segment => segment.text.includes('Contrast')))!;
  assert.ok(row.some(segment => !segment.bg && /^ {2}$/.test(segment.text)), 'gap segment without a background');
  applyUiSettings({toolTint: 'none'});
  try {
    assert.equal(bgOf(emptyView, 'Palette'), undefined, 'no resting fill');
    assert.equal(bgOf({...emptyView, hovered: '1.1'}, 'Palette'), cardTint('hover'), 'hover still shows');
  } finally {applyUiSettings({toolTint: 'standard'});}
});

test('clicks: the owner name on row 2 jumps to the actor, the bar and the title select, the fold glyph at the right end of a parent folds; a card hit box covers the bar', () => {
  const nested = plan([{title: 'One', owner: 'logox', nodes: [{title: 'Inner', owner: 'techne', nodes: [{title: 'Leaf', owner: 'kalon'}]}, {title: 'Side', owner: 'kalon'}]}]);
  const flow = flowAt(nested, 50), geometry = sidebarGeometry(30);
  const inner = flow.boxes.find(box => box.id === '1.1')!;
  const press = (x: number, y: number, time = 0) => stepMouse(flow, emptyView, geometry, {x: x + 2, y: geometry.header + y, action: 'press'}, time);
  assert.equal(inner.y1 - inner.y0, 1, 'two rows');
  assert.equal(inner.owner.y, inner.y0 + 1, 'the owner is on row 2');
  assert.equal(inner.owner.x0, 2);
  assert.deepEqual(press(inner.owner.x0, inner.owner.y).effects, [{kind: 'focus'}, {kind: 'owner', id: '1.1'}]);
  assert.deepEqual(press(inner.owner.x1 - 1, inner.owner.y).effects, [{kind: 'focus'}, {kind: 'owner', id: '1.1'}]);
  assert.deepEqual(press(inner.owner.x0, inner.y0).effects, [{kind: 'focus'}], 'the title row selects');
  assert.equal(press(inner.owner.x0, inner.y0).view.selected, '1.1');
  assert.equal(press(0, inner.y0).view.selected, '1.1', 'the bar belongs to the card');
  assert.equal(press(0, inner.y1).view.selected, '1.1');
  assert.deepEqual(press(inner.owner.x1 + 1, inner.owner.y).effects, [{kind: 'focus'}], 'the rest of row 2 selects');
  const fold = press(inner.x1 - 2, inner.y0);
  assert.equal(fold.view.expanded.get('1.1'), false, 'the fold glyph folds');
  assert.equal(fold.view.lastClick, undefined);
  assert.equal(press(inner.x1 - 6, inner.y0).view.expanded.get('1.1'), undefined, 'the title does not');
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
  assert.deepEqual(sizes(n(3), 56).rows, [[17, 16, 16]], 'thirds; the remainder goes to the first card');
  assert.deepEqual(sizes(n(4), 56).rows, [[26, 25], [26, 25]], 'four wrap evenly, 2 + 2');
  // The pelican shape: a layer of two above a layer of three keeps each row full width.
  const after = ['1.1', '1.2'];
  const mixed = sizes([...n(2), {title: 'Third', owner: 'techne', after}, {title: 'Fourth', owner: 'techne', after}, {title: 'Fifth', owner: 'techne', after}], 56);
  assert.deepEqual(mixed.rows, [[26, 25], [17, 16, 16]]);
  // Each connector stem is under the centre of its card.
  const bus = text(mixed.flow).find(line => line.includes('╭') && line.includes('╮'))!;
  const boxes = mixed.flow.boxes.filter(box => box.parent === '1');
  const centre = (id: string) => { const box = boxes.find(item => item.id === id)!; return box.x0 + Math.floor((box.x1 - box.x0) / 2); };
  assert.equal(bus[centre('1.1')], '┴', 'a source stem under the first card centre'); assert.equal(bus[centre('1.2')], '┴', 'and under the second');
  assert.equal(bus.indexOf('╭'), centre('1.3')); assert.equal(bus.lastIndexOf('╮'), centre('1.5'), 'targets on the centres of the three cards below');
});

test('a result that is only an echoed Goal line or message envelope is never shown on a card', () => {
  const base = plan([{title: 'Phase', owner: 'logox', nodes: [{title: 'Build', owner: 'techne'}]}], [{id: 'a', status: 'completed'}], {'1.1': ['a']});
  const noted = (note: string) => text(flowAt(derivePlan({...base, nodes: base.nodes.map(node => node.id === '1.1' ? {...node, note} : node)}, [{id: 'a', status: 'completed'}]), 56)).join('\n');
  assert.match(noted('Everything passes'), /techne · Everything passes/);
  assert.doesNotMatch(noted('Goal: [Message from aletheia · check the bell]'), /Goal|Message from/);
  assert.doesNotMatch(noted('[Message from aletheia · check]'), /Message from/);
});
