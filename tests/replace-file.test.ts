import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replaceFile} from '../src/store/replace-file.js';

test('Windows 暂时共享冲突保留旧值，仅重试原子替换，不重写任务成果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-replace-'));
  try {
    const source = join(directory, 'candidate'), target = join(directory, 'saved');
    await writeFile(source, 'new'); await writeFile(target, 'old');
    let attempts = 0;
    await replaceFile(source, target, async (from, to) => {
      assert.equal(await readFile(to, 'utf8'), 'old');
      if (++attempts < 3) throw Object.assign(new Error('shared'), {code: 'EPERM'});
      await rename(from, to);
    }, true);
    assert.equal(attempts, 3); assert.equal(await readFile(target, 'utf8'), 'new');
    await assert.rejects(readFile(source));
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('永久替换故障有上限，保留原文件；非共享故障和非Windows不盲重试', async () => {
  let attempts = 0;
  const permanent = Object.assign(new Error('denied'), {code: 'EPERM'});
  await assert.rejects(replaceFile('candidate', 'saved', async () => {attempts++; throw permanent;}, true), error => error === permanent);
  assert.equal(attempts, 7);
  for (const [code, windows] of [['ENOENT', true], ['EPERM', false]] as const) {
    attempts = 0;
    await assert.rejects(replaceFile('candidate', 'saved', async () => {attempts++; throw Object.assign(new Error(code), {code});}, windows));
    assert.equal(attempts, 1);
  }
});
