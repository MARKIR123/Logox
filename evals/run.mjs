#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {runCommand} from './lib/exec.mjs';
import {initBaselineRepo} from './lib/git.mjs';
import {computeCompositeScore} from './lib/scoring.mjs';
import {readSessionMetrics} from './lib/session.mjs';
import {projectDataDir} from '../scripts/project-data.mjs';

const evalsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalsDir, '..');
const tasksRoot = join(evalsDir, 'tasks');
const resultsRoot = join(evalsDir, 'results');

function timestampSlug(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

async function discoverTasks(filterSpec) {
  const entries = await readdir(tasksRoot, {withFileTypes: true});
  const ids = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  const tasks = [];
  for (const id of ids) {
    const dir = join(tasksRoot, id);
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    tasks.push({id, dir, meta});
  }
  if (!filterSpec) return tasks;
  const wanted = filterSpec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const selected = tasks.filter(t => wanted.some(w => t.id.toLowerCase() === w || t.id.toLowerCase().startsWith(w + '-')));
  if (selected.length === 0) {
    throw new Error(`No tasks matched --tasks ${filterSpec}. Available: ${tasks.map(t => t.id).join(', ')}`);
  }
  return selected;
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function parseJsonLoose(text) {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    for (const rawLine of cleaned.split(/\r?\n/).reverse()) {
      const line = rawLine.trim();
      const start = line.indexOf('{');
      const end = line.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(line.slice(start, end + 1));
        } catch {
          // Try earlier lines.
        }
      }
    }
    return null;
  }
}

/** The Logox project-data folders a temporary work directory may have been filed under (its path as given and as resolved by the OS). */
function projectDataDirsFor(workDir) {
  const paths = new Set([resolve(workDir)]);
  for (const real of [realpathSync, realpathSync.native]) {
    try { paths.add(real(workDir)); } catch { /* already removed */ }
  }
  return [...new Set([...paths].map(path => projectDataDir(path)))];
}

/**
 * Keeps what Logox wrote about a run beside its result (`logox-data/` = the project-data folder with every session ledger, `logox-project/` = the
 * work directory's `.logox/` with plans and bulletin), so the temporary folders can go.
 */
async function archiveRunData(workDir, taskResultDir) {
  for (const dir of projectDataDirsFor(workDir)) {
    if (existsSync(dir)) await cp(dir, join(taskResultDir, 'logox-data'), {recursive: true});
  }
  const projectLogox = join(workDir, '.logox');
  if (existsSync(projectLogox)) await cp(projectLogox, join(taskResultDir, 'logox-project'), {recursive: true});
}

async function setupWorkDir(taskDir, applySolution = false) {
  const workDir = await mkdtemp(join(tmpdir(), 'logox-eval-'));
  await cp(join(taskDir, 'repo'), workDir, {recursive: true});
  await initBaselineRepo(workDir);
  if (applySolution) {
    const solDir = join(taskDir, 'solution');
    if (existsSync(solDir)) {
      await cp(solDir, workDir, {
        recursive: true,
        filter: src => !src.endsWith('headless.json'),
      });
    }
  }
  return workDir;
}

async function invokeCheck(taskDir, workDir, headlessPath, artifactDir) {
  const checkScript = join(taskDir, 'check.mjs');
  const args = [checkScript, workDir, headlessPath];
  if (artifactDir) args.push(artifactDir);
  const res = await runCommand(process.execPath, args, {
    cwd: taskDir,
    env: {...process.env, ...(artifactDir ? {EVAL_RESULT_DIR: artifactDir} : {})},
  });
  if (res.code !== 0) {
    throw new Error(`check.mjs crashed (exit ${res.code}): ${res.stderr || res.stdout}`);
  }
  const parsed = parseJsonLoose(res.stdout);
  if (!parsed || typeof parsed.pass !== 'boolean' || !Array.isArray(parsed.checks)) {
    throw new Error(`check.mjs returned invalid JSON: ${res.stdout}`);
  }
  return parsed;
}

