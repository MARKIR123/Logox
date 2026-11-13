import {readFile, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {parse} from 'smol-toml';
import {z} from 'zod';
import {effortSchema, isOpenAiReasoningModel, preferenceSchema, StateFile} from './model-preferences.js';
import {hooksSchema, mcpServerSchema} from '../extensions/config.js';
import {defaultPalette, hexColorSchema} from './theme-palette.js';
import {modelTable, thinkingHint} from '../providers/model-table.js';

export const priceSchema = z.object({currency: z.string().min(1).default('USD'),
  input: z.number().finite().nonnegative().optional(), output: z.number().finite().nonnegative().optional(),
  cache_read: z.number().finite().nonnegative().optional(), cache_write: z.number().finite().nonnegative().optional(),
  /** Rate for 1-hour cache writes (Anthropic); unset means twice `input`. `cache_write` is the 5-minute rate. */
  cache_write_1h: z.number().finite().nonnegative().optional()});
export const cacheRetentionSchema = z.enum(['short', 'long']);
const cacheTtlSchema = z.number().finite().positive();
export const toolDiscoverySchema = z.enum(['auto', 'none', 'anthropic', 'openai-responses']);
const capacitySchema = z.object({
  tool_discovery: toolDiscoverySchema.optional(),
  prompt_cache_key: z.boolean().optional(),
  cache_retention: cacheRetentionSchema.optional(),
  /** Seconds the gateway keeps a prompt cache entry. Anthropic lifetimes follow `cache_retention`; for other protocols unset means unknown, which is never treated as expired. */
  cache_ttl_seconds: cacheTtlSchema.optional(),
  thinking_protocol: z.enum(['deepseek', 'anthropic-budget', 'anthropic-adaptive', 'reasoning-effort']).optional(),
  thinking_levels: z.array(effortSchema).min(1).optional(), prices: priceSchema.optional(),
  context_window: z.number().int().min(256).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  /** Most images one request may carry; Anthropic Messages defaults to 100, other protocols have no default. */
  max_images: z.number().int().positive().optional(),
});
/** Declares which built-in model catalog (see `src/providers/model-table.ts`) a custom gateway mirrors, plus id aliases for names the catalog does not list. */
export const catalogSchema = z.object({
  mirror: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  aliases: z.record(z.string().min(1), z.string().min(1)).default({}),
  subscription: z.boolean().optional(),
}).strict();
/** Context keys of earlier versions. Config files and actor profiles that still carry them load unchanged: the keys are accepted and ignored. */
export const RETIRED_CONTEXT_KEYS = ['keep_index_lines', 'task_end_floor_ratio', 'compact_accept_ratio'] as const;
export const contextPolicySchema = z.object({
  keep_recent_rounds: z.number().int().nonnegative().default(2),
  keep_recent_tools: z.number().int().nonnegative().default(2),
  reserve_tokens: z.number().int().nonnegative().default(32768),
  high_watermark_ratio: z.number().positive().lt(1).default(0.8),
  low_watermark_ratio: z.number().positive().lt(1).default(0.5),
  max_budget_tokens: z.number().int().positive().optional(),
  target_budget_tokens: z.number().int().positive().optional(),
  summary_provider: z.string().min(1).optional(),
  summary_model: z.string().min(1).optional(),
}).refine(policy => !policy.max_budget_tokens || !policy.target_budget_tokens || policy.target_budget_tokens < policy.max_budget_tokens,
  'target_budget_tokens must be less than max_budget_tokens');
export type ContextPolicy = z.infer<typeof contextPolicySchema>;
const legacyThemeDefaults = {
  user: defaultPalette.user, accent: defaultPalette.accent,
  dream_collapsed: defaultPalette.dreamCollapsed, dream_expanded: defaultPalette.dreamExpanded,
};
export const themeSchema = z.object({
  user: hexColorSchema.default(legacyThemeDefaults.user),
  accent: hexColorSchema.default(legacyThemeDefaults.accent),
  dream_collapsed: hexColorSchema.default(legacyThemeDefaults.dream_collapsed),
  dream_expanded: hexColorSchema.default(legacyThemeDefaults.dream_expanded),
}).default(legacyThemeDefaults);
export type ThemeConfig = z.infer<typeof themeSchema>;
const modelKindsSchema = z.record(z.string().min(1), z.enum(['openai_compat', 'anthropic']));
const schema = z.object({
  theme: themeSchema,
  permissions: z.object({mode: z.enum(['default', 'auto', 'creative']).default('auto'), readonly_concurrency: z.number().int().min(1).max(8).default(4)}).default({mode: 'auto', readonly_concurrency: 4}),
  mcp: z.object({playwright: z.boolean().default(true), servers: z.record(z.string().min(1), mcpServerSchema).default({})})
    .default({playwright: true, servers: {}}),
  hooks: hooksSchema.default({enabled: false, timeout_s: 5, entries: []}),
  context: contextPolicySchema.default({keep_recent_rounds: 2, keep_recent_tools: 2, reserve_tokens: 32768, high_watermark_ratio: 0.8, low_watermark_ratio: 0.5}),
  models: z.record(z.string(), capacitySchema).default({}),
  catalogs: z.record(z.string().min(1), catalogSchema).default({}),
  provider: z.object({
    context_window: capacitySchema.shape.context_window, max_output_tokens: capacitySchema.shape.max_output_tokens, max_images: capacitySchema.shape.max_images,
    thinking_effort: effortSchema.default('auto'),
    name: z.string().default('openai'), model: z.string().default(''),
    base_url: z.string().url().optional(), api_key_env: z.string().optional(),
    auth_file: z.string().min(1).optional(), auth_provider: z.string().min(1).optional(),
    tool_discovery: toolDiscoverySchema.optional(),
    prompt_cache_key: z.boolean().optional(),
    cache_retention: cacheRetentionSchema.optional(),
    cache_ttl_seconds: cacheTtlSchema.optional(),
    kind: z.enum(['openai_compat', 'anthropic']).optional(),
    model_kinds: modelKindsSchema.optional(),
    api: z.enum(['completions', 'responses']).optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    max_tokens: z.number().int().positive().default(16384),
    timeout: z.number().positive().default(600),
  }).default({thinking_effort: 'auto', name: 'openai', model: '', temperature: 0.2, max_tokens: 16384, timeout: 600}),
  automa: z.object({
    max_parallel: z.number().int().min(1).max(8).default(4),
  }).default({max_parallel: 4}),
  kernel: z.object({
    max_iterations: z.number().int().nonnegative().default(0),
    max_retries: z.number().int().nonnegative().max(10).default(3),
    /** Replay an idle actor's last request shortly before its short prompt cache expires, only while it is certain to wake again. */
    cache_keepalive: z.boolean().default(true),
  }).default({max_iterations: 0, max_retries: 3, cache_keepalive: true}),
  providers: z.record(z.string(), z.object({
    tool_discovery: toolDiscoverySchema.optional(),
    prompt_cache_key: z.boolean().optional(),
    cache_retention: cacheRetentionSchema.optional(),
    cache_ttl_seconds: cacheTtlSchema.optional(),
    kind: z.enum(['openai_compat', 'anthropic']).default('openai_compat'),
    model_kinds: modelKindsSchema.optional(),
    api: z.enum(['completions', 'responses']).optional(),
    base_url: z.string().url(), api_key_env: z.string().optional(), default_model: z.string().optional(),
    auth_file: z.string().min(1).optional(), auth_provider: z.string().min(1).optional(),
  })).default({}),
});
export type Config = z.infer<typeof schema>;
/** Case-insensitive model id match where `*` stands for any run of characters (`claude-*`). */
export function matchesModelPattern(pattern: string, model: string): boolean {
  const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + source + '$', 'i').test(model);
}
export interface ModelSettings {
  api?: 'completions' | 'responses' | undefined;
  /** Protocol of this model after `model_kinds` routing. */
  kind: 'openai_compat' | 'anthropic';
  /** Protocol of the provider as a whole (model listing and credentials), before per-model routing. */
  providerKind?: 'openai_compat' | 'anthropic';
  baseUrl: string; model: string; key: string;
  temperature: number; maxTokens: number; timeoutMs: number; thinkingControl?: boolean;
  thinkingEffort?: import('./model-preferences.js').ThinkingEffort;
  thinkingProtocol?: 'deepseek' | 'anthropic-budget' | 'anthropic-adaptive' | 'reasoning-effort';
  toolDiscovery?: z.infer<typeof toolDiscoverySchema>;
  /** Explicit opt in or out of `prompt_cache_key`; unset means on for the official OpenAI endpoint only. */
  promptCacheKey?: boolean | undefined;
  /** Explicit `cache_retention` of the model or provider. Unset leaves the per-actor and role default (Anthropic TTL) and sends nothing to OpenAI. */
  cacheRetention?: z.infer<typeof cacheRetentionSchema> | undefined;
  /** Explicit `cache_ttl_seconds` of the model or provider, in milliseconds; unset means the gateway's cache lifetime is unknown. */
  cacheTtlMs?: number | undefined;
  thinkingLevels?: readonly import('./model-preferences.js').ThinkingEffort[];
}
/**
 * Provider templates (kept under the historical name `presets`): a built-in shortcut with a fixed official endpoint and protocol.
 * A template is not a provider by itself; it becomes one when the user saves a record for it (`catalog: true` in the provider store).
 * `account` marks templates that support browser account sign-in (OAuth) in addition to an API key.
 */
