import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import type {ModelCapacity} from '../context/contracts.js';
import type {Provider} from '../runtime/messages.js';
import {modelSettings, presets, type Config, type ModelSettings} from '../config/config.js';
import {createProvider, ProviderError} from './http.js';
import {modelCapacities} from './model-capacities.js';
import {type ThinkingEffort, isOpenAiReasoningModel} from '../config/model-preferences.js';
import {AuthStorage} from './auth.js';
import {CustomProviderStorage, type CustomProviderRecord} from './custom-storage.js';
import {createHttpTransport} from './transport.js';
import {refreshOpenAIToken} from './oauth.js';

const credentialSchema = z.object({type: z.literal('api_key'), key: z.string(), env: z.record(z.string(), z.string()).optional()});
const modelsSchema = z.object({data: z.array(z.object({id: z.string().min(1),
  context_window: z.number().int().min(256).optional(), context_length: z.number().int().min(256).optional(),
  max_output_tokens: z.number().int().positive().optional(),
})).max(10000)});

async function storedKey(file: string, provider: string, env: NodeJS.ProcessEnv): Promise<string> {
  const path = file.startsWith('~/') || file.startsWith('~\\') ? join(homedir(), file.slice(2)) : file;
  let raw: Record<string, unknown>;
  try {raw = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')));}
  catch {throw new ProviderError('无法读取认证文件；检查路径与 JSON 格式');}
  const value = raw[provider];
  if (value === undefined) return '';
  const credential = credentialSchema.safeParse(value);
  if (!credential.success) throw new ProviderError('该提供商认证不是受支持的 api_key；OAuth 尚未接入');
  const key = credential.data.key;
  if (key.startsWith('!')) throw new ProviderError('认证命令尚未接入；请使用密钥或环境变量引用');
  const reference = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(key);
  if (reference) return env[reference[1] ?? reference[2]!] ?? credential.data.env?.[reference[1] ?? reference[2]!] ?? '';
  if (key.includes('$')) throw new ProviderError('认证文件只支持完整的 $ENV 或 ${ENV} 引用');
  return key;
}

function readStoredModelsForProvider(name: string): string[] {
  const storePaths = [
    join(homedir(), '.logox-ts', 'models-store.json'),
    join(homedir(), '.logox-ts', 'models-cache.json'),
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

/** 统一提供商选择与请求时认证；不拥有 Agent 历史或任务状态。 */
export class ProviderRegistry {
  private config: Config;
  private transport: ReturnType<typeof createHttpTransport> | undefined;
  readonly fetcher: typeof fetch;
  private closed = false;
  private readonly capabilities = new Map<string, {window?: number; maxOutput?: number}>();
  readonly customProviders = new Map<string, CustomProviderRecord>();
  constructor(config: Config, private readonly env: NodeJS.ProcessEnv = process.env,
    fetcher?: typeof fetch,
    readonly auth = new AuthStorage(),
    readonly customStorage = new CustomProviderStorage()) {
    this.config = config;
    this.fetcher = fetcher ?? ((input, init) => {
      if (this.closed) return Promise.reject(new ProviderError('模型网络服务已关闭'));
      this.transport ??= createHttpTransport(this.env);
      return this.transport.fetch(input, init);
    });
  }
  async close(): Promise<void> {this.closed = true; await this.transport?.close();}

  async syncCustom(): Promise<void> {
    const list = await this.customStorage.list();
    for (const record of list) {
      this.customProviders.set(record.name, record);
      this.config.providers[record.name] = {
        kind: record.kind,
        base_url: record.base_url,
        default_model: record.default_model,
      };
    }
  }

  async unregister(name: string): Promise<void> {
    await this.auth.remove(name);
    if (this.customProviders.has(name)) {
      await this.customStorage.remove(name);
      this.customProviders.delete(name);
      delete this.config.providers[name];
    }
  }

  names(): string[] {return [...new Set([...Object.keys(presets), ...Object.keys(this.config.providers), ...this.customProviders.keys(), this.config.provider.name])];}
  loginNames(): string[] {
    return this.names().filter(name => {
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
    if (custom) {
      providers[name] = {
        kind: custom.kind,
        base_url: custom.base_url,
        default_model: custom.default_model,
      };
    }
    return {...this.config, providers, provider: name === current.name
      ? {...current, ...(model !== undefined ? {model, ...(model !== current.model ? {context_window: undefined, max_output_tokens: undefined} : {})} : {})}
      : {name, model: model ?? '', temperature: current.temperature, max_tokens: current.max_tokens, timeout: current.timeout, thinking_effort: current.thinking_effort}};
  }
  thinking(): {effort: ThinkingEffort; levels: readonly ThinkingEffort[]} {
    const settings = modelSettings(this.config, this.env);
    return {effort: this.config.provider.thinking_effort, levels: settings.thinkingLevels ?? ['auto']};
  }
  selectEffort(effort: ThinkingEffort): void {
    if (!this.thinking().levels.includes(effort)) throw new ProviderError('当前模型未声明支持此思考档位');
    this.config = {...this.config, provider: {...this.config.provider, thinking_effort: effort}};
  }
  candidate(name: string, model?: string): ProviderRegistry {
    const next = new ProviderRegistry(this.configFor(name, model), this.env, this.fetcher, this.auth, this.customStorage);
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
  async settings(requireAuth = true): Promise<ModelSettings> {return this.settingsFor(this.config.provider.name, requireAuth);}
  private async settingsFor(name: string, requireAuth: boolean): Promise<ModelSettings> {
    const config = this.configFor(name), settings = modelSettings(config, this.env), provider = config.provider;
    const learned = this.capabilities.get(JSON.stringify([name, settings.model]));
    const builtin = settings.baseUrl.replace(/\/$/, '') === presets[name]?.base_url.replace(/\/$/, '') ? modelCapacities[name + '/' + settings.model] : undefined;
    settings.maxTokens = Math.min(settings.maxTokens, config.provider.max_output_tokens ?? config.models[name + '/' + settings.model]?.max_output_tokens ?? learned?.maxOutput ?? builtin?.maxOutput ?? Infinity);
    const cred = await this.auth.credential(name);
    if (cred?.type === 'oauth' && (name === 'openai' || name.toLowerCase().includes('openai'))) {
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
    if (requireAuth && !settings.key && (keyEnv || file)) throw new ProviderError('提供商 ' + name + ' 未登录；使用 /login，或设置 ' + (keyEnv ?? 'api_key_env') + ' 或检查 auth_file', false, 'authentication');
    return settings;
  }
  capacity(name = this.config.provider.name, model?: string): ModelCapacity {
    const config = this.configFor(name, model), settings = modelSettings(config, this.env);
    if (!settings.model) throw new ProviderError('尚未配置模型；使用 /model 选择模型');
    const learned = this.capabilities.get(JSON.stringify([name, settings.model]));
    const override = config.models[name + '/' + settings.model];
    const builtin = modelCapacities[name + '/' + settings.model]
      ?? modelCapacities['openai/' + settings.model]
      ?? modelCapacities['openai-compatible/' + settings.model];
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
    const window = config.provider.context_window ?? override?.context_window ?? learned?.window ?? builtin?.window ?? defaultWindow;
    const maxOutput = config.provider.max_output_tokens ?? override?.max_output_tokens ?? learned?.maxOutput ?? builtin?.maxOutput ?? defaultOutput;
    if (!window) throw new ProviderError('模型 ' + name + '/' + settings.model + ' 的上下文窗口未知；在 [models."' + name + '/' + settings.model + '"] 配置 context_window 后重启（本地填实际 num_ctx）。', false, 'capacity');
    return {identity: JSON.stringify([name, settings.model, settings.baseUrl, settings.kind, window, maxOutput]),
      window, ...(maxOutput ? {maxOutput} : {})};
  }
  providerFor(name: string, model?: string): Provider {
    return this.candidate(name, model).provider();
  }
  provider(): Provider {
    return {respond: async (request, onDelta, signal) => {
      signal.throwIfAborted();
      const settings = await this.settings();
      signal.throwIfAborted();
      return createProvider(settings, this.fetcher).respond(request, onDelta, signal);
    }};
  }
  async models(signal: AbortSignal = AbortSignal.timeout(15000)): Promise<string[]> {
    return this.modelsFor(this.config.provider.name, signal);
  }
  async modelsFor(name: string, signal: AbortSignal): Promise<string[]> {
    const settings = await this.settingsFor(name, true);
    signal.throwIfAborted();
    const headers: Record<string, string> = {};
    if (settings.kind === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (settings.key) headers['x-api-key'] = settings.key;
    } else if (settings.key) headers.authorization = 'Bearer ' + settings.key;
    let response: Response;
    try {response = await this.fetcher(settings.baseUrl.replace(/\/$/, '') + '/models', {headers, signal, redirect: 'error'});}
    catch {signal.throwIfAborted(); throw new ProviderError('模型列表连接失败', true);}
    if (!response.ok) {
      await response.body?.cancel();
      const stored = readStoredModelsForProvider(name);
      if (stored.length > 0) return [...new Set(stored)].sort();
      const known = Object.keys(modelCapacities).filter(k => k.startsWith(name + '/')).map(k => k.slice(name.length + 1));
      if (known.length > 0) return [...new Set(known)].sort();
      throw new ProviderError('模型列表查询失败（HTTP ' + response.status + '）');
    }
    const payload = modelsSchema.safeParse(await response.json().catch(() => undefined));
    if (!payload.success) {
      const stored = readStoredModelsForProvider(name);
      if (stored.length > 0) return [...new Set(stored)].sort();
      const known = Object.keys(modelCapacities).filter(k => k.startsWith(name + '/')).map(k => k.slice(name.length + 1));
      if (known.length > 0) return [...new Set(known)].sort();
      throw new ProviderError('模型列表格式无效');
    }
    for (const model of payload.data.data) {
      const window = model.context_window ?? model.context_length;
      this.capabilities.set(JSON.stringify([name, model.id]), {...(window ? {window} : {}), ...(model.max_output_tokens ? {maxOutput: model.max_output_tokens} : {})});
    }
    return [...new Set(payload.data.data.map(model => model.id))].sort();
  }
  /** 查询已认证云端和已配置本地接口；不改变当前会话选择。 */
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
      catch {signal.throwIfAborted(); throw new Error(name + '：模型列表不可用，请检查认证或连接');}
    }));
    signal.throwIfAborted();
    const models: {provider: string; id: string}[] = [], issues: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') models.push(...result.value);
      else issues.push(result.reason instanceof Error ? result.reason.message : '模型列表查询失败');
    }
    return {models, issues};
  }
  async check(signal: AbortSignal = new AbortController().signal): Promise<{text: string; elapsedMs: number}> {
    const started = Date.now();
    const settings = await this.settings();
    const isOAuth = (await this.auth.credential(this.config.provider.name))?.type === 'oauth';
    let checkModel = settings.model;
    if (this.config.provider.name === 'openai' && isOAuth) {
      if (!checkModel || checkModel.includes('gpt-4') || checkModel.includes('o3-mini')) {
        checkModel = 'gpt-6.1-sol';
      }
    }
    const turn = await createProvider({...settings, model: checkModel, maxTokens: Math.min(settings.maxTokens, 512)}, this.fetcher).respond({
      system: 'This is a connection check. Answer briefly.',
      messages: [{role: 'user', text: 'Reply with exactly LOGOX_PROVIDER_READY.'}], tools: [],
      thinking: false,
    }, () => {}, signal);
    if (turn.stop !== 'complete' || !turn.message.text.trim()) throw new ProviderError('连接检查未取得完整正文；停止原因：' + turn.stop);
    return {text: turn.message.text, elapsedMs: Date.now() - started};
  }
}
