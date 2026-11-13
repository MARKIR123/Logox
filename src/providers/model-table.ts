import {modelTableData} from './model-table.generated.js';

/** `[id, name, contextWindow, maxOutput, input modalities, thinking levels ('' = not reasoning), [input, output, cacheRead, cacheWrite], tiers?]`; prices are USD per 1M tokens. */
export type ModelRow = [id: string, name: string, window: number, maxOutput: number, input: string, levels: string,
  rates: [number, number, number, number], tiers?: [above: number, input: number, output: number, cacheRead: number, cacheWrite: number][]];
export interface ModelTableData {
  source: string; version: string; upstreamDate: string;
  providers: Record<string, {subscription: boolean; models: ModelRow[]}>;
}
/** User declaration of which catalog a gateway mirrors (`[catalogs.<provider>]` in config). */
export interface CatalogConfig {mirror?: string | readonly string[] | undefined; aliases?: Readonly<Record<string, string>> | undefined; subscription?: boolean | undefined}
/** exact: id found in the derived or declared catalog; alias: via a configured alias; normalized: effort/date suffix stripped; inferred: bare-id match in some other catalog (low confidence). */
export type Confidence = 'exact' | 'alias' | 'normalized' | 'inferred';
export interface TablePrice {
  currency: 'USD'; input: number; output: number; cache_read?: number; cache_write?: number;
  /** Rates that apply once the prompt exceeds `above` tokens. */
  tiers?: {above: number; input: number; output: number; cache_read: number; cache_write: number}[];
  /** Subscription / OAuth catalog: the figures are API-equivalent estimates, not what the user is billed. */
  subscription: boolean; confidence: Confidence; catalog: string;
}
export interface CatalogModel {
  catalog: string; id: string; name: string; window: number; maxOutput: number; input: readonly string[];
  reasoning: boolean; levels: readonly string[]; subscription: boolean;
  rates: readonly [number, number, number, number]; tiers: NonNullable<ModelRow[7]>;
}
export interface Resolution {model: CatalogModel; confidence: Confidence; subscription: boolean; /** Human-readable origin such as `catalog google` or `alias -> gemini-4-argon`. */ via: string}
export interface ResolveOptions {
  catalogs?: Readonly<Record<string, CatalogConfig>> | undefined;
  baseUrl?: string | undefined;
  /** Credential is a subscription OAuth login: prefer the subscription catalog and flag the result. */
  oauth?: boolean | undefined;
}

const HOST_CATALOGS: [RegExp, string][] = [
  [/(^|\.)api\.openai\.com$/, 'openai'], [/(^|\.)chatgpt\.com$/, 'openai-codex'], [/(^|\.)api\.anthropic\.com$/, 'anthropic'],
  [/(^|\.)api\.deepseek\.com$/, 'deepseek'], [/(^|\.)generativelanguage\.googleapis\.com$/, 'google'], [/(^|\.)openrouter\.ai$/, 'openrouter'],
  [/(^|\.)api\.x\.ai$/, 'xai'], [/(^|\.)api\.mistral\.ai$/, 'mistral'], [/(^|\.)api\.moonshot\.(ai|cn)$/, 'moonshotai'],
  [/(^|\.)(api\.z\.ai|open\.bigmodel\.cn)$/, 'zai'], [/(^|\.)api\.minimax(i)?\.(io|com)$/, 'minimax'],
  [/(^|\.)githubcopilot\.com$/, 'github-copilot'],
];
/** Order in which catalogs are consulted for a bare-id match: first-party vendors before resellers. */
const PRIORITY = ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'mistral', 'moonshotai', 'zai', 'minimax', 'openai-codex', 'github-copilot', 'google-vertex', 'openrouter'];
const EFFORT_MAP: Record<string, string> = {off: 'off', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max'};

/** Comparison key that ignores vendor prefix, `:variant`, date stamps, effort/thinking suffixes and dot-vs-dash version separators. */
export function normalizeModelId(id: string): string {
  let value = id.trim().toLowerCase();
  value = value.slice(value.lastIndexOf('/') + 1).replace(/:.*$/, '').replace(/^~/, '');
  for (let previous = ''; previous !== value;) {
    previous = value;
    value = value.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/-(minimal|low|medium|high|xhigh|max|thinking|tiered)$/, '');
  }
  return value.replace(/\./g, '-');
}
function bareId(id: string): string {return id.slice(id.lastIndexOf('/') + 1).replace(/:.*$/, '').replace(/^~/, '').toLowerCase();}
function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {return new URL(baseUrl).hostname.toLowerCase();} catch {return undefined;}
}

