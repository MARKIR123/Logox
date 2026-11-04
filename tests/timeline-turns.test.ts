import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {join} from 'node:path';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {cast} from '../src/actors/ensemble.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {decorateRow, railCell} from '../src/tui/timeline/row-presentation.js';
import {encodeRow} from '../src/tui/terminal/terminal-plane.js';
import {palette} from '../src/tui/appearance/theme.js';
import {expandedTint, quietRail} from '../src/tui/appearance/colors.js';
import {relativeToCwd, formatToolCardTitle} from '../src/tools/ui-format.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';

const strip = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '');
const headers = (rows: readonly SceneRow[]) => rows.filter(row => row.messageId.endsWith('-who'));

function round() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  const user = store.message('s', 'user', 'user', 'Make a pelican.', {activityId: 'main', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
  return {store, steps, user};
}
function addActor(store: RuntimeStore, id: string, ownerId: string, status: 'running' | 'completed' = 'running') {
  store.activities.create({sessionId: 's', activityId: id, ownerId, kind: 'actor', title: ownerId + ' task', taskTitle: ownerId + ' task', status, stage: 'x', detail: ''});
  store.message('s', ownerId, 'user', 'Do it.', {activityId: id, inputKind: 'director', source: 'logox'});
}

test('one Logox header covers prose, tool groups and actor cards of a round; a user message starts a new one', () => {
  const {store, steps} = round();
  store.message('s', 'logox', 'assistant', 'First I will look around.', {activityId: 'main'});
  for (const [index, file] of ['a.ts', 'b.ts'].entries()) {
    const id = steps.tool({id: 'r' + index, name: 'Read', arguments: JSON.stringify({file_path: file})}); steps.start(id); steps.finish(id, 'completed', 'Read\nok');
  }
  addActor(store, 'k', 'kalon'); addActor(store, 't', 'techne');
  store.message('s', 'logox', 'assistant', 'Both are working.', {activityId: 'main'});
  let rows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, null);
  const logox = headers(rows).filter(row => /Logox/.test(row.text));
  assert.equal(logox.length, 1, 'the name is printed once per round');
  assert.equal(headers(rows).filter(row => row.railGlyph === '❯').length, 1, 'one user header');
  assert.equal(logox[0]!.railGlyph, '◈');
  assert.ok(!rows.some(row => /◈ Logox/.test(row.text)), 'the name no longer carries its glyph in the text');
  assert.ok(rows.some(row => /Kalon/.test(row.text) && row.messageId === 'k') && rows.some(row => row.messageId === 't'));
  store.message('s', 'user', 'user', 'Continue please.', {activityId: 'main', inputKind: 'human'});
  store.message('s', 'logox', 'assistant', 'Continuing.', {activityId: 'main'});
  rows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, null);
  assert.equal(headers(rows).filter(row => /Logox/.test(row.text)).length, 2, 'a new round after the next user message');
  assert.equal(headers(rows).filter(row => row.railGlyph === '❯').length, 2);
});

