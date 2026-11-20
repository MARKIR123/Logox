import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {emitCheckResult, parseCheckArgs} from '../../lib/checks.mjs';
import {runCommand, runNpmTest} from '../../lib/exec.mjs';
import {gitStatusEntries, hashDirectory} from '../../lib/git.mjs';

const taskDir = dirname(fileURLToPath(import.meta.url));
const {workDir} = await parseCheckArgs();
const checks = [];

// 1. Existing tests must pass via `npm test`.
const testRun = await runNpmTest(workDir);
checks.push({
  name: 'existing_tests_pass',
  pass: testRun.code === 0,
  detail: testRun.code === 0 ? 'npm test passed' : `${testRun.stdout}\n${testRun.stderr}`.trim().slice(0, 400),
});

// 2. Hidden boundary tests must pass.
const hiddenTestFile = join(taskDir, 'hidden', 'edge.test.mjs');
const hiddenRun = await runCommand(process.execPath, ['--test', hiddenTestFile], {
  cwd: taskDir,
  env: {...process.env, TARGET_WORK_DIR: workDir},
});
checks.push({
  name: 'hidden_tests_pass',
  pass: hiddenRun.code === 0,
  detail: hiddenRun.code === 0 ? 'all 6 hidden boundary tests passed' : (hiddenRun.stderr || hiddenRun.stdout).trim().slice(0, 400),
});

// 3. Files under test/ must remain identical to baseline hashes.
const baselineHashes = await hashDirectory(join(taskDir, 'repo', 'test'));
const actualHashes = await hashDirectory(join(workDir, 'test'));
const testMismatch = Object.keys(baselineHashes).length !== Object.keys(actualHashes).length ||
  Object.entries(baselineHashes).some(([rel, hash]) => actualHashes[rel] !== hash);
checks.push({
  name: 'tests_unmodified',
  pass: !testMismatch,
  detail: !testMismatch ? 'test/ matches baseline hashes' : 'test/ files differ from baseline',
});

// 4. Only existing *.mjs source files (outside test/) may be modified; no new files.
// Ignore Logox's own `.logox/` workspace directory (e.g. `.logox/bulletin.md`).
const statusEntries = (await gitStatusEntries(workDir)).filter(
  entry => entry.path !== '.logox' && !entry.path.startsWith('.logox/')
);
const invalidChanges = statusEntries.filter(entry => {
  if (entry.status.includes('?') || entry.status.includes('A') || entry.status.includes('D') || entry.status.includes('R')) {
    return true;
  }
  return !entry.path.endsWith('.mjs') || entry.path.startsWith('test/');
});
checks.push({
  name: 'changes_scoped_to_mjs_sources',
  pass: invalidChanges.length === 0,
  detail: invalidChanges.length === 0
    ? `modified files: ${statusEntries.map(e => e.path).join(', ') || '(none)'}`
    : `disallowed changes: ${invalidChanges.map(e => `${e.status} ${e.path}`).join(', ')}`,
});

emitCheckResult(checks);
