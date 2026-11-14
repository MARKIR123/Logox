import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig, type Config} from '../src/config/config.js';
import {groupModelFamilies, groupModelsForProvider, resolveActualModel} from '../src/config/model-grouping.js';
import {effortInName, modelLabel} from '../src/config/model-preferences.js';
import {familyCandidate, normalizeModelId, tablePrice} from '../src/providers/model-table.js';
import {unpricedModels, usageRows} from '../src/context/usage.js';
import {modelLine, modelsRows} from '../src/commands/models-page.js';
import {tabDisplay} from '../src/tui/panels/tabbed-page.js';
import {rowText} from '../src/commands/tab-rows.js';
import type {UsageRecord} from '../src/context/budget.js';

async function withConfig<T>(models: Record<string, unknown>, run: (config: Config) => T | Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'logox-test-'));
  try {return await run(await loadConfig(root, {models} as never, {}, root, root));}
  finally {await rm(root, {recursive: true, force: true});}
}
const record = (model: string, id: string): UsageRecord => ({id, model, category: 'task', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0});

test('-xhigh is the top level of its family: it folds as max, or stays its own row when the family already has -max', () => {
  const folded = groupModelsForProvider(['gemini-4-hydrogen', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh'], 'antigravity', 'gemini-4-hydrogen-xhigh');
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0]!.effortLevels, ['low', 'medium', 'high', 'max', 'auto']);
  assert.equal(folded[0]!.currentEffort, 'max');
  assert.equal(resolveActualModel(folded[0]!, 'max').modelId, 'gemini-4-hydrogen-xhigh');
  assert.equal(folded[0]!.isCurrent, true);

  const both = groupModelsForProvider(['fam', 'fam-high', 'fam-max', 'fam-xhigh'], 'p', 'fam-max');
  assert.deepEqual(both.map(group => group.baseModel).sort(), ['fam', 'fam-xhigh']);
  const family = both.find(group => group.baseModel === 'fam')!;
  assert.equal(resolveActualModel(family, 'max').modelId, 'fam-max', 'the real -max variant keeps the max level');
  assert.equal(both.find(group => group.baseModel === 'fam-xhigh')!.variantMap['auto'], 'fam-xhigh');

  const families = groupModelFamilies(['fam-high', 'fam-xhigh'], 'p');
  assert.deepEqual(families.map(group => [group.baseModel, group.effortLevels]), [['fam', ['high', 'max']]]);
  assert.deepEqual(groupModelFamilies(['fam-max', 'fam-xhigh'], 'p').map(group => group.baseModel).sort(), ['fam', 'fam-xhigh']);
});

test('-xhigh names its level: effortInName is max and the label shows what the name says', () => {
  assert.equal(effortInName('gemini-4-hydrogen-xhigh'), 'max');
  assert.equal(effortInName('Family-XHIGH'), 'max');
  assert.equal(effortInName('xhigh'), undefined);
  assert.equal(modelLabel('gemini-4-hydrogen-xhigh', 'low'), 'gemini-4-hydrogen · xhigh');
  assert.equal(modelLabel('gemini-4-hydrogen-high', 'low'), 'gemini-4-hydrogen · high');
});

test('-xhigh variants resolve to their family price', () => {
  assert.equal(normalizeModelId('gemini-4-hydrogen-xhigh'), 'gemini-4-hydrogen');
  const base = tablePrice('google', 'gemini-4-argon'), variant = tablePrice('google', 'gemini-4-argon-xhigh');
  assert.ok(base && variant);
  assert.equal(variant.input, base.input);
  assert.equal(variant.output, base.output);
});

test('a family guess is offered only when exactly one built-in model shares the family prefix', () => {
  assert.equal(familyCandidate('gemini-4-hydrogen-low'), 'gemini-4-argon');
  assert.equal(familyCandidate('totally-unknown-model'), undefined);
  assert.equal(familyCandidate('gpt-5'), undefined, 'a one-segment family would be a guess');
});