async function runDryRun(tasks) {
  let allOk = true;
  console.log('Running --dry-run bidirectional verification...\n');

  for (const task of tasks) {
    const baselineDir = await setupWorkDir(task.dir, false);
    const solutionDir = await setupWorkDir(task.dir, true);
    const scratchDir = await mkdtemp(join(tmpdir(), 'logox-eval-dry-'));
    try {
      const emptyHeadlessPath = join(scratchDir, 'empty-headless.json');
      await writeFile(emptyHeadlessPath, JSON.stringify({
        version: 1,
        sessionId: 'dry-baseline',
        status: 'completed',
        final: '',
        changedFiles: [],
        errors: [],
      }), 'utf8');

      const baseRes = await invokeCheck(task.dir, baselineDir, emptyHeadlessPath, scratchDir);
      let baseOk = baseRes.pass === false;
      let baseNote = baseOk ? 'FAIL (expected)' : 'PASS (unexpected!)';
      if (task.id === 't3-investigate-readonly') {
        const finalCheck = baseRes.checks.find(c => c.name === 'final_non_empty');
        if (!finalCheck || finalCheck.pass !== false) {
          baseOk = false;
          baseNote = 'expected final_non_empty=false on baseline';
        }
      }

      const solHeadlessSource = join(task.dir, 'solution', 'headless.json');
      const solHeadlessPath = existsSync(solHeadlessSource)
        ? solHeadlessSource
        : emptyHeadlessPath;
      const solRes = await invokeCheck(task.dir, solutionDir, solHeadlessPath, scratchDir);
      const solOk = solRes.pass === true;
      const solNote = solOk ? 'PASS (expected)' : `FAIL (${solRes.checks.filter(c => !c.pass).map(c => c.name).join(', ')})`;

      const taskOk = baseOk && solOk;
      if (!taskOk) allOk = false;
      console.log(`[${taskOk ? 'OK' : 'ERR'}] ${task.id}`);
      console.log(`  baseline: ${baseNote}`);
      console.log(`  solution: ${solNote}`);
      if (!solOk) {
        for (const c of solRes.checks.filter(x => !x.pass)) {
          console.log(`    - ${c.name}: ${c.detail}`);
        }
      }
    } finally {
      await rm(baselineDir, {recursive: true, force: true});
      await rm(solutionDir, {recursive: true, force: true});
      await rm(scratchDir, {recursive: true, force: true});
    }
  }

  console.log(`\nDry-run summary: ${allOk ? 'ALL PASSED' : 'FAILED'}`);
  process.exitCode = allOk ? 0 : 1;
}

function computeDeviations(meta, headless, session) {
  const expect = meta.expect ?? {};
  const deviations = [];
  const costUsd = headless?.usage?.costUsd;
  if (typeof expect.maxCostUsd === 'number' && typeof costUsd === 'number' && costUsd > expect.maxCostUsd) {
    deviations.push(`cost>${expect.maxCostUsd}`);
  }
  const dispatches = session?.dispatches ?? null;
  if (expect.director === 'direct' && dispatches !== null && dispatches > 0) {
    deviations.push(`director:dispatched(${dispatches})`);
  } else if (expect.director === 'dispatch' && dispatches !== null && dispatches === 0) {
    deviations.push('director:no-dispatch');
  }
  const automaJobs = session?.automa?.jobs ?? headless?.automa?.jobs ?? null;
  if (expect.automa === 'expected' && automaJobs !== null && automaJobs === 0) {
    deviations.push('automa:none');
  } else if (expect.automa === 'unexpected' && automaJobs !== null && automaJobs > 0) {
    deviations.push(`automa:unexpected(${automaJobs})`);
  }
  if (expect.briefCheck === 'expected' && session && session.dispatches > 0) {
    const clearCount = session.briefChecks?.clear ?? 0;
    const skippedCount = session.briefChecks?.skipped ?? 0;
    if (clearCount === 0 && skippedCount > 0) {
      deviations.push(`briefCheck:skipped(${skippedCount})`);
    } else if (clearCount === 0 && (session.briefChecks?.gaps ?? 0) === 0) {
      deviations.push('briefCheck:not-triggered');
    }
  }
  return deviations;
}

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
  return (ms / 1000).toFixed(1) + 's';
}

function fmtCost(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return 'n/a';
  return '$' + usd.toFixed(4);
}

function fmtPct(num, den) {
  if (typeof num !== 'number' || typeof den !== 'number' || den <= 0) return 'n/a';
  return ((num / den) * 100).toFixed(1) + '%';
}

