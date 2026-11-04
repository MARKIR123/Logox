import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {actionAt, hoveredCardAt, type SceneRow} from '../src/tui/timeline/scene.js';
import {rowSegments} from '../src/tui/timeline/row-presentation.js';
import {diffSummary} from '../src/tui/timeline/tool-card.js';
import {expandedTint, faintColor} from '../src/tui/appearance/colors.js';
import {palette} from '../src/tui/appearance/theme.js';
import {cast} from '../src/actors/ensemble.js';

type Owner = 'logox' | 'kalon';
const text = (row: SceneRow) => row.displayText ?? row.text;

/** One activity (Director task or Kalon actor card) with a user brief; `calls` run through Steps. */
function scene(owner: Owner, build: (steps: Steps, advance: (ms: number) => void) => void) {
  const store = new RuntimeStore();
  let now = Date.now() - 20_000;
  const actor = owner === 'kalon';
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: owner, kind: actor ? 'actor' : 'director', title: 'Pelican', taskTitle: 'Pelican', status: 'running', stage: 'x', detail: ''});
  store.message('s', actor ? 'kalon' : 'user', 'user', 'Check files.', {activityId: 'a', inputKind: actor ? 'director' : 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: owner}, () => now);
  build(steps, ms => {now += ms;});
  const rows = (folds: Record<string, boolean> = {}, hovered: string | null = null, width = 100, controls = {}) =>
    buildStageRows(store.getSnapshot(), 's', 'logox', width, {a: true, ...folds}, hovered, {}, undefined, controls);
  return {store, rows};
}
function call(steps: Steps, advance: (ms: number) => void, name: string, args: Record<string, unknown>, result?: string, state: 'completed' | 'failed' = 'completed') {
  const id = steps.tool({id: name + Math.random(), name, arguments: JSON.stringify(args)});
  steps.start(id); advance(1800);
  if (result !== undefined) steps.finish(id, state, name + '\n' + result, state === 'failed' ? 'error' : undefined);
  return id;
}
const header = (rows: readonly SceneRow[], id: string) => rows.find(row => row.messageId === id)!;

test('a folded row is interactive over its text extent only; an open card is interactive over its whole tinted block', () => {
  let id = '';
  const {rows} = scene('logox', (steps, advance) => {id = call(steps, advance, 'Glob', {pattern: '*.ts'}, 'a.ts\nb.ts');});
  const folded = header(rows({}), id);
  const end = folded.gutterCols + stringWidth(folded.text.trimEnd());
  assert.equal(actionAt(folded, folded.gutterCols)?.foldId, id);
  assert.equal(actionAt(folded, end - 1)?.foldId, id);
  assert.equal(actionAt(folded, end), undefined, 'trailing empty cells are not interactive');
  assert.equal(actionAt(folded, folded.gutterCols - 1), undefined, 'the rail is not interactive');
  assert.equal(hoveredCardAt(folded, end), null);

  const open = rows({[id]: true});
  const head = header(open, id), body = open.find(row => row.text === 'a.ts')!;
  for (const row of [head, body]) {
    assert.ok(row.segments!.some(segment => segment.bg), 'open rows carry the tint');
    assert.equal(actionAt(row, row.gutterCols + 70)?.foldId, id, 'blank tint closes the card');
    assert.equal(actionAt(row, 99)?.foldId, id, 'the block reaches the right edge');
  }
  assert.equal(actionAt(head, head.gutterCols)?.foldId, id, 'header text toggles it');
});

test('hover inside an actor card uses the card owner colour for the mark, separators and title', () => {
  let id = '';
  const {rows} = scene('kalon', (steps, advance) => {id = call(steps, advance, 'Glob', {pattern: '*.ts'}, 'a.ts\nb.ts');});
  const row = header(rows({}, id), id);
  assert.equal(row.hoverColor, cast.kalon!.color, 'highlight is the card owner, not Logox');
  assert.equal(row.hover?.foldId, id);
  const colours = new Set(rowSegments(row, true).filter(segment => segment.text.trim()).map(segment => segment.color));
  assert.ok(colours.has(cast.kalon!.color));
  assert.ok(!colours.has(palette.accent), 'never the Logox accent');
  const mark = row.segments!.find(segment => segment.selectionKey === id + ':icon')!;
  assert.equal(mark.color, cast.kalon!.color);
  assert.ok(row.segments!.filter(segment => segment.separator).every(segment => segment.color === cast.kalon!.color));
});

