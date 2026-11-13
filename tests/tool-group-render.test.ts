import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {actionAt, hoveredCardAt, type SceneRow} from '../src/tui/timeline/scene.js';
import {decorateRow} from '../src/tui/timeline/row-presentation.js';
import {palette} from '../src/tui/appearance/theme.js';
import {visibleRunningCalls, ROW_MIN_MS, groupVerb, toolGroupRow} from '../src/tui/timeline/group-row.js';
import {builtinActors} from '../src/actors/builtins.js';
import type {ActorStyles} from '../src/tui/appearance/actor-style.js';
import type {ToolGroup} from '../src/tui/timeline/tool-groups.js';

function fixture(owner = 'logox') {
  const store = new RuntimeStore();
  let now = Date.now() - 20_000;
  const actor = owner !== 'logox';
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: owner, kind: actor ? 'actor' : 'director', title: 'Pelican', taskTitle: 'Pelican animation', status: 'running', stage: 'x', detail: ''});
  store.message('s', actor ? owner : 'user', 'user', 'Check the pelican files.', {activityId: 'a', inputKind: actor ? 'director' : 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: owner}, () => now);
  const call = (name: string, args: Record<string, unknown>, opts: {fail?: boolean; run?: boolean} = {}) => {
    if (opts.run) now = Date.now() - 3200;
    const id = steps.tool({id: name + now, name, arguments: JSON.stringify(args)});
    steps.start(id); now += 300;
    if (!opts.run) steps.finish(id, opts.fail ? 'failed' : 'completed', name + '\nok', opts.fail ? 'error' : undefined);
    return id;
  };
  const think = (text: string) => {const id = steps.thinking(); store.appendMessage(id, text); now += 800; steps.finish(id, 'completed'); return id;};
  const rows = (width: number, folds: Record<string, boolean> = {}, hovered: string | null = null, roles?: ActorStyles) => buildStageRows(store.getSnapshot(), 's', 'logox', width, folds, hovered, {}, roles);
  const groupId = () => store.getSnapshot().messages.find(m => m.kind === 'tool')!.id + '-group';
  return {store, call, think, rows, groupId};
}
const text = (row: SceneRow) => row.displayText ?? row.text;
const GROUP = /[▸▾] [A-Z][\w' -]* \d+ (?:patterns?|files?|directory|directories|page actions?|commands?)/;
/** A stage-titled group header: `▸ <intent> · <Verb> N <noun>`. */
const TITLED = (intent: string) => new RegExp('[▸▾] ' + intent + ' · [A-Z][\\w\' -]* \\d+ (?:patterns?|files?|directory|directories|page actions?|commands?)');
const header = (rows: readonly SceneRow[]) => rows.find(row => GROUP.test(text(row)))!;

function standard(f: ReturnType<typeof fixture>) {
  f.call('Grep', {pattern: 'pedal'}); f.call('Read', {file_path: 'G:/p/pelican.html'}); f.call('Read', {file_path: 'G:/p/pelican.html'});
  f.call('Shell', {command: 'ls src'});
}

test('group header has no tool icon and keeps the single-tool icon elsewhere', () => {
  const f = fixture(); standard(f);
  f.call('Edit', {file_path: 'G:/p/a.ts', old_string: 'a', new_string: 'b'});
  const rows = f.rows(100);
  assert.match(text(header(rows)), /^\s*▸ [A-Z][\w' -]* 1 pattern · [A-Z][\w' -]* 2 files · [A-Z][\w' -]* 1 directory/);
  assert.ok(!text(header(rows)).includes('▮'));
  assert.ok(!text(header(f.rows(100, {[f.groupId()]: true}))).includes('▮'));
  assert.ok(rows.some(row => /▮ Edit/i.test(text(row))), 'non-collapsible tools keep their icon');
});

test('a running actor does not split the Director tool run; only its card does', () => {
  const f = fixture();
  f.call('Glob', {pattern: 'before-1'}); f.call('Glob', {pattern: 'before-2'});
  f.store.activities.create({sessionId: 's', activityId: 'b', ownerId: 'techne', kind: 'actor', title: 'Rig', taskTitle: 'Rig', status: 'running', stage: 'x', detail: ''});
  f.store.message('s', 'techne', 'user', 'Build the rig.', {activityId: 'b', inputKind: 'director'});
  const actor = new Steps(f.store, {sessionId: 's', activityId: 'b', ownerId: 'techne'});
  for (const pattern of ['after-1', 'after-2', 'after-3']) {
    const id = actor.tool({id: 'actor-' + pattern, name: 'Read', arguments: JSON.stringify({file_path: 'G:/p/' + pattern})});
    actor.start(id); actor.finish(id, 'completed', 'ok');
    f.call('Glob', {pattern});
  }
  const rows = f.rows(120).map(text);
  assert.equal(rows.filter(row => /[▸▾] [A-Z][\w' -]* 2 patterns/.test(row)).length, 1, 'calls before the card stay one group');
  assert.equal(rows.filter(row => /[▸▾] [A-Z][\w' -]* 3 patterns/.test(row)).length, 1, 'calls after the card fold across the actor messages');
  assert.ok(!rows.some(row => /▮ Glob/.test(row)), rows.join('\n'));
  const card = rows.findIndex(row => /Techne · Rig/.test(row));
  assert.ok(card > rows.findIndex(row => / 2 patterns/.test(row)) && card < rows.findIndex(row => / 3 patterns/.test(row)), 'the card sits between the two groups');
});

test('single collapsible tool call stays a normal tool card', () => {
  const f = fixture(); f.call('Read', {file_path: 'G:/p/a.ts'});
  const rows = f.rows(100);
  assert.ok(rows.some(row => /▮ Read/i.test(text(row))));
  assert.ok(!rows.some(row => GROUP.test(text(row))));
});

test('whole group title row hovers and toggles, trailing blanks and other rows do not', () => {
  const f = fixture(); standard(f);
  const id = f.groupId(), row = header(f.rows(100));
  const titleEnd = row.gutterCols + stringWidth(row.text.trimEnd());
  for (const x of [row.gutterCols, row.gutterCols + 3, Math.floor((row.gutterCols + titleEnd) / 2), titleEnd - 1]) {
    assert.equal(actionAt(row, x)?.kind, 'toggle_fold', 'click at ' + x);
    assert.equal(hoveredCardAt(row, x), id, 'hover at ' + x);
  }
  assert.equal(actionAt(row, titleEnd + 2), undefined, 'trailing blank is not hit');
  assert.equal(hoveredCardAt(row, titleEnd + 2), null);
  const hovered = header(f.rows(100, {}, id));
  const colors = new Set(hovered.segments!.filter(s => s.selectionKey?.startsWith(id + ':title') && s.text.trim() && s.text !== ' · ').map(s => s.color));
  assert.equal(colors.size, 1, 'hovering lights the entire title in one role color');
});

test('Task-from card draws no icon and its whole title row hovers', () => {
  const f = fixture('kalon'); standard(f);
  const rows = f.rows(100, {a: true});
  const row = rows.find(r => /Task from/.test(text(r)))!;
  assert.ok(!text(row).includes('▮'));
  assert.match(text(row), /▸ Task from/);
  const end = row.gutterCols + stringWidth(row.text.trimEnd());
  assert.equal(hoveredCardAt(row, end - 1), 'a-goal');
  assert.equal(actionAt(row, end - 1)?.kind, 'toggle_fold');
});

test('narrow widths keep verb, counts and elapsed time and never wrap', () => {
  const f = fixture(); standard(f);
  for (const width of [40, 60, 100]) {
    const rows = f.rows(width), row = header(rows);
    assert.ok(stringWidth(text(row)) <= width, `fits ${width}`);
    assert.match(text(row), /s\s*$/);
    assert.equal(rows.filter(r => r.messageId === row.messageId).length, 1, 'single row');
    assert.match(text(row), /1 pattern/);
  }
  assert.ok(!/pelican|pedal/.test(text(header(f.rows(100)))), 'file names are not part of the header');
});

test('expanded group shows its tool children; thinking is folded into the one row under the header', () => {
  const f = fixture(); f.call('Grep', {pattern: 'pedal'}); f.think('Check pelican.html next.'); f.call('Read', {file_path: 'G:/p/pelican.html'});
  const lines = f.rows(100, {[f.groupId()]: true}).map(text);
  const at = (re: RegExp) => lines.findIndex(l => re.test(l));
  assert.ok(at(/Thought for/) < at(GROUP), 'thinking sits above the tool group, directly under the speaker header');
  assert.equal(lines.filter(l => /Thought/.test(l)).length, 1);
  assert.ok(at(GROUP) < at(/▮ Grep/) && at(/▮ Grep/) < at(/▮ Read/));
});

test('collapsed running group lists each running tool as a └ row; expanded shows none', () => {
  const f = fixture(); f.call('Grep', {pattern: 'pedal'}); f.call('Read', {file_path: 'G:/p/a.ts'});
  f.call('Shell', {command: 'npm test'}, {run: true}); f.call('Shell', {command: 'npm run build'}, {run: true});
  const rows = f.rows(100), index = rows.findIndex(r => GROUP.test(text(r)));
  assert.match(text(rows[index + 1]!), /^\s*└ ▮ Shell\(npm test\)/);
  assert.match(text(rows[index + 2]!), /^\s*└ ▮ Shell\(npm run build\)/);
  assert.equal(hoveredCardAt(rows[index + 1], rows[index + 1]!.gutterCols + 6), f.groupId(), 'running rows belong to the group');
  assert.equal(actionAt(rows[index + 1], rows[index + 1]!.gutterCols + 6)?.kind, 'toggle_fold');
  assert.ok(!f.rows(100, {[f.groupId()]: true}).some(r => /└/.test(text(r))), 'expanded groups show no └ rows');
  const idle = fixture(); standard(idle);
  assert.ok(!idle.rows(100).some(r => /└/.test(text(r))));
});

test('failed call is split out as a normal error card between two groups', () => {
  const f = fixture(); f.call('Grep', {pattern: 'a'}); f.call('Read', {file_path: 'G:/p/a.ts'});
  f.call('Read', {file_path: 'G:/p/missing.css'}, {fail: true});
  f.call('Read', {file_path: 'G:/p/b.ts'}); f.call('Read', {file_path: 'G:/p/c.ts'});
  const lines = f.rows(100).map(text);
  const groups = lines.flatMap((l, i) => GROUP.test(l) ? [i] : []), failed = lines.findIndex(l => /▮ Read.*missing/.test(l));
  assert.equal(groups.length, 2);
  assert.ok(groups[0]! < failed && failed < groups[1]!);
  assert.ok(!/Error/.test(lines[failed]!), 'the failed row carries its reason once and no trailing Error label');
});

test('a status line draws no row and never enters a group title; the remaining prose still shows', () => {
  const f = fixture();
  f.store.message('s', 'logox', 'assistant', '⏵ Reading the sources\nLooking now.', {activityId: 'a'});
  standard(f);
  const rows = f.rows(100), lines = rows.filter(row => !row.railGlyph).map(text); // the speaker header may still name the latest line
  assert.ok(!lines.some(l => l.includes('⏵') || l.includes('Reading the sources')), 'the line is stripped and drawn nowhere: ' + lines.join(' | '));
  const title = rows.find(r => GROUP.test(text(r)))!;
  assert.ok(title, 'the group keeps its verb summary');
  assert.ok(lines.some(l => l.includes('Looking now.')), 'the remaining prose still shows');
  assert.equal(title.segments![0]!.italic, true, 'group titles are italic');
});

test('without a status line the group falls back to its verb list', () => {
  const f = fixture(); standard(f);
  const lines = f.rows(100).map(text);
  assert.ok(lines.some(l => /^\s*[▸▾] [A-Z][\w' -]* 1 pattern/.test(l)), lines.join(' | '));
});

test('a status line before a single call keeps that call a normal row and adds no row', () => {
  const f = fixture();
  f.store.message('s', 'logox', 'assistant', '⏵ Looking at the palette', {activityId: 'a'});
  f.call('Read', {file_path: 'G:/p/colors.css'});
  const lines = f.rows(100).filter(row => !row.railGlyph).map(text);
  assert.ok(!lines.some(l => l.includes('Looking at the palette')), lines.join(' | '));
  assert.ok(lines.some(l => /▮ Read/.test(l)));
  assert.ok(!lines.some(l => GROUP.test(l)));
});

test('status lines between calls do not split a group', () => {
  const f = fixture();
  f.store.message('s', 'logox', 'assistant', '⏵ First look', {activityId: 'a'});
  f.call('Read', {file_path: 'G:/p/a.ts'}); f.call('Read', {file_path: 'G:/p/b.ts'});
  f.store.message('s', 'logox', 'assistant', '⏵ Then another file', {activityId: 'a'});
  f.call('Read', {file_path: 'G:/p/c.ts'});
  const lines = f.rows(100).filter(row => !row.railGlyph).map(text);
  assert.equal(lines.filter(l => GROUP.test(l)).length, 1, lines.join(' | '));
  assert.ok(lines.some(l => /[▸▾] [A-Z][\w' -]* 3 files/.test(l)), lines.join(' | '));
  assert.ok(!lines.some(l => /First look|Then another file/.test(l)));
});

test('an actor window and an open actor card draw no status row either and keep verb-titled groups', () => {
  const f = fixture('kalon');
  f.store.message('s', 'kalon', 'assistant', '⏵ Checking the gradients', {activityId: 'a'});
  standard(f);
  const lines = buildStageRows(f.store.getSnapshot(), 's', 'kalon', 100, {}, null).filter(row => !row.railGlyph).map(text);
  assert.ok(!lines.some(l => /^s*[│ ]*Checking the gradientss*$/.test(l)), 'no row of its own: ' + lines.join(' | '));
  assert.ok(lines.some(l => GROUP.test(l)));
  const g = fixture('kalon');
  g.store.message('s', 'kalon', 'assistant', '⏵ Reading the sources', {activityId: 'a'});
  standard(g);
  const card = g.rows(100, {a: true}).filter(row => !row.railGlyph).map(text);
  assert.ok(!card.some(l => /^s*[│ ]*Reading the sourcess*$/.test(l) || l.includes('⏵')), 'no row of its own');
  assert.ok(card.some(l => GROUP.test(l)));
});

test('shell command names are not group targets', () => {
  const f = fixture(); f.call('Read', {file_path: 'G:/p/a.ts'}); f.call('Shell', {command: 'npm test'}); f.call('Shell', {command: 'git status'});
  const row = text(header(f.rows(100)));
  assert.match(row, /1 file · [A-Z][\w' -]* 2 commands/);
  assert.ok(!/ npm|git/.test(row));
});

test('actor card groups with the role verb', () => {
  const f = fixture('kalon'); standard(f);
  const shipped: ActorStyles = Object.fromEntries(builtinActors.map(actor => [actor.id, actor]));
  assert.match(text(header(f.rows(100, {a: true}, null, shipped))), /▸ (?:Sought|Gleaned|Combed|Foraged|Hunted) 1 pattern · .* 2 files/);
});

test('running tool rows linger at least 700ms and finish out cleanly', () => {
  const call = (id: string, state: string) => ({id, kind: 'tool', step: {state, elapsedMs: 0}}) as unknown as ToolGroup['messages'][number];
  const group = (running: boolean, ...messages: ToolGroup['messages'][number][]) => ({id: 'hold-test', running, messages}) as unknown as ToolGroup;
  assert.deepEqual(visibleRunningCalls(group(true, call('a', 'running')), 1000).map(m => m.id), ['a']);
  assert.deepEqual(visibleRunningCalls(group(true, call('a', 'completed'), call('b', 'running')), 1000 + ROW_MIN_MS - 1).map(m => m.id), ['a', 'b']);
  assert.deepEqual(visibleRunningCalls(group(true, call('a', 'completed'), call('b', 'running')), 1000 + ROW_MIN_MS).map(m => m.id), ['b']);
  assert.deepEqual(visibleRunningCalls(group(false, call('a', 'completed'), call('b', 'completed')), 9e9), []);
});

test('group verbs are stable per group and category, gerund while running and past when done', () => {
  const pool = {read: ['Examining/Examined', 'Auditing/Audited', 'Dissecting/Dissected']};
  for (const id of ['g1', 'g2', 'g3', 'g4']) {
    const running = groupVerb(id, 'read', true, pool), done = groupVerb(id, 'read', false, pool);
    assert.equal(running, groupVerb(id, 'read', true, pool), 'same word on every frame');
    assert.equal(pool.read.findIndex(e => e.startsWith(running + '/')), pool.read.findIndex(e => e.endsWith('/' + done)), 'same index for both forms');
  }
  assert.ok(new Set(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map(id => groupVerb(id, 'read', true, pool))).size > 1, 'different groups get different words');
  assert.match(groupVerb('g1', 'run', true), /^(Running|Executing)$/, 'falls back to the default pool');
});

test('group header uses the actor pool, no role verb and no target list', () => {
  const f = fixture(); standard(f);
  const group = {id: 'x-group', running: false, elapsedMs: 2400, messages: [], targets: ['pelican.html'], counts: {search: 2, read: 3, command: 1}} as unknown as ToolGroup;
  const row = toolGroupRow(group, {id: 'x-group', open: false, width: 80, verbs: {search: ['Scouting/Scouted'], read: ['Examining/Examined'], run: ['Testing/Tested']}});
  assert.equal(row.titleSegments[0]!.text, '▸ Scouted 2 patterns · Examined 3 files · Tested 1 command');
  assert.equal(row.status, '2.4s');
  const narrow = toolGroupRow(group, {id: 'x-group', open: false, width: 40, verbs: {search: ['Scouting/Scouted'], read: ['Examining/Examined']}});
  assert.match(narrow.titleSegments[0]!.text, /^▸ Scouted 2 patterns · …$/);
  assert.ok(!/pelican|Inspect|Probe/.test(text(header(f.rows(100)))));
});

test('too-narrow headers drop list then browse first and mark the loss with one …', () => {
  const group = {id: 'x-group', running: false, elapsedMs: 2400, messages: [], counts: {search: 1, read: 1, list: 1, browse: 1, command: 1}} as unknown as ToolGroup;
  const verbs = {search: ['Scouting/Scouted'], read: ['Examining/Examined'], list: ['Mapping/Mapped'], browse: ['Viewing/Viewed'], run: ['Testing/Tested']};
  const at = (width: number) => toolGroupRow(group, {id: 'x-group', open: false, width, verbs});
  assert.equal(at(200).titleSegments[0]!.text, '▸ Scouted 1 pattern · Examined 1 file · Mapped 1 directory · Viewed 1 page action · Tested 1 command');
  const three = at(76);
  assert.equal(three.titleSegments[0]!.text, '▸ Scouted 1 pattern · Examined 1 file · Tested 1 command · …');
  assert.equal(three.status, '2.4s');
  assert.ok(!/Mapped|Viewed/.test(three.titleSegments[0]!.text));
});

function iconAt(row: SceneRow, now: number) {
  const out = decorateRow(row, now, true);
  const cell = out.selectionCells!.find(c => c.key.endsWith(':icon') && c.offset === 0)!;
  let column = 0;
  for (const segment of out.segments!) {
    const width = stringWidth(segment.text);
    if (cell.column >= column && cell.column < column + width) return {text: segment.text[cell.column - column]!, color: segment.color};
    column += width;
  }
  throw new Error('icon not found');
}

test('running tool icon breathes on the 200 ms frame rhythm; finished tools stay still', () => {
  const running = fixture(); running.call('Shell', {command: 'npm test'}, {run: true});
  const done = fixture(); done.call('Shell', {command: 'npm test'});
  const failed = fixture(); failed.call('Shell', {command: 'npm test'}, {fail: true});
  const pick = (f: ReturnType<typeof fixture>) => f.rows(100).find(r => /▮ Shell/.test(text(r)))!;
  const T = 2_000_000;
  const colors = new Set(Array.from({length: 10}, (_, i) => iconAt(pick(running), T + i * 200).color));
  assert.ok(colors.size >= 5, 'color changes frame by frame');
  assert.equal(iconAt(pick(running), T).text, '▮', 'shape never changes');
  assert.equal(iconAt(pick(running), T).color, iconAt(pick(running), T + 50).color, 'no change inside one frame');
  for (const now of [T, T + 800, T + 1600]) {
    assert.deepEqual(iconAt(pick(done), now), {text: '▮', color: palette.muted});
    assert.deepEqual(iconAt(pick(failed), now), {text: '▮', color: palette.error});
  }
});

test('running tool and group titles are white; finished ones are muted', () => {
  const running = fixture(); running.call('Shell', {command: 'npm test'}, {run: true});
  const done = fixture(); done.call('Shell', {command: 'npm test'});
  const toolRow = (f: ReturnType<typeof fixture>) => f.rows(100).find(r => /▮ Shell/.test(text(r)))!;
  const T = 2_000_000;
  // The shimmer only touches the tool word; the arguments behind it hold the base color.
  const tail = (row: SceneRow, now: number) => decorateRow(row, now, true).segments!.filter(s => /npm test/.test(s.text)).at(-1)!.color;
  assert.equal(tail(toolRow(running), T), palette.fg);
  assert.equal(tail(toolRow(done), T), palette.muted);
  const g = fixture(); g.call('Grep', {pattern: 'a'}); g.call('Read', {file_path: 'G:/p/a.ts'}); g.call('Shell', {command: 'npm test'}, {run: true});
  const done2 = fixture(); standard(done2);
  const titles = (row: SceneRow) => row.segments!.filter(s => s.selectionKey?.includes(':title') && !s.selectionKey.includes('hint') && s.text.trim() && s.text !== ' · ');
  assert.ok(titles(header(g.rows(100))).every(s => s.color === palette.fg && s.italic), 'running group: white italic');
  assert.ok(titles(header(done2.rows(100))).every(s => s.color === palette.muted && s.italic), 'finished group: muted italic');
  assert.ok(header(done2.rows(100)).segments!.filter(s => /ds$/.test(s.text.trim())).every(s => s.italic), 'elapsed time is italic too');
  assert.ok(!toolRow(done).segments!.some(s => s.italic), 'single tool cards stay upright');
});

test('running thinking title is white and finished thinking is muted', () => {
  const store = new RuntimeStore();
  let now = Date.now() - 5000;
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 't', status: 'running', stage: 'x', detail: ''});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'logox'}, () => now);
  const id = steps.thinking(); store.appendMessage(id, 'pondering');
  const find = () => buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, null).find(r => r.messageId === id)!;
  const last = (row: SceneRow) => decorateRow(row, 2_000_000, true).segments!.filter(s => s.selectionKey?.endsWith(':title')).at(-1)!.color;
  // The running title shimmers (it is never the muted finished color).
  assert.notEqual(last(find()), palette.muted);
  now += 1000; steps.finish(id, 'completed');
  assert.equal(last(find()), palette.muted);
});
