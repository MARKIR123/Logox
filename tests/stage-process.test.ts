import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {decorateRow, railCell} from '../src/tui/timeline/row-presentation.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';
import {palette} from '../src/tui/appearance/theme.js';
import {faintColor} from '../src/tui/appearance/colors.js';
import {cast} from '../src/actors/ensemble.js';
import {recordWrite} from '../src/tools/WriteTool/record.js';

const text = (row: SceneRow) => row.displayText ?? row.text;
const plain = (row: SceneRow) => text(row).replace(/[│]/g, ' ').trim();

/** One Director round (`owner` logox) or one open Techne actor card in the Director timeline (`owner` techne). */
function fixture(owner: 'logox' | 'techne' = 'logox') {
  const store = new RuntimeStore();
  let now = Date.now() - 20_000;
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  const activityId = owner === 'logox' ? 'main' : 'b';
  if (owner !== 'logox') {
    store.activities.create({sessionId: 's', activityId: 'b', ownerId: owner, kind: 'actor', title: 'Rig', taskTitle: 'Rig', status: 'running', stage: 'x', detail: ''});
    store.message('s', owner, 'user', 'Build the rig.', {activityId: 'b', inputKind: 'director'});
  }
  const steps = new Steps(store, {sessionId: 's', activityId, ownerId: owner}, () => now);
  const call = (name: string, args: Record<string, unknown>, opts: {fail?: boolean; reason?: string; run?: boolean} = {}) => {
    const id = steps.tool({id: name + store.getSnapshot().messages.length, name, arguments: JSON.stringify(args)});
    steps.start(id); now += 400;
    if (!opts.run) steps.finish(id, opts.fail ? 'failed' : 'completed', name + '\n' + (opts.reason ?? 'ok'), opts.fail ? 'error' : undefined);
    return id;
  };
  const stage = (line: string) => store.message('s', owner, 'assistant', '⏵ ' + line, {activityId});
  const think = (body: string, ms = 900) => {const id = steps.thinking(); store.appendMessage(id, body); now += ms; steps.finish(id, 'completed'); return id;};
  const rows = (width = 100, folds: Record<string, boolean> = {}, hovered: string | null = null, roles = cast) =>
    buildStageRows(store.getSnapshot(), 's', 'logox', width, {b: true, ...folds}, hovered, {}, roles);
  return {store, steps, call, stage, think, rows, advance: (ms: number) => {now += ms;}, now: () => now};
}

// --- Thinking body ---

test('thinking body: no duration column, 2-column indent, ∴ opens each thought with a hanging indent, one blank row between thoughts', () => {
  const f = fixture();
  const first = f.think('Initial hypothesis about the long scene that wraps onto a second visual row of the body.\nSecond paragraph of the same thought.');
  f.think('A second thought.');
  f.steps.endGroup('completed');
  const rows = f.rows(40, {[first]: true});
  const head = rows.findIndex(row => row.messageId === first);
  const after = rows.slice(head + 1);
  const end = after.findIndex(row => !row.messageId.startsWith(first + '-t') && !row.messageId.startsWith('spacer'));
  const body = end < 0 ? after : after.slice(0, end);
  const lines = body.map(text);
  assert.ok(lines.length >= 5, lines.join('|'));
  assert.ok(lines.every(line => !/\b\d+s\b/.test(line)), 'no per-thought duration column: ' + lines.join('|'));
  assert.equal(lines[0]!.startsWith('  ∴ Initial'), true, 'body starts two columns under the title with the ∴ marker: ' + lines[0]);
  assert.equal(lines.filter(line => line.includes('∴')).length, 2, 'one marker per thought');
  const wrapped = lines.find(line => line.includes('visual row'))!;
  assert.ok(wrapped.startsWith('    '), 'continuation rows hang under the text, not under the marker');
  const gap = body.findIndex(row => row.messageId.startsWith('spacer'));
  assert.ok(gap > 0 && text(body[gap]!).trim() === '', 'a blank row separates the thoughts');
  assert.equal(body.filter(row => text(row).trim() === '').length, 1, 'and nothing else is blank');
  assert.ok(text(body[gap + 1]!).includes('∴ A second thought.'));
  const mark = body[0]!.segments!.find(segment => segment.text === '∴ ')!;
  assert.equal(mark.color, faintColor(), 'the marker is faint');
  const words = body[0]!.segments!.find(segment => segment.text.includes('Initial'))!;
  assert.equal(words.color, palette.muted); assert.equal(words.italic, true, 'text stays muted italic');
  const toolBody = fixture(); const id = toolBody.call('Shell', {command: 'echo hi'}, {reason: 'one\ntwo'});
  const toolRow = toolBody.rows(40, {[id]: true}).find(row => row.messageId.startsWith(id + '-b-'))!;
  assert.equal(toolRow.gutterCols, rows[head + 1]!.gutterCols, 'same body indent as every other card body');
});