export const presets: Record<string, {kind: ModelSettings['kind']; base_url: string; api_key_env?: string; model_kinds?: Record<string, ModelSettings['kind']>; account?: boolean; description: string; listed?: false}> = {
  deepseek: {kind: 'openai_compat', base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY', description: 'DeepSeek official API'},
  openai: {kind: 'openai_compat', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', account: true, description: 'OpenAI API or ChatGPT account'},
  // A user's local proxy, not a built-in provider: `listed: false` keeps its endpoint knowledge (default URL, the Claude routing below) without offering it as a template.
  // The local proxy serves Claude over the native Messages endpoint too; its OpenAI view of Claude intermittently mislabels the answer as reasoning.
  antigravity: {kind: 'openai_compat', base_url: 'http://127.0.0.1:8045/v1', model_kinds: {'claude-*': 'anthropic'}, description: 'Local Antigravity proxy on port 8045', listed: false},
  anthropic: {kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_key_env: 'ANTHROPIC_API_KEY', description: 'Anthropic Claude API'},
};
/**
 * Names that older configs and saved selections may still use for a template. They are never listed; they resolve to the template's endpoint values
 * (`openai-compatible` was a duplicate of `openai`). A provider the user defined under such a name (with its own `base_url` or a `[providers.<name>]` entry) is not an alias.
 */
export const legacyTemplateNames: Record<string, string> = {'openai-compatible': 'openai'};
function templateName(name: string, defined: boolean): string {return !defined && Object.hasOwn(legacyTemplateNames, name) ? legacyTemplateNames[name]! : name;}
/** Every listed template name, whether or not the user set it up. Entries with `listed: false` are known endpoints only (see `presets`). */
export function templateNames(): string[] {return Object.entries(presets).filter(([, template]) => template.listed !== false).map(([name]) => name);}
/** Templates that support account sign-in. */
export function accountTemplateNames(): string[] {return Object.entries(presets).filter(([, template]) => template.account).map(([name]) => name);}
function pathKey(path: string): string {return process.platform === 'win32' ? path.toLowerCase() : path;}
function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result = {...left};
  for (const [key, value] of Object.entries(right)) {
    if (key === 'api_key') throw new Error('Use api_key_env; config files do not store keys');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      let previous = result[key] && typeof result[key] === 'object' ? result[key] as Record<string, unknown> : {};
      const update = value as Record<string, unknown>;
      // When the provider identity changes, do not inherit the previous endpoint's address, model or credentials.
      if (key === 'provider' && typeof update.name === 'string' && typeof previous.name === 'string' && update.name !== previous.name) {
        previous = Object.fromEntries(Object.entries(previous).filter(([field]) => ['temperature', 'max_tokens', 'timeout', 'thinking_effort'].includes(field)));
      } else if (key === 'provider' && typeof update.model === 'string' && typeof previous.model === 'string' && update.model !== previous.model) {
        previous = Object.fromEntries(Object.entries(previous).filter(([field]) => !['context_window', 'max_output_tokens', 'max_images'].includes(field)));
      }
      result[key] = merge(previous, update);
    } else result[key] = value;
  }
  return result;
}
export async function loadConfig(cwd: string, overrides: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env, home = homedir(), projectBoundary?: string,
  diagnostic: (message: string) => void = message => {process.stderr.write(message + '\n');}): Promise<Config> {
  const ancestors: string[] = [];
  let directory = resolve(cwd);
  for (;;) {
    ancestors.unshift(directory);
    if (projectBoundary && pathKey(directory) === pathKey(resolve(projectBoundary))) break;
    const parent = dirname(directory);
    if (directory === parent) break;
    directory = parent;
  }
  const actualHome = pathKey(await realpath(homedir()));
  const projectDirectories = (await Promise.all(ancestors.map(path => realpath(path)))).filter(path => pathKey(path) !== actualHome);
  const files = [
    join(home, '.logox', 'config.toml'),
    ...projectDirectories.flatMap(path => [
      join(path, '.logox', 'config.toml'),
    ]),
  ];
  let raw: Record<string, unknown> = {};
  const loaded = new Set<string>();
  for (const file of files) {
    let content: string;
    try {
      const canonical = pathKey(await realpath(file));
      if (loaded.has(canonical)) continue;
      loaded.add(canonical);
      content = await readFile(file, 'utf8');
    }
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
    try {raw = merge(raw, parse(content, {unsafeKeyBehaviour: 'throw'}));}
    catch {throw new Error('Invalid config: ' + file + ' (check TOML format and api_key_env)');}
  }
  try {
    const prefPaths = [
      join(cwd, '.logox', 'state', 'model-preferences.json'),
      join(home, '.logox', 'model-preferences.json'),
    ];
    let previous: z.infer<typeof preferenceSchema> | undefined;
    for (const p of prefPaths) {
      previous = await new StateFile(p, preferenceSchema).read();
      if (previous) break;
    }
    if (previous) {
      const candidate = merge(raw, {provider: {name: previous.provider, model: previous.model, thinking_effort: previous.effort}});
      modelSettings(schema.parse(candidate), env);
      raw = candidate;
    }
  } catch {diagnostic('The last model selection is unreadable or invalid; using config instead. The original state file is preserved.');}
  let environment: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('LOGOX__') || value === undefined) continue;
    const path = key.slice(7).toLowerCase().split('__');
    if (path.some(part => !part || ['__proto__', 'constructor', 'prototype', 'api_key'].includes(part))) throw new Error('Invalid environment config key');
    const update: Record<string, unknown> = {};
    let cursor = update;
    for (const part of path.slice(0, -1)) {cursor[part] = {}; cursor = cursor[part] as Record<string, unknown>;}
    cursor[path.at(-1)!] = ['name', 'model', 'base_url', 'api_key_env', 'kind', 'default_model', 'auth_file', 'auth_provider'].includes(path.at(-1)!) ? value : /^(true|false)$/.test(value) ? value === 'true' : /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    environment = merge(environment, update);
  }
  return withLegacyNames(schema.parse(merge(merge(raw, environment), overrides)));
}
/** Resolves a legacy template name in the selection (and its declared `[models]` keys) to the template it duplicated; silent, never listed. */
function withLegacyNames(config: Config): Config {
  const name = config.provider.name;
  const alias = templateName(name, Boolean(config.provider.base_url || config.providers[name]));
  const models = Object.fromEntries(Object.entries(config.models).map(([key, value]) => {
    const [provider] = key.split('/', 1);
    return provider !== undefined && Object.hasOwn(legacyTemplateNames, provider) && !config.providers[provider] ? [legacyTemplateNames[provider] + key.slice(provider.length), value] : [key, value];
  }));
  return {...config, models: {...models, ...config.models}, provider: alias === name ? config.provider : {...config.provider, name: alias}};
}
export function modelSettings(config: Config, env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const provider = config.provider;
  const template = templateName(provider.name, Boolean(provider.base_url || config.providers[provider.name]));
  const selected = config.providers[provider.name] ?? presets[template];
  if (!selected && !provider.base_url) throw new Error('Unknown provider: ' + provider.name);
  const baseUrl = provider.base_url ?? selected!.base_url;
  const keyEnv = provider.api_key_env ?? selected?.api_key_env;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model URL must be an HTTP(S) address without credentials');
  const model = provider.model || (selected && 'default_model' in selected ? selected.default_model ?? '' : '');
  const declared = config.models[provider.name + '/' + model];
  const official = baseUrl.replace(/\/$/, '') === presets[template]?.base_url.replace(/\/$/, '');
  const cleanModel = model.toLowerCase();
  const cleanProvider = provider.name.toLowerCase();
  const providerKind = provider.kind ?? selected?.kind ?? 'openai_compat';
  // Explicit `[provider] kind` pins the whole provider; otherwise the first matching `model_kinds` pattern routes this model. Preset routes apply only to the preset's own endpoint.
  const routes = provider.kind ? undefined : provider.model_kinds ?? config.providers[provider.name]?.model_kinds ?? (official ? presets[template]?.model_kinds : undefined);
  const kind = routes ? Object.entries(routes).find(([pattern]) => matchesModelPattern(pattern, model))?.[1] ?? providerKind : providerKind;
  const toolDiscovery = declared?.tool_discovery ?? provider.tool_discovery ?? config.providers[provider.name]?.tool_discovery ?? 'auto';
  if (toolDiscovery === 'anthropic' && kind !== 'anthropic') throw new Error('Anthropic tool discovery requires the Anthropic message protocol.');
  if (toolDiscovery === 'openai-responses' && kind !== 'openai_compat') throw new Error('OpenAI Responses discovery requires the OpenAI protocol.');
  const protocol = declared?.thinking_protocol ?? (
    official && provider.name === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model) ? 'deepseek'
    : (official && provider.name === 'anthropic' || kind !== providerKind && kind === 'anthropic') && /^claude-(opus-4-[678]|sonnet-4-6|opus-5|sonnet-5|fable)/i.test(model) ? 'anthropic-adaptive'
    : (provider.name === 'anthropic' || cleanModel.includes('claude')) && kind === 'anthropic' ? 'anthropic-budget'
    : (cleanProvider === 'deepseek' || cleanModel.includes('deepseek') || cleanModel.includes('reasoner') || cleanModel.includes('r1')) && kind === 'openai_compat' ? 'deepseek'
    : template === 'openai' && isOpenAiReasoningModel(model) ? 'reasoning-effort'
    : (cleanProvider === 'antigravity' || url.port === '8045' || cleanModel.includes('gemini') || cleanModel.includes('thinking')) && kind === 'openai_compat' ? 'reasoning-effort'
    : undefined);
  if ((protocol?.startsWith('anthropic-') && kind !== 'anthropic') || ((protocol === 'deepseek' || protocol === 'reasoning-effort') && kind !== 'openai_compat')) throw new Error('thinking_protocol does not match the provider kind');
  const promptCacheKey = declared?.prompt_cache_key ?? provider.prompt_cache_key ?? config.providers[provider.name]?.prompt_cache_key;
  const cacheRetention = declared?.cache_retention ?? provider.cache_retention ?? config.providers[provider.name]?.cache_retention;
  const cacheTtl = declared?.cache_ttl_seconds ?? provider.cache_ttl_seconds ?? config.providers[provider.name]?.cache_ttl_seconds;
  return {kind, providerKind, baseUrl, toolDiscovery, promptCacheKey, cacheRetention, ...(cacheTtl !== undefined ? {cacheTtlMs: Math.round(cacheTtl * 1000)} : {}), api: provider.api ?? config.providers[provider.name]?.api,
    model, thinkingEffort: provider.thinking_effort,
    ...(protocol ? {
      thinkingProtocol: protocol,
      thinkingLevels: declared?.thinking_levels ?? (
        protocol === 'deepseek'
          ? ['auto', 'off', 'low', 'high', 'max']
          : protocol === 'anthropic-adaptive' && model.startsWith('claude-opus-')
            ? ['auto', 'off', 'low', 'medium', 'high', 'max']
            : protocol === 'reasoning-effort' && (official || config.catalogs[provider.name]?.mirror !== undefined)
              ? ['auto', ...(thinkingHint(modelTable.resolve(provider.name, model, {catalogs: config.catalogs, baseUrl})) ?? ['off', 'low', 'medium', 'high'])]
              : ['auto', 'off', 'low', 'medium', 'high']
      ),
    } : {}),
    key: keyEnv ? env[keyEnv] ?? '' : '',
    temperature: provider.temperature, maxTokens: provider.max_tokens, timeoutMs: provider.timeout * 1000,
    ...(provider.name === 'deepseek' && url.hostname === 'api.deepseek.com' ? {thinkingControl: true} : {})};
}
