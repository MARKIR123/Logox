import test from 'node:test';
import assert from 'node:assert/strict';
import {actionAt, hoveredCardAt, type SceneRow} from '../src/tui/timeline/scene.js';
import {linkSegments} from '../src/tui/timeline/tool-card.js';
import {encodeRow} from '../src/tui/terminal/terminal-plane.js';
import {faintColor} from '../src/tui/appearance/colors.js';
import {palette} from '../src/tui/appearance/theme.js';
import {toolFixture, rowText} from './tool-fixture.js';

const strip = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '');
const lines = (count: number) => Array.from({length: count}, (_, i) => `line ${i + 1}`);

test('a long body shows 12 lines and one italic faint expander that hovers, clicks and expands in place', () => {
  const {id, rows} = toolFixture('Glob', {pattern: '**/*'}, Array.from({length: 30}, (_, i) => `src/file-${i + 1}.ts`).join('\n'));
  const closed = rows();
  const body = closed.filter(row => /file-\d+\.ts$/.test(row.text));
  assert.equal(body.length, 12);
  const more = closed.find(row => row.messageId === id + '-more')!;
  assert.equal(more.text, '… 18 more lines');
  const part = more.segments!.find(segment => segment.text.includes('more lines'))!;
  assert.equal(part.italic, true); assert.equal(part.color, faintColor()); assert.ok(!part.underline);
  // its own fold, reachable by mouse and keyboard (Ctrl+N / Ctrl+O walk row actions)
  assert.deepEqual(more.action, {kind: 'toggle_fold', foldId: id + '-more'});
  assert.equal(actionAt(more, more.gutterCols)?.foldId, id + '-more');
  assert.equal(hoveredCardAt(more, more.gutterCols + 2), id + '-more');
  assert.equal(actionAt(body[0]!, body[0]!.gutterCols)?.foldId, id, 'other body rows still belong to the card');
  // hover: brighter and underlined
  const hovered = rows({}, id + '-more').find(row => row.messageId === id + '-more')!;
  const bright = hovered.segments!.find(segment => segment.text.includes('more lines'))!;
  assert.equal(bright.color, palette.fg); assert.equal(bright.underline, true); assert.equal(bright.italic, true);
  // click: the expander fold opens the whole body, no expander left
  const expanded = rows({[id + '-more']: true});
  assert.equal(expanded.filter(row => /file-\d+\.ts$/.test(row.text)).length, 30);
  assert.ok(!expanded.some(row => row.messageId === id + '-more'));
});

test('a body of exactly 12 lines has no expander', () => {
  const {rows} = toolFixture('Glob', {pattern: '*'}, Array.from({length: 12}, (_, i) => `f${i}.ts`).join('\n'));
  assert.ok(!rows().some(row => /more lines?$/.test(row.text)));
});

test('empty results render one italic faint line, never nothing, and the header does not repeat it', () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ['Shell', {command: 'true'}, 'Exit code: 0\n', 'No output'],
    ['Glob', {pattern: '*.zzz'}, '', 'No files matched'],
    ['Grep', {pattern: 'zzz'}, 'No matches found.', 'No matches'],
    ['Read', {file_path: 'empty.txt'}, '1: ', 'Empty file'],
  ];
  for (const [name, args, result, expected] of cases) {
    const {id, rows} = toolFixture(name, args, result);
    const all = rows();
    const empty = all.find(row => row.text === expected);
    assert.ok(empty, name + ' shows ' + expected);
    const part = empty!.segments!.find(segment => segment.text === expected)!;
    assert.equal(part.italic, true); assert.equal(part.color, faintColor());
    const header = all.find(row => row.messageId === id)!;
    assert.ok(!rowText(header).includes(expected), 'no duplicate in the header: ' + rowText(header));
  }
});

test('header anatomy: open ▾ with the title in fg, folded ▮ muted, elapsed time faint at the right edge', () => {
  const {id, rows} = toolFixture('Glob', {pattern: 'src/*.ts'}, 'src/a.ts\nsrc/b.ts');
  const open = rows().find(row => row.messageId === id)!;
  assert.match(open.text, /^▾ Glob\(src\/\*\.ts\) · 2 files {2,}0\.0s$/);
  const folded = rows({[id]: false}).find(row => row.messageId === id)!;
  assert.match(folded.text, /^▮ Glob\(src\/\*\.ts\) · 2 files {2,}0\.0s$/);
  const time = folded.segments!.find(segment => segment.selectionKey === id + ':status')!;
  assert.equal(time.color, faintColor());
  assert.equal(folded.segments!.find(segment => segment.selectionKey === id + ':title')!.color, palette.muted);
  assert.equal(open.segments!.find(segment => segment.selectionKey === id + ':title')!.color, palette.fg);
});

