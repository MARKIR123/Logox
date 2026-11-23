import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import type {TeamEvent} from '../src/runtime/team-events.js';
import type {Delegation} from '../src/runtime/delegations.js';
import type {Plan, PlanNode} from '../src/runtime/plan.js';
import {taskGraph} from '../src/runtime/task-graph.js';
import {actModel, finalScene, plannedWork, sceneAt} from '../src/runtime/team-acts.js';
import {actorDetail, rosterOrder, stageAt, workerName, type StageSnapshot} from '../src/runtime/team-stage.js';
import {CONTENT_X} from '../src/tui/panels/sidebar-frame.js';
import {PLAY_STEP_MS, arrived, buildTeamLayout, emptyTeamView, paintTeam, positionOf, selectedId, stageRowsFor, stepPlay, stepTeamKey, stepTeamMouse, teamGeometry, teamGeometryFor, teamLabeler, teamWidth,
  togglePlay, type TeamLayout, type TeamPointer, type TeamView} from '../src/tui/panels/team-sidebar.js';
import {GAP, PULSE_MS, buildStage, controlsRow, nextSpeed, pulseAt, reserveFor, scrubPosition, stageHeight, stripRow, workerPieces, type StagePlan} from '../src/tui/panels/team-stage.js';

const SYMBOLS: Record<string, string> = {logox: '◈', kalon: '✧', techne: '⊞', aletheia: '◎'};
const label = teamLabeler(id => ({symbol: SYMBOLS[id] ?? '◇', name: id}));
const T0 = new Date(2026, 10, 20, 8, 0, 0).getTime();
let counter = 0;
const ev = (event: Omit<TeamEvent, 'id' | 'at' | 'ref'> & {at?: number}): TeamEvent => {const n = counter++; return {id: 'e' + n, at: T0 + n * 60_000, ref: 'r' + n, ...event};};
const fresh = () => {counter = 0;};
const user = (): TeamEvent => ev({from: 'user', to: ['logox'], kind: 'user', text: 'draw it'});
const assign = (...to: string[]): TeamEvent => ev({from: 'logox', to, kind: 'assign', text: 'task'});
const message = (from: string, ...to: string[]): TeamEvent => ev({from, to, kind: 'message', text: 'hello from ' + from});
const report = (from: string, status: 'done' | 'failed' | 'blocked' = 'done'): TeamEvent => ev({from, to: ['logox'], kind: 'report', status, text: 'finished'});
const wait = (from: string, on: string): TeamEvent => ev({from, to: [on], kind: 'waiting', text: 'waiting on ' + on});
const workers = (from: string, ...items: {title: string; fork?: boolean; name?: string}[]): TeamEvent =>
  ev({from, to: [], kind: 'workers', text: items.length + ' workers', items: items.map(item => ({title: item.title, fork: item.fork ?? false, ...(item.name ? {name: item.name} : {})}))});
const result = (dispatcher: string, title: string, status: 'done' | 'failed' = 'done'): TeamEvent => ev({from: 'automa', to: [dispatcher], kind: 'result', status, title, dispatcher, text: 'ok'});

/** The approved design's session: the person, a dispatch, a peer message, workers, a result, a wait, a report. */
function story(): TeamEvent[] {
  fresh();
  return [user(), assign('kalon', 'techne'), message('techne', 'kalon'), workers('kalon', {title: 'scout'}, {title: 'palette'}, {title: 'sketch', fork: true}), result('kalon', 'scout'),
    wait('aletheia', 'techne'), report('techne'), message('kalon', 'aletheia')];
}
const ROWS = (plan: StagePlan) => plan.rows.map(row => row.map(cell => cell.text).join(''));
/** A stage of one scene (no acts): its height reserved from the end of the stream, as the sidebar does for each act. */
const buildOne = (snapshot: StageSnapshot, final: StageSnapshot, width: number): StagePlan => {
  const need = reserveFor([final]);
  return buildStage(snapshot, need, stageHeight([final], need, width, label), width, label);
};
const stageOf = (events: readonly TeamEvent[], index: number, width: number): StagePlan => buildOne(stageAt(events, index), stageAt(events, events.length - 1), width);

// ---------------------------------------------------------------------------------------------------------------------------------- state
test('only the actors that appeared up to the index are on stage, in roster order whatever the order of appearance', () => {
  fresh();
  const events = [assign('aletheia'), assign('techne', 'kalon'), message('zed', 'kalon'), message('aaron', 'zed')];
  assert.deepEqual(stageAt(events, 0).actors.map(actor => actor.id), ['aletheia']);
  assert.deepEqual(stageAt(events, 1).actors.map(actor => actor.id), ['kalon', 'techne', 'aletheia'], 'roster order: kalon, techne, aletheia');
  assert.deepEqual(stageAt(events, 3).actors.map(actor => actor.id), ['kalon', 'techne', 'aletheia', 'aaron', 'zed'], 'unknown actors follow, alphabetically');
  assert.deepEqual(stageAt(events, -1).actors, []);
  assert.deepEqual(rosterOrder(['zed', 'techne', 'kalon']), ['kalon', 'techne', 'zed']);
  assert.equal(stageAt(events, 99).index, 3, 'an index past the end is the end');
});

test('actor states: assigned or messaged is working, a done report is done, a wait is waiting until what it waits on reports', () => {
  const events = story();
  const state = (index: number, id: string) => stageAt(events, index).actors.find(actor => actor.id === id)?.state;
  assert.equal(state(1, 'kalon'), 'working');
  assert.equal(state(1, 'techne'), 'working');
  assert.equal(state(5, 'aletheia'), 'waiting');
  assert.equal(state(6, 'techne'), 'done');
  assert.equal(state(6, 'aletheia'), 'working', 'what it waited on reported: it goes on');
  assert.equal(state(0, 'kalon'), undefined);
  fresh();
  const failing = [assign('kalon', 'techne'), report('kalon', 'failed'), report('techne', 'blocked')];
  assert.equal(stageAt(failing, 1).actors[0]!.state, 'failed');
  assert.equal(stageAt(failing, 2).actors[1]!.state, 'waiting');
  assert.equal(stageAt([user()], 0).actors.length, 0, 'the person is not a card');
});

