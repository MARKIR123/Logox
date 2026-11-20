import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runAudit} from '../src/engine.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('config auditor baseline', () => {
  it('passes on sample-good.json', () => {
    const cfg = JSON.parse(readFileSync(join(rootDir, 'config', 'sample-good.json'), 'utf8'));
    const audit = runAudit(cfg);
    assert.equal(audit.ok, true);
    assert.equal(audit.results.length, 10);
  });

  it('flags failures on sample-bad.json', () => {
    const cfg = JSON.parse(readFileSync(join(rootDir, 'config', 'sample-bad.json'), 'utf8'));
    const audit = runAudit(cfg);
    assert.equal(audit.ok, false);
    assert.ok(audit.results.some(r => !r.valid && r.level === 'error'));
  });
});
