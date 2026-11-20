import {readdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {emitCheckResult, parseCheckArgs} from '../../lib/checks.mjs';
import {runCommand, runNpmTest} from '../../lib/exec.mjs';
import {gitStatusEntries} from '../../lib/git.mjs';

const taskDir = dirname(fileURLToPath(import.meta.url));
const {workDir, headless} = await parseCheckArgs();
const checks = [];

// 1. npm test passes in workDir.
const testRun = await runNpmTest(workDir);
checks.push({
  name: 'tests_pass',
  pass: testRun.code === 0,
  detail: testRun.code === 0 ? 'npm test passed' : `${testRun.stdout}\n${testRun.stderr}`.trim().slice(0, 400),
});

// 2. All 10 rule modules under src/rules/ export new `ruleMeta` + `evaluate`, and no longer export legacy `meta` or `check`.
const rulesDir = join(workDir, 'src', 'rules');
const ruleFiles = (await readdir(rulesDir).catch(() => [])).filter(f => f.endsWith('.mjs')).sort();
const badRules = [];
for (const file of ruleFiles) {
  try {
    const mod = await import(pathToFileURL(join(rulesDir, file)).href + '?t=' + Date.now());
    const metaOk = mod.ruleMeta &&
      typeof mod.ruleMeta.id === 'string' &&
      (mod.ruleMeta.severity === 'error' || mod.ruleMeta.severity === 'warn') &&
      typeof mod.ruleMeta.title === 'string';
    const evalOk = typeof mod.evaluate === 'function';
    const legacyGone = !('check' in mod) && !('meta' in mod);
    if (!metaOk || !evalOk || !legacyGone) {
      badRules.push(`${file}(metaOk=${Boolean(metaOk)},evalOk=${evalOk},legacyGone=${legacyGone})`);
    }
  } catch (err) {
    badRules.push(`${file}(importError=${err instanceof Error ? err.message : String(err)})`);
  }
}
checks.push({
  name: 'rules_migrated_to_v2_interface',
  pass: ruleFiles.length === 10 && badRules.length === 0,
  detail: ruleFiles.length === 10 && badRules.length === 0
    ? 'all 10 rule modules export ruleMeta + evaluate without legacy meta/check'
    : `ruleCount=${ruleFiles.length}; issues=${badRules.join(', ')}`,
});

// 3. Hidden CLI checks against hidden/{good,warn-only,bad}.json.
const cliPath = join(workDir, 'src', 'cli.mjs');
const goodCfg = join(taskDir, 'hidden', 'good.json');
const warnCfg = join(taskDir, 'hidden', 'warn-only.json');
const badCfg = join(taskDir, 'hidden', 'bad.json');

const jsonGood = await runCommand(process.execPath, [cliPath, goodCfg, '--format', 'json'], {cwd: workDir});
let jsonGoodOk = false;
let jsonGoodDetail = '';
if (jsonGood.code === 0) {
  try {
    const parsed = JSON.parse(jsonGood.stdout);
    const validCounts = parsed?.counts &&
      parsed.counts.total === 10 &&
      parsed.counts.passed === 10 &&
      parsed.counts.errors === 0 &&
      parsed.counts.warnings === 0;
    const validFindings = Array.isArray(parsed?.findings) &&
      parsed.findings.length === 10 &&
      parsed.findings.every(f =>
        typeof f.id === 'string' &&
        (f.severity === 'error' || f.severity === 'warn') &&
        typeof f.title === 'string' &&
        f.passed === true &&
        typeof f.details === 'string'
      );
    jsonGoodOk = parsed?.passed === true && Boolean(validCounts) && Boolean(validFindings);
    jsonGoodDetail = jsonGoodOk ? 'valid 10-rule JSON payload on good.json' : `unexpected JSON shape: ${jsonGood.stdout.slice(0, 220)}`;
  } catch (err) {
    jsonGoodDetail = `JSON parse error: ${err instanceof Error ? err.message : String(err)}`;
  }
} else {
  jsonGoodDetail = `expected exit 0, got ${jsonGood.code}: ${jsonGood.stderr || jsonGood.stdout}`;
}
checks.push({name: 'cli_json_good', pass: jsonGoodOk, detail: jsonGoodDetail});

const jsonBad = await runCommand(process.execPath, [cliPath, badCfg, '--format', 'json'], {cwd: workDir});
let jsonBadOk = false;
let jsonBadDetail = '';
if (jsonBad.code !== 0) {
  try {
    const parsed = JSON.parse(jsonBad.stdout);
    jsonBadOk = parsed?.passed === false &&
      parsed?.counts?.total === 10 &&
      parsed?.counts?.errors === 6 &&
      parsed?.counts?.warnings === 4 &&
      Array.isArray(parsed?.findings) &&
      parsed.findings.every(f => f.passed === false);
    jsonBadDetail = jsonBadOk ? 'all 10 rule failures reported with exit!=0' : `unexpected bad.json counts: ${JSON.stringify(parsed?.counts)}`;
  } catch (err) {
    jsonBadDetail = `JSON parse error on bad.json: ${err instanceof Error ? err.message : String(err)}`;
  }
} else {
  jsonBadDetail = 'expected non-zero exit on bad.json';
}
checks.push({name: 'cli_json_bad', pass: jsonBadOk, detail: jsonBadDetail});

const warnNormal = await runCommand(process.execPath, [cliPath, warnCfg, '--format', 'json'], {cwd: workDir});
const warnStrict = await runCommand(process.execPath, [cliPath, warnCfg, '--format', 'json', '--strict'], {cwd: workDir});
let strictOk = false;
try {
  const normalParsed = JSON.parse(warnNormal.stdout);
  const strictParsed = JSON.parse(warnStrict.stdout);
  strictOk = warnNormal.code === 0 &&
    normalParsed.passed === true &&
    normalParsed.counts?.warnings === 4 &&
    warnStrict.code !== 0 &&
    strictParsed.passed === false;
} catch {
  strictOk = false;
}
checks.push({
  name: 'cli_strict_mode',
  pass: strictOk,
  detail: strictOk
    ? 'warn-only passes normally (exit 0) and fails under --strict (exit!=0)'
    : `normalExit=${warnNormal.code}, strictExit=${warnStrict.code}`,
});

const mdRun = await runCommand(process.execPath, [cliPath, badCfg, '--format', 'markdown'], {cwd: workDir});
const mdText = mdRun.stdout.trim();
const mdOk = mdRun.code !== 0 &&
  /^#/m.test(mdText) &&
  ['R01', 'R05', 'R10'].every(id => mdText.includes(id));
checks.push({
  name: 'cli_markdown_report',
  pass: mdOk,
  detail: mdOk ? 'markdown report contains headings and rule IDs' : `exit=${mdRun.code}, len=${mdText.length}`,
});

const defaultRun = await runCommand(process.execPath, [cliPath, goodCfg], {cwd: workDir});
const invalidFmt = await runCommand(process.execPath, [cliPath, goodCfg, '--format', 'xml'], {cwd: workDir});
const defaultOk = defaultRun.code === 0 && defaultRun.stdout.includes('[PASS]') && defaultRun.stdout.includes('R01');
const invalidOk = invalidFmt.code !== 0 && (invalidFmt.stderr + invalidFmt.stdout).trim().length > 0;
checks.push({
  name: 'cli_default_and_invalid_format',
  pass: defaultOk && invalidOk,
  detail: `defaultOk=${defaultOk}, invalidFormatRejected=${invalidOk}`,
});

// 4. README documents --format and --strict, tests updated, and non-empty final report.
const readme = await readFile(join(workDir, 'README.md'), 'utf8').catch(() => '');
const readmeOk = readme.includes('--format') && readme.includes('--strict');
checks.push({
  name: 'readme_updated',
  pass: readmeOk,
  detail: readmeOk ? 'README.md documents --format and --strict' : 'README.md missing --format or --strict',
});

const statusEntries = (await gitStatusEntries(workDir)).filter(
  entry => entry.path !== '.logox' && !entry.path.startsWith('.logox/')
);
const changedTests = statusEntries.filter(entry => entry.path.startsWith('test/') && entry.path.endsWith('.mjs'));
checks.push({
  name: 'tests_added_or_modified',
  pass: changedTests.length > 0 && testRun.code === 0,
  detail: changedTests.length > 0 ? `updated tests: ${changedTests.map(e => e.path).join(', ')}` : 'no test files added or modified',
});

const finalOk = typeof headless.final === 'string' && headless.final.trim().length > 0;
checks.push({
  name: 'final_report_non_empty',
  pass: finalOk,
  detail: finalOk ? `final length=${headless.final.trim().length}` : 'headless.final is empty',
});

emitCheckResult(checks);
