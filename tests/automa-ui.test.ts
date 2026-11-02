import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {actionAt, hoveredCardAt, type SceneRow} from '../src/tui/timeline/scene.js';
import {decorateRow} from '../src/tui/timeline/row-presentation.js';
import {palette} from '../src/tui/appearance/theme.js';
import {getToolUI} from '../src/tools/ui-registry.js';
import {AUTOMA_ANIMATION_FRAMES} from '../src/tools/orchestration/AutomaTool/prompt.js';

const text = (row: SceneRow) => row.displayText ?? row.text;
const call = (args: unknown) => ({id: 'c', name: 'Automa', arguments: typeof args === 'string' ? args : JSON.stringify(args)});

function fixture(swarm: AutomaSwarm | undefined, opts: {finish?: boolean; args?: unknown} = {}) {
  const store = new RuntimeStore();
  let now = Date.now() - 20_000;
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 'Swarm', taskTitle: 'Swarm', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Trace the queue.', {activityId: 'a', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'logox'}, () => now);
  const id = steps.tool({id: 'automa1', name: 'Automa', arguments: typeof opts.args === 'string' ? opts.args : JSON.stringify(opts.args ?? {jobs: [{title: 'Trace resume path', brief: 'x'}]})});
  steps.start(id);
  if (swarm) steps.swarm(id, swarm);
  if (opts.finish) {now += 12_100; steps.finish(id, 'completed', 'Automa\nok');}
  const rows = (folds: Record<string, boolean> = {}, hovered: string | null = null, width = 100) => buildStageRows(store.getSnapshot(), 's', 'logox', width, folds, hovered);
  return {store, id, rows};
}
const started = () => Date.now() - 6200;
const swarm = (): AutomaSwarm => ({name: 'drone swarm', jobs: [
  {title: 'Trace resume path in delivery-queue', state: 'running', elapsedMs: 0, startedAt: started(), calls: [{name: 'Read', title: 'queue.ts', state: 'running'}]},
  {title: 'Map the retry handlers', state: 'done', elapsedMs: 4100, calls: [{name: 'Grep', title: 'retry', state: 'completed'}, {name: 'Read', title: 'http.ts', state: 'failed'}], receipt: 'Three handlers found in http.ts.'},
  {title: 'Check lock release', state: 'failed', elapsedMs: 900, calls: [], receipt: 'Could not open the lock file.'},
  {title: 'Count the exports', state: 'queued', elapsedMs: 0, calls: []},
]});
const HEADER = /[▸▾] (?:Drone swarm|Atelier hands|Runners|Work crew|Other)/;
const header = (rows: readonly SceneRow[]) => rows.find(row => HEADER.test(text(row)))!;

test('running header names the swarm, counts jobs and returns, and failures', () => {
  const rows = fixture(swarm()).rows();
  const row = header(rows);
  assert.match(text(row), /^\s*▸ Drone swarm · 4 drones · 2 returned · 1 failed · \d+\.\ds\s*$/);
  assert.ok(!text(row).includes('▮'), 'expandable header has no icon');
  const separators = row.segments!.filter(s => s.text.trim() === '·');
  assert.ok(separators.length >= 4);
  for (const s of separators) {assert.equal(s.text, ' · '); assert.equal(s.color, palette.muted); assert.equal(s.separator, true);}
  const title = row.segments!.find(s => s.selectionKey?.endsWith(':title') && s.text.includes('Drone'));
  assert.equal(title?.color, palette.fg, 'running header reads white');
  assert.equal(title?.italic, true);
});

test('finished header is muted, fully counted, and noun follows the swarm name', () => {
  const done = swarm();
  const finished: AutomaSwarm = {name: 'work crew', jobs: done.jobs.slice(1, 2)};
  const row = header(fixture(finished, {finish: true}).rows());
  assert.match(text(row), /▸ Work crew · 1 member · 1 returned · \d+\.\ds/);
  const title = row.segments!.find(s => s.selectionKey?.endsWith(':title') && s.text.includes('Work'));
  assert.equal(title?.color, palette.muted, 'finished header is muted');
  for (const [name, noun] of [['atelier hands', 'hands'], ['runners', 'runners'], ['other', 'jobs']] as const) {
    const two = {name, jobs: done.jobs.slice(1, 3)};
    assert.match(text(header(fixture(two, {finish: true}).rows())), new RegExp(`2 ${noun} · 2 returned`));
  }
  const denied: AutomaSwarm = {name: 'drone swarm', jobs: [{title: 'x', state: 'denied', elapsedMs: 0, calls: []}, {title: 'y', state: 'failed', elapsedMs: 0, calls: []}]};
  assert.match(text(header(fixture(denied, {finish: true}).rows())), /2 drones · 2 returned · 1 failed · 1 denied/);
});

