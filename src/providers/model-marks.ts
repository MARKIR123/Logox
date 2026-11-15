/**
 * Tier and vision marks of a model. They only help the user filter and choose models: the runtime never routes a request by task difficulty,
 * and the only automatic use of a mark is the image fallback (a model that cannot see images gets a placeholder, and an Automa job marked `vision` runs on the vision fallback).
 *
 * A mark is derived (known family, then price rank within the provider; input modalities of the catalog row) and a user override in `model-tiers.json` wins.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {StateFile} from '../config/model-preferences.js';
import type {MarkChange} from '../runtime/command-surface.js';
import {modelTable, normalizeModelId, priceOf, type ModelRow, type ModelTable, type ResolveOptions} from './model-table.js';

export type Tier = 1 | 2 | 3 | 4;
export const TIER_NAMES: Readonly<Record<Tier, string>> = {1: 'light', 2: 'standard', 3: 'strong', 4: 'frontier'};
export interface ModelMarks {
  readonly tier: Tier;
  /** True when the model can see images. */
  readonly vision: boolean;
  /** True for a value the runtime guessed; false for one the user set. */
  readonly derived: {readonly tier: boolean; readonly vision: boolean};
}

const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const overrideSchema = z.strictObject({tier: tierSchema.optional(), vision: z.boolean().optional()});
const fileSchema = z.strictObject({version: z.literal(1), models: z.record(z.string().min(1), overrideSchema)});
type Overrides = Record<string, z.infer<typeof overrideSchema>>;
export const MARKS_FILE = 'model-tiers.json';

/** Known families, strongest first (a name that mentions two keeps the higher). Matched on the model id and the catalog name. */
const FAMILIES: readonly (readonly [RegExp, Tier])[] = [[/fable|mythos/, 4], [/opus/, 3], [/sonnet/, 2], [/haiku/, 1]];
/** Absolute input price (USD per 1M) thresholds for a provider with fewer than four priced models. */
const SMALL_PROVIDER: readonly (readonly [number, Tier])[] = [[0.8, 1], [2.5, 2], [8, 3]];
const EFFORT_SUFFIX = /-(extra-low|low|medium|high|xhigh|max|tiered|thinking)$/;

export function familyTier(...names: readonly (string | undefined)[]): Tier | undefined {
  const text = names.filter(Boolean).join(' ').toLowerCase();
  return FAMILIES.find(([pattern]) => pattern.test(text))?.[1];
}

function rowInput(row: ModelRow, at: number): number {
  const card = row[8]?.filter(item => item[0] <= at).at(-1);
  return card ? card[1] : row[6][0];
}

const peerCache = new WeakMap<ModelTable, Map<string, readonly number[]>>();
/** Ascending input prices of the distinct priced models in the catalogs a provider maps to; one price per normalized id. */
function peerPrices(table: ModelTable, provider: string, options: ResolveOptions): readonly number[] {
  const catalogs = table.catalogsFor(provider, options), key = catalogs.join('|');
  const cache = peerCache.get(table) ?? peerCache.set(table, new Map()).get(table)!;
  const known = cache.get(key);
  if (known) return known;
  const seen = new Map<string, number>(), now = Date.now();
  for (const catalog of catalogs) for (const row of table.data.providers[catalog]?.models ?? []) {
    const price = rowInput(row, now), id = normalizeModelId(row[0]);
    if (price > 0 && !seen.has(id)) seen.set(id, price);
  }
  const prices = [...seen.values()].sort((a, b) => a - b);
  cache.set(key, prices);
  return prices;
}

/** Input price (USD per 1M) of a model from the model table; undefined when the table does not know it or lists no price. */
export function inputPrice(provider: string, model: string, options: ResolveOptions = {}, table: ModelTable = modelTable): number | undefined {
  const hit = table.resolve(provider, model, options);
  const price = hit ? priceOf(hit).input : 0;
  return price > 0 ? price : undefined;
}

/** The tier a model gets without a user override: known family, then price quartile within its provider (absolute thresholds for a small provider), else T2. */
export function deriveTier(provider: string, model: string, options: ResolveOptions = {}, table: ModelTable = modelTable): Tier {
  const hit = table.resolve(provider, model, options);
  const family = familyTier(model, hit?.model.name, hit?.model.id);
  if (family) return family;
  const price = hit ? priceOf(hit).input : 0;
  if (!(price > 0)) return 2;
  const peers = peerPrices(table, provider, options);
  if (peers.length >= 4) {
    const cheaper = peers.filter(value => value < price).length;
    return Math.min(4, Math.floor(cheaper / peers.length * 4) + 1) as Tier;
  }
  return SMALL_PROVIDER.find(([limit]) => price < limit)?.[1] ?? 4;
}

