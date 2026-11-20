import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(rootDir, 'src', 'cli.mjs');

describe('wordfreq CLI', () => {
  it('prints plain-text frequency table sorted by count descending then word ascending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wordfreq-test-'));
    try {
      const sample = join(dir, 'input.txt');
      writeFileSync(sample, 'pear apple banana apple pear apple\n', 'utf8');
      const res = spawnSync(process.execPath, [cliPath, sample], {encoding: 'utf8'});
      assert.equal(res.status, 0);
      assert.equal(res.stdout, 'apple   3\npear    2\nbanana  1\n');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it('prints sorted JSON array when --format json is specified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wordfreq-test-'));
    try {
      const sample = join(dir, 'input.txt');
      writeFileSync(sample, 'pear apple banana apple pear apple\n', 'utf8');
      const res = spawnSync(process.execPath, [cliPath, sample, '--format', 'json'], {encoding: 'utf8'});
      assert.equal(res.status, 0);
      assert.deepEqual(JSON.parse(res.stdout), [
        {word: 'apple', count: 3},
        {word: 'pear', count: 2},
        {word: 'banana', count: 1},
      ]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it('exits non-zero on invalid --format value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wordfreq-test-'));
    try {
      const sample = join(dir, 'input.txt');
      writeFileSync(sample, 'hello\n', 'utf8');
      const res = spawnSync(process.execPath, [cliPath, sample, '--format', 'xml'], {encoding: 'utf8'});
      assert.notEqual(res.status, 0);
      assert.ok((res.stderr + res.stdout).trim().length > 0);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