test('workers: the dispatcher keeps each job (name, status, duration); a result settles the job with its title and the live counts follow', () => {
  const events = story();
  const at3 = stageAt(events, 3).actors.find(actor => actor.id === 'kalon')!;
  assert.equal(at3.workers, 2);
  assert.equal(at3.forks, 1);
  assert.deepEqual(at3.jobs.map(job => [job.name, job.fork, job.status]), [['scout', false, 'running'], ['palette', false, 'running'], ['sketch', true, 'running']]);
  const at4 = stageAt(events, 4).actors.find(actor => actor.id === 'kalon')!;
  assert.equal(at4.workers, 1);
  assert.equal(at4.forks, 1);
  assert.equal(at4.jobs[0]!.status, 'done');
  assert.equal(at4.jobs[0]!.ms, 60_000, 'the duration is the time between the dispatch and the result');
  assert.equal(stageAt(events, 2).actors.find(actor => actor.id === 'kalon')!.jobs.length, 0, 'nothing before the dispatch');
  fresh();
  const named = [workers('kalon', {title: 'Collect reference illustrations of coastal cycling', name: 'scout'}, {title: 'palette'}), result('kalon', 'Collect reference illustrations of coastal cycling', 'failed')];
  const jobs = stageAt(named, 1).actors[0]!.jobs;
  assert.deepEqual(jobs.map(job => [job.name, job.status]), [['scout', 'failed'], ['palette', 'running']], 'a job name is used when it has one, the title otherwise');
  assert.equal(workerName({title: 'x', name: ' '}), 'x');
});

test('edges count what travelled so far; waits stay open until the waiter acts; the current edge and the last four events are kept apart', () => {
  const events = story();
  const edges = (index: number) => Object.fromEntries(stageAt(events, index).edges.map(edge => [edge.from + '>' + edge.to, edge.count]));
  assert.deepEqual(edges(2), {'user>logox': 1, 'logox>kalon': 1, 'logox>techne': 1, 'techne>kalon': 1});
  assert.deepEqual(edges(6), {'user>logox': 1, 'logox>kalon': 1, 'logox>techne': 1, 'techne>kalon': 1, 'automa>kalon': 1, 'techne>logox': 1});
  assert.deepEqual(stageAt(events, 5).waits, [{from: 'aletheia', to: 'techne'}]);
  assert.deepEqual(stageAt(events, 6).waits, [], 'techne reported: the wait is over');
  assert.deepEqual(stageAt(events, 2).current, {id: events[2]!.id, kind: 'message', from: 'techne', to: ['kalon']});
  assert.equal(stageAt(events, 0).hasUser, true);
  assert.equal(stageAt([events[1]!], 0).hasUser, false);
  const snapshot = stageAt(events, 7);
  assert.deepEqual(snapshot.recent.map(item => [item.from, item.to, item.age]), [['kalon', ['aletheia'], 0]], 'only traffic between companions: the report to Logox is not a channel message');
  assert.equal(stageAt(events, 4).recent.length, 1, 'the last four events hold one message between companions (an assign from Logox is a bus edge)');
  assert.equal(stageAt(events, 4).recent[0]!.age, 2);
  assert.ok(stageAt(events, 7).recent.every(item => item.age < 4));
  assert.equal(stageAt(events, 1).peers, false);
  assert.equal(stageAt(events, 2).peers, true);
  // A message 4 events old has faded out of `recent` but keeps its count.
  fresh();
  const old = [message('techne', 'kalon'), user(), user(), user(), user()];
  assert.equal(stageAt(old, 4).recent.length, 0);
  assert.equal(stageAt(old, 4).edges.find(edge => edge.from === 'techne')!.count, 1);
});

test('the actor detail: the latest task, workers, the latest messages with who and which way, counts per peer', () => {
  const events = story();
  const detail = actorDetail(events, 7, 'kalon');
  assert.equal(detail.state, 'working');
  assert.equal(detail.task, 'hello from techne', 'the latest thing it was given');
  assert.deepEqual(detail.jobs.map(job => job.name), ['scout', 'palette', 'sketch']);
  assert.deepEqual(detail.peers, [{peer: 'aletheia', sent: 1, received: 0}, {peer: 'logox', sent: 0, received: 1}, {peer: 'techne', sent: 0, received: 1}]);
  assert.deepEqual(detail.messages.map(item => [item.direction, item.peer, item.kind]), [['out', 'aletheia', 'message'], ['in', 'techne', 'message'], ['in', 'logox', 'assign']]);
  assert.equal(actorDetail(events, 0, 'kalon').task, undefined);
  assert.equal(actorDetail(events, 1, 'kalon').task, 'task');
});

// ---------------------------------------------------------------------------------------------------------------------------------- layout
test('every row is exactly the width at 36, 56 and 80 columns and the height never changes while a replay steps through', () => {
  const events = story();
  for (const width of [33, 53, 77]) {
    const heights = new Set<number>();
    for (let index = 0; index < events.length; index++) {
      const plan = stageOf(events, index, width);
      heights.add(plan.height);
      assert.equal(plan.rows.length, plan.height);
      assert.ok(ROWS(plan).every(row => stringWidth(row) === width), `${width}: every row is ${width} cells\n` + ROWS(plan).join('\n'));
    }
    assert.equal(heights.size, 1, `${width}: one height for the whole replay`);
    const final = stageAt(events, events.length - 1);
    assert.equal(stageHeight([final], reserveFor([final]), width, label), [...heights][0]);
  }
  assert.equal(stageOf(events, 3, 12).height, 0, 'no room for a stage under 20 columns');
});

test('Logox is a rounded card at the top centre, the person above it, the companions in one row of equal cards with a gap of three in roster order', () => {
  const events = story();
  const plan = stageOf(events, 7, 53), rows = ROWS(plan);
  const box = (id: string) => plan.boxes.find(item => item.id === id)!;
  const logox = box('logox'), kalon = box('kalon'), techne = box('techne'), aletheia = box('aletheia');
  assert.equal(Math.abs((logox.x0 + logox.x1) / 2 - 53 / 2) < 1.5, true, 'centred');
  assert.ok(logox.y0 > box('user').y0, 'the person above Logox');
  assert.ok(rows[box('user').y0]!.includes('✓ you'));
  assert.ok(rows[logox.y0]!.slice(logox.x0, logox.x1).startsWith('╭') && rows[logox.y1]!.slice(logox.x0, logox.x1).endsWith('╯'));
  assert.ok(rows[logox.y0 + 1]!.includes('◈ Logox'));
  assert.deepEqual([kalon.y0, techne.y0], [aletheia.y0, aletheia.y0], 'one row');
  assert.ok(kalon.x0 < techne.x0 && techne.x0 < aletheia.x0, 'roster order, left to right');
  const widthOf = (item: typeof kalon) => item.x1 - item.x0;
  assert.equal(widthOf(kalon), widthOf(techne));
  assert.equal(widthOf(techne), widthOf(aletheia));
  assert.equal(techne.x0 - kalon.x1, GAP);
  assert.equal(aletheia.x0 - techne.x1, GAP);
  assert.ok(widthOf(kalon) >= 11);
  assert.ok(rows[kalon.y0 + 1]!.includes('✧ Kalon') && rows[kalon.y0 + 2]!.includes('working'));
  assert.ok(rows[aletheia.y0 + 1]!.includes('◎ Aletheia') && rows[aletheia.y0 + 2]!.includes('working'));
});