test('collapsed running swarm lists only running jobs as └ rows with their own clock', () => {
  const f = fixture(swarm());
  const rows = f.rows(), index = rows.indexOf(header(rows));
  const live = rows.filter(r => /└/.test(text(r)));
  assert.equal(live.length, 1);
  assert.equal(rows[index + 1], live[0]);
  assert.match(text(live[0]!), /^\s*└ [◜◠◝◞◡◟] Trace resume path in delivery-queue · \d+\.\ds\s*$/);
  const row = live[0]!;
  assert.equal(row.hover?.foldId, f.id, 'the └ row belongs to the swarm card');
  assert.equal(hoveredCardAt(row, row.gutterCols + 6), f.id);
  assert.equal(actionAt(row, row.gutterCols + 6)?.kind, 'toggle_fold');
  assert.equal(row.animation?.step?.state, 'running');
  const sep = row.segments!.find(s => s.text === ' · ')!;
  assert.equal(sep.color, palette.muted);
  assert.equal(sep.separator, true);
});

test('└ row frame and clock come from the clock at decoration time, without timers', () => {
  const f = fixture(swarm());
  const row = f.rows().find(r => /└/.test(text(r)))!;
  const a = text(decorateRow(row, 1_000_000)), b = text(decorateRow(row, 1_000_400));
  assert.notEqual(a, b, 'frame or clock moved');
  assert.ok(AUTOMA_ANIMATION_FRAMES.some(glyph => a.includes('└ ' + glyph)));
  assert.equal(stringWidth(a), stringWidth(b), 'row width never changes');
  assert.match(text(decorateRow(row, Date.now() + 60_000)), /1m\d\ds/);
});

test('expanded swarm shows no └ rows and nests one card per job', () => {
  const f = fixture(swarm());
  const lines = f.rows({[f.id]: true}).map(text);
  assert.ok(!lines.some(l => /└/.test(l)));
  assert.match(lines.find(l => HEADER.test(l))!, /▾ Drone swarm/);
  assert.ok(lines.some(l => /▸ Trace resume path in delivery-queue · running · \d/.test(l)));
  assert.ok(lines.some(l => /▸ Map the retry handlers · done · 4\.1s/.test(l)));
  assert.ok(lines.some(l => /▸ Check lock release · failed · 0\.9s/.test(l)));
  assert.ok(lines.some(l => /▸ Count the exports · queued/.test(l)));
  assert.ok(!lines.some(l => /http\.ts|Three handlers/.test(l)), 'collapsed jobs hide calls and receipt');
});

test('expanding a job shows its calls and receipt, keyed by message id and job index', () => {
  const f = fixture(swarm());
  const jobId = f.id + '-job-1';
  const rows = f.rows({[f.id]: true, [jobId]: true});
  const lines = rows.map(text);
  const at = (re: RegExp) => lines.findIndex(l => re.test(l));
  assert.ok(at(/▾ Map the retry handlers · done/) >= 0);
  assert.ok(at(/▾ Map the retry/) < at(/✓ Grep retry/) && at(/✓ Grep retry/) < at(/✗ Read http\.ts/) && at(/✗ Read http\.ts/) < at(/Three handlers found/));
  assert.ok(!lines.some(l => /Could not open the lock file/.test(l)), 'other jobs stay folded');
  const jobRow = rows[at(/▾ Map the retry/)]!;
  assert.equal(actionAt(jobRow, jobRow.gutterCols + 4)?.kind, 'toggle_fold');
  assert.deepEqual(actionAt(jobRow, jobRow.gutterCols + 4), {kind: 'toggle_fold', foldId: jobId});
  assert.ok(f.rows({[f.id]: true}).map(text).every(l => !/Three handlers/.test(l)), 'folding back is not served from a stale layout');
  const plain = f.rows({[f.id]: true}).map(r => JSON.stringify(r.segments));
  assert.notDeepEqual(f.rows({[f.id]: true}, jobId).map(r => JSON.stringify(r.segments)), plain, 'hovering a job recolors it');
});

