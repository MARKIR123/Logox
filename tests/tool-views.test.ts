import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {palette} from '../src/tui/appearance/theme.js';
import {faintColor} from '../src/tui/appearance/colors.js';
import {recordWrite} from '../src/tools/WriteTool/record.js';
import {highlightLine, languageOf} from '../src/tui/timeline/tool-code.js';
import {toolFixture, rowText} from './tool-fixture.js';

const numbered = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => `${from + i}: line ${from + i}`).join('\n');

test('Read: right-aligned faint line numbers, light syntax colour, `lines A–B of N`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logox-test-'));
  try {
    const file = join(dir, 'a.ts');
    writeFileSync(file, Array.from({length: 40}, (_, i) => i === 8 ? '// note' : `const v${i} = ${i};`).join('\n'));
    const result = ['8: const v7 = 7;', '9: // note', '10: const s = "x";', '(Remaining lines omitted)'].join('\n');
    const {id, rows} = toolFixture('Read', {file_path: file, offset: 8, limit: 3}, result);
    const all = rows();
    assert.match(rowText(all.find(row => row.messageId === id)!), /· lines 8–10 of 40 · 0\.0s\s*$/);
    const ten = all.find(row => /^10 {2}const s/.test(row.text))!;
    assert.ok(ten, 'numbers right-aligned to the widest: ' + all.map(row => row.text).join('|'));
    assert.equal(ten.segments!.find(segment => segment.text.startsWith('10'))!.color, faintColor());
    assert.equal(ten.segments!.find(segment => segment.text === '"x"')!.color, palette.syntaxString);
    assert.equal(ten.segments!.find(segment => segment.text === 'const')!.color, palette.syntaxKeyword);
    assert.ok(all.some(row => /^ 8 {2}const v7/.test(row.text)), 'single digits are padded');
    const note = all.find(row => row.text.includes('// note'))!;
    assert.equal(note.segments!.find(segment => segment.text.includes('// note'))!.color, faintColor());
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('Read: a whole file reads `N lines`; the tokenizer colours numbers and carries block comments', () => {
  const {id, rows} = toolFixture('Read', {file_path: 'x.py'}, numbered(1, 3));
  assert.match(rowText(rows().find(row => row.messageId === id)!), /· 3 lines · 0\.0s\s*$/);
  assert.equal(languageOf('a.tsx'), 'c');
  const first = highlightLine('/* start 42', 'c');
  assert.equal(first.inBlock, true);
  const second = highlightLine('end */ x = 7', 'c', first.inBlock);
  assert.equal(second.inBlock, false);
  assert.equal(second.segments.find(segment => segment.text.includes('7'))!.color, palette.syntaxNumber);
});

test('Read: Markdown files render through the Markdown layout, not as numbered source', () => {
  const {rows} = toolFixture('Read', {file_path: 'docs/BRAND.md'}, '1: # Brand rules\n2: \n3: Plain **bold** text');
  const all = rows();
  const heading = all.find(row => row.text.includes('Brand rules'))!;
  assert.ok(heading && !heading.text.includes('#'), 'heading is rendered, not source');
  assert.ok(heading.segments!.some(segment => segment.bold));
  assert.ok(!all.some(row => /^1 {2}#/.test(row.text)), 'no line-number gutter');
});

test('Read: an image is one non-expandable row with its size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logox-test-'));
  try {
    const png = Buffer.alloc(64); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
    const file = join(dir, 'p.png'); writeFileSync(file, png);
    const {id, rows} = toolFixture('Read', {file_path: file}, `[Image file: ${file}, size: 86016 bytes, format: image/png. Visual content presented to model.]`);
    const all = rows();
    const header = all.find(row => row.messageId === id)!;
    assert.match(rowText(header), /^▮ Read\(.*p\.png\) · image · 1280 × 720 · 84\.0 KB/);
    assert.equal(header.action, undefined); assert.equal(header.hits, undefined); assert.equal(header.hover, undefined);
    assert.equal(all.filter(row => row.messageId.startsWith(id) && row.messageId !== id && !row.messageId.endsWith('-who')).length, 0, 'no body rows');
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('Edit: numbered hunks separated by a faint ⋯ row, `+N −M`, and `… N more hunks`', () => {
  const body = Array.from({length: 40}, (_, i) => `row ${i}`);
  const after = body.map((row, i) => [0, 14, 29].includes(i) ? row + ' changed' : row);
  const {id, rows} = toolFixture('Edit', {file_path: 'virtual/never-on-disk.ts', old_string: body.join('\n'), new_string: after.join('\n')}, 'Updated virtual/never-on-disk.ts');
  const all = rows();
  assert.match(rowText(all.find(row => row.messageId === id)!), /Edit\(virtual\/never-on-disk\.ts\) · added 3 · removed 3 · 0\.0s\s*$/);
  const removed = all.find(row => row.text.includes('− ') && row.text.includes('row 0'))!;
  assert.match(removed.text, /^ {2}1 − row 0$/);
  assert.equal(removed.bg, palette.diffRemovedBg);
  assert.ok(all.some(row => row.text === '… 2 more hunks'), 'long edits cut at a hunk boundary: ' + all.map(row => row.text).join('|'));
  assert.ok(!all.some(row => row.text.includes('⋯')), 'the cut falls on the boundary, so no dangling separator');
  const open = rows({[id + '-more']: true});
  const separators = open.filter(row => /^\s*⋯$/.test(row.text));
  assert.equal(separators.length, 2, 'hunks are separated by a faint ⋯ row');
  assert.equal(separators[0]!.segments!.find(segment => segment.text.includes('⋯'))!.color, faintColor());
  assert.equal(open.filter(row => row.messageId === id + '-more').map(row => row.text).join(), '… show less');
});

test('Write: a new file shows its head like Read with `new file · N lines`; an overwrite shows a diff when the previous text is known', () => {
  const content = Array.from({length: 20}, (_, i) => `export const n${i} = ${i};`).join('\n');
  recordWrite('/p/brand-assets.mjs', content, null);
  const fresh = toolFixture('Write', {file_path: '/p/brand-assets.mjs', content}, 'Updated /p/brand-assets.mjs');
  const all = fresh.rows();
  assert.match(rowText(all.find(row => row.messageId === fresh.id)!), /· new file · 20 lines · 0\.0s\s*$/);
  assert.ok(all.some(row => /^ 1 {2}export const n0 = 0;$/.test(row.text)));
  assert.ok(all.some(row => row.text === '… 8 more lines'));
  const next = content.replace('n3 = 3', 'n3 = 33');
  recordWrite('/p/over.mjs', next, Buffer.from(content));
  const over = toolFixture('Write', {file_path: '/p/over.mjs', content: next}, 'Updated /p/over.mjs');
  const diff = over.rows();
  assert.match(rowText(diff.find(row => row.messageId === over.id)!), /· added 1 · removed 1 · 0\.0s\s*$/);
  assert.ok(diff.some(row => row.text.includes('− export const n3 = 3;')) && diff.some(row => row.text.includes('+ export const n3 = 33;')));
  const unknown = toolFixture('Write', {file_path: '/p/unknown.txt', content: 'a\nb'}, 'Updated /p/unknown.txt');
  assert.match(rowText(unknown.rows().find(row => row.messageId === unknown.id)!), /· 2 lines · 0\.0s\s*$/);
});

test('Grep: hits grouped by file with a faint count, matches highlighted bold in the warm colour, `N matches in M files`', () => {
  const result = ['src/a.ts:8: export const EMBLEM_PIXELS = 1;', 'src/a.ts:9: export const EMBLEM_WORDMARK = 2;', 'tests/b.ts:12: assert.equal(EMBLEM_PIXELS.length, 26);'].join('\n');
  const {id, rows} = toolFixture('Grep', {pattern: 'EMBLEM_\\w+', output_mode: 'content'}, result);
  const all = rows();
  assert.match(rowText(all.find(row => row.messageId === id)!), /· 3 matches in 2 files · 0\.0s\s*$/);
  const group = all.find(row => row.text === 'src/a.ts  2')!;
  assert.ok(group, 'file header with count: ' + all.map(row => row.text).join('|'));
  assert.equal(group.segments!.find(segment => segment.text === 'a.ts')!.color, palette.path);
  assert.equal(group.segments!.find(segment => segment.text === '  2')!.color, faintColor());
  const hit = all.find(row => row.text.includes('EMBLEM_WORDMARK'))!;
  const mark = hit.segments!.find(segment => segment.text === 'EMBLEM_WORDMARK')!;
  assert.equal(mark.color, palette.highlight); assert.equal(mark.bold, true);
  assert.match(hit.text, /^ {2} 9 {2}export const EMBLEM_WORDMARK = 2;$/);
  assert.ok(all.findIndex(row => row.text === 'tests/b.ts  1') > all.findIndex(row => row.text === hit.text));
});

test('Grep: files-only and count modes list files sensibly', () => {
  const files = toolFixture('Grep', {pattern: 'x'}, 'src/a.ts\nsrc/b.ts');
  assert.match(rowText(files.rows().find(row => row.messageId === files.id)!), /· 2 files · 0\.0s\s*$/);
  const count = toolFixture('Grep', {pattern: 'x', output_mode: 'count'}, 'src/a.ts:4\nsrc/b.ts:3');
  const all = count.rows();
  assert.match(rowText(all.find(row => row.messageId === count.id)!), /· 7 matches in 2 files · 0\.0s\s*$/);
  assert.ok(all.some(row => row.text === 'src/a.ts  4'));
});

test('Glob: directory part faint, file name in the path colour, `N files`', () => {
  const {id, rows} = toolFixture('Glob', {pattern: 'assets/*.svg'}, 'assets/banner.svg\nlogo.svg');
  const all = rows();
  assert.match(rowText(all.find(row => row.messageId === id)!), /· 2 files · 0\.0s\s*$/);
  const row = all.find(item => item.text === 'assets/banner.svg')!;
  assert.equal(row.segments!.find(segment => segment.text === 'assets/')!.color, faintColor());
  assert.equal(row.segments!.find(segment => segment.text === 'banner.svg')!.color, palette.path);
  assert.equal(all.find(item => item.text === 'logo.svg')!.segments!.find(segment => segment.text === 'logo.svg')!.color, palette.path);
});

test('Shell: exit badge colours, `$ command` in the path colour', () => {
  const ok = toolFixture('Shell', {command: 'git push origin master'}, 'Exit code: 0\nEverything up-to-date');
  const header = ok.rows().find(row => row.messageId === ok.id)!;
  assert.ok(!header.text.includes('exit'), 'success is quiet: no exit summary on exit 0');
  const command = ok.rows().find(row => row.text === '$ git push origin master')!;
  assert.equal(command.segments!.find(segment => segment.text === 'git push origin master')!.color, palette.path);
  const bad = toolFixture('Shell', {command: 'false'}, 'Exit code: 1\n', 'failed');
  assert.equal(bad.rows().find(row => row.messageId === bad.id)!.segments!.find(segment => segment.text === 'exit 1')!.color, palette.error);
});