test('assign runs down the bus with ▼ and its label, a report up with ▲; used edges stay, the current one is accent, a wait is dashed warning', () => {
  const events = story();
  const early = stageOf(events, 1, 53), rows = ROWS(early);
  assert.equal(rows.filter(row => row.includes('▼')).length >= 2, true);
  assert.ok(rows.some(row => row.includes('assign')), 'the label sits on the current edge');
  assert.ok(rows.some(row => /╭─+┴─+╮/.test(row)), 'the bus joins the stem with box characters');
  // Below Logox (its top border carries the person's arrow).
  const tones = (plan: StagePlan, glyph: string) => plan.rows.slice(plan.boxes.find(item => item.id === 'logox')!.y1 + 1).flatMap(row => row.filter(cell => cell.text.includes(glyph)).map(cell => cell.tone));
  assert.ok(tones(early, '▼').length === 2 && tones(early, '▼').every(tone => tone === 'accent'), 'the current edge is accent');
  const later = stageOf(events, 6, 53);
  assert.ok(tones(later, '▲').includes('accent'), 'the report is the current edge');
  assert.ok(tones(later, '▼').every(tone => tone === 'faint'), 'used edges are faint');
  const waiting = stageOf(events, 5, 53);
  assert.ok(ROWS(waiting).some(row => row.includes('┄') || row.includes('┆')), 'a wait is dashed');
  assert.ok(waiting.rows.flatMap(row => row.filter(cell => /[┄┆]/.test(cell.text))).every(cell => cell.tone === 'warning' || cell.tone === 'accent'));
});

test('a message is the segment of the channel under the cards between the two ports with an arrowhead at the receiver, in the sender\'s colour and accent while current', () => {
  const events = story();
  const plan = stageOf(events, 2, 53), rows = ROWS(plan);
  const kalon = plan.boxes.find(item => item.id === 'kalon')!, techne = plan.boxes.find(item => item.id === 'techne')!;
  const channel = rows[kalon.y1 + 1]!;
  assert.ok(channel.includes('╰◀') && channel.includes('╯'), 'techne to kalon points left into kalon\'s port\n' + rows.join('\n'));
  const kalonPort = kalon.x0 + Math.floor((kalon.x1 - kalon.x0) / 2), technePort = techne.x0 + Math.floor((techne.x1 - techne.x0) / 2);
  assert.equal(rows[kalon.y1]![kalonPort], '┬');
  assert.equal(rows[techne.y1]![technePort], '┬');
  assert.equal(stringWidth(channel.slice(0, kalonPort)), kalonPort);
  assert.ok(plan.rows[kalon.y1 + 1]!.some(cell => cell.tone === 'accent' && cell.text.includes('◀')), 'current: accent');
  assert.ok(rows.some(row => row.includes('msg')), 'the label of the current message');
  // Two events later it is older, in the sender's own colour, not accent.
  const older = stageOf(events, 4, 53);
  const cells = older.rows[kalon.y1 + 1]!.filter(cell => cell.text.includes('◀'));
  assert.ok(cells.length === 1 && cells[0]!.tone === 'owner' && cells[0]!.owner === 'techne');
  // Older than the last four events it is gone entirely, the count stays on the detail page.
  const faded = stageOf(events, 6, 53);
  assert.ok(!ROWS(faded).some(row => row.includes('◀')), 'faded out\n' + ROWS(faded).join('\n'));
});

test('no edge is ever drawn through a card and the cards read the same with or without edges', () => {
  const events = story();
  for (const width of [33, 53, 77]) for (let index = 0; index < events.length; index++) {
    const plan = stageOf(events, index, width), bare = buildOne({...stageAt(events, index), edges: [], waits: [], recent: [], current: undefined as never, hasUser: false}, stageAt(events, events.length - 1), width);
    const rows = ROWS(plan), bareRows = ROWS(bare);
    for (const box of plan.boxes) {
      if (box.id === 'user') continue;
      // The rows between the borders (a border shows where a line enters or leaves: a port, the person's arrow).
      for (let y = box.y0 + 1; y < box.y1; y++) {
        const inside = (list: string[]) => sliceCells(list[y]!, box.x0 + 1, box.x1 - 1);
        // Interior (between the side borders): identical with and without edges, and no line or arrow character in it.
        assert.equal(inside(rows), inside(bareRows), `${width}/${index}: card ${box.id} row ${y} interior`);
        assert.ok(!/[▼▲◀▶┆┄┼]/.test(inside(rows)), `${width}/${index}: nothing drawn through ${box.id}`);
      }
    }
  }
});
const sliceCells = (text: string, from: number, to: number): string => {
  let out = '', at = 0;
  for (const char of text) {const size = stringWidth(char); if (at >= from && at < to) out += char; at += size;}
  return out;
};

test('more companions than fit wrap into evenly filled rows with a trunk in column 0, channels per row and a trunk in the last column; nothing overlaps or leaves the width', () => {
  fresh();
  const names = ['kalon', 'techne', 'aletheia', 'mira', 'orin', 'vex'];
  const events = [user(), assign(...names), message('techne', 'aletheia'), message('kalon', 'vex'), message('mira', 'orin'), report('vex')];
  const plan = stageOf(events, events.length - 1, 33), rows = ROWS(plan);
  assert.ok(rows.every(row => stringWidth(row) === 33));
  const cards = plan.boxes.filter(item => item.id !== 'user' && item.id !== 'logox');
  assert.equal(cards.length, 6);
  const tops = [...new Set(cards.map(item => item.y0))];
  assert.equal(tops.length, 3, 'three rows of two');
  assert.ok(cards.every(item => item.x0 >= 2 && item.x1 <= 32), 'column 0 and the last column are free for the trunks');
  for (const top of tops) assert.equal(cards.filter(item => item.y0 === top).length, 2, 'evenly filled');
  for (const a of cards) for (const b of cards) if (a !== b) assert.ok(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 < b.y0 || b.y1 < a.y0, `${a.id} and ${b.id} do not overlap`);
  const trunk = rows.slice(plan.boxes.find(item => item.id === 'logox')!.y1 + 1).map(row => row[0]);
  assert.ok(trunk.includes('│') || trunk.includes('├'), 'the bus trunk in column 0');
  assert.ok(rows.some(row => row.endsWith('│') || row.endsWith('┤') || row.endsWith('╮') || row.endsWith('╯')), 'the message trunk in the last column');
  // The current message crosses rows (kalon in row 1 to vex in row 3 is the earlier one; the current event is the report on the bus).
  const cross = stageOf(events, 3, 33);
  assert.ok(cross.paths.length === 1 && cross.paths[0]!.length > 6, 'the current cross-row message has a pulse path');
  const crossRows = ROWS(cross);
  assert.ok(crossRows.some(row => row.includes('◀')), 'the arrowhead enters the receiver row from the trunk');
  // Cards and the stage still fit eight actors at 80 columns.
  fresh();
  const many = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
  const big = stageOf([user(), assign(...many)], 1, 77);
  assert.ok(ROWS(big).every(row => stringWidth(row) === 77));
  assert.equal(big.boxes.filter(item => item.id !== 'user' && item.id !== 'logox').length, 8);
});

