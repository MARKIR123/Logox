import type {TabRow} from '../runtime/command-surface.js';
import type {DiscoveredModel} from '../providers/model-pool.js';
import type {Config} from '../config/config.js';
import {modelTable} from '../providers/model-table.js';
import {row} from './tab-rows.js';

const compact = (value: number | undefined): string => value === undefined ? '?' : value >= 1_000_000 ? +(value / 1_000_000).toFixed(2) + 'M' : value >= 1000 ? Math.round(value / 1000) + 'k' : String(value);
const dollars = (value: number | undefined): string => value === undefined ? '?' : '$' + (value >= 10 ? value.toFixed(0) : +value.toFixed(3));
/** A configured price counts only when it names an input or output rate (the cost lookup ignores anything else). */
const priced = (prices: {input?: number | undefined; output?: number | undefined} | undefined): boolean => prices !== undefined && (prices.input !== undefined || prices.output !== undefined);

/** One configured model as a single line: window, output limit, prices per 1M tokens and where the figures came from. */
export function modelLine(config: Pick<Config, 'models' | 'catalogs'>, model: Pick<DiscoveredModel, 'provider' | 'id' | 'window' | 'maxOutput'>): string {
  const own = config.models[model.provider + '/' + model.id], hit = modelTable.resolve(model.provider, model.id, {catalogs: config.catalogs});
  const window = model.window ?? own?.context_window ?? hit?.model.window, output = model.maxOutput ?? own?.max_output_tokens ?? hit?.model.maxOutput;
  const prices = priced(own?.prices) ? own?.prices : hit ? {input: hit.model.rates[0], output: hit.model.rates[1]} : undefined;
  const price = prices ? dollars(prices.input) + ' in / ' + dollars(prices.output) + ' out per 1M' : 'no price';
  const source = priced(own?.prices) ? 'config' : hit ? hit.confidence + ' · ' + hit.model.catalog + (hit.subscription ? ' · subscription estimate' : '') : 'unknown';
  return compact(window) + ' window · ' + compact(output) + ' max out · ' + price + ' · ' + source;
}

/** The read-only `Models & pricing` page: configured providers and models, with the catalog source and its confidence. */
export function modelsRows(config: Pick<Config, 'models' | 'catalogs'>, providers: readonly string[], models: readonly DiscoveredModel[]): TabRow[] {
  const rows: TabRow[] = [];
  for (const provider of providers) {
    const own = models.filter(model => model.provider === provider);
    if (rows.length) rows.push(row.blank());
    rows.push(row.heading(provider + ' (' + own.length + ')'));
    if (!own.length) rows.push(row.muted('No models cached. Use /providers and press r to fetch them.'));
    // A model nothing can price is drawn muted, so the gap shows before any usage; its line says `no price`.
    for (const model of own) {
      const line = modelLine(config, model);
      rows.push(row.field(model.id + (model.isOffline ? ' [offline]' : ''), line, line.includes(' · no price · ') ? 'muted' : undefined));
    }
  }
  if (!providers.length) rows.push(row.text('No providers configured. Run /login to add one.'));
  rows.push(row.blank(), row.rule('Source'),
    row.muted('exact: the id is in the catalog · alias / normalized: matched through a mapping or a stripped suffix · inferred: a bare-id match elsewhere (low confidence) · config: your own prices.'),
    row.muted('A gateway that mirrors another vendor declares it with [catalogs.<provider>] in config.toml so its models resolve exactly.'));
  return rows;
}
