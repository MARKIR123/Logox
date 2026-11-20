import {emitCheckResult, parseCheckArgs} from '../../lib/checks.mjs';
import {gitStatusEntries} from '../../lib/git.mjs';

const {workDir, headless} = await parseCheckArgs();
const checks = [];

// 1. Working tree must remain completely clean (read-only investigation).
// Ignore Logox's own `.logox/` workspace directory (e.g. `.logox/bulletin.md`).
const statusEntries = (await gitStatusEntries(workDir)).filter(
  entry => entry.path !== '.logox' && !entry.path.startsWith('.logox/')
);
const changedFiles = (Array.isArray(headless.changedFiles) ? headless.changedFiles : []).filter(
  p => p !== '.logox' && !String(p).startsWith('.logox/')
);
checks.push({
  name: 'readonly_no_changes',
  pass: statusEntries.length === 0 && changedFiles.length === 0,
  detail: statusEntries.length === 0 && changedFiles.length === 0
    ? 'working directory clean, changedFiles empty'
    : `git status=${statusEntries.map(e => `${e.status} ${e.path}`).join(', ')}; changedFiles=${changedFiles.join(', ')}`,
});

const finalText = typeof headless.final === 'string' ? headless.final : '';

// 2. `final` must be non-empty.
checks.push({
  name: 'final_non_empty',
  pass: finalText.trim().length > 0,
  detail: finalText.trim().length > 0 ? `final length=${finalText.trim().length}` : 'final is empty',
});

// 3. `final` must cite the 3 key locations on the effective chain with line numbers (±1 tolerance).
const expectedChain = [
  {file: 'src/config/env.mjs', lines: [28, 29]},
  {file: 'src/config/loader.mjs', lines: [15, 19]},
  {file: 'src/http/client.mjs', lines: [5, 14]},
];

function matchFileLine(text, file, allowedLines) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}(?::|#L)(\\d+)`, 'g');
  const foundLines = [];
  for (const match of text.matchAll(regex)) {
    const lineNum = Number(match[1]);
    foundLines.push(lineNum);
    if (allowedLines.some(target => Math.abs(lineNum - target) <= 1)) {
      return {ok: true, matched: `${file}:${lineNum}`};
    }
  }
  return {ok: false, foundLines};
}

for (const item of expectedChain) {
  const res = matchFileLine(finalText, item.file, item.lines);
  checks.push({
    name: `cite_${item.file.replace(/[/.]/g, '_')}`,
    pass: res.ok,
    detail: res.ok
      ? `matched ${res.matched}`
      : `expected ${item.file} near lines ${item.lines.join('/')} (±1), found: ${res.foundLines.join(',') || 'none'}`,
  });
}

// 4. `final` must explain the ms vs s unit conversion error in one sentence.
const sentences = finalText.split(/[。！？\n.!?]+/).map(s => s.trim()).filter(Boolean);
const unitSentence = sentences.find(s =>
  (/(?:毫秒|ms)/i.test(s) && /(?:秒|sec|seconds)/i.test(s)) &&
  /(?:错|误|换算|转换|乘|1000|单位|wrong|convert|multipl)/i.test(s)
);
checks.push({
  name: 'unit_conversion_explained',
  pass: Boolean(unitSentence),
  detail: unitSentence ? `matched: ${unitSentence.slice(0, 140)}` : 'no sentence mentioning both ms and seconds with conversion error',
});

// 5. `final` must not affirmatively claim distractor files are the source of the 30s request timeout.
const distractors = ['legacy-timeout.json', 'heartbeat.json'];
const falseAttributions = [];
for (const name of distractors) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}[^\\n。；;]{0,35}(?:是来源|是真实来源|导致了?\\s*30|直接配置了请求超时|生效的请求超时)`, 'g');
  for (const match of finalText.matchAll(regex)) {
    const snippet = match[0];
    if (!/(?:不是|并非|未|没有|无关|干扰|仅用于|并未)/.test(snippet)) {
      falseAttributions.push(snippet);
    }
  }
}
checks.push({
  name: 'no_distractor_false_attribution',
  pass: falseAttributions.length === 0,
  detail: falseAttributions.length === 0
    ? 'no affirmative false attribution to distractor files'
    : `false attribution: ${falseAttributions.join(' | ')}`,
});

emitCheckResult(checks);