test('nested open cards tint at stepped strengths in the owner colour: a child never matches its parent', () => {
  let one = '', two = '', groupId = '';
  const {rows} = scene('kalon', (steps, advance) => {
    one = call(steps, advance, 'Read', {file_path: 'a.ts'}, '1: x\n2: y');
    two = call(steps, advance, 'Read', {file_path: 'b.ts'}, '1: z');
  });
  const all = rows({});
  groupId = all.find(row => row.messageId.endsWith('-group'))?.messageId ?? '';
  assert.ok(groupId, 'the two reads form a group');
  const bgOf = (list: readonly SceneRow[], id: string) => list.find(row => row.messageId === id)!.segments!.find(segment => segment.selectionKey === id + ':title' || segment.selectionKey === id + ':icon')!.bg;
  const kalon = cast.kalon!.color;
  const actorOnly = rows({});
  const actorRow = header(actorOnly, 'a');
  assert.equal(actorRow.segments!.find(segment => segment.text.includes('Kalon'))!.bg, expandedTint(kalon, 1), 'the open actor card is depth 1');
  const groupOpen = rows({[groupId]: true});
  assert.equal(bgOf(groupOpen, groupId), expandedTint(kalon, 2), 'a group inside the actor card is depth 2');
  const childOpen = rows({[groupId]: true, [one]: true});
  assert.equal(bgOf(childOpen, one), expandedTint(kalon, 3), 'a tool inside an open group is depth 3');
  assert.notEqual(expandedTint(kalon, 1), expandedTint(kalon, 2));
  assert.notEqual(expandedTint(kalon, 2), expandedTint(kalon, 3));
  // Logox's own cards follow the same scheme in Logox colour: tool depth 1, tool in an open group depth 2.
  let l1 = '', lg = '';
  const logox = scene('logox', (steps, advance) => {
    l1 = call(steps, advance, 'Read', {file_path: 'a.ts'}, '1: x');
    call(steps, advance, 'Read', {file_path: 'b.ts'}, '1: y');
  });
  lg = logox.rows({}).find(row => row.messageId.endsWith('-group'))!.messageId;
  assert.equal(bgOf(logox.rows({[lg]: true}), lg), expandedTint(palette.accent, 1));
  assert.equal(bgOf(logox.rows({[lg]: true, [l1]: true}), l1), expandedTint(palette.accent, 2));
});

test('thinking has one expander that counts lines across thoughts and toggles to show less', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'a', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'logox'});
  const first = steps.thinking(); store.appendMessage(first, Array.from({length: 9}, (_, i) => 'alpha ' + i).join('\n')); steps.finish(first, 'completed');
  const second = steps.thinking(); store.appendMessage(second, Array.from({length: 9}, (_, i) => 'beta ' + i).join('\n')); steps.finish(second, 'completed');
  steps.endGroup('completed');
  const build = (folds: Record<string, boolean>) => buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[first]: true, ...folds}, null);
  const closed = build({});
  const expanders = closed.filter(row => /… \d+ more/.test(row.text));
  assert.equal(expanders.length, 1, 'one expander for the whole body');
  assert.equal(expanders[0]!.text, '… 6 more lines');
  assert.ok(!closed.some(row => /more thoughts?/.test(row.text)));
  assert.equal(expanders[0]!.messageId, first + '-more');
  assert.equal(actionAt(expanders[0], expanders[0]!.gutterCols)?.foldId, first + '-more');
  const open = build({[first + '-more']: true});
  assert.ok(open.some(row => row.text.includes('beta 8')));
  const less = open.filter(row => row.messageId === first + '-more');
  assert.equal(less.length, 1); assert.equal(less[0]!.text, '… show less');
  assert.equal(open.indexOf(less[0]!), open.findLastIndex(row => row.messageId.startsWith(first) && row.text.trim()), 'show less ends the body');
});

test('the diff summary uses faint words and leaves out a zero side', () => {
  const both = diffSummary({added: 16, removed: 16});
  assert.equal(both.map(piece => piece.text).join(''), 'added 16 · removed 16');
  assert.equal(both[0]!.color, faintColor());
  assert.equal(diffSummary({added: 3, removed: 0}).map(piece => piece.text).join(''), 'added 3');
  assert.equal(diffSummary({added: 0, removed: 2}).map(piece => piece.text).join(''), 'removed 2');
  assert.deepEqual(diffSummary({added: 0, removed: 0}), []);
});

test('bodies use the full terminal width instead of a 100-column cap', () => {
  const long = 'x'.repeat(150);
  let id = '';
  const {rows} = scene('logox', (steps, advance) => {id = call(steps, advance, 'Shell', {command: 'echo'}, 'Exit code: 0\n' + long);});
  const all = rows({[id]: true}, null, 200);
  const body = all.filter(row => row.text.startsWith('xxxx'));
  assert.equal(body.length, 1, 'the 150-column line is not wrapped');
  assert.equal(body[0]!.text, long);
});

