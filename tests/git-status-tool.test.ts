import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  executeGitStatus,
  gitStatusSchema,
} from '../src/tools/protocol/_GitStatusTool/_GitStatusTool.js';
import {meta} from '../src/tools/protocol/_GitStatusTool/meta.js';
import {UI} from '../src/tools/protocol/_GitStatusTool/UI.js';

test('_GitStatus meta and UI conform to silent protocol tool specs', () => {
  assert.equal(meta.name, '_GitStatus');
  assert.equal(meta.category, 'protocol');
  assert.equal(meta.roles, 'all');
  assert.equal(meta.promptVisibility, 'explicit');
  assert.equal(meta.terminalVisibility, 'silent');
  assert.equal(UI.visibility, 'hidden');
});

test('executeGitStatus returns graceful message for non-git directory', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-non-git-'));
  try {
    const result = await executeGitStatus({}, tempDir);
    assert.equal(result.isError, false);
    assert.ok(result.text.includes('Not a git repository'));
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('executeGitStatus returns branch and status in real git directory', async () => {
  const result = await executeGitStatus({mode: 'compact'}, process.cwd());
  assert.equal(result.isError, false);
  assert.ok(result.text.includes('Branch'));
});

test('executeGitStatus validates arguments using gitStatusSchema', () => {
  const valid = gitStatusSchema.safeParse({mode: 'detailed'});
  assert.equal(valid.success, true);

  const invalid = gitStatusSchema.safeParse({mode: 'unsupported-mode'});
  assert.equal(invalid.success, false);
});