test('thinking: the title row is an italic summary; a running one keeps the actor glyph, Thinking with the shimmer and the live clock', () => {
  const f = fixture();
  const done = f.think('one'); f.think('two'); f.steps.endGroup('completed');
  const row = f.rows().find(r => r.messageId === done)!;
  assert.match(text(row), /^▸ Thought 2 times/);
  assert.ok(row.segments!.filter(s => s.selectionKey === done + ':title' && s.text.trim()).every(s => s.italic), 'thinking title is italic');
  const live = fixture();
  const id = live.steps.thinking(); live.store.appendMessage(id, 'working it out'); live.advance(1500);
  const frames = ['▖', '▌', '▘', '▀'];
  const roles = {...cast, logox: {...cast.logox!, thinkingAnimation: frames}};
  const liveRow = live.rows(100, {}, null, roles).find(r => r.messageId === id)!;
  assert.doesNotMatch(text(liveRow), /▸/, 'no plain ▸ row while thinking');
  const seen = new Set<string>();
  for (const offset of [0, 200, 400, 600]) {
    const drawn = decorateRow(liveRow, live.now() + offset);
    const glyph = drawn.segments!.find(s => s.selectionKey === id + ':icon')!;
    assert.ok(frames.includes(glyph.text.trim()), 'the role thinkingAnimation frames: ' + glyph.text);
    seen.add(glyph.text);
    assert.match(drawn.displayText!, /^\S Thinking · \d+\.\ds/, 'glyph, Thinking, live clock: ' + drawn.displayText);
  }
  assert.ok(seen.size > 1, 'the glyph animates');
  const title = (now: number) => decorateRow(liveRow, now).segments!.filter(s => s.selectionKey === id + ':title').map(s => s.color).join();
  assert.notEqual(title(live.now()), title(live.now() + 360), 'the title shimmers');
  assert.equal(decorateRow(liveRow, live.now()).displayText!.length, decorateRow(liveRow, live.now() + 5000).displayText!.length, 'fixed-width slots');
});

