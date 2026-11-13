// Shared analysis of request fingerprints (`<session>/requests/<actor>.fingerprints.jsonl`, written by src/providers/fingerprint.ts).
// Used by scripts/cache-report.mjs and by the [Cache] section of scripts/score-session.mjs.
//
// Definitions:
//   Block        One unit of the request prefix in send order: the tool list, each system block, then every message block.
//   Pair         Two consecutive requests of one actor whose purpose is `task` (a failed request, one with an error result, is skipped).
//   Pure append  The later request starts with every block of the earlier one, so a provider prompt cache can extend the entry.
//   Miss         A request whose usage reports cacheRead below 5% of input while input is at least 1024 tokens (smaller prompts are not cached).
//   Miss class   prefix changed: the pair is not a pure append (the first differing block is named).
//                fields changed: pure append, but a cache-relevant request field differs (model, protocol, thinking, retention, ttl, cache key, discovery).
//                idle: pure append, same fields, and the gap since the previous request of any purpose is longer than that request's recorded cache lifetime.
//                unexplained: pure append, same fields, short gap: the provider dropped the entry.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

export const MISS_RATIO = 0.05;
export const MIN_CACHED_INPUT = 1024;
const SUFFIX = '.fingerprints.jsonl';
/** Request fields compared between a pair; `maxTokens` and `stream` are recorded but never change a cache entry (a budget derived from them shows up in `thinking`). */
const CACHE_FIELDS = ['thinking', 'retention', 'ttlMs', 'cacheKey', 'discovery'];
const CATEGORIES = ['tools', 'system', 'user', 'assistantText', 'thinking', 'toolArgs', 'context'];

function readLines(file) {
  let text;
  try {text = readFileSync(file, 'utf8');} catch {return [];}
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {rows.push(JSON.parse(line));} catch {/* torn line */}
  }
  return rows;
}

/** Fingerprint requests per actor with their result line attached; null when the session has no fingerprint file. */
export function readFingerprints(sessionDir) {
  const dir = join(sessionDir, 'requests');
  if (!existsSync(dir)) return null;
  const actors = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(SUFFIX)) continue;
    const rows = readLines(join(dir, name));
    const results = new Map(rows.filter(row => row.kind === 'result').map(row => [row.id, row]));
    const requests = rows.filter(row => row.kind === 'request' && Array.isArray(row.messages) && row.sizes).map(row => ({...row, result: results.get(row.id)}));
    if (requests.length) actors[name.slice(0, -SUFFIX.length)] = requests;
  }
  return Object.keys(actors).length ? actors : null;
}

/** The prefix of a request as comparable blocks: tools, system blocks, then messages, each with the estimated tokens it carries. */
export function blocksOf(request) {
  const system = request.system ?? [];
  return [
    {key: 'tools:' + request.tools, label: 'tools', tokens: request.sizes.tools ?? 0},
    ...system.map((hash, index) => ({key: 'system' + index + ':' + hash, label: system.length > 1 ? 'system[' + index + ']' : 'system', tokens: Math.round((request.sizes.system ?? 0) / system.length)})),
    ...request.messages.map(([hash, tokens, label], index) => ({key: 'm:' + hash, label: 'msg#' + index + ' ' + label, tokens})),
  ];
}

/** How the later request relates to the earlier one: kept blocks, pure append, first differing block and the tokens from there on. */
export function comparePrefix(previous, current) {
  const a = blocksOf(previous), b = blocksOf(current);
  let kept = 0;
  while (kept < a.length && kept < b.length && a[kept].key === b[kept].key) kept++;
  const pure = kept === a.length;
  const tokensAfter = b.slice(kept).reduce((total, block) => total + block.tokens, 0);
  let firstDiff = null;
  if (!pure) {
    const before = a[kept].label, after = b[kept]?.label;
    firstDiff = {index: kept, label: after === undefined ? 'truncated, dropped ' + before : before === after ? after : before + ' -> ' + after};
  }
  return {kept, total: a.length, pure, firstDiff, tokensAfter};
}

