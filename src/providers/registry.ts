import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import type {ModelCapacity} from '../context/contracts.js';
import type {Provider} from '../runtime/messages.js';
import {modelSettings, presets, providerFamily, templateNames, type Config, type ModelSettings} from '../config/config.js';
import {resolveProviderCapabilities} from './capabilities.js';
import {createProvider, ProviderError} from './http.js';
import {modelCapacities} from './model-capacities.js';
import {modelTable, type Resolution} from './model-table.js';
import {type ThinkingEffort, isOpenAiReasoningModel} from '../config/model-preferences.js';
import {AuthStorage} from './auth.js';
import {CustomProviderStorage, type CustomProviderRecord} from './custom-storage.js';
import {createHttpTransport} from './transport.js';
import {refreshOpenAIToken} from './oauth.js';
import {RequestGate, type RequestGateOptions} from './request-gate.js';

/** Anthropic's documented maximum number of images in one Messages request. */
const ANTHROPIC_MAX_IMAGES = 100;
const credentialSchema = z.object({type: z.literal('api_key'), key: z.string(), env: z.record(z.string(), z.string()).optional()});
const modelsSchema = z.object({data: z.array(z.object({id: z.string().min(1),
  context_window: z.number().int().min(256).optional(), context_length: z.number().int().min(256).optional(),
  max_output_tokens: z.number().int().positive().optional(),
})).max(10000)});

async function storedKey(file: string, provider: string, env: NodeJS.ProcessEnv): Promise<string> {
  const path = file.startsWith('~/') || file.startsWith('~\\') ? join(homedir(), file.slice(2)) : file;
  let raw: Record<string, unknown>;
  try {raw = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')));}
  catch {throw new ProviderError('Cannot read the auth file; check the path and JSON format');}
  const value = raw[provider];
  if (value === undefined) return '';
  const credential = credentialSchema.safeParse(value);
  if (!credential.success) throw new ProviderError('This provider credential is not a supported api_key; OAuth is not available yet');
  const key = credential.data.key;
  if (key.startsWith('!')) throw new ProviderError('Auth commands are not supported yet; use a key or an environment variable reference');
  const reference = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(key);
  if (reference) return env[reference[1] ?? reference[2]!] ?? credential.data.env?.[reference[1] ?? reference[2]!] ?? '';
  if (key.includes('$')) throw new ProviderError('The auth file only supports a complete $ENV or ${ENV} reference');
  return key;
}

function readStoredModelsForProvider(name: string): string[] {
  const storePaths = [
    join(homedir(), '.logox', 'models-store.json'),
    join(homedir(), '.logox', 'models-cache.json'),
  ];
  for (const p of storePaths) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw[name] && typeof raw[name] === 'object' && Array.isArray((raw[name] as Record<string, unknown>).models)) {
          const list = ((raw[name] as Record<string, unknown>).models as Array<Record<string, unknown>>)
            .map(m => m.id).filter(id => typeof id === 'string') as string[];
          if (list.length > 0) return list;
        }
        if (Array.isArray(raw.models)) {
          const list = (raw.models as Array<Record<string, unknown>>)
            .filter(m => m.provider === name).map(m => m.id).filter(id => typeof id === 'string') as string[];
          if (list.length > 0) return list;
        }
      }
    } catch {}
  }
  return [];
}

type ProviderEntry = Config['providers'][string];
/**
 * The config entry a stored record stands for. The record owns its endpoint: `base_url`, `kind` and `api` are exactly what it stores,
 * template-based or not. A template only supplies what the record does not store (the key variable); `model_kinds` routing of a template
 * applies through `modelSettings()` only while the URL is still the template's official one.
 */
function recordEntry(record: CustomProviderRecord, existing: ProviderEntry | undefined): ProviderEntry {
  const template = record.catalog && Object.hasOwn(presets, record.name) ? presets[record.name] : undefined;
  const kind = record.kind;
  return {
    ...existing,
    kind,
    base_url: record.base_url,
    ...(template?.api_key_env && !existing?.api_key_env ? {api_key_env: template.api_key_env} : {}),
    default_model: record.default_model ?? existing?.default_model,
    api: record.api ?? (kind === 'anthropic' ? undefined : existing?.api),
  };
}

