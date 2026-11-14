import {z} from 'zod';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {StateFile} from '../config/model-preferences.js';
import type {Config} from '../config/config.js';
import {usageRecordSchema, type UsageRecord} from './budget.js';
import {costOf, modelKey, priceFor} from './cost.js';
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
/** The rows that name unpriced models and show the TOML that prices the first one (never an alias to a sibling model: a same-family model can bill very differently). */
function unpricedRows(records: readonly UsageRecord[], config: Config): TabRow[] {
  const unpriced = unpricedModels(records, config);
  if (!unpriced.length) return [];
  const listed = unpriced.slice(0, LISTED_UNPRICED).map(item => item.model + ' (' + item.turns + (item.turns === 1 ? ' turn)' : ' turns)')).join(', ');
  const first = unpriced[0]!.model;
  const rows: TabRow[] = [row.text('Unpriced, so the cost is partial: ' + listed + (unpriced.length > LISTED_UNPRICED ? ', +' + (unpriced.length - LISTED_UNPRICED) + ' more' : '')),
    row.muted('To price ' + first + ', add to config.toml (USD per 1M tokens; cache_read and cache_write are optional):'),
    {kind: 'text', text: '[models."' + first + '"]', indent: 2}, {kind: 'text', text: 'prices = {input = 0.0, output = 0.0}', indent: 2}];
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

/** One actor's usage as the `/usage` page needs it. `records` are the records of that actor's meter, Automa calls included (they are charged to the dispatcher). */
export interface UsageOwner {id: string; name: string; records: readonly UsageRecord[]}
export interface UsagePageInput {
  owners: readonly UsageOwner[]; config: Config; now: number;
  /** When the session started; the wall-time line is left out when unknown. */
  startedAt?: number | undefined;
  /** Providers billed by subscription: their cost is an API-equivalent estimate. */
  subscriptions?: ReadonlySet<string> | undefined;
}
const CATEGORIES = ['task', 'summary', 'approval', 'automa', 'keepalive'] as const;
const CATEGORY_NAMES: Record<typeof CATEGORIES[number], string> = {task: 'Task', summary: 'Summary', approval: 'Approval', automa: 'Automa', keepalive: 'Keep-alive'};
interface Sums {input: number; output: number; cacheRead: number; cacheWrite: number; requests: number}
function sums(records: readonly UsageRecord[]): Sums {
  const total: Sums = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: records.length};
  for (const record of records) {total.input += record.input; total.output += record.output; total.cacheRead += record.cacheRead; total.cacheWrite += record.cacheWrite;}
  return total;
}
const count = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const tokensText = (total: Sums) => count(total.input) + ' in / ' + count(total.output) + ' out / ' + count(total.cacheRead) + ' cache read / ' + count(total.cacheWrite) + ' cache write';
const cacheShare = (total: Sums) => total.input > 0 ? Math.round(total.cacheRead / total.input * 100) + '%' : 'n/a';
const requestsText = (total: Sums) => count(total.requests) + (total.requests === 1 ? ' request' : ' requests');
function costText(records: readonly UsageRecord[], config: Config): string {
  const cost = costOf(records, config);
  return cost === undefined ? 'unknown (no price)' : (cost.partial ? '~' : '') + cost.amount.toFixed(4) + ' ' + cost.currency + (cost.partial ? ' (partial)' : '');
}
/** The provider part of a record's model identity. */
const providerOf = (record: UsageRecord) => modelKey(record.model).split('/')[0] ?? '';
/** The headline numbers of a record set: used by the `/usage` session block and by the `/status` usage section, so both read one calculation. */
export function usageTotalRows(records: readonly UsageRecord[], config: Config): TabRow[] {
  const total = sums(records);
  return [row.field('Cost', costText(records, config)), row.field('Tokens', tokensText(total)), row.field('Cache hit', cacheShare(total) + ' of input'), row.field('Requests', count(total.requests))];
}
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? hours + 'h ' + minutes + 'm' : minutes ? minutes + 'm ' + seconds % 60 + 's' : seconds + 's';
}
/** `/usage` Session tab: the session total, one block per actor in roster order, Automa by dispatcher, then the by-model and by-category breakdowns. */
export function sessionUsageRows(input: UsagePageInput): TabRow[] {
  const {owners, config} = input, subscriptions = input.subscriptions ?? new Set<string>();
  const all = owners.flatMap(owner => owner.records);
  const rows: TabRow[] = [row.heading('Session total'), ...usageTotalRows(all, config)];
  if (input.startedAt !== undefined) rows.push(row.field('Wall time', duration(input.now - input.startedAt)));
  rows.push(...unpricedRows(all, config));
  const estimated = [...new Set(all.map(providerOf).filter(provider => subscriptions.has(provider)))];
  if (estimated.length) rows.push(row.muted('API-equivalent estimate, not billed on a subscription: ' + estimated.join(', ')));
  if (!all.length) return [...rows, row.blank(), row.muted('No response usage recorded yet.')];
  for (const owner of owners) {
    const own = owner.records.filter(record => record.category !== 'automa');
    rows.push(row.blank(), row.heading(owner.name));
    if (own.length) rows.push(...usageTotalRows(own, config)); else rows.push(row.muted('No usage yet'));
  }
  const dispatched = owners.map(owner => ({owner, records: owner.records.filter(record => record.category === 'automa')})).filter(item => item.records.length);
  if (dispatched.length) {
    rows.push(row.blank(), row.heading('Automa'));
    for (const {owner, records} of dispatched) {
      const total = sums(records);
      rows.push(row.field('Dispatched by ' + owner.name, costText(records, config) + ' · ' + count(total.input) + ' in / ' + count(total.output) + ' out · cache hit ' + cacheShare(total) + ' · ' + requestsText(total)));
    }
  }
  const models = new Map<string, UsageRecord[]>();
  for (const record of all) {const key = modelKey(record.model); models.set(key, [...models.get(key) ?? [], record]);}
  rows.push(row.blank(), row.heading('By model'));
  for (const [model, records] of models) {
    const total = sums(records);
    rows.push(row.field(model, costText(records, config) + ' · ' + count(total.input) + ' in / ' + count(total.output) + ' out · cache read ' + count(total.cacheRead) + ' · write ' + count(total.cacheWrite) + ' · ' + requestsText(total)));
  }
  const used = CATEGORIES.filter(category => all.some(record => record.category === category));
  rows.push(row.blank(), row.heading('By category'));
  for (const category of used) {
    const records = all.filter(record => record.category === category), total = sums(records);
    rows.push(row.field(CATEGORY_NAMES[category], costText(records, config) + ' · ' + count(total.input) + ' in / ' + count(total.output) + ' out · ' + requestsText(total)));
  }
  return rows;
}
/**
 * `/usage` Plan tab, or undefined when no subscription provider is in use (it has records, or is `selected`). LOGOX stores no plan limits or
 * rate-limit windows: provider responses are only read for token usage and 429 handling. The tab shows what this session spent on the plan and says so.
 */
export function planUsageRows(input: UsagePageInput & {selected?: readonly string[]}): TabRow[] | undefined {
  const subscriptions = input.subscriptions ?? new Set<string>();
  const all = input.owners.flatMap(owner => owner.records);
  const providers = [...new Set([...all.map(providerOf), ...input.selected ?? []])].filter(provider => subscriptions.has(provider));
  if (!providers.length) return undefined;
  const rows: TabRow[] = [];
  for (const provider of providers) {
    const records = all.filter(record => providerOf(record) === provider), total = sums(records);
    rows.push(...rows.length ? [row.blank()] : [], row.heading(provider + ' (subscription)'),
      row.field('This session', count(total.input) + ' in / ' + count(total.output) + ' out · ' + requestsText(total)),
      row.field('API-equivalent cost', records.length ? costText(records, input.config) : 'none yet'),
      row.muted('Plan limits and reset times are not reported by this provider.'));
  }
  return rows;
}
