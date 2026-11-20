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
});
