import type {Config} from '../config/config.js';
import type {UsageRecord} from './budget.js';
import type {ModelTurn, TurnUsage} from '../runtime/messages.js';
import {tablePrice} from '../providers/model-table.js';

export interface Price {currency: string; input?: number | undefined; output?: number | undefined; cache_read?: number | undefined; cache_write?: number | undefined}
export function modelKey(identity: string): string {
  try {const parts: unknown = JSON.parse(identity); if (Array.isArray(parts) && typeof parts[0] === 'string' && typeof parts[1] === 'string') return parts[0] + '/' + parts[1];} catch {}
  return identity;
}
type PriceConfig = Pick<Config, 'models'> & Partial<Pick<Config, 'catalogs'>>;
/**
 * The single price lookup: per-million-token rates for one model, or undefined when none is known. A configured
 * `[models."provider/model".prices]` always wins; otherwise the built-in model table answers (gateway mapping from
 * `[catalogs.<provider>]`; `subscription` marks API-equivalent figures for ChatGPT/Copilot-style plans).
 */
export function modelPrice(config: PriceConfig, provider: string, model: string): (Price & {subscription?: boolean}) | undefined {
  return config.models[provider + '/' + model]?.prices ?? tablePrice(provider, model, {catalogs: config.catalogs});
}
/** Lookup by the `provider/model` key used in usage records. */
export function priceFor(config: PriceConfig, key: string): Price | undefined {
  const at = key.indexOf('/');
  return at < 0 ? modelPrice(config, '', key) : modelPrice(config, key.slice(0, at), key.slice(at + 1));
}
/** The ledger form of one provider-reported usage, priced when a price is known (see `runtime/messages.ts:turnUsageSchema`). */
export function turnUsageOf(usage: NonNullable<ModelTurn['usage']>, identity: string, config?: PriceConfig): TurnUsage | undefined {
  if (!Number.isFinite(usage.input + usage.output) || usage.input < 0 || usage.output < 0) return undefined;
  const key = modelKey(identity), at = key.indexOf('/');
  const entry = {input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
    provider: at < 0 ? '' : key.slice(0, at), model: at < 0 ? key : key.slice(at + 1)};
  const cost = config && entry.cacheRead + entry.cacheWrite <= entry.input
    ? costOf([{id: 'turn', category: 'task', input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite, model: key}], config) : undefined;
  return {...entry, ...(cost ? {cost: cost.amount, currency: cost.currency} : {})};
}
export interface Cost {readonly amount: number; readonly currency: string; readonly partial: boolean}
/** Sums priced usage. Missing cache rates fall back to the input rate (partial); records with no price are skipped (partial). Undefined when nothing could be priced. */
export function costOf(records: readonly UsageRecord[], config: PriceConfig, skip: (provider: string) => boolean = () => false): Cost | undefined {
  let amount = 0, currency: string | undefined, partial = false, priced = 0;
  for (const record of records) {
    const key = modelKey(record.model);
    if (skip(key.split('/')[0] ?? '')) continue;
    const price = priceFor(config, key);
    if (!price || price.input === undefined && price.output === undefined || currency && currency !== price.currency) {partial = true; continue;}
    currency ??= price.currency;
    const input = price.input;
    if (input === undefined && record.input > 0 || price.output === undefined && record.output > 0) {partial = true;}
    if ((record.cacheRead > 0 && price.cache_read === undefined) || (record.cacheWrite > 0 && price.cache_write === undefined)) partial = true;
    const fresh = Math.max(0, record.input - record.cacheRead - record.cacheWrite);
    amount += (fresh * (input ?? 0) + record.output * (price.output ?? 0) + record.cacheRead * (price.cache_read ?? input ?? 0) +
      record.cacheWrite * (price.cache_write ?? input ?? 0)) / 1e6;
    priced++;
  }
  return priced && currency ? {amount, currency, partial} : undefined;
}