test('tool-group titles are italic while their tool rows stay upright', () => {
  const f = fixture();
  f.call('Read', {file_path: 'a.ts'}); f.call('Read', {file_path: 'b.ts'}); f.call('Grep', {pattern: 'x'});
  const rows = f.rows(100, {}), title = rows.find(r => /^▸ [A-Z][\w' -]* \d+ /.test(plain(r)))!;
  assert.ok(title.segments!.filter(s => s.selectionKey?.endsWith(':title') && s.text.trim()).every(s => s.italic));
  const open = f.rows(100, {[title.messageId]: true});
  const child = open.find(r => /▮ Read\(a\.ts\)/.test(text(r)))!;
  assert.ok(!child.segments!.some(s => s.italic), 'individual tool rows stay upright');
});

// --- Status lines ---

test('status lines draw no rows: no heading between groups, nothing merged away, never inside a group title', () => {
  for (const owner of ['logox', 'techne'] as const) {
    const f = fixture(owner);
    f.stage('Mapping the current layout');
    f.call('Read', {file_path: 'a.ts'}); f.call('Grep', {pattern: 'p'});
    f.stage('Applying the fix to the stylesheet');
    f.call('Read', {file_path: 'b.ts'});
    f.call('Edit', {file_path: 'a.css', old_string: 'a', new_string: 'b'});
    f.stage('Checking that everything still passes');
    f.call('Shell', {command: 'npm test'}); f.call('Shell', {command: 'ls'});
    const rows = f.rows(100).filter(row => !row.railGlyph), lines = rows.map(plain); // the speaker header may still name the latest line
    assert.ok(!lines.some(line => /^\s*(?:Mapping the current layout|Applying the fix to the stylesheet|Checking that everything still passes)\s*$|⏵/.test(line)), owner + ' no stage row:\n' + lines.join('\n'));
    assert.equal(rows.filter(row => row.messageId.endsWith('-stage')).length, 0);
    const groups = lines.filter(line => /^▸ (?!Task from)/.test(line));
    assert.equal(groups.length, 2, owner + ' reads across the first two lines fold into one group, the shell calls into another: ' + groups.join('|'));
    assert.match(groups[0]!, /1 pattern · .*2 files/, 'the read group spans the status line: Read, Grep and Read together');
    const order = [lines.findIndex(line => /^▸ .*(file|pattern)/.test(line)), lines.findIndex(line => /^▮ Edit/.test(line)), lines.findIndex((line, index) => index > 0 && /^▸ .*(command|directory)/.test(line))];
    assert.ok(order.every(index => index >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, owner + ' order\n' + lines.join('\n'));
  }
});

test('the live header uses the latest status line; the card shows it with the running tool', () => {
  const f = fixture('techne');
  f.stage('Tracing the pedal phase');
  f.call('Shell', {command: 'sleep 9'}, {run: true});
  const lines = f.rows().map(text);
  assert.ok(lines.some(line => /Rig · Tracing the pedal phase · Shell\(sleep 9\)/.test(line)), 'card subtitle: ' + lines.join('|'));
  assert.ok(lines.some(line => /Logox .*Waiting on Techne/.test(line)));
  const g = fixture();
  g.stage('Verifying the build');
  g.call('Shell', {command: 'sleep 9'}, {run: true});
  assert.ok(g.rows().some(row => /^Logox · Verifying the build/.test(text(row))), 'live header uses the stage');
});

// --- Same-file edit merge ---

test('consecutive edits of one file fold into one summed row; expanded it shows every edit’s hunks in order', () => {
  const f = fixture('techne');
  const ids = [1, 2, 3, 4].map(n => f.call('Edit', {file_path: 'animation.css', old_string: `.a${n} {top: ${n}px}`, new_string: `.a${n} {top: ${n + 1}px}`}));
  const rows = f.rows(110);
  const head = rows.filter(row => ids.includes(row.messageId));
  assert.equal(head.length, 1, 'one row for four edits: ' + rows.map(text).join('|'));
  assert.match(plain(head[0]!), /^▮ Edit\(animation\.css\) ×4 · added 4 · removed 4 · 1\.6s$/);
  const expanded = f.rows(110, {[ids[0]!]: true});
  const body = expanded.filter(row => row.messageId.startsWith(ids[0]! + '-b-')).map(text);
  const order = [1, 2, 3, 4].map(n => body.findIndex(line => line.includes(`.a${n} {top: ${n + 1}px}`)));
  assert.ok(order.every(index => index >= 0), body.join('|'));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in order');
  assert.equal(body.filter(line => line.includes('⋯')).length, 3, 'a ⋯ separator between the edits');
  assert.ok(expanded.some(row => row.messageId === ids[0]! + '-more' || row.messageId.startsWith(ids[0]!)), 'single fold id of the first edit');
  assert.equal(expanded.filter(row => /… (show less|\d+ more)/.test(row.text)).length, 0, 'short combined diffs need no expander');
  const long = fixture('techne');
  const many = Array.from({length: 6}, (_, n) => long.call('Edit', {file_path: 'big.css', old_string: Array.from({length: 4}, (_, i) => `a${n}${i}`).join('\n'), new_string: Array.from({length: 4}, (_, i) => `b${n}${i}`).join('\n')}));
  const cut = long.rows(110, {[many[0]!]: true}).filter(row => row.messageId === many[0]! + '-more');
  assert.equal(cut.length, 1, 'one expander for the combined diff');
  assert.match(cut[0]!.text, /^… \d+ more (lines|hunks)$/);
});

test('a merged edit row is red with the failed edit’s reason; other files and other rows break the merge, a status line does not', () => {
  const f = fixture('techne');
  const a = f.call('Edit', {file_path: 'a.css', old_string: 'x', new_string: 'y'});
  f.call('Edit', {file_path: 'a.css', old_string: 'zzz', new_string: 'y'}, {fail: true, reason: 'Error: old_string not found in a.css'});
  f.call('Edit', {file_path: 'a.css', old_string: 'q', new_string: 'r'});
  f.call('Edit', {file_path: 'b.css', old_string: 'q', new_string: 'r'});
  f.call('Read', {file_path: 'c.ts'});
  f.call('Edit', {file_path: 'b.css', old_string: 'q', new_string: 'r'});
  f.stage('Now the second file');
  f.call('Edit', {file_path: 'b.css', old_string: 'q', new_string: 'r'});
  const rows = f.rows(110);
  const merged = rows.find(row => row.messageId === a)!;
  assert.match(plain(merged), /^▮ Edit\(a\.css\) ×3 · old_string not found in a\.css · added 2 · removed 2 · /);
  const mark = merged.segments!.find(s => s.selectionKey === a + ':icon')!;
  assert.equal(mark.color, palette.error, 'red mark');
  const edits = rows.filter(row => /Edit\(/.test(text(row)));
  assert.equal(edits.length, 3, 'a.css ×3, b.css, then b.css ×2 across the status line: ' + edits.map(text).join('|'));
  assert.equal(edits.filter(row => /×\d/.test(text(row))).length, 2);
});

test('a Write that overwrote a known file folds into the surrounding edits of that file', () => {
  const f = fixture('techne');
  const first = f.call('Edit', {file_path: 'merge-target.css', old_string: 'a', new_string: 'b'});
  recordWrite('merge-target.css', 'fresh\ncontent\n', Buffer.from('old\ncontent\n'));
  f.call('Write', {file_path: 'merge-target.css', content: 'fresh\ncontent\n'});
  const rows = f.rows(110);
  const merged = rows.filter(row => /merge-target\.css/.test(text(row)));
  assert.equal(merged.length, 1, merged.map(text).join('|'));
  assert.match(plain(merged[0]!), /Edit\(merge-target\.css\) ×2 · added 2 · removed 2/);
  assert.equal(merged[0]!.messageId, first);
});

// --- Rails ---

test('the outer rail always keeps the round speaker colour next to an open actor card; the tint never covers it', () => {
  const f = fixture('techne');
  f.think('planning the rig');
  f.stage('Looking around');
  f.call('Read', {file_path: 'a.ts'}); f.call('Read', {file_path: 'b.ts'});
  f.stage('Editing');
  f.call('Edit', {file_path: 'a.css', old_string: 'x', new_string: 'y'}); f.call('Edit', {file_path: 'a.css', old_string: 'y', new_string: 'z'});
  f.call('Shell', {command: 'npm test'}, {fail: true, reason: 'Exit code: 1\nboom'});
  f.store.message('s', 'kalon', 'user', '[Message from kalon · hi]\nbody', {activityId: 'b', inputKind: 'collaboration'});
  const group = f.store.getSnapshot().messages.find(m => m.kind === 'tool')!.id + '-group';
  const rows = f.rows(100, {[group]: true});
  const start = rows.findIndex(row => /^⊞ Techne/.test(plain(row)));
  assert.ok(start > 0, rows.map(text).join('\n'));
  const inner = rows.slice(start).filter(row => row.railColor !== undefined && row.gutterCols > 0 && !row.messageId.startsWith('spacer'));
  assert.ok(inner.length > 6);
  for (const row of inner) {
    assert.equal(row.railColor, palette.accent, 'Logox rail for: ' + text(row));
    const cell = railCell(row);
    assert.equal(cell.bg, undefined, 'no tint behind the outer rail');
    assert.equal(stringWidth(cell.text), 2);
  }
  assert.ok(rows.slice(start).some(row => row.bg), 'the open card is tinted');
  assert.ok(rows.slice(start).filter(row => row.bg).every(row => row.gutterCols >= 2), 'the tint starts after the rail columns');
});

// --- Clipping ---

test('long titles clip with … inside the row at every width, inside actor cards and groups too', () => {
  const f = fixture('techne');
  const cmd = 'node C:/Users/ADMINI~1/AppData/Local/Temp/logox-scratchpad/ca103dacd2a4/3b4391d1/test_motion_engine.js --verbose --long';
  const ids = [f.call('Shell', {command: cmd, description: 'Execute unit tests for motion-engine.js'}),
    f.call('Shell', {command: cmd}, {fail: true, reason: 'Exit code: 1\nboom'}), f.call('Shell', {command: cmd}, {run: true}),
    f.call('mcp', {server: 'playwright', action: 'call', tool: 'browser_navigate', arguments: {url: 'file:///C:/Users/Administrator/AppData/Local/Temp/logox-scratchpad/ca103dacd2a4/preview/index.html'}}, {fail: true, reason: 'Error: net::ERR_FILE_NOT_FOUND'})];
  f.call('Read', {file_path: 'C:/very/long/path/' + 'segment/'.repeat(12) + 'file.ts'}); f.call('Read', {file_path: 'b.ts'});
  const group = f.store.getSnapshot().messages.find(m => m.kind === 'tool' && /Read/.test(m.text))!.id + '-group';
  for (const width of [28, 40, 60, 77, 120]) for (const open of [false, true]) {
    const rows = f.rows(width, {[group]: open});
    for (const row of rows) assert.ok(stringWidth(decorateRow(row, Date.now()).displayText ?? row.text) <= width, `${width}: ${text(row)}`);
    for (const id of ids.slice(0, 3)) {
      const row = rows.find(r => r.messageId === id)!;
      if (width <= 60) assert.ok(text(row).includes('…'), `${width} clipped with an ellipsis: ${text(row)}`);
    }
  }
});