test('the usage page names unpriced models, the TOML that prices the first, and a catalog alias for a gateway', async () => {
  await withConfig({}, config => {
    const records = [
      ...Array.from({length: 3}, (_, index) => record('antigravity/gemini-4-hydrogen-high', 'h' + index)),
      record('antigravity/gemini-4-hydrogen', 'a'), record('google/gemini-4-argon', 'priced'),
    ];
    assert.deepEqual(unpricedModels(records, config), [{model: 'antigravity/gemini-4-hydrogen-high', turns: 3}, {model: 'antigravity/gemini-4-hydrogen', turns: 1}]);
    const lines = usageRows(records, config).map(rowText);
    const at = lines.findIndex(line => line.startsWith('Unpriced'));
    assert.ok(at >= 0, lines.join('\n'));
    assert.match(lines[at]!, /antigravity\/gemini-4-hydrogen-high \(3 turns\), antigravity\/gemini-4-hydrogen \(1 turn\)$/);
    assert.match(lines[at + 1]!, /^To price antigravity\/gemini-4-hydrogen-high, add to config\.toml/);
    assert.equal(lines[at + 2], '  [models."antigravity/gemini-4-hydrogen-high"]');
    assert.equal(lines[at + 3], '  prices = {input = 0.0, output = 0.0}');
    assert.equal(lines[at + 4], 'Or, if it bills like gemini-4-argon: [catalogs.antigravity.aliases] "gemini-4-hydrogen-high" = "gemini-4-argon" (one entry per model id)');
    const totals = lines.findIndex(line => line.startsWith('Total input / output'));
    assert.ok(totals >= 0 && totals < at, 'the notice follows the totals');
  });
});

test('the usage page lists a handful of unpriced models, offers no alias without a unique sibling, and stays silent when everything is priced', async () => {
  await withConfig({'local/priced': {prices: {input: 1, output: 2}}}, config => {
    const many = Array.from({length: 7}, (_, index) => record('local/mystery-' + index, 'm' + index));
    const lines = usageRows([...many, record('local/priced', 'p')], config).map(rowText);
    const unpriced = lines.find(line => line.startsWith('Unpriced'))!;
    assert.match(unpriced, /, \+3 more$/);
    assert.equal(unpriced.split(' turn').length - 1, 4);
    assert.ok(lines.includes('  [models."local/mystery-0"]'));
    assert.ok(!lines.some(line => line.includes('catalogs')), 'no sibling, no alias line');
    assert.ok(!usageRows([record('local/priced', 'p')], config).map(rowText).some(line => /Unpriced|config\.toml/.test(line)));
  });
});

test('the models page mutes a model with no price and says so; a configured price clears it', async () => {
  await withConfig({'local/own': {prices: {input: 1, output: 2}}}, config => {
    const rows = modelsRows(config, ['local'], [{provider: 'local', id: 'mystery'}, {provider: 'local', id: 'own'}] as never);
    const toneOf = (label: string) => { const found = rows.find(item => item.kind === 'field' && item.label === label); return found?.kind === 'field' ? found.tone : 'missing'; };
    assert.match(modelLine(config, {provider: 'local', id: 'mystery'}), / · no price · unknown$/);
    assert.deepEqual([toneOf('mystery'), toneOf('own')], ['muted', undefined]);
    // A muted field draws its value in the muted tone and not bold.
    const display = tabDisplay({id: 'models', title: 'Models', lines: rows.map(rowText), rows}, 120);
    const drawn = display.find(cells => cells[0]?.text.startsWith('mystery:'))!;
    const ordinary = display.find(cells => cells[0]?.text.startsWith('own:'))!;
    assert.match(drawn[1]!.text, /no price/);
    assert.notEqual(drawn[1]!.color, ordinary[1]!.color);
    assert.equal(drawn[1]!.bold, undefined);
    assert.equal(ordinary[1]!.bold, true);
  });
});