test('a job card hovers across its whole title row and keeps separators muted', () => {
  const f = fixture(swarm());
  const jobId = f.id + '-job-1';
  const row = f.rows({[f.id]: true}).find(r => /Map the retry handlers · done/.test(text(r)))!;
  const end = row.gutterCols + stringWidth(row.text.trimEnd());
  assert.equal(row.hover?.endCol, end);
  assert.equal(hoveredCardAt(row, end - 1), jobId);
  assert.equal(hoveredCardAt(row, end), null);
  for (const s of row.segments!.filter(s => s.text.trim() === '·')) assert.equal(s.color, palette.muted);
});

test('jobs still queued or running in an ended step show as interrupted', () => {
  const f = fixture(swarm(), {finish: true});
  const open = f.rows({[f.id]: true}).map(text);
  assert.ok(open.some(l => /▸ Trace resume path in delivery-queue · interrupted/.test(l)));
  assert.ok(open.some(l => /▸ Count the exports · interrupted/.test(l)));
  assert.ok(!open.some(l => /· running|· queued/.test(l)));
  const collapsed = f.rows().map(text);
  assert.ok(!collapsed.some(l => /└/.test(l)), 'nothing is running any more');
  assert.match(collapsed.find(l => HEADER.test(l))!, /4 drones · 4 returned · 1 failed/);
});

test('no swarm yet, legacy args and malformed args fall back to the default card', () => {
  for (const args of [{jobs: [{title: 'Trace resume path', brief: 'x'}]}, {prompt: 'p', description: 'Old scan', paths: ['a']}, 'not json']) {
    const rows = fixture(undefined, {args}).rows();
    assert.ok(rows.some(r => /▮ Automa/.test(text(r))), 'default tool card');
    assert.ok(!rows.some(r => HEADER.test(text(r))));
  }
  assert.ok(fixture(undefined, {args: {description: 'Old scan'}}).rows().some(r => /▮ Automa · Old scan/.test(text(r))));
});

test('title() is one line, decision first and never throws', () => {
  const ui = getToolUI('Automa');
  assert.equal(ui.title(call({jobs: [{title: 'Trace resume path', brief: 'b'}]})), 'Automa · Trace resume path');
  assert.equal(ui.title(call({jobs: [{title: 'a', brief: 'b'}, {title: 'c', brief: 'd'}, {title: 'e', brief: 'f'}]})), 'Automa · 3 jobs');
  assert.equal(ui.title(call({release: ['i1']})), 'Automa · release');
  assert.equal(ui.title(call({prompt: 'p', description: 'Old scan', paths: ['a']})), 'Automa · Old scan');
  assert.equal(ui.title(call({jobs: [{title: 'multi\nline   title', brief: 'b'}]})), 'Automa · multi line title');
  const long = ui.title(call({jobs: [{title: 'x'.repeat(300), brief: 'b'}]}));
  assert.ok(!long.includes('\n') && long.length <= 90);
  for (const bad of ['not json', 'null', '[]', '{"jobs":"x"}', '{"jobs":[null]}', '{"jobs":[{"title":5}]}', '']) assert.doesNotThrow(() => ui.title(call(bad)));
  assert.equal(ui.title(call('not json')), 'Automa');
});

test('Automa is not swallowed by a Read/Grep tool group', () => {
  const f = fixture(swarm());
  const steps = new Steps(f.store, {sessionId: 's', activityId: 'a', ownerId: 'logox'}, () => Date.now() - 10_000);
  for (const [name, args] of [['Read', {file_path: 'G:/p/a.ts'}], ['Grep', {pattern: 'x'}]] as const) {
    const id = steps.tool({id: name + '1', name, arguments: JSON.stringify(args)}); steps.start(id); steps.finish(id, 'completed', name + '\nok');
  }
  const lines = f.rows().map(text);
  assert.ok(lines.some(l => HEADER.test(l)));
  assert.ok(lines.some(l => /[▸▾] [A-Z][\w' -]* \d+ (?:files?|patterns?)/.test(l)), 'the Read/Grep calls still group');
});

test('a running header redraws its whole elapsed time, not the padded slice of it', () => {
  const {rows} = fixture(swarm());
  const row = header(rows());
  const started = row.animation!.step!.runningSince!;
  const live = text(decorateRow(row, started + 21_300));
  assert.match(live, /· 21\.3s/, live);
});