const changedFields = (previous, current) => {
  const names = [];
  for (const name of CACHE_FIELDS) if (JSON.stringify(previous.fields?.[name]) !== JSON.stringify(current.fields?.[name])) names.push(name);
  for (const name of ['model', 'protocol']) if (previous[name] !== current[name]) names.push(name);
  return names;
};
const usageOf = request => request.result?.usage;
/** True when the usage shows an (almost) empty cache read on a prompt big enough to be cached. */
export function isMiss(request) {
  const usage = usageOf(request);
  return !!usage && typeof usage.cacheRead === 'number' && usage.input >= MIN_CACHED_INPUT && usage.cacheRead < usage.input * MISS_RATIO;
}

/** Analyzes the requests of one actor in file order. */
export function analyzeActor(requests) {
  const ok = requests.filter(request => !request.result?.error);
  const task = ok.filter(request => request.purpose === 'task');
  const pairs = [];
  const classes = {'prefix changed': 0, 'fields changed': 0, idle: 0, unexplained: 0};
  for (let index = 1; index < task.length; index++) {
    const previous = task[index - 1], current = task[index];
    const compared = comparePrefix(previous, current);
    const usage = usageOf(current);
    const row = {id: current.id, time: current.time, activityId: current.activityId, purpose: current.purpose, ...compared,
      input: usage?.input ?? null, cacheRead: usage?.cacheRead ?? null, miss: isMiss(current), class: null, detail: null};
    if (row.miss) {
      const fields = changedFields(previous, current);
      const earlier = ok[ok.indexOf(current) - 1] ?? previous;
      const gap = current.time - earlier.time, lifetime = earlier.fields?.ttlMs;
      if (!compared.pure) {row.class = 'prefix changed'; row.detail = 'block ' + compared.firstDiff.index;}
      else if (fields.length) {row.class = 'fields changed'; row.detail = fields.join(', ');}
      else if (typeof lifetime === 'number' && gap > lifetime) {row.class = 'idle'; row.detail = Math.round(gap / 1000) + 's gap, lifetime ' + Math.round(lifetime / 1000) + 's';}
      else {row.class = 'unexplained'; row.detail = Math.round(gap / 1000) + 's gap';}
      classes[row.class]++;
    }
    pairs.push(row);
  }
  const billed = ok.filter(request => typeof usageOf(request)?.cacheRead === 'number');
  const inputBilled = billed.reduce((total, request) => total + usageOf(request).input, 0);
  const sizeAverage = Object.fromEntries([...CATEGORIES, 'images', 'toolResults', 'total'].map(name => [name, 0]));
  const byTool = {};
  let largest;
  for (const request of ok) {
    const sizes = request.sizes;
    for (const name of CATEGORIES) sizeAverage[name] += sizes[name] ?? 0;
    sizeAverage.images += sizes.images?.tokens ?? 0;
    for (const [tool, tokens] of Object.entries(sizes.toolResults ?? {})) {byTool[tool] = (byTool[tool] ?? 0) + tokens; sizeAverage.toolResults += tokens;}
    sizeAverage.total += sizes.total ?? 0;
    if (!largest || (sizes.total ?? 0) > (largest.sizes.total ?? 0)) largest = request;
  }
  const count = ok.length || 1;
  for (const name of Object.keys(sizeAverage)) sizeAverage[name] = Math.round(sizeAverage[name] / count);
  for (const name of Object.keys(byTool)) byTool[name] = Math.round(byTool[name] / count);
  const pure = pairs.filter(pair => pair.pure).length;
  return {
    summary: {requests: requests.length, task: task.length, keepalive: requests.filter(request => request.purpose === 'keepalive').length,
      failed: requests.length - ok.length, pairs: pairs.length, pureAppend: pure, pureAppendShare: pairs.length ? pure / pairs.length : null,
      cacheReadShare: inputBilled ? billed.reduce((total, request) => total + usageOf(request).cacheRead, 0) / inputBilled : null,
      misses: classes, missCount: pairs.filter(pair => pair.miss).length,
      sizeAverage: {...sizeAverage, toolResultsByTool: byTool},
      largest: largest ? {id: largest.id, time: largest.time, messages: largest.messages.length, sizes: largest.sizes} : null},
    pairs,
  };
}

