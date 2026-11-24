import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planBlocks} from '../src/tools/coordination/PlanTool/UI.js';
import {toolFixture, rowText} from './tool-fixture.js';

const CREATED = [
  'Created plan p2 "Voxel terrarium index.html" with 1 Build the single-file voxel terrarium (techne); 2 Polish visuals and check the seasons (kalon).',
  'Plan p2 is active: 0/2 top-level nodes accepted.',
].join('\n');
const bodyText = (name: string, args: Record<string, unknown>, result: string) => {
  const {id, rows} = toolFixture(name, args, result);
  const all = rows();
  return {header: rowText(all.find(row => row.messageId === id)!), body: all.filter(row => row.messageId !== id).map(rowText)};
};
const ids = (text: string) => /\bp\d+\b|(?<![\d.])\d+\.\d+(?![\d.])|^\s*[○●✓]\s*\d+ /m.test(text);

test('Plan view: a created plan is a title, one row per step with its owner, and `N of M done` - no ids', () => {
  const args = {op: 'create', title: 'Voxel terrarium index.html', nodes: [{title: 'Build the single-file voxel terrarium', owner: 'techne'}, {title: 'Polish visuals and check the seasons', owner: 'kalon', after: ['1']}]};
  const {header, body} = bodyText('Plan', args, CREATED);
  assert.match(header, /· 0 of 2 done/);
  const text = body.join('\n');
  assert.match(text, /Voxel terrarium index\.html/);
  assert.match(text, /○ Build the single-file voxel terrarium · Techne/);
  assert.match(text, /○ Polish visuals and check the seasons · Kalon · after "Build the single-file voxel terrarium"/);
  assert.ok(!ids(text), text);
  assert.ok(!/top-level|p2/.test(header + text));
});

test('Plan view: the outline read shows status glyphs, nesting, progress, acceptance and evidence', () => {
  const outline = [
    'Plan p1 "Ship it" [active] 1/2 accepted',
    '  1 Build [accepted] techne 2/2',
    '    - accepted by logox: tests pass',
    '    1.1 Core [accepted] techne',
    '    1.2 Edge cases [accepted] automa',
    '  2 Review [pending] kalon after 1',
    '    - acceptance: no visual regressions',
    '    - note: waits for the build',
  ].join('\n');
  const {header, body} = bodyText('Plan', {}, outline);
  const text = body.join('\n');
  assert.match(header, /· 1 of 2 done/);
  assert.match(text, /^ *Ship it *$/m);
  assert.match(text, /✓ Build · Techne · 2 of 2 done/);
  assert.match(text, /Accepted by Logox: tests pass/);
  assert.match(text, /^ {4}✓ Core · Techne/m);
  assert.match(text, /○ Review · Kalon · after "Build"/);
  assert.match(text, /Done when: no visual regressions/);
  assert.match(text, /Note: waits for the build/);
  assert.ok(!ids(text), text);
});

test('Plan view: every op reads as a sentence-free human row', () => {
  const cases: [string, string, RegExp][] = [
    ['Added 3 Fix bug (techne); 3.1 Sub (techne).', 'Added to the plan', /○ Fix bug · Techne/],
    ['Updated 2 Review (aletheia).', 'Updated', /○ Review · Aletheia/],
    ['Removed 2 Review (kalon) and 2 below it.', 'Removed, with 2 below it', /– Review · Kalon · removed/],
    ['Accepted 1 Build (techne).', 'Accepted', /✓ Build · Techne/],
    ['Reopened 1 Build (techne).', 'Reopened', /○ Build · Techne/],
    ['Abandoned 1 Build (techne).', 'Dropped', /– Build · Techne · dropped/],
    ['Abandoned plan p1 "Ship it".', 'Plan dropped: Ship it', /Plan dropped: Ship it/],
  ];
  for (const [result, heading, row] of cases) {
    const text = bodyText('Plan', {op: 'update', id: '2'}, result + '\nPlan p1 is active: 1/2 top-level nodes accepted.').body.join('\n');
    assert.ok(text.includes(heading), result + ' -> ' + text);
    assert.match(text, row);
    assert.ok(!ids(text), text);
  }
});

test('Plan view: a multi-op result keeps its order, and unknown lines stay readable', () => {
  const {blocks, progress} = planBlocks('Accepted 1 A (techne).\nAdded 2 B (kalon).\nSomething else.\nPlan p1 is done: 2/2 top-level nodes accepted.');
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'step', 'heading', 'step', 'text']);
  assert.equal(progress, 'all 2 done');
});

test('Plan view: a long step title wraps under itself', () => {
  const title = 'Build the entire single-file voxel terrarium with scene, flora and fauna, four seasons and interaction';
  const {body} = bodyText('Plan', {op: 'create', title: 'T'}, `Created plan p1 "T" with 1 ${title} (techne).\nPlan p1 is active: 0/1 top-level nodes accepted.`);
  const rows = body.filter(row => /voxel|seasons|interaction/.test(row));
  assert.ok(rows.length >= 2, body.join('|'));
  assert.ok(rows.slice(1).every(row => row.startsWith('  ') && !row.startsWith('  ○')));
});

test('Read: an image row opens a detail with path, format, pixel size and file size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logox-test-'));
  try {
    const png = Buffer.alloc(64); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
    const file = join(dir, 'p.png'); writeFileSync(file, png);
    const {id, rows} = toolFixture('Read', {file_path: file}, `[Image file: ${file}, size: 86016 bytes, format: image/png. Visual content presented to model.]`);
    const open = rows();
    const header = open.find(row => row.messageId === id)!;
    assert.ok(header.action, 'the image row can be toggled');
    const text = open.filter(row => row.messageId !== id).map(rowText).join('\n');
    assert.match(text, /Path\s+.*p\.png/);
    assert.match(text, /Format\s+PNG/);
    assert.match(text, /Dimensions\s+1280 × 720 pixels/);
    assert.match(text, /Size\s+84\.0 KB \(86,016 bytes\)/);
    const closed = rows({[id]: false});
    assert.ok(!closed.some(row => /Dimensions/.test(rowText(row))), 'folded: no detail rows');
  } finally {rmSync(dir, {recursive: true, force: true});}
});