test('header rows draw the speaker glyph in the two rail columns; other rows keep a quiet │ rail', () => {
  const {store} = round();
  store.message('s', 'logox', 'assistant', 'Hello there.', {activityId: 'main'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 60, {}, null);
  const user = headers(rows).find(row => row.railGlyph === '❯')!, logox = headers(rows).find(row => row.railGlyph === '◈')!;
  assert.equal(user.railColor, palette.user); assert.equal(logox.railColor, palette.accent);
  for (const row of [user, logox]) {
    const cell = railCell(row);
    assert.equal(stringWidth(cell.text), 2); assert.equal(cell.bold, true); assert.equal(cell.color, row.railColor);
    assert.match(strip(encodeRow(row, 0, null)), new RegExp('^' + row.railGlyph + ' '));
  }
  const body = rows.find(row => row.text === 'Hello there.')!;
  assert.equal(railCell(body).text, '│ ');
  assert.equal(railCell(body).color, quietRail(body.railColor));
  assert.notEqual(railCell(body).color, body.railColor, 'the rail is mixed toward the background');
  assert.ok(strip(encodeRow(body, 1, null)).startsWith('│ '));
});

test('an actor window groups its own turn under one header with the role symbol', () => {
  const store = new RuntimeStore();
  addActor(store, 'k', 'kalon');
  store.message('s', 'kalon', 'assistant', 'Sketching.', {activityId: 'k'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'kalon'});
  const id = steps.tool({id: 'w', name: 'Write', arguments: JSON.stringify({file_path: 'a.svg', content: 'x'})}); steps.start(id); steps.finish(id, 'completed', 'Write\nok');
  store.message('s', 'kalon', 'assistant', 'Done sketching.', {activityId: 'k'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'kalon', 100, {}, null);
  const own = headers(rows).filter(row => row.railGlyph === cast.kalon!.symbol);
  assert.equal(own.length, 1);
  assert.match(own[0]!.text, /^Kalon/);
});

test('the Logox header shows the macro state only: no tool title, no Thinking; Waiting on actors; quiet when the round is done', () => {
  const {store, steps} = round();
  const think = steps.thinking(); store.appendMessage(think, 'hmm');
  const header = (hover: string | null = null) => headers(buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, hover)).find(row => row.railGlyph === '◈')!;
  assert.match(decorateRow(header(), Date.now()).displayText!, /^Logox\s*$/);
  steps.finish(think, 'completed');
  const tool = steps.tool({id: 'r', name: 'Read', arguments: JSON.stringify({file_path: 'index.html'})}); steps.start(tool);
  assert.match(decorateRow(header(), Date.now()).displayText!, /^Logox\s*$/, 'a running tool title never reaches the header');
  steps.finish(tool, 'completed', 'Read\nok');
  addActor(store, 'k', 'kalon');
  const waiting = decorateRow(header(), Date.now());
  assert.match(waiting.displayText!, /^Logox · Waiting on Kalon\s*$/);
  assert.equal(waiting.animation, undefined, 'the header carries no spinner animation');
  store.activities.update('s', 'k', {status: 'completed'}); steps.close('completed'); store.activities.update('s', 'main', {status: 'completed'});
  assert.equal(header().animation, undefined, 'header rows never animate');
  assert.equal(header().text.trim(), 'Logox', 'no stage was written: just the name');
});

test('consecutive folded actor cards stack tightly; one blank separates prose from the first card', () => {
  const {store} = round();
  store.message('s', 'logox', 'assistant', 'Dispatching.', {activityId: 'main'});
  addActor(store, 'k', 'kalon'); addActor(store, 't', 'techne'); addActor(store, 'a', 'aletheia');
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, null);
  const first = rows.findIndex(row => row.messageId === 'k');
  assert.equal(rows[first + 1]!.messageId, 't', 'no spacer between folded cards');
  assert.equal(rows[first + 2]!.messageId, 'a');
  assert.equal(rows[first - 1]!.tone, 'spacer', 'one blank between prose and the first card');
  assert.match(rows[first]!.text, /^✧ Kalon/, 'the card header sits directly after the rail, with no extra indent');
  assert.equal(rows[first]!.gutterCols, 2);
});

test('expanded cards carry only a faint owner tint: no cap rows, inner rail under the symbol', () => {
  const {store} = round();
  addActor(store, 'k', 'kalon');
  store.message('s', 'kalon', 'assistant', 'Working on it.', {activityId: 'k'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {k: true}, null);
  assert.ok(!rows.some(row => /-(top|bottom)$/.test(row.messageId) || /^[▄▀]+$/.test(row.text)), 'no ▄/▀ caps');
  const tint = expandedTint(cast.kalon!.color);
  const header = rows.find(row => row.messageId === 'k')!;
  assert.equal(header.segments!.find(segment => segment.text.trim() === '')?.bg ?? header.bg, tint);
  const body = rows.find(row => row.text === 'Working on it.')!;
  assert.equal(body.bg, tint);
  assert.equal(body.prefixSegments![0]!.text, '│ ', 'the inner rail starts in the symbol column');
  assert.equal(body.gutterCols, 4);
  const folded = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, null).find(row => row.messageId === 'k')!;
  assert.equal(folded.bg, undefined, 'folded cards never carry a background');
});

