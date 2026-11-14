#!/usr/bin/env node
// Regenerates src/providers/model-table.generated.ts from the public `@oh-my-pi/pi-catalog` model catalog (MIT).
// SECURITY: the package is untrusted data. It is only downloaded (`npm pack`, never `npm install`) and its `src/models.json` and
// `LICENSE` are read as plain text/JSON. No file from the package is imported, required or executed, and its own decoder is not used:
// the compact encoding is decoded here by `decodeCatalog()`.
//
//   node scripts/sync-model-table.mjs                    # pinned version
//   node scripts/sync-model-table.mjs --latest           # newest published version
//   node scripts/sync-model-table.mjs --version 18.20.0
//   node scripts/sync-model-table.mjs --from <dir>       # use an already extracted package directory (offline)
//   node scripts/sync-model-table.mjs --check            # exit 1 when the committed file is out of date
import {execFileSync, execSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const PACKAGE = '@oh-my-pi/pi-catalog';
export const PINNED_VERSION = '18.20.0';
/** Catalog providers LOGOX can meaningfully resolve against: first-party vendors, ChatGPT/Copilot subscriptions, the OpenRouter gateway and the Antigravity proxy's own catalog. */
export const KEEP_PROVIDERS = ['anthropic', 'deepseek', 'github-copilot', 'google', 'google-antigravity', 'google-vertex', 'minimax', 'mistral', 'moonshotai',
  'openai', 'openai-codex', 'openrouter', 'xai', 'zai'];
/** LOGOX catalog name -> the provider name upstream uses, where the two differ. */
export const UPSTREAM_NAMES = {moonshotai: 'moonshot'};
/** Providers billed through a subscription, so token prices are API-equivalent estimates rather than charges. */
export const SUBSCRIPTION_PROVIDERS = ['github-copilot', 'openai-codex'];
const FALLBACK_COPYRIGHT = 'Copyright (c) 2025-2026 Can Bölük';
const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Upstream marks "since forever" with the smallest Date; anything earlier than this counts as the base card. */
const FOREVER = -1e14;

/**
 * Decodes the compact `models.json` encoding into plain model objects (`{id, provider, ...fields}`).
 * Value: a primitive, or `[id]` referencing `nodes[id]` (`[-1]` = undefined). Node: `[1, items]` (array) or
 * `[0, pairs, shapeIndex, maskWords]` (object: alternating key index and value, then the booleans of `booleanShapes[shapeIndex]` from the mask bits).
 * Provider: `[name, encodedConstants, rows]`; row: `[id, [nodeIndex], delta?]` (delta only carries wire compat data and is ignored).
 */
export function decodeCatalog(raw) {
  const {keys, booleanShapes, nodes, providers} = raw;
  const cache = new Map();
  const fill = (target, node) => {
    const pairs = node[1];
    for (let i = 0; i < pairs.length; i += 2) target[keys[pairs[i]]] = decode(pairs[i + 1]);
    const shape = booleanShapes[node[2]], mask = node[3];
    for (let i = 0; i < shape.length; i++) target[keys[shape[i]]] = ((mask[i >>> 5] >>> (i % 32)) & 1) !== 0;
  };
  const decode = value => {
    if (!Array.isArray(value)) return value;
    const id = value[0];
    if (id === -1) return undefined;
    if (cache.has(id)) return cache.get(id);
    const node = nodes[id];
    let result;
    if (node[0] === 1) result = node[1].map(decode);
    else {result = {}; fill(result, node);}
    cache.set(id, result);
    return result;
  };
  const models = [];
  for (const [name, constants, rows] of providers) {
    const base = decode(constants) ?? {};
    for (const row of rows) {
      const model = {id: row[0], ...base};
      fill(model, nodes[row[1][0]]);
      model.provider = name;
      models.push(model);
    }
  }
  return models;
}

/** Reasoning levels offered by a model: its upstream efforts in a fixed order, plus `off` unless effort is mandatory; `fixed` = reasons but has no control; '' = not a reasoning model. */
export function thinkingLevels(model) {
  if (!model.reasoning) return [];
  const efforts = Array.isArray(model.thinking?.efforts) ? model.thinking.efforts.filter(level => LEVEL_ORDER.includes(level)) : [];
  if (efforts.length === 0) return ['fixed'];
  const levels = new Set(efforts);
  if (!model.thinking?.requiresEffort) levels.add('off');
  return LEVEL_ORDER.filter(level => levels.has(level));
}
const rate = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const card = cost => [rate(cost.input), rate(cost.output), rate(cost.cacheRead), rate(cost.cacheWrite)];
/** One compact tuple per model: [id, name, window, maxOutput (0 = unknown), input modalities, reasoning levels ('' = not a reasoning model), [input, output, cacheRead, cacheWrite], tiers?, dated?]. */
export function trimModel(model) {
  const cost = model.cost ?? {};
  const cards = (Array.isArray(cost.timeBased?.effectiveRates) ? cost.timeBased.effectiveRates : []).filter(item => typeof item.effectiveFrom === 'number')
    .sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  const base = cards.length > 0 ? cards[0] : cost;
  // Peak/off-peak tariffs (`peakWindows`, `offPeakMultiplier`) are deliberately ignored: only the list price is kept.
  const row = [model.id, model.name ?? model.id, model.contextWindow, Number.isFinite(model.maxTokens) ? model.maxTokens : 0, (model.input ?? ['text']).join(','),
    thinkingLevels(model).join(','), card(base)];
  const long = cost.longContext;
  const tiers = long && typeof long.inputThreshold === 'number' ? [[long.inputThreshold, ...card(long)]] : [];
  const dated = cards.slice(1).filter(item => item.effectiveFrom > FOREVER).map(item => [item.effectiveFrom, ...card(item)]);
  if (tiers.length > 0 || dated.length > 0) row.push(tiers);
  if (dated.length > 0) row.push(dated);
  return row;
}
/** Keeps models with a context window, by id (later rows win). */
export function chatModels(models) {
  const byId = new Map();
  for (const model of models) {
    if (model && typeof model.id === 'string' && Number.isFinite(model.contextWindow) && model.contextWindow > 0) byId.set(model.id, model);
  }
  return byId;
}
/** Pure transform: `models` is the decoded upstream list. Output order and formatting are deterministic. */
export function buildTable(models, meta, keep = KEEP_PROVIDERS, upstream = UPSTREAM_NAMES) {
  const providers = {};
  for (const name of [...keep].sort()) {
    const source = upstream[name] ?? name;
    const rows = [...chatModels(models.filter(model => model.provider === source)).values()]
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(trimModel);
    if (rows.length > 0) providers[name] = {subscription: SUBSCRIPTION_PROVIDERS.includes(name), models: rows};
  }
  return {source: meta.source, version: meta.version, providers};
}
export function renderTable(table, copyright = FALLBACK_COPYRIGHT) {
  const providerLines = Object.entries(table.providers).map(([name, entry]) =>
    '    ' + JSON.stringify(name) + ': {subscription: ' + entry.subscription + ', models: [\n' + entry.models.map(row => '      ' + JSON.stringify(row)).join(',\n') + ',\n    ]},');
  return [
    '// GENERATED by scripts/sync-model-table.mjs. Do not edit; run `npm run sync:models` to refresh.',
    '// Source: ' + table.source + '@' + table.version + '.',
    '// The upstream package is MIT licensed. ' + copyright.replace(/\.$/, '') + '. Permission is hereby granted, free of charge, to any person obtaining',
    '// a copy of this data to deal in it without restriction, subject to the MIT notice (https://opensource.org/license/mit).',
    '// Prices are USD per 1M tokens; windows and limits are tokens. Row layout is documented by ModelRow in model-table.ts.',
    "import type {ModelTableData} from './model-table.js';",
    '',
    'export const modelTableData: ModelTableData = {',
    '  source: ' + JSON.stringify(table.source) + ',',
    '  version: ' + JSON.stringify(table.version) + ',',
    '  providers: {',
    ...providerLines,
    '  },',
    '};',
    '',
  ].join('\n');
}
/** Copyright lines of an MIT LICENSE text, joined; falls back to the known holder. */
export function copyrightOf(license) {
  const lines = String(license ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => /^Copyright \(c\) /.test(line));
  return lines.length > 0 ? lines.join('; ') : FALLBACK_COPYRIGHT;
}
/** Reads the extracted package's `src/models.json` and `LICENSE` as data. */
export function readPackage(directory) {
  const raw = JSON.parse(readFileSync(join(directory, 'src', 'models.json'), 'utf8'));
  if (raw.version !== 1) throw new Error('Unsupported catalog encoding version: ' + raw.version);
  let license = '';
  try {license = readFileSync(join(directory, 'LICENSE'), 'utf8');} catch {}
  const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
  return {models: decodeCatalog(raw), meta: {source: PACKAGE, version}, copyright: copyrightOf(license)};
}
function pack(version, work) {
  if (!/^(latest|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(version)) throw new Error('Invalid version: ' + version);
  const out = execSync('npm pack ' + PACKAGE + '@' + version + ' --silent', {cwd: work, encoding: 'utf8'}).trim().split(/\r?\n/).at(-1);
  const extract = join(work, 'x');
  mkdirSync(extract);
  execFileSync('tar', ['-xzf', out, '-C', 'x'], {cwd: work}); // relative paths: GNU tar reads "C:" as a remote host
  return join(extract, 'package');
}
async function main() {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = resolve(option('--out') ?? join(root, 'src', 'providers', 'model-table.generated.ts'));
  let directory = option('--from'), work;
  if (!directory) {
    work = mkdtempSync(join(tmpdir(), 'logox-model-sync-'));
    directory = pack(args.includes('--latest') ? 'latest' : option('--version') ?? PINNED_VERSION, work);
  }
  try {
    const {models, meta, copyright} = readPackage(resolve(directory));
    const table = buildTable(models, meta);
    const text = renderTable(table, copyright);
    if (args.includes('--check')) {
      let current = '';
      try {current = readFileSync(target, 'utf8');} catch {}
      if (current !== text) {console.error('model-table.generated.ts is out of date for ' + meta.version); process.exitCode = 1;}
      return;
    }
    writeFileSync(target, text);
    const counts = Object.entries(table.providers).map(([name, entry]) => name + ' ' + entry.models.length);
    console.log('Wrote ' + target + ' (' + meta.source + '@' + meta.version + ', ' + Object.values(table.providers).reduce((sum, entry) => sum + entry.models.length, 0) + ' models, ' + Buffer.byteLength(text) + ' bytes)');
    console.log('Rows per provider: ' + counts.join(', '));
    const dated = Object.entries(table.providers).flatMap(([name, entry]) => entry.models.filter(row => row[8]).map(row => name + '/' + row[0] + ' from ' + new Date(row[8][0][0]).toISOString().slice(0, 10)));
    if (dated.length > 0) console.warn('Dated rate cards (priced by the card in force when the cost is computed): ' + dated.join(', '));
  } finally {
    if (work) rmSync(work, {recursive: true, force: true});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
