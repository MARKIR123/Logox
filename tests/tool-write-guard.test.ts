import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeWrite, writeSchema} from '../src/tools/WriteTool/WriteTool.js';
import {Snapshots} from '../src/tools/snapshots.js';
import {WRITE_LARGE_FILE_NOTICE} from '../src/tools/WriteTool/prompt.js';

async function fixture(t: TestContext, existing?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-write-guard-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'target.txt');
  if (existing !== undefined) await writeFile(file, existing);
  const snapshots = new Snapshots(join(directory, 'snapshots'));
  const write = (content: string, overwrite?: boolean) => executeWrite(
    writeSchema.parse({file_path: file, content, ...(overwrite === undefined ? {} : {overwrite})}),
    file, snapshots, 'round', new AbortController().signal, 'techne');
  return {file, write};
}

test('Write creates new files of any size without the guard', async t => {
  const f = await fixture(t);
  assert.equal((await f.write('x'.repeat(100 * 1024))).isError, false);
});

test('Write overwrites small existing files freely', async t => {
  const f = await fixture(t, 'small\n');
  await f.write('replaced\n');
  assert.equal(await readFile(f.file, 'utf8'), 'replaced\n');
});

test('Write refuses to replace an existing file over 20 KB and names the escape hatch', async t => {
  const f = await fixture(t, 'x'.repeat(21 * 1024));
  await assert.rejects(f.write('tiny'), error => error instanceof Error && error.message === WRITE_LARGE_FILE_NOTICE);
  assert.match(WRITE_LARGE_FILE_NOTICE, /Edit/);
  assert.match(WRITE_LARGE_FILE_NOTICE, /overwrite: true/);
  assert.equal((await readFile(f.file, 'utf8')).length, 21 * 1024);
});

test('Write refuses to replace an existing file over 400 lines even when small in bytes', async t => {
  const f = await fixture(t, 'a\n'.repeat(401));
  await assert.rejects(f.write('tiny'), /Edit/);
});

test('Write allows existing files at the thresholds', async t => {
  const f = await fixture(t, 'x'.repeat(20 * 1024));
  assert.equal((await f.write('ok')).isError, false);
  const g = await fixture(t, 'a\n'.repeat(399));
  assert.equal((await g.write('ok')).isError, false);
});

test('overwrite: true permits a deliberate wholesale replacement', async t => {
  const f = await fixture(t, 'x'.repeat(30 * 1024));
  await f.write('replacement', true);
  assert.equal(await readFile(f.file, 'utf8'), 'replacement');
});
