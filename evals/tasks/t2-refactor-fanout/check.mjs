import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {emitCheckResult, parseCheckArgs} from '../../lib/checks.mjs';
import {runCommand, runNpmTest} from '../../lib/exec.mjs';

const taskDir = dirname(fileURLToPath(import.meta.url));
const {workDir} = await parseCheckArgs();
const checks = [];

/**
 * Collects all .mjs files recursively under a directory.
 */
async function collectMjs(dir) {
  const out = [];
  const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectMjs(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * Lexical scanner for JS source that strips comments and string/template literal text
 * (while retaining expressions inside `${...}`) and finds standalone `log(` calls.
 */
function findLegacyLogCalls(source) {
  const hits = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const templateStack = [];
  let braceDepth = 0;

  const isIdentChar = ch => /[A-Za-z0-9_$]/.test(ch);

  const scanTemplateText = () => {
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') {
        if (source[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        return;
      }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        templateStack.push(braceDepth);
        braceDepth++;
        return;
      }
      if (ch === '\n') line++;
      i++;
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          if (source[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (source[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      scanTemplateText();
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth--;
      i++;
      if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        scanTemplateText();
      }
      continue;
    }

    if (source.startsWith('log', i)) {
      const prev = i > 0 ? source[i - 1] : '';
      const after = source[i + 3] ?? '';
      if (!isIdentChar(prev) && prev !== '.' && !isIdentChar(after)) {
        let j = i + 3;
        while (j < n && /\s/.test(source[j])) j++;
        if (source[j] === '(') {
          hits.push(line);
        }
      }
    }

    if (ch === '\n') line++;
    i++;
  }
  return hits;
}

// 1. No legacy log(...) calls anywhere in src/ (excluding comments & strings).
const srcFiles = await collectMjs(join(workDir, 'src'));
const remainingCalls = [];
for (const file of srcFiles) {
  const text = await readFile(file, 'utf8');
  const lines = findLegacyLogCalls(text);
  if (lines.length > 0) {
    remainingCalls.push(`${relative(workDir, file).replaceAll('\\', '/')}:${lines.join(',')}`);
  }
}
checks.push({
  name: 'no_legacy_log_calls',
  pass: remainingCalls.length === 0,
  detail: remainingCalls.length === 0
    ? `scanned ${srcFiles.length} source files cleanly`
    : `legacy log( calls found at: ${remainingCalls.join('; ')}`,
});

// 2. logger.mjs no longer exports `log` and still exports `logger`.
let loggerRemoved = false;
let loggerDetail = '';
try {
  const loggerUrl = pathToFileURL(join(workDir, 'src', 'logger.mjs')).href + '?t=' + Date.now();
  const loggerMod = await import(loggerUrl);
  const hasLog = 'log' in loggerMod;
  const hasLogger = typeof loggerMod.logger?.info === 'function' &&
    typeof loggerMod.logger?.warn === 'function' &&
    typeof loggerMod.logger?.error === 'function';
  loggerRemoved = !hasLog && hasLogger;
  loggerDetail = loggerRemoved
    ? 'logger.mjs exports logger.{info,warn,error} and no longer exports log'
    : `hasLog=${hasLog}, hasLogger=${hasLogger}`;
} catch (error) {
  loggerDetail = error instanceof Error ? error.message : String(error);
}
checks.push({
  name: 'logger_legacy_export_removed',
  pass: loggerRemoved,
  detail: loggerDetail,
});

// 3. Preserved comment mentioning `log(` in src/modules/ingest.mjs must remain intact.
const expectedComment = "// Legacy note: callers previously invoked log('info', ...) directly before batching.";
const ingestText = await readFile(join(workDir, 'src', 'modules', 'ingest.mjs'), 'utf8').catch(() => '');
const commentPreserved = ingestText.includes(expectedComment);
checks.push({
  name: 'comment_preserved',
  pass: commentPreserved,
  detail: commentPreserved ? 'ingest.mjs legacy comment preserved verbatim' : 'legacy comment in ingest.mjs was altered or removed',
});

// 4. All existing tests pass via npm test.
const testRun = await runNpmTest(workDir);
checks.push({
  name: 'existing_tests_pass',
  pass: testRun.code === 0,
  detail: testRun.code === 0 ? 'npm test passed' : `${testRun.stdout}\n${testRun.stderr}`.trim().slice(0, 400),
});

// 5. Hidden tests invoking all 12 modules and verifying logger output pass.
const hiddenTestFile = join(taskDir, 'hidden', 'modules-behavior.test.mjs');
const hiddenRun = await runCommand(process.execPath, ['--test', hiddenTestFile], {
  cwd: taskDir,
  env: {...process.env, TARGET_WORK_DIR: workDir},
});
checks.push({
  name: 'hidden_tests_pass',
  pass: hiddenRun.code === 0,
  detail: hiddenRun.code === 0 ? 'all 12 module logger verification tests passed' : (hiddenRun.stderr || hiddenRun.stdout).trim().slice(0, 400),
});

emitCheckResult(checks);