test('time follows the content inline, a running Shell shows ■ Stop at the far right, finished tools show nothing there', () => {
  let running = '', done = '', read = '';
  const {rows} = scene('logox', (steps, advance) => {
    running = call(steps, advance, 'Shell', {command: 'sleep 30'});
    done = call(steps, advance, 'Shell', {command: 'ls'}, 'Exit code: 0\nok');
    read = call(steps, advance, 'Read', {file_path: 'a.ts'});
  });
  const group = rows({}).find(row => row.messageId.endsWith('-group'))!.messageId;
  const collapsed = rows({}, null, 100);
  const peek = header(collapsed, running);
  assert.match(text(peek), /^└ ▮ Shell\(sleep 30\) · \d+\.\ds? +■ Stop\s*$/, 'a running call under a collapsed group has its own Stop');
  const all = rows({[group]: true}, null, 100);
  const live = header(all, running);
  assert.match(text(live), /▮ Shell\(sleep 30\) · \d+\.\ds? +■ Stop\s*$/, text(live));
  const control = live.controls![0]!;
  assert.equal(control.endCol, 100 - 2, 'Stop sits at the far right of the row');
  assert.equal(control.action.kind, 'stop_actor'); assert.equal(control.action.foldId, running);
  assert.equal(actionAt(live, control.startCol)?.foldId, running, 'the Stop control wins over the card toggle');
  const gap = live.gutterCols + stringWidth(live.text.slice(0, live.text.indexOf('■ Stop')).trimEnd()) + 1;
  assert.notEqual(actionAt(live, gap)?.foldId, running, 'the gap before Stop is not part of the card');
  assert.equal(actionAt(live, live.gutterCols)?.foldId, running);
  const stopping = header(rows({[group]: true}, null, 100, {stopping: new Set([running])}), running);
  assert.match(text(stopping), /Stopping…\s*$/);
  assert.equal(stopping.controls![0]!.disabled, true);
  assert.ok(!text(header(all, read)).includes('Stop'), 'a call that cannot be cancelled on its own has no Stop');
  const finished = text(header(all, done));
  assert.match(finished, /▮ Shell\(ls\) · \d+\.\ds\s*$/);
  assert.ok(!/Completed|Stop/.test(finished));
  assert.ok(!header(all, done).controls?.length);
});

test('a failed call shows its reason once, with no trailing Error label', () => {
  let id = '';
  const {rows} = scene('logox', (steps, advance) => {id = call(steps, advance, 'Edit', {file_path: 'a.ts', old_string: 'x', new_string: 'y'}, 'No match found for old_string; please re-read file', 'failed');});
  const line = text(header(rows({}), id));
  assert.match(line, /No match found for old_string; please re-read file · \d/);
  assert.ok(!/Error/.test(line), line);
  assert.equal(line.split('No match found').length, 2, 'the reason is not repeated in the row');
});

test('a browser failure reads as one clean reason, never raw markdown', () => {
  let id = '';
  const {rows} = scene('logox', (steps, advance) => {id = call(steps, advance, 'mcp__playwright__browser_navigate', {url: 'file:///C:/p/preview.html'}, '### Error\nError: net::ERR_FILE_NOT_FOUND at file:///C:/p/preview.html', 'failed');});
  const all = rows({});
  const line = text(all.find(row => row.messageId === id && /Opened/.test(row.text)) ?? header(all, id));
  assert.ok(!line.includes('###'), line);
  assert.ok(!/Error/.test(line.replace('ERR_FILE_NOT_FOUND', '')), line);
  assert.ok(line.includes('net::ERR_FILE_NOT_FOUND'), line);
});

test('a long Shell title clips with an ellipsis inside the row instead of wrapping', () => {
  let id = '';
  const command = 'Get-ChildItem -Recurse ' + 'very-long-directory-name/'.repeat(12) + ' | Measure-Object';
  const {rows} = scene('logox', (steps, advance) => {id = call(steps, advance, 'Shell', {command}, 'Exit code: 1\nboom', 'failed');});
  const own = rows({}, null, 80).filter(row => row.messageId === id);
  assert.equal(own.length, 1, 'one row, no continuation line');
  assert.ok(own[0]!.text.includes('…'));
  assert.ok(own[0]!.text.includes('exit 1'), 'the summary and time keep their place');
  assert.ok(stringWidth(text(own[0]!)) <= 80);
});