/** Unifies provider selection and request-time authentication; owns no agent history or task state. */
export class ProviderRegistry {
  private config: Config;
  private transport: ReturnType<typeof createHttpTransport> | undefined;
  readonly fetcher: typeof fetch;
  private closed = false;
  private readonly capabilities = new Map<string, {window?: number; maxOutput?: number}>();
  readonly customProviders = new Map<string, CustomProviderRecord>();
  /** One gate per normalized endpoint, shared with candidates so every model request to an endpoint queues together. */
  /** Providers whose stored credential was seen to be an OAuth (subscription) login; set by settingsFor() and used by sync table lookups. */
  private readonly oauthProviders = new Set<string>();
  private gates = new Map<string, RequestGate>();
  /** Gate tuning; tests shorten cooldowns. Applies to gates created afterwards. */
  gateOptions: RequestGateOptions = {};
  constructor(config: Config, private readonly env: NodeJS.ProcessEnv = process.env,
    fetcher?: typeof fetch,
    readonly auth = new AuthStorage(),
    readonly customStorage = new CustomProviderStorage()) {
    this.config = config;
    this.fetcher = fetcher ?? ((input, init) => {
      if (this.closed) return Promise.reject(new ProviderError('Model network service is closed'));
      this.transport ??= createHttpTransport(this.env);
      return this.transport.fetch(input, init);
    });
  }
  async close(): Promise<void> {this.closed = true; await this.transport?.close();}

  /** Loads the provider store into the config; first writes a `catalog: true` record for every template that already has a credential but no record. */
  async syncCustom(): Promise<void> {
    const list = await this.customStorage.list();
    const known = new Set(list.map(record => record.name));
    // One-time reconciliation: a credential for a template always belongs to a provider record. Credentials that match nothing are left alone.
    const credentials = await this.auth.providers().catch(() => [] as string[]);
    for (const name of credentials) {
      const template = presets[name];
      if (!template || known.has(name) || !Object.hasOwn(presets, name)) continue;
      const record: CustomProviderRecord = {name, base_url: template.base_url, kind: template.kind, catalog: true};
      try {await this.customStorage.save(record);} catch {continue;}
      list.push(record); known.add(name);
    }
    for (const record of list) {
      this.customProviders.set(record.name, record);
      this.config.providers[record.name] = recordEntry(record, this.config.providers[record.name]);
    }
  }

  /** Makes sure a template has its `catalog: true` record (saving a key or finishing an account sign-in calls this); other names are ignored. */
  async ensureTemplateRecord(name: string): Promise<void> {
    const template = Object.hasOwn(presets, name) ? presets[name] : undefined;
    if (!template || this.customProviders.has(name) || await this.customStorage.get(name)) return;
    await this.customStorage.save({name, base_url: template.base_url, kind: template.kind, catalog: true});
    await this.syncCustom();
  }

  async unregister(name: string): Promise<void> {
    if (this.customProviders.has(name)) {
      await this.customStorage.remove(name);
      this.customProviders.delete(name);
      delete this.config.providers[name];
    }
    await this.auth.remove(name);
  }