export class ModelTable {
  private readonly catalogs = new Map<string, {subscription: boolean; byId: Map<string, CatalogModel>; byNormal: Map<string, CatalogModel>; byBare: Map<string, CatalogModel>}>();
  private order: string[] = [];
  constructor(readonly data: ModelTableData) {
    for (const [name, entry] of Object.entries(data.providers)) {
      const byId = new Map<string, CatalogModel>(), byNormal = new Map<string, CatalogModel>(), byBare = new Map<string, CatalogModel>();
      for (const row of entry.models) {
        const model: CatalogModel = {catalog: name, id: row[0], name: row[1], window: row[2], maxOutput: row[3], input: row[4].split(',').filter(Boolean),
          reasoning: row[5] !== '', levels: row[5].split(',').filter(Boolean), subscription: entry.subscription, rates: row[6], tiers: row[7] ?? []};
        byId.set(model.id.toLowerCase(), model);
        const variant = model.id.includes(':'), normal = normalizeModelId(model.id), bare = bareId(model.id);
        // Rows are sorted by id; a plain id beats a ':variant', and an id already in normalized form beats a dated or suffixed sibling.
        const sibling = byNormal.get(normal);
        if (!sibling || (!variant && sibling.id.includes(':')) || (bare === normal && bareId(sibling.id) !== normal)) byNormal.set(normal, model);
        const other = byBare.get(bare);
        if (!other || (!variant && other.id.includes(':'))) byBare.set(bare, model);
      }
      this.catalogs.set(name, {subscription: entry.subscription, byId, byNormal, byBare});
    }
    const names = [...this.catalogs.keys()];
    this.order = [...PRIORITY.filter(name => this.catalogs.has(name)), ...names.filter(name => !PRIORITY.includes(name)).sort()];
  }
  has(catalog: string): boolean {return this.catalogs.has(catalog);}
  catalogNames(): string[] {return [...this.catalogs.keys()];}
  /** Ids a catalog lists, sorted; used as an offline model list. */
  modelIds(catalog: string): string[] {return [...(this.catalogs.get(catalog)?.byId.values() ?? [])].map(model => model.id).sort();}
  /** Catalogs a LOGOX provider maps to, most specific first: declared mirror, same name, base-URL host, then the OpenAI catalogs for OpenAI. */
  catalogsFor(provider: string, options: ResolveOptions = {}): string[] {
    const found: string[] = [];
    const add = (name: string | undefined) => {if (name && this.catalogs.has(name) && !found.includes(name)) found.push(name);};
    const declared = options.catalogs?.[provider]?.mirror;
    for (const name of typeof declared === 'string' ? [declared] : declared ?? []) add(name);
    if (found.length > 0) return found;
    const host = hostOf(options.baseUrl);
    const byHost = host ? HOST_CATALOGS.find(([pattern]) => pattern.test(host))?.[1] : undefined;
    const lower = provider.toLowerCase();
    // OpenAI's own endpoint maps to the OpenAI catalogs whatever the provider is called (`openai`, the account provider `openai-auth`); a subscription login prefers the ChatGPT catalog.
    if (lower === 'openai' || byHost === 'openai') {
      if (options.oauth) add('openai-codex');
      add('openai'); add('openai-codex');
    }
    add(lower); add(byHost);
    return found;
  }
  /** Looks `model` up for `provider`. Returns undefined when neither the mapped catalogs nor a bare-id match know it. */
  resolve(provider: string, model: string, options: ResolveOptions = {}): Resolution | undefined {
    const config = options.catalogs?.[provider];
    const lookups = this.catalogsFor(provider, options);
    const aliasKey = Object.keys(config?.aliases ?? {}).find(key => key.toLowerCase() === model.toLowerCase());
    const aliasTarget = aliasKey ? config?.aliases?.[aliasKey] : undefined;
    const wrap = (hit: CatalogModel, confidence: Confidence, via: string): Resolution => ({model: hit, confidence, via,
      subscription: config?.subscription ?? ((options.oauth && hit.catalog === 'openai-codex') || hit.subscription)});
    const within = (id: string, exactConfidence: Confidence, label: string): Resolution | undefined => {
      for (const name of lookups) {
        const catalog = this.catalogs.get(name)!;
        const exact = catalog.byId.get(id.toLowerCase());
        if (exact) return wrap(exact, exactConfidence, label + name);
      }
      for (const name of lookups) {
        const normal = this.catalogs.get(name)!.byNormal.get(normalizeModelId(id));
        if (normal) return wrap(normal, exactConfidence === 'alias' ? 'alias' : 'normalized', label + name + ' (normalized id)');
      }
      return undefined;
    };
    if (aliasTarget) {
      const hit = within(aliasTarget, 'alias', 'alias ' + aliasTarget + ' in ') ?? this.inferred(aliasTarget, wrap);
      if (hit) return hit;
    }
    return within(model, 'exact', 'catalog ') ?? this.inferred(model, wrap);
  }
  private inferred(model: string, wrap: (hit: CatalogModel, confidence: Confidence, via: string) => Resolution): Resolution | undefined {
    const bare = bareId(model);
    for (const name of this.order) {
      const hit = this.catalogs.get(name)!.byBare.get(bare);
      if (hit) return wrap(hit, 'inferred', 'bare id in catalog ' + name);
    }
    const normal = normalizeModelId(model);
    for (const name of this.order) {
      const hit = this.catalogs.get(name)!.byNormal.get(normal);
      if (hit) return wrap(hit, 'inferred', 'normalized bare id in catalog ' + name);
    }
    return undefined;
  }
  price(provider: string, model: string, options: ResolveOptions = {}): TablePrice | undefined {
    const hit = this.resolve(provider, model, options);
    return hit ? priceOf(hit) : undefined;
  }
}
export function priceOf(hit: Resolution): TablePrice {
  const [input, output, cacheRead, cacheWrite] = hit.model.rates;
  // Upstream writes 0 for "not offered"; when both cache rates are 0 on a paid model they are unknown, so callers fall back to the input rate.
  const cache = input > 0 && cacheRead === 0 && cacheWrite === 0 ? {} : {cache_read: cacheRead, cache_write: cacheWrite};
  return {currency: 'USD', input, output, ...cache,
    ...(hit.model.tiers.length > 0 ? {tiers: hit.model.tiers.map(([above, i, o, r, w]) => ({above, input: i, output: o, cache_read: r, cache_write: w}))} : {}),
    subscription: hit.subscription, confidence: hit.confidence, catalog: hit.model.catalog};
}
/** Maps table thinking levels onto LOGOX efforts (`xhigh` and `max` become `max`, `minimal` becomes `low`). Undefined for non-reasoning models. */
export function thinkingHint(hit: Resolution | undefined): ('off' | 'low' | 'medium' | 'high' | 'max')[] | undefined {
  if (!hit || !hit.model.reasoning || hit.confidence === 'inferred') return undefined;
  const efforts = new Set<string>();
  for (const level of hit.model.levels) {const mapped = EFFORT_MAP[level]; if (mapped) efforts.add(mapped);}
  const ordered = (['off', 'low', 'medium', 'high', 'max'] as const).filter(level => efforts.has(level));
  return ordered.length > 0 ? ordered : undefined;
}

export const modelTable = new ModelTable(modelTableData);
/** True when the provider's prices are subscription-based: declared `subscription`, an OAuth login on the ChatGPT catalog, or a subscription catalog such as github-copilot. */
export function isSubscriptionProvider(provider: string, options: ResolveOptions = {}): boolean {
  const declared = options.catalogs?.[provider]?.subscription;
  if (declared !== undefined) return declared;
  const first = modelTable.catalogsFor(provider, options)[0];
  return Boolean(first && modelTable.data.providers[first]?.subscription) || Boolean(options.oauth && modelTable.catalogsFor(provider, options).includes('openai-codex'));
}
/** Built-in list price (USD per 1M tokens) for a provider/model, honouring gateway catalog mapping; user `[models."p/m".prices]` is applied by the caller. */
export function tablePrice(provider: string, model: string, options: ResolveOptions = {}): TablePrice | undefined {return modelTable.price(provider, model, options);}