test('a failed call shows its reason in the summary and the full text below', () => {
  const {id, rows} = toolFixture('Read', {file_path: 'missing.ts'}, 'File not found: missing.ts\nCheck the path.', 'failed');
  const all = rows();
  assert.match(rowText(all.find(row => row.messageId === id)!), /Read\(missing\.ts\) · File not found: missing\.ts/);
  assert.ok(all.some(row => row.text === 'Check the path.' && row.color === palette.error));
});

test('links, URLs and domains are underlined in the link color; the terminal encodes the underline', () => {
  const parts = linkSegments('see https://example.com/a/b, docs.anthropic.com/en and localhost:5173/index.html or README.md.');
  const links = parts.filter(part => part.underline);
  assert.deepEqual(links.map(part => part.text), ['https://example.com/a/b', 'docs.anthropic.com/en', 'localhost:5173/index.html']);
  assert.ok(links.every(part => part.color === palette.link));
  assert.ok(parts.filter(part => !part.underline).every(part => !part.color));
  const row = {messageId: 'x', line: 0, text: 'docs.anthropic.com', railColor: '', gutterCols: 0, softWrap: false, noSelect: true, tone: 'body',
    segments: [{text: 'docs.anthropic.com', underline: true, color: palette.link}]} as unknown as SceneRow;
  assert.ok(encodeRow(row, 0, null).includes('\x1b[4m'));
  assert.ok(!strip(encodeRow(row, 0, null)).includes('\x1b'));
});

test('shell shows the command, then the output tail with the expander above it; expanding reveals the earlier lines', () => {
  const {id, rows} = toolFixture('Shell', {command: 'npm test'}, 'Exit code: 1\n' + lines(20).join('\n') + '\nStderr:\nboom', 'failed');
  const closed = rows();
  const at = (text: string) => closed.findIndex(row => row.text === text);
  assert.ok(at('$ npm test') > 0);
  const more = closed.findIndex(row => row.messageId === id + '-more');
  assert.ok(more > at('$ npm test') && more < at('line 10'), 'expander between the command and the tail');
  assert.equal(closed[more]!.text, '… 9 more lines');
  assert.ok(at('line 9') < 0 && at('line 10') > 0 && at('boom') > at('line 20'));
  assert.equal(closed.find(row => row.text === 'boom')!.color, palette.error, 'stderr in the error color');
  assert.match(rowText(closed.find(row => row.messageId === id)!), /Shell\(npm test\) · exit 1 +0\.0s$/);
  assert.ok(!rowText(closed.find(row => row.messageId === id)!).includes('Error'), 'exit code replaces the Error label');
  const expanded = rows({[id + '-more']: true});
  assert.ok(expanded.findIndex(row => row.text === 'line 1') < expanded.findIndex(row => row.text === 'line 20'));
  assert.ok(!expanded.some(row => row.messageId === id + '-more'));
});

test('an expanded tool group lists each member as its own folded row with its summary, each expandable with the same anatomy', async () => {
  const {RuntimeStore} = await import('../src/runtime/store.js');
  const {Steps} = await import('../src/runtime/steps.js');
  const {buildStageRows} = await import('../src/tui/timeline/stage.js');
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
  const call = (name: string, args: Record<string, unknown>, result: string) => {
    const id = steps.tool({id: name + Math.random(), name, arguments: JSON.stringify(args)}); steps.start(id); steps.finish(id, 'completed', name + '\n' + result); return id;
  };
  const read = call('Read', {file_path: 'src/a.ts'}, '1: x\n2: y');
  call('Grep', {pattern: 'x', output_mode: 'content'}, 'src/a.ts:1: x');
  const snapshot = store.getSnapshot();
  const group = snapshot.messages.find(message => message.kind === 'tool')!.id + '-group';
  const rows = (folds: Record<string, boolean>) => buildStageRows(snapshot, 's', 'logox', 90, folds, null).map(rowText);
  const folded = rows({[group]: true});
  assert.ok(folded.some(text => /^ {2}▮ Read\(src\/a\.ts\) · 2 lines +0\.0s/.test(text)));
  assert.ok(folded.some(text => /^ {2}▮ Grep\("x"\) · 1 match in 1 file +0\.0s/.test(text)));
  const one = rows({[group]: true, [read]: true});
  assert.ok(one.some(text => /^ {2}▾ Read\(src\/a\.ts\)/.test(text)) && one.some(text => /^ {4}1 {2}x/.test(text)));
  assert.ok(one.some(text => /^ {2}▮ Grep/.test(text)), 'siblings stay folded');
});