  /**
   * The providers: saved records, then providers declared in config, then templates whose key variable is set in the environment,
   * then the selected provider. Templates the user never set up are not providers (see `templateNames()`).
   */
  names(): string[] {
    const fromEnvironment = Object.entries(presets).filter(([, template]) => template.api_key_env && this.env[template.api_key_env]).map(([name]) => name);
    return [...new Set([...this.customProviders.keys(), ...Object.keys(this.config.providers), ...fromEnvironment, this.config.provider.name])];
  }
  /** Every built-in template name, set up or not. */
  templateNames(): string[] {return templateNames();}
  /** Names `/login <name>` and its completion accept: the providers plus the templates, minus keyless local endpoints. */
  loginNames(): string[] {
    return [...new Set([...this.names(), ...this.templateNames()])].filter(name => {
      const config = this.configFor(name), definition = config.providers[name] ?? presets[name];
      const host = new URL(modelSettings(config, this.env).baseUrl).hostname;
      return !!(config.provider.api_key_env ?? definition?.api_key_env) || !['localhost', '127.0.0.1', '[::1]'].includes(host);
    });
  }
  selection(): {provider: string; model: string; kind: ModelSettings['kind']; baseUrl: string} {
    const {model, kind, baseUrl} = modelSettings(this.config, this.env);
    return {provider: this.config.provider.name, model, kind, baseUrl};
  }
  private configFor(name: string, model?: string): Config {
    const current = this.config.provider;
    const custom = this.customProviders.get(name);
    const providers = {...this.config.providers};
    if (custom) providers[name] = recordEntry(custom, providers[name]);
    return {...this.config, providers, provider: name === current.name
      ? {...current, ...(model !== undefined ? {model, ...(model !== current.model ? {context_window: undefined, max_output_tokens: undefined, max_images: undefined} : {})} : {})}
      : {name, model: model ?? '', temperature: current.temperature, max_tokens: current.max_tokens, timeout: current.timeout, thinking_effort: current.thinking_effort}};
  }
  thinking(): {effort: ThinkingEffort; levels: readonly ThinkingEffort[]} {
    const settings = modelSettings(this.config, this.env);
    return {effort: this.config.provider.thinking_effort, levels: settings.thinkingLevels ?? ['auto']};
  }
  selectEffort(effort: ThinkingEffort): void {
    if (!this.thinking().levels.includes(effort)) throw new ProviderError('The current model does not declare support for this thinking level');
    this.config = {...this.config, provider: {...this.config.provider, thinking_effort: effort}};
  }
  candidate(name: string, model?: string): ProviderRegistry {
    const next = new ProviderRegistry(this.configFor(name, model), this.env, this.fetcher, this.auth, this.customStorage);
    next.gates = this.gates;
    next.gateOptions = this.gateOptions;
    for (const [k, v] of this.customProviders) next.customProviders.set(k, v);
    for (const [key, value] of this.capabilities) next.capabilities.set(key, {...value});
    const settings = modelSettings(next.config, this.env);
    if (!settings.thinkingLevels?.includes(next.config.provider.thinking_effort)) next.config.provider.thinking_effort = 'auto';
    return next;
  }
  adopt(next: ProviderRegistry): void {this.config = next.config;}
  select(name: string, model?: string): void {
    const next = this.configFor(name, model);
    modelSettings(next, this.env);
    this.config = next;
  }
  /** Settings as configured for one provider/model, without credentials or network access. */
  configuredSettings(name: string, model?: string): ModelSettings {return modelSettings(this.configFor(name, model), this.env);}
  async settings(requireAuth = true): Promise<ModelSettings> {return this.settingsFor(this.config.provider.name, requireAuth);}
  private async settingsFor(name: string, requireAuth: boolean): Promise<ModelSettings> {
    const config = this.configFor(name), settings = modelSettings(config, this.env), provider = config.provider;
    const learned = this.capabilities.get(JSON.stringify([name, settings.model]));
    const builtin = settings.baseUrl.replace(/\/$/, '') === presets[name]?.base_url.replace(/\/$/, '') ? modelCapacities[providerFamily(name) + '/' + settings.model] : undefined;
    settings.maxTokens = Math.min(settings.maxTokens, config.provider.max_output_tokens ?? config.models[name + '/' + settings.model]?.max_output_tokens ?? learned?.maxOutput ?? builtin?.maxOutput ?? Infinity);
    const cred = await this.auth.credential(name);
    if (cred?.type === 'oauth') this.oauthProviders.add(name);
    // The stored credential type decides; the only OAuth login Logox ships is the ChatGPT account (`oauth.ts`), so no provider name is consulted.
    if (cred?.type === 'oauth') {
      const expires = cred.expires_at ?? cred.expires ?? 0;
      if (expires && Date.now() >= expires - 180_000) {
        try {
          const refreshed = await refreshOpenAIToken(cred, this.fetcher);
          await this.auth.saveOAuth(name, refreshed, new AbortController().signal);
          settings.key = typeof refreshed.access_token === 'string' ? refreshed.access_token : '';
        } catch {
          settings.key = cred.access_token ?? cred.access ?? settings.key;
        }
      } else {
        settings.key = cred.access_token ?? cred.access ?? settings.key;
      }
    } else {
      settings.key = await this.auth.key(name) || settings.key;
    }
    const selected = config.providers[name] ?? presets[name];
    const file = provider.auth_file ?? config.providers[name]?.auth_file;
    if (!settings.key && file) settings.key = await storedKey(file, provider.auth_provider ?? config.providers[name]?.auth_provider ?? name, this.env);
    const keyEnv = provider.api_key_env ?? selected?.api_key_env;
    if (requireAuth && !settings.key && presets[name]?.account && !keyEnv && !file) throw new ProviderError('Provider ' + name + ' is not logged in; use /login to sign in with your account', false, 'authentication');
    if (requireAuth && !settings.key && (keyEnv || file)) throw new ProviderError('Provider ' + name + ' is not logged in; use /login, set ' + (keyEnv ?? 'api_key_env') + ', or check auth_file', false, 'authentication');
    return settings;
  }
  /** Built-in table lookup for a provider/model honouring `[catalogs.<provider>]` gateway mapping; `oauth` prefers the subscription catalog. */
  tableHit(name: string, model: string, baseUrl?: string, oauth = this.oauthProviders.has(name) || Boolean(presets[name]?.account)): Resolution | undefined {
    return modelTable.resolve(name, model, {catalogs: this.config.catalogs, baseUrl: baseUrl ?? this.configFor(name).providers[name]?.base_url ?? presets[name]?.base_url, oauth});
  }
  capacity(name = this.config.provider.name, model?: string): ModelCapacity {
    const config = this.configFor(name, model), settings = modelSettings(config, this.env);
    if (!settings.model) throw new ProviderError('No model configured; use /model to select one');
    const learned = this.capabilities.get(JSON.stringify([name, settings.model]));
    const override = config.models[name + '/' + settings.model];
    const hit = this.tableHit(name, settings.model, settings.baseUrl);
    const table = hit && hit.confidence !== 'inferred' ? {window: hit.model.window, maxOutput: hit.model.maxOutput} : undefined;
    const guessed = hit?.confidence === 'inferred' ? {window: hit.model.window, maxOutput: hit.model.maxOutput} : undefined;
    const base = modelCapacities[providerFamily(name) + '/' + settings.model]
      ?? modelCapacities['openai/' + settings.model];
    const isAntigravity = name === 'antigravity' || settings.baseUrl.includes('8045');
    const cleanModel = settings.model.toLowerCase();
    const isReasoning = isOpenAiReasoningModel(cleanModel);
    const isClaudeOrGemini = cleanModel.includes('gemini') || cleanModel.includes('claude');
    const defaultWindow = isAntigravity && isClaudeOrGemini ? 1_000_000
      : isClaudeOrGemini ? (cleanModel.includes('opus-4-6') || cleanModel.includes('sonnet-4-6') || cleanModel.includes('gemini') ? 1_000_000 : 200_000)
      : isReasoning ? 272_000
      : cleanModel.includes('gpt-4') ? 128_000
      : undefined;
    const defaultOutput = isAntigravity && cleanModel.includes('claude') ? 128_000
      : isClaudeOrGemini ? 64_000
      : isReasoning ? 128_000
      : cleanModel.includes('gpt-4') ? 16_384
      : undefined;
    const window = config.provider.context_window ?? override?.context_window ?? learned?.window ?? table?.window ?? base?.window ?? defaultWindow ?? guessed?.window;
    const maxOutput = config.provider.max_output_tokens ?? override?.max_output_tokens ?? learned?.maxOutput ?? table?.maxOutput ?? base?.maxOutput ?? defaultOutput ?? guessed?.maxOutput;
    if (!window) throw new ProviderError('Context window for model ' + name + '/' + settings.model + ' is unknown; set context_window under [models."' + name + '/' + settings.model + '"] and restart (for local models, use the actual num_ctx).', false, 'capacity');
    // Anthropic documents 100 images per request; every other protocol has no built-in limit and relies on configuration or a provider rejection.
    const maxImages = config.provider.max_images ?? override?.max_images ?? (settings.kind === 'anthropic' ? ANTHROPIC_MAX_IMAGES : undefined);
    return {identity: JSON.stringify([name, settings.model, settings.baseUrl, settings.kind, window, maxOutput]),
      window, ...(maxOutput ? {maxOutput} : {}), ...(maxImages ? {maxImages} : {})};
  }
  /** Gate key is the endpoint only (lowercase origin plus path); credentials, query and fragment are never part of it. */
  private gateFor(baseUrl: string): RequestGate {
    let key: string;
    try {
      const url = new URL(baseUrl);
      key = url.protocol.toLowerCase() + '//' + url.host.toLowerCase() + url.pathname.replace(/\/+$/, '');
    } catch {key = baseUrl.trim().replace(/\/+$/, '').toLowerCase();}
    let gate = this.gates.get(key);
    if (!gate) {gate = new RequestGate(this.gateOptions); this.gates.set(key, gate);}
    return gate;
  }
  providerFor(name: string, model?: string): Provider {
    return this.candidate(name, model).provider();
  }
  provider(): Provider {
    const registry = this;
    return {get capabilities() {return resolveProviderCapabilities(modelSettings(registry.config, registry.env));},
      cacheProfile: async (request, signal) => {
        signal.throwIfAborted();
        const settings = await registry.settings(false);
        return createProvider(settings, this.fetcher).cacheProfile?.(request, signal);
      },
      resolveCapabilities: async signal => {
        signal.throwIfAborted();
        const settings = await registry.settings(false);
        signal.throwIfAborted();
        return resolveProviderCapabilities(settings);
      }, respond: async (request, onDelta, signal) => {
      signal.throwIfAborted();
      const settings = await this.settings();
      signal.throwIfAborted();
      const inner = createProvider(settings, this.fetcher);
      return this.gateFor(settings.baseUrl).run(() => inner.respond(request, onDelta, signal), signal);
    }};
  }
  async models(signal: AbortSignal = AbortSignal.timeout(15000)): Promise<string[]> {
    return this.modelsFor(this.config.provider.name, signal);
  }
  /** The models in use for a provider: the enabled subset when one is saved, otherwise everything `availableModels()` finds. */
  async modelsFor(name: string, signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted();
    const enabled = this.customProviders.get(name)?.models;
    if (enabled?.length) return [...enabled];
    return this.availableModels(name, signal);
  }
  /** Everything the provider offers, ignoring the enabled subset: the live `/models` list, or the stored and built-in lists when the endpoint does not answer (a subscription login cannot list models). With `requireAuth` false a provider that is not signed in is still listed from those fallbacks. */
  async availableModels(name: string, signal: AbortSignal, requireAuth = true): Promise<string[]> {
    signal.throwIfAborted();
    const settings = await this.settingsFor(name, requireAuth);
    signal.throwIfAborted();
    const headers: Record<string, string> = {};
    if ((settings.providerKind ?? settings.kind) === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (settings.key) headers['x-api-key'] = settings.key;
    } else if (settings.key) headers.authorization = 'Bearer ' + settings.key;
    let response: Response;
    try {response = await this.fetcher(settings.baseUrl.replace(/\/$/, '') + '/models', {headers, signal, redirect: 'error'});}
    catch {signal.throwIfAborted(); throw new ProviderError('Model list connection failed', true);}
    if (!response.ok) {
      await response.body?.cancel();
      const stored = readStoredModelsForProvider(name);
      if (stored.length > 0) return [...new Set(stored)].sort();
      const known = this.knownModels(name);
      if (known.length > 0) return [...new Set(known)].sort();
      throw new ProviderError('Model list query failed (HTTP ' + response.status + ')');
    }
    const payload = modelsSchema.safeParse(await response.json().catch(() => undefined));
    if (!payload.success) {
      const stored = readStoredModelsForProvider(name);
      if (stored.length > 0) return [...new Set(stored)].sort();
      const known = this.knownModels(name);
      if (known.length > 0) return [...new Set(known)].sort();
      throw new ProviderError('Model list format is invalid');
    }
    for (const model of payload.data.data) {
      const window = model.context_window ?? model.context_length;
      this.capabilities.set(JSON.stringify([name, model.id]), {...(window ? {window} : {}), ...(model.max_output_tokens ? {maxOutput: model.max_output_tokens} : {})});
    }
    return [...new Set(payload.data.data.map(model => model.id))].sort();
  }
  /** Offline model list: base capacities plus the built-in table for the catalogs this provider maps to. */
  private knownModels(name: string): string[] {
    const fromBase = Object.keys(modelCapacities).filter(k => k.startsWith(name + '/')).map(k => k.slice(name.length + 1));
    const settings = modelSettings(this.configFor(name), this.env);
    const catalog = modelTable.catalogsFor(name, {catalogs: this.config.catalogs, baseUrl: settings.baseUrl})[0];
    return [...fromBase, ...(catalog && (name === catalog || this.config.catalogs[name]?.mirror !== undefined) ? modelTable.modelIds(catalog) : [])];
  }
  /** Queries authenticated cloud and configured local endpoints; does not change the current session selection. */
  async modelCatalog(signal: AbortSignal): Promise<{models: {provider: string; id: string}[]; issues: string[]}> {
    const results = await Promise.allSettled(this.names().map(async name => {
      const settings = await this.settingsFor(name, false);
      signal.throwIfAborted();
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.baseUrl).hostname);
      const definition = this.config.providers[name];
      const configured = name === this.config.provider.name || !!definition;
      const noAuth = !(name === this.config.provider.name ? this.config.provider.api_key_env : undefined) && !definition?.api_key_env && !definition?.auth_file;
      if (!settings.key && !(configured && (local || noAuth && !!definition))) return [];
      const querySignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      try {return (await this.modelsFor(name, querySignal)).map(id => ({provider: name, id}));}
      catch {signal.throwIfAborted(); throw new Error(name + ': model list unavailable; check authentication or connection');}
    }));
    signal.throwIfAborted();
    const models: {provider: string; id: string}[] = [], issues: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') models.push(...result.value);
      else issues.push(result.reason instanceof Error ? result.reason.message : 'Model list query failed');
    }
    return {models, issues};
  }
  async check(signal: AbortSignal = new AbortController().signal): Promise<{text: string; elapsedMs: number}> {
    const started = Date.now();
    const settings = await this.settings();
    const isOAuth = (await this.auth.credential(this.config.provider.name))?.type === 'oauth';
    let checkModel = settings.model;
    if (isOAuth) {
      if (!checkModel || checkModel.includes('gpt-4') || checkModel.includes('o3-mini')) {
        checkModel = 'gpt-6.1-sol';
      }
    }
    const turn = await createProvider({...settings, model: checkModel, maxTokens: Math.min(settings.maxTokens, 512)}, this.fetcher).respond({
      system: 'This is a connection check. Answer briefly.',
      messages: [{role: 'user', text: 'Reply with exactly LOGOX_PROVIDER_READY.'}], tools: [],
      thinking: false,
    }, () => {}, signal);
    if (turn.stop !== 'complete' || !turn.message.text.trim()) throw new ProviderError('Connection check did not get a complete response; stop reason: ' + turn.stop);
    return {text: turn.message.text, elapsedMs: Date.now() - started};
  }
}