function buildSummaryMarkdown(runMeta, rows, keptDirs) {
  const lines = [
    `# Logox 评测汇总 (${runMeta.runName})`,
    '',
    `- 时间: ${runMeta.startedAt}`,
    `- CLI: \`${runMeta.logoxCli}\``,
    `- Provider / Model: ${runMeta.provider || '(default)'} / ${runMeta.model || '(default)'}`,
    '',
    '| 任务 | 通过 | 得分 (0-100) | 耗时 | 费用 | 输入 / 输出 token | 缓存命中率 | 派工次数 | Automa (读/写) | 派工审查结果 | SendMessage 次数 | 偏离预期 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];

  let passCount = 0;
  let totalScore = 0;
  let scoreCount = 0;
  let totalDuration = 0;
  let totalCost = 0;
  let hasCost = false;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let hasTokens = false;
  let totalDispatches = 0;
  let hasDispatches = false;
  let totalRead = 0;
  let totalCode = 0;
  let hasAutoma = false;
  let totalSend = 0;
  let hasSend = false;
  let totalDeviations = 0;
  const totalBrief = {clear: 0, skipped: 0, failed: 0, gaps: 0};
  let hasBrief = false;

  for (const row of rows) {
    if (row.pass) passCount++;
    if (typeof row.score === 'number') { totalScore += row.score; scoreCount++; }
    if (typeof row.durationMs === 'number') totalDuration += row.durationMs;
    if (typeof row.costUsd === 'number') { totalCost += row.costUsd; hasCost = true; }
    if (typeof row.inputTokens === 'number' && typeof row.outputTokens === 'number') {
      totalInput += row.inputTokens;
      totalOutput += row.outputTokens;
      totalCacheRead += row.cacheReadTokens ?? 0;
      hasTokens = true;
    }
    if (row.session) {
      hasDispatches = true;
      totalDispatches += row.session.dispatches;
      hasAutoma = true;
      totalRead += row.session.automa.byRoute.read ?? 0;
      totalCode += row.session.automa.byRoute.code ?? 0;
      hasSend = true;
      totalSend += row.session.sendMessages.total;
      hasBrief = true;
      totalBrief.clear += row.session.briefChecks.clear;
      totalBrief.skipped += row.session.briefChecks.skipped;
      totalBrief.failed += row.session.briefChecks.failed;
      totalBrief.gaps += row.session.briefChecks.gaps;
    }
    totalDeviations += row.deviations.length;

    const label = row.repeat > 1 ? `${row.taskId} (#${row.runIndex})` : row.taskId;
    const scoreText = typeof row.score === 'number' ? row.score.toFixed(1) : 'n/a';
    const tokensText = typeof row.inputTokens === 'number' ? `${row.inputTokens} / ${row.outputTokens}` : 'n/a';
    const cacheText = fmtPct(row.cacheReadTokens, row.inputTokens);
    const dispatchText = row.session ? `${row.session.dispatches} (${row.session.dispatchedTasksTotal})` : 'n/a';
    const automaText = row.session ? `${row.session.automa.byRoute.read ?? 0} / ${row.session.automa.byRoute.code ?? 0}` : 'n/a';
    const briefText = row.session
      ? `c:${row.session.briefChecks.clear} s:${row.session.briefChecks.skipped} f:${row.session.briefChecks.failed} g:${row.session.briefChecks.gaps}`
      : 'n/a';
    const sendText = row.session ? String(row.session.sendMessages.total) : 'n/a';
    const devText = row.deviations.length ? row.deviations.join(', ') : '-';

    lines.push(`| ${label} | ${row.pass ? 'PASS' : 'FAIL'} | ${scoreText} | ${fmtDuration(row.durationMs)} | ${fmtCost(row.costUsd)} | ${tokensText} | ${cacheText} | ${dispatchText} | ${automaText} | ${briefText} | ${sendText} | ${devText} |`);
  }

  const avgScoreText = scoreCount > 0 ? (totalScore / scoreCount).toFixed(1) : 'n/a';
  lines.push(
    `| **合计 / 均值** | **${passCount}/${rows.length}** | **${avgScoreText}** | **${fmtDuration(totalDuration)}** | **${hasCost ? fmtCost(totalCost) : 'n/a'}** | **${hasTokens ? `${totalInput} / ${totalOutput}` : 'n/a'}** | **${hasTokens ? fmtPct(totalCacheRead, totalInput) : 'n/a'}** | **${hasDispatches ? totalDispatches : 'n/a'}** | **${hasAutoma ? `${totalRead} / ${totalCode}` : 'n/a'}** | **${hasBrief ? `c:${totalBrief.clear} s:${totalBrief.skipped} f:${totalBrief.failed} g:${totalBrief.gaps}` : 'n/a'}** | **${hasSend ? totalSend : 'n/a'}** | **${totalDeviations}** |`
  );

  if (keptDirs.length > 0) {
    lines.push('', '## 保留的临时工作目录 (--keep)', '');
    for (const item of keptDirs) {
      lines.push(`- ${item.label}: \`${item.path}\``);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function resolveSummaryPath(spec) {
  const direct = resolve(spec);
  if (existsSync(join(direct, 'summary.json'))) return join(direct, 'summary.json');
  if (existsSync(direct) && direct.endsWith('.json')) return direct;
  const inResults = join(resultsRoot, spec, 'summary.json');
  if (existsSync(inResults)) return inResults;
  const dirs = await readdir(resultsRoot, {withFileTypes: true}).catch(() => []);
  const matches = dirs
    .filter(d => d.isDirectory() && (d.name === spec || d.name.endsWith('-' + spec)))
    .map(d => d.name)
    .sort();
  if (matches.length > 0) {
    const candidate = join(resultsRoot, matches.at(-1), 'summary.json');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot locate summary.json for "${spec}"`);
}

function aggregateByTask(summary) {
  const map = new Map();
  for (const row of summary.rows ?? []) {
    const list = map.get(row.taskId) ?? [];
    list.push(row);
    map.set(row.taskId, list);
  }
  const agg = new Map();
  for (const [taskId, list] of map) {
    const passRate = list.filter(r => r.pass).length / list.length;
    const scores = list.map(r => r.score).filter(v => typeof v === 'number');
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const costs = list.map(r => r.costUsd).filter(v => typeof v === 'number');
    const avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
    const durs = list.map(r => r.durationMs).filter(v => typeof v === 'number');
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const inTok = list.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
    const cacheRead = list.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);
    const cacheRate = inTok > 0 ? cacheRead / inTok : null;
    agg.set(taskId, {passRate, avgScore, avgCost, avgDur, cacheRate});
  }
  return agg;
}

function formatCompareMetric(a, b, formatter, higherBetter) {
  if (a === null || b === null) return `${a === null ? 'n/a' : formatter(a)} -> ${b === null ? 'n/a' : formatter(b)}`;
  const diff = b - a;
  if (Math.abs(diff) < 1e-9) return `${formatter(a)} -> ${formatter(b)} (=)`;
  const arrow = diff > 0 ? '↑' : '↓';
  const note = higherBetter === undefined ? '' : (diff > 0) === higherBetter ? '' : ' !';
  return `${formatter(a)} -> ${formatter(b)} (${arrow}${note})`;
}

async function runCompare(specA, specB) {
  const pathA = await resolveSummaryPath(specA);
  const pathB = await resolveSummaryPath(specB);
  const sumA = JSON.parse(await readFile(pathA, 'utf8'));
  const sumB = JSON.parse(await readFile(pathB, 'utf8'));
  const mapA = aggregateByTask(sumA);
  const mapB = aggregateByTask(sumB);
  const allTasks = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

  console.log(`Comparing ${sumA.runName} (A) vs ${sumB.runName} (B)\n`);
  console.log('| 任务 | 通过率 | 综合得分 | 平均费用 | 平均耗时 | 缓存命中率 |');
  console.log('|---|---|---|---|---|---|');
  for (const taskId of allTasks) {
    const a = mapA.get(taskId) ?? {passRate: null, avgScore: null, avgCost: null, avgDur: null, cacheRate: null};
    const b = mapB.get(taskId) ?? {passRate: null, avgScore: null, avgCost: null, avgDur: null, cacheRate: null};
    console.log(
      `| ${taskId} | ${formatCompareMetric(a.passRate, b.passRate, v => `${(v * 100).toFixed(0)}%`, true)} | ` +
      `${formatCompareMetric(a.avgScore, b.avgScore, v => v.toFixed(1), true)} | ` +
      `${formatCompareMetric(a.avgCost, b.avgCost, v => `$${v.toFixed(4)}`, false)} | ` +
      `${formatCompareMetric(a.avgDur, b.avgDur, v => `${(v / 1000).toFixed(1)}s`, false)} | ` +
      `${formatCompareMetric(a.cacheRate, b.cacheRate, v => `${(v * 100).toFixed(1)}%`, true)} |`
    );
  }
}

function openLiveLogTerminal(liveLogPath) {
  if (process.platform === 'win32') {
    const psCmd = `$Host.UI.RawUI.WindowTitle = 'Logox Eval Live Log'; Get-Content -Path '${liveLogPath.replace(/'/g, "''")}' -Wait -Tail 50`;
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '""', 'pwsh', '-NoExit', '-Command', psCmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  console.log(`Tail live log in another terminal: tail -f "${liveLogPath}"`);
  return false;
}

async function main() {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      tasks: {type: 'string'},
      repeat: {type: 'string', default: '1'},
      label: {type: 'string'},
      compare: {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
      keep: {type: 'boolean', default: false},
      'open-terminal': {type: 'boolean', default: false},
      quiet: {type: 'boolean', default: false},
      provider: {type: 'string'},
      model: {type: 'string'},
      'base-url': {type: 'string'},
      'auth-file': {type: 'string'},
      logox: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
  });

  if (values.help) {
    console.log(
      'Usage:\n' +
      '  node evals/run.mjs [--tasks t1,t2] [--repeat N] [--label name] [--keep]\n' +
      '                     [--open-terminal] [--quiet] [--provider name] [--model name] [--logox path]\n' +
      '  node evals/run.mjs --dry-run [--tasks t1,t2]\n' +
      '  node evals/run.mjs --compare <runA> <runB>\n'
    );
    return;
  }

  if (values.compare) {
    if (positionals.length < 2) {
      throw new Error('--compare requires two run names or paths: node evals/run.mjs --compare <a> <b>');
    }
    await runCompare(positionals[0], positionals[1]);
    return;
  }

  const tasks = await discoverTasks(values.tasks);

  if (values['dry-run']) {
    await runDryRun(tasks);
    return;
  }

  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error(`--repeat must be a positive integer, got: ${values.repeat}`);
  }

  const logoxCli = resolve(values.logox ?? join(repoRoot, 'dist', 'src', 'cli.js'));
  if (!existsSync(logoxCli)) {
    throw new Error(`Logox CLI not found at ${logoxCli}. Run "npm run build" or specify --logox <path>.`);
  }

  const runName = values.label ? `${timestampSlug()}-${values.label}` : timestampSlug();
  const runDir = join(resultsRoot, runName);
  await mkdir(runDir, {recursive: true});
  const liveLogPath = join(runDir, 'live.log');
  await writeFile(liveLogPath, `# Logox Eval Live Log (${runName})\n`, 'utf8');
  if (values['open-terminal']) {
    openLiveLogTerminal(liveLogPath);
  }

  const rows = [];
  const keptDirs = [];
  const startedAt = new Date().toISOString();

  for (const task of tasks) {
    for (let runIndex = 1; runIndex <= repeat; runIndex++) {
      const tag = repeat > 1 ? `${task.id} (run ${runIndex}/${repeat})` : task.id;
      console.log(`==> Running ${tag}...`);
      await appendFile(liveLogPath, `\n==> Running ${tag} (${new Date().toISOString()})...\n`, 'utf8');
      const taskResultDir = repeat > 1 ? join(runDir, task.id, `run-${runIndex}`) : join(runDir, task.id);
      await mkdir(taskResultDir, {recursive: true});

      const workDir = await setupWorkDir(task.dir, false);
      let keepThisDir = values.keep;
      try {
        const taskFilePath = join(task.dir, 'task.md');
        const cliArgs = [
          logoxCli,
          '--task-file', taskFilePath,
          '--output', 'json',
          '--permission-mode', String(task.meta.permissionMode ?? 'auto'),
          '--timeout', String(task.meta.timeoutMinutes ?? 15),
          '--verbose',
        ];
        if (values.provider) cliArgs.push('--provider', values.provider);
        if (values.model) cliArgs.push('--model', values.model);
        if (values['base-url']) cliArgs.push('--base-url', values['base-url']);
        if (values['auth-file']) cliArgs.push('--auth-file', values['auth-file']);

        let stderrRemainder = '';
        let logWriteChain = Promise.resolve();
        const wallStart = Date.now();
        const runRes = await runCommand(process.execPath, cliArgs, {
          cwd: workDir,
          onStderr: chunk => {
            const text = stderrRemainder + chunk.toString('utf8');
            const parts = text.split(/\r?\n/);
            stderrRemainder = parts.pop() ?? '';
            const prefixed = parts.filter(Boolean).map(line => `[${task.id}] ${line}\n`).join('');
            if (prefixed) {
              if (!values.quiet) process.stdout.write(prefixed);
              logWriteChain = logWriteChain.then(() => appendFile(liveLogPath, prefixed, 'utf8')).catch(() => {});
            }
          },
        });
        if (stderrRemainder.trim()) {
          const tailLine = `[${task.id}] ${stderrRemainder.trim()}\n`;
          if (!values.quiet) process.stdout.write(tailLine);
          logWriteChain = logWriteChain.then(() => appendFile(liveLogPath, tailLine, 'utf8')).catch(() => {});
        }
        await logWriteChain;
        const wallMs = Date.now() - wallStart;

        const headlessPath = join(taskResultDir, 'headless.json');
        const progressPath = join(taskResultDir, 'progress.log');
        await writeFile(progressPath, runRes.stderr, 'utf8');

        let headless = parseJsonLoose(runRes.stdout);
        if (!headless) {
          headless = {
            version: 1,
            sessionId: null,
            status: 'failed',
            durationMs: wallMs,
            final: '',
            usage: null,
            changedFiles: [],
            errors: [`Logox exited with code ${runRes.code}: ${(runRes.stderr || runRes.stdout).trim().slice(0, 400)}`],
          };
        }
        await writeFile(headlessPath, JSON.stringify(headless, null, 2) + '\n', 'utf8');

        const checkResult = await invokeCheck(task.dir, workDir, headlessPath, taskResultDir);
        await writeFile(join(taskResultDir, 'check.json'), JSON.stringify(checkResult, null, 2) + '\n', 'utf8');

        const sessionMetrics = await readSessionMetrics(workDir, headless.sessionId).catch(() => null);
        await writeFile(join(taskResultDir, 'session.json'), JSON.stringify(sessionMetrics, null, 2) + '\n', 'utf8');

        const deviations = computeDeviations(task.meta, headless, sessionMetrics);
        const usage = headless.usage ?? {};
        const durationMs = typeof headless.durationMs === 'number' ? headless.durationMs : wallMs;
        const scored = computeCompositeScore({
          meta: task.meta,
          checkResult,
          headless,
          session: sessionMetrics,
          durationMs,
        });
        const row = {
          taskId: task.id,
          runIndex,
          repeat,
          pass: checkResult.pass,
          score: scored.total,
          scoreBreakdown: scored.breakdown,
          logoxExitCode: runRes.code,
          logoxStatus: headless.status ?? null,
          durationMs,
          costUsd: typeof usage.costUsd === 'number' ? usage.costUsd : null,
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
          cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : null,
          cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : null,
          session: sessionMetrics,
          deviations,
          workDir: keepThisDir ? workDir : null,
        };
        rows.push(row);

        const doneLine = `    ${row.pass ? 'PASS' : 'FAIL'} (score=${row.score.toFixed(1)}, ${fmtDuration(row.durationMs)}, cost=${fmtCost(row.costUsd)})`;
        console.log(doneLine);
        await appendFile(liveLogPath, doneLine + '\n', 'utf8');
        if (keepThisDir) {
          keptDirs.push({label: tag, path: workDir});
        }
      } finally {
        if (!keepThisDir) {
          for (const dir of projectDataDirsFor(workDir)) await rm(dir, {recursive: true, force: true});
          await rm(workDir, {recursive: true, force: true});
        }
      }
    }
  }

  const runMeta = {
    runName,
    startedAt,
    finishedAt: new Date().toISOString(),
    logoxCli,
    provider: values.provider ?? null,
    model: values.model ?? null,
    repeat,
  };
  const summary = {...runMeta, rows};
  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  const md = buildSummaryMarkdown(runMeta, rows, keptDirs);
  await writeFile(join(runDir, 'summary.md'), md, 'utf8');

  console.log(`\nResults written to ${runDir}`);
  console.log('\n' + md);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