test('at most two channel rows: a third overlapping message is not drawn and the current one always is', () => {
  fresh();
  const events = [assign('kalon', 'techne', 'aletheia'), message('kalon', 'aletheia'), message('techne', 'aletheia'), message('aletheia', 'kalon'), message('kalon', 'techne')];
  const plan = stageOf(events, 4, 53);
  const kalon = plan.boxes.find(item => item.id === 'kalon')!;
  const below = ROWS(plan).slice(kalon.y1 + 1, kalon.y1 + 4);
  assert.ok(below.slice(0, 2).some(row => /[◀▶]/.test(row)));
  assert.ok(!/[◀▶]/.test(below[2] ?? ''), 'no third channel row');
  assert.equal(plan.paths.length, 1);
  const arrows = ROWS(plan).join('').match(/[◀▶]/g)!.length;
  assert.ok(arrows <= 2, 'two segments at most: ' + arrows);
  const current = plan.paths[0]!, from = current[0]!, to = current.at(-1)!;
  assert.ok(Math.abs(to.x - from.x) > 0, 'the current message (kalon to techne) is drawn');
});

test('workers sit inside their dispatcher\'s card: as many jobs as fit, then counts, then the total', () => {
  const events = story();
  const wide = stageOf(events, 4, 77), rows = ROWS(wide);
  const kalon = wide.boxes.find(item => item.id === 'kalon')!;
  const inner = sliceCells(rows[kalon.y1 - 1]!, kalon.x0 + 1, kalon.x1 - 1);
  assert.match(inner, /◦ scout ✓/, 'a worker with its status mark: ' + inner);
  assert.equal(kalon.y1 - kalon.y0, 4, 'the card has a worker row when any actor ever dispatched');
  assert.ok(rows.every(row => !row.includes('workers')), 'nothing under the card any more');
  const narrow = ROWS(stageOf(events, 4, 33)).join('\n');
  assert.match(narrow, /◦2 ⑂1 ✓1/, 'counts when narrow\n' + narrow);
  const text = (jobs: Parameters<typeof workerPieces>[0], room: number) => workerPieces(jobs, room).map(piece => piece.text).join('');
  const jobs = [{name: 'scout', title: 'scout', fork: false, status: 'done' as const, startedAt: 0}, {name: 'palette', title: 'palette', fork: false, status: 'running' as const, startedAt: 0},
    {name: 'sketch', title: 'sketch', fork: true, status: 'failed' as const, startedAt: 0}];
  assert.equal(text(jobs, 60), '◦ scout ✓  ◦ palette …  ⑂ sketch ✗');
  assert.equal(text(jobs, 12), '◦ scout ✓ +2');
  assert.equal(text(jobs, 9), '◦2 ⑂1 ✓1', 'counts when the names do not fit, the failures go first');
  assert.equal(text(jobs, 6), '◦2 ⑂1');
  assert.equal(text(jobs, 3), '◦3', 'down to the total');
  assert.equal(text([], 20), '');
  // Fewer jobs than fit are listed whole; the rest is counted: `+n`.
  assert.match(text(jobs, 26), /^◦ scout ✓  ◦ palette … \+1$/);
});

test('a short sidebar collapses the stage to the controls and a one-line status; under twelve rows there is none', () => {
  const events = story();
  const layout = buildTeamLayout(events, {width: teamWidth(56), label});
  assert.equal(stageRowsFor(layout, 44).mode, 'full');
  assert.ok(stageRowsFor(layout, 44).rows >= 12);
  assert.deepEqual(stageRowsFor(layout, 29), {rows: 2, mode: 'strip'});
  assert.deepEqual(stageRowsFor(layout, 12), {rows: 2, mode: 'strip'});
  assert.deepEqual(stageRowsFor(layout, 11), {rows: 0, mode: 'off'});
  assert.deepEqual(stageRowsFor(buildTeamLayout([], {width: teamWidth(56), label}), 44), {rows: 0, mode: 'off'});
  const geometry = teamGeometryFor(layout, 24);
  assert.deepEqual([geometry.header, geometry.stage, geometry.footer, geometry.body], [2, 2, 2, 18]);
  assert.deepEqual(teamGeometry(24), {height: 24, header: 2, footer: 2, body: 20, stage: 0, stageMode: 'off'}, 'the plain geometry has no stage');
  const strip = stripRow(stageAt(events, 5).actors, 60, label).map(cell => cell.text).join('');
  assert.equal(strip, 'Working ✧ kalon ⊞ techne · Waiting ◎ aletheia · Done —');
  const done = stripRow(stageAt(events, 6).actors, 60, label).map(cell => cell.text).join('');
  assert.equal(done, 'Working ✧ kalon ◎ aletheia · Waiting — · Done ⊞ techne');
  assert.ok(stringWidth(stripRow(stageAt(events, 6).actors, 20, label).map(cell => cell.text).join('')) <= 20);
  const lines = paintTeam({layout, view: {...emptyTeamView, live: false, selected: layout.ids[5]!}, width: 56, height: 24, focused: false, ownerColor: () => '#fff', label, stage: true}).map(line => line.map(segment => segment.text).join(''));
  assert.equal(lines.length, 24);
  assert.ok(lines.every(line => stringWidth(line) === 56));
  assert.match(lines[3]!, /^│ Working kalon techne · Waiting aletheia · Done —/, 'the glyphs go when the line would not fit');
  const roomy = buildTeamLayout(events, {width: teamWidth(64), label});
  const wide = paintTeam({layout: roomy, view: {...emptyTeamView, live: false, selected: roomy.ids[5]!}, width: 64, height: 24, focused: false, ownerColor: () => '#fff', label, stage: true}).map(line => line.map(segment => segment.text).join(''));
  assert.match(wide[3]!, /^│ Working ✧ kalon ⊞ techne · Waiting ◎ aletheia · Done —/);
  assert.match(lines[2]!, /^│ ◀ ▶ ▶ Play /);
  assert.match(lines.at(-1)!, /^│ [●○] Live +all members ▾ *$/, 'with a stage the footer keeps the Live switch and the member filter; the controls row carries the stepping');
  assert.equal(lines.filter(line => line.includes('◀ ▶')).length, 1, 'the stepping buttons appear once');
  const plain = paintTeam({layout, view: {...emptyTeamView, live: false, selected: layout.ids[5]!}, width: 56, height: 24, focused: false, ownerColor: () => '#fff', label}).map(line => line.map(segment => segment.text).join(''));
  assert.match(plain.at(-1)!, /^│ ◀ ▶ {3}6 \/ 8 /, 'without a stage the footer keeps the full form');
});