test('an open tool card tints with its surface owner color and indents its body under the title', () => {
  const {store, steps} = round();
  const id = steps.tool({id: 'w', name: 'Write', arguments: JSON.stringify({file_path: 'a.txt', content: 'hi'})}); steps.start(id); steps.finish(id, 'completed', 'Write\nwritten ok');
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[id]: true}, null);
  const head = rows.find(row => row.messageId === id)!;
  assert.equal(head.bg, expandedTint(palette.accent));
  assert.match(head.text, /^▾ Write\(a\.txt\)/);
  const body = rows.find(row => row.text === '1  hi')!; // the rendered view of what was written, not the raw result text
  assert.equal(body.bg, head.bg);
  assert.equal(body.gutterCols, head.gutterCols + 2, 'body is indented two columns under the title');
});

test('the card subtitle takes the latest ⏵ narration of a running actor', () => {
  const {store} = round();
  addActor(store, 'k', 'kalon');
  store.message('s', 'kalon', 'assistant', '⏵ Editing index.html\n', {activityId: 'k'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 120, {}, null);
  assert.match(rows.find(row => row.messageId === 'k')!.text, /kalon task · Editing index\.html/);
});

test('shell output shows the command, then the tail with an expander above it; error lines in red', () => {
  const {store, steps} = round();
  const id = steps.tool({id: 'sh', name: 'Shell', arguments: JSON.stringify({command: 'npx playwright test'})}); steps.start(id);
  steps.finish(id, 'failed', 'Shell\nExit code: 1\n' + ['early noise', ...Array.from({length: 10}, (_, i) => 'noise ' + i), 'Running 3 tests', 'Error: pedals stay in phase'].join('\n'), 'error');
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[id]: true}, null);
  const at = rows.findIndex(row => row.text === '$ npx playwright test');
  assert.ok(at > 0, 'command row');
  const error = rows.find(row => row.text.startsWith('Error: pedals'))!;
  assert.equal(rows.find(row => row.text === 'Running 3 tests')!.color, palette.muted);
  assert.equal(error.color, palette.error);
  const more = rows.findIndex(row => /^… 1 more line$/.test(row.text));
  assert.ok(more > at && more < rows.findIndex(row => row.text === 'Running 3 tests'), 'the expander sits above the tail, below the command');
  assert.ok(!rows.some(row => row.text === 'early noise'));
});

test('paths inside the workspace show relative to the cwd; paths outside stay absolute', () => {
  const inside = join(process.cwd(), 'src', 'app.ts'), outside = join(process.cwd(), '..', 'elsewhere', 'file.ts');
  assert.equal(relativeToCwd(inside), 'src/app.ts');
  assert.equal(relativeToCwd('src/app.ts'), 'src/app.ts');
  assert.equal(relativeToCwd(outside), outside);
  assert.equal(relativeToCwd(inside, join(process.cwd(), 'src')), 'app.ts');
  assert.equal(formatToolCardTitle({id: '1', name: 'Read', arguments: JSON.stringify({file_path: inside})}), 'Read(src/app.ts)');
  assert.equal(formatToolCardTitle({id: '2', name: 'Write', arguments: JSON.stringify({file_path: inside, content: 'a\nb'})}), 'Write(src/app.ts) · 2 lines');
  assert.equal(formatToolCardTitle({id: '3', name: 'Grep', arguments: JSON.stringify({pattern: 'x', path: join(process.cwd(), 'src')})}), 'Grep("x" in src)');
  assert.ok(formatToolCardTitle({id: '4', name: 'Read', arguments: JSON.stringify({file_path: outside})}).includes('elsewhere'));
});

test('the live header shows the current stage instead of the single running tool', () => {
  const {store, steps} = round();
  store.message('s', 'logox', 'assistant', '⏵ Tracing the pedal phase', {activityId: 'main'});
  const id = steps.tool({id: 'rd', name: 'Read', arguments: JSON.stringify({file_path: 'G:/p/a.ts'})}); steps.start(id);
  const header = headers(buildStageRows(store.getSnapshot(), 's', 'logox', 100, {}, null)).at(-1)!;
  assert.match(strip(header.displayText ?? header.text), /Tracing the pedal phase/);
  assert.doesNotMatch(strip(header.displayText ?? header.text), /Read/);
});