/** A model the table does not know is treated as vision-capable. */
export function deriveVision(provider: string, model: string, options: ResolveOptions = {}, table: ModelTable = modelTable): boolean {
  const hit = table.resolve(provider, model, options);
  return hit ? hit.model.input.includes('image') : true;
}

/** False for ids that are plainly not chat models (embeddings, speech, image and video generation, moderation): the runtime needs tool calls from a worker. */
export const likelyToolCapable = (model: string): boolean => !/embed|tts|whisper|moderation|dall-?e|rerank|transcri|realtime|audio|imagen|\bveo\b|sora|speech|image/i.test(model);

export const markKey = (provider: string, model: string): string => provider + '/' + model;
export function splitMarkKey(key: string): {provider: string; model: string} {
  const at = key.indexOf('/');
  return {provider: key.slice(0, at), model: key.slice(at + 1)};
}

/**
 * The user's overrides of one `model-tiers.json`. Reads are synchronous (a request needs the mark at once) and tolerate a missing or corrupt file;
 * writes go through the atomic `StateFile` and never replace a corrupt file.
 */
export class ModelMarkStore {
  private overrides: Overrides | undefined;
  private readonly file: StateFile<z.infer<typeof fileSchema>>;
  /** Catalog declarations of the user's config (`[catalogs.<provider>]`), so a gateway resolves to the catalog it mirrors. */
  private options: ResolveOptions = {};
  constructor(readonly path: string, private readonly table: ModelTable = modelTable) {
    this.file = new StateFile(path, fileSchema);
  }
  configure(options: ResolveOptions): void {this.options = options;}
  private load(): Overrides {
    if (this.overrides) return this.overrides;
    try {this.overrides = fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8').replace(/^﻿/, ''))).models;}
    catch {this.overrides = {};}
    return this.overrides;
  }
  /** The user's override for a model; a model id that names its thinking level (`-high`) also reads the override of its family. */
  override(provider: string, model: string): {readonly tier?: Tier | undefined; readonly vision?: boolean | undefined} | undefined {
    const all = this.load();
    return all[markKey(provider, model)] ?? all[markKey(provider, model.replace(EFFORT_SUFFIX, ''))];
  }
  marks(provider: string, model: string): ModelMarks {
    const own = this.override(provider, model);
    return {
      tier: own?.tier ?? deriveTier(provider, model, this.options, this.table),
      vision: own?.vision ?? deriveVision(provider, model, this.options, this.table),
      derived: {tier: own?.tier === undefined, vision: own?.vision === undefined},
    };
  }
  vision(provider: string, model: string): boolean {return this.marks(provider, model).vision;}
  /** Input price (USD per 1M tokens) from the model table, honouring the configured catalogs. */
  price(provider: string, model: string): number | undefined {return inputPrice(provider, model, this.options, this.table);}
  /** Applies a change to the model named by `key` (`<provider>/<model>`) and persists it before returning. */
  async change(key: string, change: MarkChange): Promise<void> {
    const {provider, model} = splitMarkKey(key);
    if (!provider || !model) throw new Error('Not a model: ' + key);
    let result: Overrides = this.load();
    await this.file.update(current => {
      const models: Overrides = {...(current?.models ?? {})};
      const entry = {...models[key]};
      if ('clear' in change) delete models[key];
      else {
        if ('tier' in change) entry.tier = change.tier;
        if ('vision' in change) entry.vision = change.vision;
        models[key] = entry;
      }
      result = models;
      return {version: 1 as const, models};
    });
    this.overrides = result;
  }
  async setTier(provider: string, model: string, tier: Tier): Promise<void> {await this.change(markKey(provider, model), {tier});}
  async setVision(provider: string, model: string, vision: boolean): Promise<void> {await this.change(markKey(provider, model), {vision});}
  async clear(provider: string, model: string): Promise<void> {await this.change(markKey(provider, model), {clear: true});}
  /** What a picker needs to edit marks: apply a change and read the marks a row stands for. */
  pickerMarks() {
    return {change: (key: string, change: MarkChange) => this.change(key, change),
      resolve: (key: string): ModelMarks => {const {provider, model} = splitMarkKey(key); return this.marks(provider, model);}};
  }
}

const stores = new Map<string, ModelMarkStore>();
/** One store per directory, so the picker, the request path and Automa all read the same overrides. */
export function modelMarkStore(directory: string): ModelMarkStore {
  const path = join(directory, MARKS_FILE);
  return stores.get(path) ?? stores.set(path, new ModelMarkStore(path)).get(path)!;
}
export const tierLabel = (tier: number): string => 'T' + tier;
/** The two marks as plain text (`T2 ◉`); a model that cannot see images shows only its tier. */
export const marksText = (marks: ModelMarks): string => tierLabel(marks.tier) + (marks.vision ? ' ◉' : '');