test('the stage draws with palette colours only and no cell carries a background, in every mode', () => {
  const events = story();
  const layout = buildTeamLayout(events, {width: teamWidth(56), label});
  for (const height of [44, 20, 10]) for (const index of [0, 2, 5, 7]) {
    const lines = paintTeam({layout, view: {...emptyTeamView, live: false, selected: layout.ids[index]!, hoveredStage: 'card:kalon', card: 'techne'}, width: 56, height, focused: true, ownerColor: id => '#' + (id.charCodeAt(0) % 10).toString().repeat(6),
      label, stage: true, pulseMs: 100});
    assert.equal(lines.length, height);
    for (const segment of lines.flat()) assert.equal((segment as {bg?: string}).bg, undefined);
    assert.ok(lines.every(line => stringWidth(line.map(segment => segment.text).join('')) === 56));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------- pulse
test('the pulse is a pure function of elapsed time: it walks the path from sender to receiver in 500 ms and then is gone', () => {
  const path = Array.from({length: 10}, (_, x) => ({x, y: 3}));
  assert.deepEqual(pulseAt(path, 0), {x: 0, y: 3});
  assert.deepEqual(pulseAt(path, 249), {x: 4, y: 3});
  assert.deepEqual(pulseAt(path, PULSE_MS - 1), {x: 9, y: 3});
  assert.equal(pulseAt(path, PULSE_MS), undefined);
  assert.equal(pulseAt(path, -1), undefined);
  assert.equal(pulseAt([], 10), undefined);
  const positions = [0, 100, 200, 300, 400].map(ms => pulseAt(path, ms)!.x);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'it only moves forward');
  assert.equal(PULSE_MS, 500);
});

test('a pulse path runs from the sender to the receiver: you into Logox, Logox down to the card, the card up to Logox, a worker result into its card', () => {
  const events = story();
  const first = stageOf(events, 0, 53);
  assert.equal(first.paths.length, 1);
  const you = first.boxes.find(item => item.id === 'user')!, logox = first.boxes.find(item => item.id === 'logox')!;
  assert.equal(first.paths[0]![0]!.y, you.y0 + 1);
  assert.equal(first.paths[0]!.at(-1)!.y, logox.y0, 'into the top of Logox');
  const assigned = stageOf(events, 1, 53);
  assert.equal(assigned.paths.length, 2, 'one pulse per receiver');
  for (const path of assigned.paths) {assert.equal(path[0]!.y, logox.y1); assert.ok(path.at(-1)!.y > logox.y1);}
  const reported = stageOf(events, 6, 53);
  const techne = reported.boxes.find(item => item.id === 'techne')!;
  assert.ok(reported.paths[0]![0]!.y < techne.y0 && reported.paths[0]![0]!.y > logox.y1, 'a report starts at the card and ends at Logox');
  assert.equal(reported.paths[0]!.at(-1)!.y, logox.y1);
  const settled = stageOf(events, 4, 53), kalon = settled.boxes.find(item => item.id === 'kalon')!;
  assert.ok(settled.paths[0]!.every(point => point.y >= kalon.y0 && point.y <= kalon.y1), 'a result pulses inside the dispatcher\'s card');
  assert.equal(stageOf(events, 3, 53).paths.length, 0, 'a dispatch of workers has no travelling edge');
  const painted = (ms?: number) => {
    const layout = buildTeamLayout(events, {width: teamWidth(56), label});
    const lines = paintTeam({layout, view: {...emptyTeamView, live: false, selected: layout.ids[1]!}, width: 56, height: 44, focused: false, ownerColor: () => '#fff', label, stage: true, ...(ms !== undefined ? {pulseMs: ms} : {})});
    return lines.slice(3, 18).map(line => line.map(segment => segment.text).join(''));
  };
  assert.ok(!painted().join('').includes('●'), 'no pulse unless the host gives the time');
  assert.ok(painted(10).join('').includes('●') && painted(300).join('').includes('●'));
  assert.ok(!painted(PULSE_MS).join('').includes('●'), 'done');
  assert.notDeepEqual(painted(10), painted(300), 'it moves');
});

test('stepping by hand jumps and never animates; playback and a new post while Live start the pulse', () => {
  const events = story();
  const layout = buildTeamLayout(events, {width: teamWidth(56), label});
  const geometry = teamGeometryFor(layout, 44);
  const pulsing: TeamView = {...emptyTeamView, live: false, selected: layout.ids[2]!, pulse: {id: layout.ids[2]!, at: 100}, playing: true, card: 'kalon'};
  for (const key of [{right: true}, {left: true}, {down: true}, {up: true}, {home: true}, {end: true}, {pageDown: true}]) {
    const step = stepTeamKey(layout, pulsing, geometry, key, 5000);
    assert.equal(step.view.pulse, undefined, JSON.stringify(key) + ' leaves no pulse');
    assert.ok(!step.view.playing, JSON.stringify(key) + ' stops playback');
  }
  const scrubbed = stepTeamMouse(layout, pulsing, geometry, {x: CONTENT_X + 0, y: geometry.header, action: 'press'}, 5000, 56, label);
  assert.equal(scrubbed.view.pulse, undefined, 'the ◀ button jumps');
  assert.equal(selectedId(layout, scrubbed.view), layout.ids[1]);
  // Playback pulses the post it moves to.
  const play = togglePlay(layout, {...emptyTeamView, live: false, selected: layout.ids[2]!}, geometry, 1000);
  assert.equal(play.playing, true);
  assert.equal(play.pulse, undefined, 'starting from the middle only starts the timer');
  const stepped = stepPlay(layout, play, geometry, 2000);
  assert.equal(selectedId(layout, stepped), layout.ids[3]);
  assert.deepEqual(stepped.pulse, {id: layout.ids[3]!, at: 2000});
  assert.equal(stepped.playing, true);
  assert.equal(stepped.live, false);
  // Arriving at the end switches to Live, with the last post pulsing, and stops.
  let view = play, now = 2000;
  for (let guard = 0; guard < 20 && view.playing; guard++) view = stepPlay(layout, view, geometry, now += PLAY_STEP_MS);
  assert.equal(view.live, true);
  assert.equal(view.playing, false);
  assert.equal(selectedId(layout, view), layout.ids.at(-1));
  assert.equal(view.pulse?.id, layout.ids.at(-1));
  // Play at the end starts over from the first post (with its pulse); pause stops.
  const restart = togglePlay(layout, view, geometry, 9000);
  assert.equal(selectedId(layout, restart), layout.ids[0]);
  assert.deepEqual(restart.pulse, {id: layout.ids[0]!, at: 9000});
  assert.equal(restart.live, false);
  assert.equal(togglePlay(layout, restart, geometry, 9100).playing, false);
  assert.equal(stepPlay(layout, {...emptyTeamView, live: false, selected: layout.ids[2]!}, geometry, 1).pulse, undefined, 'not playing: nothing happens');
  // A new post while Live pulses; a view that left Live is left alone.
  assert.deepEqual(arrived(emptyTeamView, 'e9', 700).pulse, {id: 'e9', at: 700});
  assert.equal(arrived({...emptyTeamView, live: false}, 'e9', 700).pulse, undefined);
  assert.equal(PLAY_STEP_MS, 900);
});

// ---------------------------------------------------------------------------------------------------------------------------------- controls
test('the controls row: step buttons, Play or Pause, the scrubber with its thumb, the counter with the elapsed time and the speed; narrow widths drop words first', () => {
  const text = (width: number, extra: Partial<Parameters<typeof controlsRow>[0]> = {}) => controlsRow({width, playing: false, speed: 1, position: 13, total: 26, elapsed: 587_000, ...extra}).cells.map(cell => cell.text).join('');
  const wide = text(53);
  assert.match(wide, /^◀ ▶ ▶ Play [━─●]+ 13\/26 · \+9m47s {2}1×$/);
  assert.equal(stringWidth(wide), 53);
  assert.match(text(53, {playing: true}), /^◀ ▶ ❚❚ Pause /);
  assert.match(text(53, {speed: 4}), /4×$/);
  for (const width of [33, 28, 24]) assert.equal(stringWidth(text(width)), width, 'fills the width at ' + width);
  assert.ok(!text(33).includes('+9m47s') && text(33).includes('Play'), 'the elapsed time goes first when narrow');
  assert.ok(!text(24).includes('Play') && text(24).startsWith('◀ ▶ ▶ '), 'then the word');
  const row = controlsRow({width: 53, playing: false, speed: 2, position: 1, total: 26, elapsed: 0});
  assert.deepEqual(row.regions.map(region => region.control), ['prev', 'next', 'play', 'scrub', 'speed']);
  const thumb = (position: number, total: number) => {
    const cells = controlsRow({width: 53, playing: false, speed: 1, position, total, elapsed: 0}).cells.map(cell => cell.text).join('');
    return stringWidth(cells.slice(0, cells.indexOf('●')));
  };
  assert.ok(thumb(1, 26) < thumb(13, 26) && thumb(13, 26) < thumb(26, 26));
  const last = controlsRow({width: 53, playing: false, speed: 1, position: 26, total: 26, elapsed: 0}).bar;
  assert.equal(thumb(26, 26) - last.x0, last.length - 1, 'the last post puts the thumb at the end');
  assert.equal(scrubPosition(row.bar, row.bar.x0, 26), 1);
  assert.equal(scrubPosition(row.bar, row.bar.x0 + row.bar.length - 1, 26), 26);
  assert.equal(scrubPosition(row.bar, row.bar.x0 - 9, 26), 1, 'clamped');
  assert.equal(scrubPosition(row.bar, row.bar.x0 + 99, 26), 26);
  assert.equal(scrubPosition(row.bar, row.bar.x0 + Math.round((row.bar.length - 1) / 2), 26), 14);
  assert.equal(nextSpeed(1, 1, true), 2);
  assert.equal(nextSpeed(2, 1, true), 4);
  assert.equal(nextSpeed(4, 1, true), 1, 'a click cycles');
  assert.equal(nextSpeed(4, 1, false), 4, 'a key clamps');
  assert.equal(nextSpeed(1, -1, false), 1);
  assert.equal(nextSpeed(4, -1, false), 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------- interaction
const HEIGHT = 44;
const setup = () => {
  const events = story();
  const layout = buildTeamLayout(events, {width: teamWidth(56), label});
  const geometry = teamGeometryFor(layout, HEIGHT);
  const press = (view: TeamView, x: number, y: number, now = 0, action: TeamPointer['action'] = 'press') =>
    stepTeamMouse(layout, view, geometry, {x: CONTENT_X + x, y, action}, now, 56, label);
  return {events, layout, geometry, press};
};

test('the controls work by click and key: play and pause, step, speed, Home and End, and the Live switch', () => {
  const {layout, geometry, press} = setup();
  assert.equal(geometry.stageMode, 'full');
  const row = (view: TeamView) => controlsRow({width: layout.width, playing: view.playing ?? false, speed: view.speed ?? 1, position: positionOf(layout, view), total: layout.ids.length, elapsed: 0});
  const y = geometry.header;
  const at = (view: TeamView, control: string) => row(view).regions.find(region => region.control === control)!.x0;
  let view: TeamView = {...emptyTeamView, live: false, selected: layout.ids[3]!};
  // ◀ ▶
  view = press(view, at(view, 'prev'), y).view;
  assert.equal(selectedId(layout, view), layout.ids[2]);
  view = press(view, at(view, 'next'), y).view;
  view = press(view, at(view, 'next'), y).view;
  assert.equal(selectedId(layout, view), layout.ids[4]);
  // Play, then Pause.
  const played = press(view, at(view, 'play'), y, 100);
  assert.equal(played.view.playing, true);
  assert.deepEqual(played.effects, [{kind: 'focus'}]);
  assert.equal(press(played.view, at(played.view, 'play'), y, 200).view.playing, false);
  // Speed cycles 1x, 2x, 4x, 1x.
  const speeds = [1];
  let sped = view;
  for (let n = 0; n < 3; n++) {sped = press(sped, at(sped, 'speed'), y).view; speeds.push(sped.speed!);}
  assert.deepEqual(speeds, [1, 2, 4, 1]);
  // Keys.
  const space = stepTeamKey(layout, view, geometry, {space: true}, 50);
  assert.equal(space.view.playing, true);
  assert.equal(stepTeamKey(layout, space.view, geometry, {space: true}, 60).view.playing, false);
  assert.equal(stepTeamKey(layout, view, geometry, {faster: true}).view.speed, 2);
  assert.equal(stepTeamKey(layout, {...view, speed: 4}, geometry, {faster: true}).view.speed, 4);
  assert.equal(stepTeamKey(layout, {...view, speed: 4}, geometry, {slower: true}).view.speed, 2);
  assert.equal(stepTeamKey(layout, view, geometry, {slower: true}).view.speed, 1);
  assert.equal(selectedId(layout, stepTeamKey(layout, view, geometry, {left: true}).view), layout.ids[3]);
  assert.equal(selectedId(layout, stepTeamKey(layout, view, geometry, {right: true}).view), layout.ids[5]);
  assert.equal(selectedId(layout, stepTeamKey(layout, view, geometry, {home: true}).view), layout.ids[0]);
  const end = stepTeamKey(layout, view, geometry, {end: true}).view;
  assert.equal(end.live, true);
  assert.equal(selectedId(layout, end), layout.ids.at(-1));
  // The Live switch sits at the left of the footer row, beside the member filter.
  const live = stepTeamMouse(layout, view, geometry, {x: CONTENT_X + 2, y: geometry.height - 1, action: 'press'}, 0, 56, label).view;
  assert.equal(live.live, true);
});

test('the scrubber jumps on a click and follows a drag, even outside the panel, until the release', () => {
  const {layout, geometry, press} = setup();
  const bar = controlsRow({width: layout.width, playing: false, speed: 1, position: 1, total: layout.ids.length, elapsed: 0}).bar;
  const y = geometry.header;
  const first = press({...emptyTeamView, playing: true}, bar.x0 + bar.length - 1, y);
  assert.equal(selectedId(layout, first.view), layout.ids.at(-1), 'a click at the end of the bar jumps to the last post');
  assert.equal(first.view.live, false);
  assert.equal(first.view.scrubbing, true);
  assert.equal(first.view.playing, false, 'a jump pauses');
  assert.equal(first.view.pulse, undefined);
  const mid = press(first.view, bar.x0 + Math.round((bar.length - 1) / 2), y, 0, 'drag');
  assert.equal(positionOf(layout, mid.view), 1 + Math.round(Math.round((bar.length - 1) / 2) / (bar.length - 1) * (layout.ids.length - 1)));
  assert.equal(mid.view.scrubbing, true);
  const back = stepTeamMouse(layout, mid.view, geometry, {x: -40, y: 30, action: 'drag'}, 0, 56, label);
  assert.equal(positionOf(layout, back.view), 1, 'dragging left of the panel clamps to the first post');
  const beyond = stepTeamMouse(layout, back.view, geometry, {x: 500, y: 0, action: 'drag'}, 0, 56, label);
  assert.equal(positionOf(layout, beyond.view), layout.ids.length);
  const released = stepTeamMouse(layout, beyond.view, geometry, {x: 500, y: 0, action: 'release'}, 0, 56, label);
  assert.equal(released.view.scrubbing, false);
  assert.equal(selectedId(layout, released.view), layout.ids.at(-1));
  const idle = stepTeamMouse(layout, emptyTeamView, geometry, {x: 10, y: 10, action: 'drag'}, 0, 56, label);
  assert.equal(idle.view, emptyTeamView, 'a drag that holds nothing changes nothing');
});

test('a click on a card selects it and filters the feed to that member, again clears it; a double click (or Enter) opens the actor; hover brightens', () => {
  const {events, layout, geometry, press} = setup();
  const plan = buildOne(stageAt(events, 7), stageAt(events, events.length - 1), layout.width);
  const kalon = plan.boxes.find(item => item.id === 'kalon')!, logox = plan.boxes.find(item => item.id === 'logox')!;
  const px = kalon.x0 + 2, py = geometry.header + 1 + kalon.y0 + 1;
  const view: TeamView = {...emptyTeamView, live: false, selected: layout.ids[7]!};
  const hover = press(view, px, py, 0, 'move');
  assert.equal(hover.view.hoveredStage, 'card:kalon');
  assert.equal(press(hover.view, px, py, 0, 'move').view, hover.view, 'unchanged hover is the same view');
  const first = press(view, px, py, 1000);
  assert.equal(first.view.filter, 'kalon');
  assert.equal(first.view.card, 'kalon');
  assert.deepEqual(first.effects, [{kind: 'focus'}]);
  assert.ok(first.view.hoveredStage === undefined);
  const filteredLayout = buildTeamLayout(events, {width: teamWidth(56), filter: 'kalon', label});
  assert.ok(filteredLayout.ids.length < layout.ids.length, 'the feed is filtered');
  const second = press(first.view, px, py, 1200);
  assert.deepEqual(second.effects, [{kind: 'focus'}, {kind: 'actor', id: 'kalon'}], 'a second click within 350 ms opens the actor');
  assert.equal(second.view.filter, 'kalon', 'it keeps the filter the first click set');
  const slow = press(first.view, px, py, 5000);
  assert.equal(slow.view.filter, undefined, 'a slow second click is another click: it clears the filter');
  assert.equal(slow.view.card, undefined);
  // Enter on a chosen card opens it; without one Enter opens the post.
  assert.deepEqual(stepTeamKey(layout, first.view, geometry, {enter: true}).effects, [{kind: 'actor', id: 'kalon'}]);
  assert.deepEqual(stepTeamKey(layout, view, geometry, {enter: true}).effects, [{kind: 'open', id: layout.ids[7]!}]);
  // Choosing a post by the keyboard drops the card.
  assert.equal(stepTeamKey(layout, first.view, geometry, {up: true}).view.card, undefined);
  // The Logox card filters and opens too.
  const lx = press(view, logox.x0 + 3, geometry.header + 1 + logox.y0 + 1, 0);
  assert.equal(lx.view.filter, 'logox');
  assert.deepEqual(press(lx.view, logox.x0 + 3, geometry.header + 1 + logox.y0 + 1, 100).effects.at(-1), {kind: 'actor', id: 'logox'});
  // The current post under the stage opens on a double click only.
  const eventY = geometry.header + 1 + plan.height;
  const one = press(view, 5, eventY, 0);
  assert.deepEqual(one.effects, [{kind: 'focus'}]);
  assert.deepEqual(press(one.view, 5, eventY, 100).effects, [{kind: 'focus'}, {kind: 'open', id: layout.ids[7]!}]);
  // The wheel over the stage steps the selection like the feed.
  const wheel = stepTeamMouse(layout, view, geometry, {x: CONTENT_X + 5, y: geometry.header + 3, action: 'wheel_up'}, 0, 56, label);
  assert.equal(selectedId(layout, wheel.view), layout.ids[6]);
  // A click on empty stage space only focuses.
  assert.deepEqual(press(view, 0, geometry.header + 2).effects, [{kind: 'focus'}]);
});

test('on a short sidebar the strip names are clickable too, and the stage rows shift the feed rows (a click in the feed still selects its post)', () => {
  const events = story();
  const layout = buildTeamLayout(events, {width: teamWidth(56), label});
  const geometry = teamGeometryFor(layout, 24);
  assert.equal(geometry.stageMode, 'strip');
  const view: TeamView = {...emptyTeamView, live: false, selected: layout.ids[5]!};
  const line = paintTeam({layout, view, width: 56, height: 24, focused: false, ownerColor: () => '#fff', label, stage: true}).map(row => row.map(segment => segment.text).join(''));
  const stripY = geometry.header + 1, x = line[stripY]!.indexOf('kalon') - CONTENT_X;
  const step = stepTeamMouse(layout, view, geometry, {x: CONTENT_X + x + 1, y: stripY, action: 'press'}, 0, 56, label);
  assert.equal(step.view.filter, 'kalon');
  // The first feed row is under the stage.
  const feedY = geometry.header + geometry.stage;
  const click = stepTeamMouse(layout, view, geometry, {x: CONTENT_X + 12, y: feedY + 1, action: 'press'}, 0, 56, label);
  assert.ok(click.view.selected !== undefined && click.effects.some(effect => effect.kind === 'focus'));
});

// ---------------------------------------------------------------------------------------------------------------------------------- acts: the cards carry the task
/** Two acts of one plan (`Draw`, then `Animate`); the second has a worker out, a wait, a task not started yet and a failure on request. */
function acted(failTechne = false) {
  const node = (id: string, extra: Partial<PlanNode> = {}): PlanNode => ({id, title: 'Node ' + id, owner: 'techne', after: [], acceptance: [], links: [], ...extra});
  const plan: Plan = {id: 'p1', title: 'Pelican', status: 'active', createdAt: 0, updatedAt: 1, sessionId: 's', nodes: [
    node('1', {title: 'Draw', owner: 'logox'}), node('1.1', {title: 'Ink', owner: 'kalon', links: [{activityId: 'k1'}]}),
    node('2', {title: 'Animate', owner: 'logox'}), node('2.1', {title: 'Pedal', links: [{activityId: 't2'}, {automaJob: 't2/J1'}]}),
    node('2.2', {title: 'Review', owner: 'aletheia', after: ['2.1'], links: [{activityId: 'al'}]}), node('2.3', {title: 'Ship', owner: 'aletheia'})]};
  const d = (id: string, extra: Partial<Delegation> = {}): Delegation => ({id, kind: 'actor', ownerId: 'techne', title: id, status: 'completed', rootId: id, children: [], blockedBy: [],
    assignment: {title: extra.title ?? id, owns: [], acceptance: []}, ...extra});
  const delegations = [d('R', {kind: 'director', ownerId: 'logox'}), d('k1', {ownerId: 'kalon', parentId: 'R', rootId: 'R'}), d('t2', {parentId: 'R', rootId: 'R'}),
    d('al', {ownerId: 'aletheia', parentId: 'R', rootId: 'R', status: 'queued'}), d('t2/J1', {kind: 'automa', jobId: 'J1', parentId: 't2', rootId: 'R', status: 'done', title: 'scout'})];
  fresh();
  const at = (event: TeamEvent, ref: string, extra: Partial<TeamEvent> = {}): TeamEvent => ({...event, ref, ...extra});
  const events = [user(), at(assign('kalon'), 'k1'), at(report('kalon'), 'k1'), user(), at(assign('techne'), 't2'), at(workers('techne', {title: 'scout'}), 't2/J1'), at(wait('aletheia', 'techne'), 'al'),
    at(result('techne', 'scout'), 't2/J1'), at(report('techne', failTechne ? 'failed' : 'done'), 't2')];
  const closes = [events[2]!.at + 1000];
  return {events, model: actModel(taskGraph(plan, delegations, 's'), events, closes)};
}
const sceneStage = (model: ReturnType<typeof acted>['model'], index: number, width: number) => {
  const scene = sceneAt(model, index), final = finalScene(model, scene.act), need = reserveFor([final], plannedWork(model));
  return buildStage(scene.snapshot, need, stageHeight([final], need, width, label), width, label);
};

test('the cards say what each actor is doing in the act: its task with n/m, why it waits, done or failed, its workers, and the next task that has not started', () => {
  const {model} = acted();
  const text = (index: number, width = 56) => ROWS(sceneStage(model, index, width)).join('\n');
  // Act 1: Kalon sketches, then its report settles the task.
  assert.match(text(1), /✧ Kalon/);
  assert.match(text(1), /│ Ink +│/);
  assert.match(text(2), /Ink +done/, 'settled: the title with `done`');
  assert.doesNotMatch(text(2), /Techne|Animate|Pedal|Review/, 'act 1 is its own scene');
  // Act 2 with the worker out and Aletheia held: Techne reads `Pedal loop 0/1` and its worker; Aletheia the wait reason and its next task.
  const mid = text(6);
  assert.match(mid, /Pedal +0\/1/);
  assert.match(mid, /◦ scout …/);
  assert.match(mid, /waits techne/);
  assert.match(mid, /next: Ship/);
  assert.doesNotMatch(mid, /Kalon|Ink/, 'Kalon left the stage with act 1');
  assert.match(text(7), /Pedal +1\/1/, 'the worker\'s result moves n');
  const done = text(8);
  assert.match(done, /Pedal +done/);
  assert.doesNotMatch(done, /waits techne/, 'the wait ended with the report');
  assert.match(done, /Review/, 'Aletheia is on its own task once its wait ended');
  // A failure reads failed.
  assert.match(ROWS(sceneStage(acted(true).model, 8, 56)).join('\n'), /Pedal +failed/);
  // The height never moves inside an act, whatever the point, and every row is as wide as the stage.
  for (let index = 4; index <= 8; index++) {const plan = sceneStage(model, index, 56); assert.equal(plan.height, sceneStage(model, 4, 56).height); assert.ok(ROWS(plan).every(row => stringWidth(row) === 56));}
});

test('with no task for an actor the card falls back to its state word; the next row exists only where the plan has tasks not yet started', () => {
  const {model} = acted();
  fresh();
  const events = [user(), assign('kalon'), report('kalon')];
  const bare = actModel(undefined, events, []);
  assert.match(ROWS(sceneStage(bare, 1, 56)).join('\n'), /working/, 'no task graph: the card shows the state word');
  const withPlan = sceneStage(model, 2, 56), without = sceneStage(bare, 2, 56);
  assert.ok(withPlan.height > without.height, 'the plan reserves the next row');
  assert.doesNotMatch(ROWS(without).join('\n'), /next:/);
});
