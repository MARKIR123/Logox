import {z} from 'zod';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {StateFile} from '../config/model-preferences.js';
import type {Config} from '../config/config.js';
import {usageRecordSchema, type UsageRecord} from './budget.js';
import {costOf, modelKey, priceFor} from './cost.js';
import {familyCandidate, modelTable} from '../providers/model-table.js';
import type {TabRow} from '../runtime/command-surface.js';
import {row, rowText} from '../commands/tab-rows.js';

const ledgerSchema = z.array(usageRecordSchema);
export class UsageLedger {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly report: (message: string) => void) {}
  private file(sessionId: string, ownerId: string) {
    return new StateFile(join(this.root, createHash('sha256').update(JSON.stringify([sessionId, ownerId])).digest('hex') + '.json'), ledgerSchema);
  }
  async read(sessionId: string, ownerId: string): Promise<UsageRecord[]> {
    try {return await this.file(sessionId, ownerId).read() ?? [];}
    catch {this.report('Usage records unreadable; original file preserved; this process starts recording from zero.'); return [];}
  }
  record(sessionId: string, ownerId: string, record: UsageRecord): void {
    this.pending = this.pending.then(() => this.file(sessionId, ownerId).update(current => {
      const records = current ?? [];
      return records.some(item => item.id === record.id) ? records : [...records, record];
    })).catch(() => {this.report('Usage save failed; this process\'s statistics remain viewable and the original file is preserved.');});
  }
  async flush(): Promise<void> {await this.pending;}
}
const LISTED_UNPRICED = 4;
/** Models with usage but no price, most used first, with their number of recorded calls. */
export function unpricedModels(records: readonly UsageRecord[], config: Config): {model: string; turns: number}[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = modelKey(record.model), price = priceFor(config, key);
    if (!price || price.input === undefined && price.output === undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([model, turns]) => ({model, turns})).sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
}
/** The rows that name unpriced models and show the TOML that prices the first one (plus a catalog alias when one built-in model is the obvious sibling of a gateway's model). */
function unpricedRows(records: readonly UsageRecord[], config: Config): TabRow[] {
  const unpriced = unpricedModels(records, config);
  if (!unpriced.length) return [];
  const listed = unpriced.slice(0, LISTED_UNPRICED).map(item => item.model + ' (' + item.turns + (item.turns === 1 ? ' turn)' : ' turns)')).join(', ');
  const first = unpriced[0]!.model, at = first.indexOf('/'), provider = at < 0 ? '' : first.slice(0, at), model = first.slice(at + 1);
  const rows: TabRow[] = [row.text('Unpriced, so the cost is partial: ' + listed + (unpriced.length > LISTED_UNPRICED ? ', +' + (unpriced.length - LISTED_UNPRICED) + ' more' : '')),
    row.muted('To price ' + first + ', add to config.toml (USD per 1M tokens; cache_read and cache_write are optional):'),
    {kind: 'text', text: '[models."' + first + '"]', indent: 2}, {kind: 'text', text: 'prices = {input = 0.0, output = 0.0}', indent: 2}];
  const sibling = provider && !modelTable.has(provider) ? familyCandidate(model) : undefined;
  if (sibling) rows.push(row.muted('Or, if it bills like ' + sibling + ': [catalogs.' + provider + '.aliases] "' + model + '" = "' + sibling + '" (one entry per model id)'));
  return rows;
}
/** Structured usage page. Missing cache rates bill at the input rate and mark the figure partial; a model with no price shows none and is listed with the config that prices it. */
export function usageRows(records: readonly UsageRecord[], config: Config): TabRow[] {
  const totalInput = records.reduce((sum, record) => sum + record.input, 0), totalOutput = records.reduce((sum, record) => sum + record.output, 0);
  const rows: TabRow[] = [row.muted('Actual response usage; input includes cache. Cost uses configured or built-in list prices.'),
    row.field('Total input / output', totalInput + ' / ' + totalOutput + ' token'), ...unpricedRows(records, config)];
  const groups = new Map<string, {input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number}>();
  for (const record of records) {
    const key = JSON.stringify([modelKey(record.model), record.category]);
    const total = groups.get(key) ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0};
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) total[field] += record[field];
    total.cacheWrite1h += record.cacheWrite1h ?? 0;
    groups.set(key, total);
  }
  if (!groups.size) return [...rows, row.text('No response usage recorded yet.')];
  for (const [key, total] of groups) {
    const [model, category] = z.tuple([z.string(), z.string()]).parse(JSON.parse(key));
    const cost = costOf([{id: 'group', model, category: 'task', ...total}], config);
    rows.push(row.blank(), row.heading(model + ' · ' + (['task', 'approval', 'automa', 'keepalive'].includes(category) ? category : 'summary')),
      row.field('Input / output', total.input + ' / ' + total.output + ' token'),
      row.field('Cache read / write', total.cacheRead + ' / ' + total.cacheWrite + ' token'),
      row.field('Estimated cost', cost === undefined ? 'unknown (no price)' : (cost.partial ? '~' : '') + cost.amount.toFixed(6) + ' ' + cost.currency + (cost.partial ? ' (partial: cache rate billed as input)' : '')));
  }
  return rows;
}
export function usageLines(records: readonly UsageRecord[], config: Config): string[] {return usageRows(records, config).map(rowText);}
