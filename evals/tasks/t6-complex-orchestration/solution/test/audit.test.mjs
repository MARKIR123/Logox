import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ALL_RULES, auditConfig} from '../src/engine.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(rootDir, 'src', 'cli.mjs');

describe('config auditor v2', () => {
  it('exposes ruleMeta and evaluate on all 10 rule plugins', () => {
    assert.equal(ALL_RULES.length, 10);
    for (const rule of ALL_RULES) {
      assert.equal(typeof rule.ruleMeta?.id, 'string');
      assert.ok(['error', 'warn'].includes(rule.ruleMeta?.severity));
      assert.equal(typeof rule.ruleMeta?.title, 'string');
      assert.equal(typeof rule.evaluate, 'function');
      assert.equal('check' in rule, false);
    }
  });

  it('audits sample-good and sample-bad configs', () => {
    const good = JSON.parse(readFileSync(join(rootDir, 'config', 'sample-good.json'), 'utf8'));
    const bad = JSON.parse(readFileSync(join(rootDir, 'config', 'sample-bad.json'), 'utf8'));
    const goodRes = auditConfig(good);
    assert.equal(goodRes.passed, true);
    assert.equal(goodRes.counts.errors, 0);
    const badRes = auditConfig(bad);
    assert.equal(badRes.passed, false);
    assert.ok(badRes.counts.errors > 0);
  });

  it('supports --format json, --format markdown, and --strict via CLI', () => {
    const goodFile = join(rootDir, 'config', 'sample-good.json');
    const jsonRes = spawnSync(process.execPath, [cliPath, goodFile, '--format', 'json'], {encoding: 'utf8'});
    assert.equal(jsonRes.status, 0);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.passed, true);
    assert.equal(parsed.counts.total, 10);

    const mdRes = spawnSync(process.execPath, [cliPath, goodFile, '--format', 'markdown'], {encoding: 'utf8'});
    assert.equal(mdRes.status, 0);
    assert.ok(mdRes.stdout.includes('# Configuration Audit Report'));

    const dir = mkdtempSync(join(tmpdir(), 'auditor-warn-'));
    try {
      const warnCfg = JSON.parse(readFileSync(goodFile, 'utf8'));
      warnCfg.host = '0.0.0.0';
      const warnFile = join(dir, 'warn.json');
      writeFileSync(warnFile, JSON.stringify(warnCfg), 'utf8');

      const normal = spawnSync(process.execPath, [cliPath, warnFile, '--format', 'json'], {encoding: 'utf8'});
      assert.equal(normal.status, 0);

      const strict = spawnSync(process.execPath, [cliPath, warnFile, '--format', 'json', '--strict'], {encoding: 'utf8'});
      assert.notEqual(strict.status, 0);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
