import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeEdit} from '../src/tools/EditTool/EditTool.js';
import {Snapshots} from '../src/tools/snapshots.js';

async function fixture(t: TestContext, content: string) {
  const hash = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  const directory = join(tmpdir(), 'logox-scratchpad', hash, randomUUID());
  await mkdir(directory, {recursive: true});
  t.after(() => rm(directory, {recursive: true, force: true}));
  await writeFile(join(directory, 'style.css'), content);
  const file = await realpath(join(directory, 'style.css'));
  const snapshots = new Snapshots(join(directory, 'snapshots'));
  return {file, snapshots, edit: (old_string: string, new_string: string, replace_all = false) =>
    executeEdit({file_path: file, old_string, new_string, replace_all}, file, snapshots, 'edit-round')};
}

for (const [label, targetNewline, inputNewline] of [
  ['LF target and LF input', '\n', '\n'],
  ['LF target and CRLF input', '\n', '\r\n'],
  ['CRLF target and LF input', '\r\n', '\n'],
] as const) test(`Edit matches ${label} in a mixed-newline file without changing unrelated bytes`, async t => {
  const prefix = '﻿/* unrelated header */\r\n/* note */\n';
  const target = ['.top-brand {', '  justify-content: space-between;', '}'].join(targetNewline);
  const suffix = '\n/* untouched footer */\r\n';
  const before = prefix + target + suffix;
  const f = await fixture(t, before);
  const old = ['.top-brand {', '  justify-content: space-between;', '}'].join(inputNewline);
  const replacement = ['.top-brand {', '  justify-content: flex-start;', '  content: "$& $1 雪";', '}'];
  const result = await f.edit(old, replacement.join('\n'));
  assert.equal(result.isError, false);
  assert.deepEqual(await readFile(f.file), Buffer.from(prefix + replacement.join(targetNewline) + suffix));
  await f.snapshots.undo(['edit-round']);
  assert.deepEqual(await readFile(f.file), Buffer.from(before));
});

for (const newline of ['\n', '\r\n']) test(`Edit uses the target line's ${newline === '\n' ? 'LF' : 'CRLF'} when inserting new lines`, async t => {
  const prefix = 'unrelated\r\n';
  const before = prefix + 'old' + newline + 'tail\n';
  const f = await fixture(t, before);
  await f.edit('old', 'new\nextra');
  assert.deepEqual(await readFile(f.file), Buffer.from(prefix + 'new' + newline + 'extra' + newline + 'tail\n'));
});

test('Edit rejects multiple logical matches across LF and CRLF without writing a snapshot', async t => {
  const before = 'old\nline\nseparator\r\nold\r\nline\r\n';
  const f = await fixture(t, before);
  await assert.rejects(f.edit('old\nline', 'new\nline'), /Multiple matches/);
  assert.deepEqual(await readFile(f.file), Buffer.from(before));
  assert.deepEqual(await f.snapshots.undo(['edit-round']), []);
});

test('Edit rejects overlapping logical matches instead of choosing one target', async t => {
  const before = 'same\r\nsame\nsame';
  const f = await fixture(t, before);
  await assert.rejects(f.edit('same\nsame', 'new'), /Multiple matches/);
  assert.deepEqual(await readFile(f.file), Buffer.from(before));
  assert.deepEqual(await f.snapshots.undo(['edit-round']), []);
});

test('Edit replace_all preserves the local newline style of each occurrence', async t => {
  const before = '﻿old\nline\nseparator\r\nold\r\nline\r\n';
  const f = await fixture(t, before);
  await f.edit('old\nline', '$&\n$1', true);
  assert.deepEqual(await readFile(f.file), Buffer.from('﻿$&\n$1\nseparator\r\n$&\r\n$1\r\n'));
  await f.snapshots.undo(['edit-round']);
  assert.deepEqual(await readFile(f.file), Buffer.from(before));
});

test('Edit keeps whitespace matching exact and leaves a missing target unchanged', async t => {
  const before = 'header\r\n  old\n  line\n';
  const f = await fixture(t, before);
  await assert.rejects(f.edit('old\nline', 'new'), /No match/);
  assert.deepEqual(await readFile(f.file), Buffer.from(before));
  assert.deepEqual(await f.snapshots.undo(['edit-round']), []);
});
