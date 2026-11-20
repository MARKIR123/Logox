import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {emitCheckResult, parseCheckArgs} from '../../lib/checks.mjs';
import {runCommand, runNpmTest} from '../../lib/exec.mjs';
import {gitStatusEntries} from '../../lib/git.mjs';

const taskDir = dirname(fileURLToPath(import.meta.url));
const {workDir} = await parseCheckArgs();
const checks = [];

// 1. Existing and added tests pass via npm test.
const testRun = await runNpmTest(workDir);
checks.push({
  name: 'tests_pass',
  pass: testRun.code === 0,
  detail: testRun.code === 0 ? 'npm test passed' : `${testRun.stdout}\n${testRun.stderr}`.trim().slice(0, 400),
});

const cliPath = join(workDir, 'src', 'cli.mjs');
const baselineCliPath = join(taskDir, 'repo', 'src', 'cli.mjs');
const samplePath = join(taskDir, 'hidden', 'sample.txt');

// 2a. Hidden CLI check: --format json outputs sorted [{"word": string, "count": number}].
const jsonRun = await runCommand(process.execPath, [cliPath, samplePath, '--format', 'json'], {cwd: workDir});
let jsonOk = false;
let jsonDetail = '';
if (jsonRun.code !== 0) {
  jsonDetail = `exited with ${jsonRun.code}: ${jsonRun.stderr || jsonRun.stdout}`;
} else {
  try {
    const parsed = JSON.parse(jsonRun.stdout);
    const expected = [
      {word: 'beta', count: 4},
      {word: 'alpha', count: 3},
      {word: 'gamma', count: 2},
      {word: 'delta', count: 1},
      {word: 'zebra', count: 1},
    ];
    const validShape = Array.isArray(parsed) &&
      parsed.length === expected.length &&
      parsed.every((item, idx) =>
        item &&
        typeof item === 'object' &&
        typeof item.word === 'string' &&
        typeof item.count === 'number' &&
        item.word === expected[idx].word &&
        item.count === expected[idx].count
      );
    jsonOk = validShape;
    jsonDetail = validShape
      ? 'valid sorted JSON array with exact word/count entries'
      : `unexpected JSON payload: ${jsonRun.stdout.trim().slice(0, 200)}`;
  } catch (err) {
    jsonDetail = `invalid JSON output: ${err instanceof Error ? err.message : String(err)}`;
  }
}
checks.push({
  name: 'cli_format_json',
  pass: jsonOk,
  detail: jsonDetail,
});

// 2b. Hidden CLI check: default output matches baseline verbatim.
const baselineDefault = await runCommand(process.execPath, [baselineCliPath, samplePath], {cwd: workDir});
const currentDefault = await runCommand(process.execPath, [cliPath, samplePath], {cwd: workDir});
const defaultMatches = currentDefault.code === 0 && currentDefault.stdout === baselineDefault.stdout;
checks.push({
  name: 'cli_default_output_unchanged',
  pass: defaultMatches,
  detail: defaultMatches
    ? 'default CLI output matches baseline verbatim'
    : `exit=${currentDefault.code}; expected=${JSON.stringify(baselineDefault.stdout)} actual=${JSON.stringify(currentDefault.stdout)}`,
});

// 2c. Hidden CLI check: invalid --format exits non-zero with message.
const invalidRun = await runCommand(process.execPath, [cliPath, samplePath, '--format', 'xml'], {cwd: workDir});
const invalidOutput = (invalidRun.stderr + invalidRun.stdout).trim();
const invalidOk = invalidRun.code !== 0 && invalidOutput.length > 0;
checks.push({
  name: 'cli_invalid_format_rejected',
  pass: invalidOk,
  detail: invalidOk
    ? `exited ${invalidRun.code} with message: ${invalidOutput.slice(0, 120)}`
    : `expected non-zero exit with message, got code=${invalidRun.code}, output=${JSON.stringify(invalidOutput)}`,
});

// 3. src/count.mjs exports at least one new symbol beyond countWords, and src/cli.mjs imports & calls it.
let apiAligned = false;
let apiDetail = '';
try {
  const countUrl = pathToFileURL(join(workDir, 'src', 'count.mjs')).href + '?t=' + Date.now();
  const countMod = await import(countUrl);
  const newExports = Object.keys(countMod).filter(name => name !== 'countWords' && typeof countMod[name] === 'function');
  const cliSource = await readFile(cliPath, 'utf8');
  const cleanCli = cliSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const importedNames = new Set();
  const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/count\.mjs['"]/g;
  for (const match of cleanCli.matchAll(namedImportRegex)) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const [orig, alias] = cleaned.split(/\s+as\s+/).map(s => s.trim());
      if (newExports.includes(orig)) {
        importedNames.add(alias || orig);
      }
    }
  }
  const nsImportMatch = cleanCli.match(/import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*['"]\.\/count\.mjs['"]/);
  if (nsImportMatch) {
    const ns = nsImportMatch[1];
    for (const name of newExports) {
      if (new RegExp(`\\b${ns}\\.${name}\\s*\\(`).test(cleanCli)) {
        importedNames.add(`${ns}.${name}`);
      }
    }
  }

  const calledNames = [...importedNames].filter(id => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^.\\w$])${escaped}\\s*\\(`).test(cleanCli);
  });

  apiAligned = newExports.length > 0 && calledNames.length > 0;
  apiDetail = apiAligned
    ? `src/count.mjs new exports=[${newExports.join(', ')}]; src/cli.mjs calls [${calledNames.join(', ')}]`
    : `newExports=[${newExports.join(', ')}], calledByCli=[${calledNames.join(', ')}]`;
} catch (err) {
  apiDetail = err instanceof Error ? err.message : String(err);
}
checks.push({
  name: 'library_and_cli_aligned',
  pass: apiAligned,
  detail: apiDetail,
});

// 4. README.md mentions `--format json`.
const readme = await readFile(join(workDir, 'README.md'), 'utf8').catch(() => '');
const readmeUpdated = readme.includes('--format json');
checks.push({
  name: 'readme_documents_format_json',
  pass: readmeUpdated,
  detail: readmeUpdated ? 'README.md mentions --format json' : 'README.md missing --format json',
});

// 5. At least one test file under test/ was added or modified.
const statusEntries = await gitStatusEntries(workDir);
const changedTests = statusEntries.filter(entry => entry.path.startsWith('test/') && entry.path.endsWith('.mjs'));
checks.push({
  name: 'tests_added_or_modified',
  pass: changedTests.length > 0 && testRun.code === 0,
  detail: changedTests.length > 0
    ? `updated test files: ${changedTests.map(e => e.path).join(', ')}`
    : 'no test file under test/ was added or modified',
});

emitCheckResult(checks);