/** Analysis of every actor of a session; null when no fingerprint file exists. */
export function analyzeSession(sessionDir) {
  const actors = readFingerprints(sessionDir);
  if (!actors) return null;
  return Object.fromEntries(Object.entries(actors).map(([actor, requests]) => [actor, analyzeActor(requests)]));
}

const pct = value => value === null || value === undefined ? 'n/a' : Math.round(value * 100) + '%';
const clock = time => new Date(time).toISOString().slice(11, 19);
const sizesText = sizes => ['total ' + sizes.total, 'tools ' + sizes.tools, 'system ' + sizes.system, 'user ' + sizes.user, 'assistant ' + sizes.assistantText,
  'thinking ' + sizes.thinking, 'tool-args ' + sizes.toolArgs, 'tool-results ' + (typeof sizes.toolResults === 'number' ? sizes.toolResults : Object.values(sizes.toolResults ?? {}).reduce((a, b) => a + b, 0)),
  'images ' + (typeof sizes.images === 'number' ? sizes.images : sizes.images?.tokens ?? 0), 'context ' + sizes.context].join(' | ');

/** Plain-text report for one analyzed session. `all` lists every pair; otherwise only pairs that are not pure appends or that missed. */
export function renderReport(analysis, {all = false, dir = ''} = {}) {
  const out = ['Cache report' + (dir ? ': ' + dir : ''), 'Sizes are estimated tokens. A miss is cacheRead < 5% of input on a prompt of at least ' + MIN_CACHED_INPUT + ' tokens.'];
  for (const [actor, {summary, pairs}] of Object.entries(analysis)) {
    out.push('', '[' + actor + '] ' + summary.requests + ' requests (task ' + summary.task + ', keepalive ' + summary.keepalive + (summary.failed ? ', failed ' + summary.failed : '') + ')');
    out.push('  pure append ' + pct(summary.pureAppendShare) + ' (' + summary.pureAppend + '/' + summary.pairs + ' pairs) | cache read ' + pct(summary.cacheReadShare) + ' of input');
    const m = summary.misses;
    out.push('  misses ' + summary.missCount + ': prefix changed ' + m['prefix changed'] + ', idle ' + m.idle + ', fields changed ' + m['fields changed'] + ', unexplained ' + m.unexplained);
    out.push('  average  ' + sizesText(summary.sizeAverage));
    const topTools = Object.entries(summary.sizeAverage.toolResultsByTool).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, tokens]) => name + ' ' + tokens).join(', ');
    if (topTools) out.push('  tool results (avg): ' + topTools);
    if (summary.largest) out.push('  largest  ' + sizesText(summary.largest.sizes) + ' (' + summary.largest.messages + ' messages, ' + clock(summary.largest.time) + ')');
    const rows = (all ? pairs : pairs.filter(pair => !pair.pure || pair.miss)).map(pair => [
      clock(pair.time), pair.kept + '/' + pair.total, pair.pure ? 'yes' : 'no', pair.firstDiff ? 'block ' + pair.firstDiff.index + ' ' + pair.firstDiff.label : '-',
      String(pair.tokensAfter), pair.cacheRead === null ? 'n/a' : pair.input ? pct(pair.cacheRead / pair.input) : '0%', pair.class ? pair.class + ' (' + pair.detail + ')' : '']);
    if (rows.length) {
      const head = ['time', 'kept', 'pure', 'first difference', 'tokens after', 'cache', 'miss class'];
      const widths = head.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
      const line = cells => '  ' + cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
      out.push(line(head), ...rows.map(line));
    } else out.push('  (every pair is a pure append and none missed)');
  }
  return out.join('\n');
}
