import {readFile, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {parse} from 'smol-toml';
import {z} from 'zod';

const capacitySchema = z.object({
  context_window: z.number().int().min(256).optional(),
  max_output_tokens: z.number().int().positive().optional(),
});
export const contextPolicySchema = z.object({
  keep_recent_rounds: z.number().int().nonnegative().default(2),
  keep_recent_tools: z.number().int().nonnegative().default(2),
  reserve_tokens: z.number().int().nonnegative().default(32768),
  low_watermark_ratio: z.number().positive().lt(1).default(0.5),
  max_budget_tokens: z.number().int().positive().optional(),
  target_budget_tokens: z.number().int().positive().optional(),
  summary_provider: z.string().min(1).optional(),
  summary_model: z.string().min(1).optional(),
}).refine(policy => !policy.max_budget_tokens || !policy.target_budget_tokens || policy.target_budget_tokens < policy.max_budget_tokens,
  'target_budget_tokens 必须小于 max_budget_tokens');
export type ContextPolicy = z.infer<typeof contextPolicySchema>;
const schema = z.object({
  context: contextPolicySchema.default({keep_recent_rounds: 2, keep_recent_tools: 2, reserve_tokens: 32768, low_watermark_ratio: 0.5}),
  models: z.record(z.string(), capacitySchema).default({}),
  provider: z.object({
    context_window: capacitySchema.shape.context_window, max_output_tokens: capacitySchema.shape.max_output_tokens,
    name: z.string().default('openai-compatible'), model: z.string().default(''),
    base_url: z.string().url().optional(), api_key_env: z.string().optional(),
    auth_file: z.string().min(1).optional(), auth_provider: z.string().min(1).optional(),
    kind: z.enum(['openai_compat', 'anthropic']).optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    max_tokens: z.number().int().positive().default(16384),
    timeout: z.number().positive().default(120),
  }).default({name: 'openai-compatible', model: '', temperature: 0.2, max_tokens: 16384, timeout: 120}),
  kernel: z.object({
    max_iterations: z.number().int().positive().default(50),
    max_retries: z.number().int().nonnegative().max(10).default(3),
  }).default({max_iterations: 50, max_retries: 3}),
  providers: z.record(z.string(), z.object({
    kind: z.enum(['openai_compat', 'anthropic']).default('openai_compat'),
    base_url: z.string().url(), api_key_env: z.string().optional(), default_model: z.string().optional(),
    auth_file: z.string().min(1).optional(), auth_provider: z.string().min(1).optional(),
  })).default({}),
});
export type Config = z.infer<typeof schema>;
export interface ModelSettings {
  kind: 'openai_compat' | 'anthropic'; baseUrl: string; model: string; key: string;
  temperature: number; maxTokens: number; timeoutMs: number; thinkingControl?: boolean;
}
export const presets: Record<string, {kind: ModelSettings['kind']; base_url: string; api_key_env?: string}> = {
  'openai-compatible': {kind: 'openai_compat', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY'},
  deepseek: {kind: 'openai_compat', base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY'},
  ollama: {kind: 'openai_compat', base_url: 'http://127.0.0.1:11434/v1'},
  'lm-studio': {kind: 'openai_compat', base_url: 'http://127.0.0.1:1234/v1'},
  anthropic: {kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_key_env: 'ANTHROPIC_API_KEY'},
};
function pathKey(path: string): string {return process.platform === 'win32' ? path.toLowerCase() : path;}
function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result = {...left};
  for (const [key, value] of Object.entries(right)) {
    if (key === 'api_key') throw new Error('请使用 api_key_env，配置文件不保存密钥');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      let previous = result[key] && typeof result[key] === 'object' ? result[key] as Record<string, unknown> : {};
      const update = value as Record<string, unknown>;
      // 提供商身份改变时，不继承上一个接口的地址、模型或认证。
      if (key === 'provider' && typeof update.name === 'string' && typeof previous.name === 'string' && update.name !== previous.name) {
        previous = Object.fromEntries(Object.entries(previous).filter(([field]) => ['temperature', 'max_tokens', 'timeout'].includes(field)));
      }
      result[key] = merge(previous, update);
    } else result[key] = value;
  }
  return result;
}
export async function loadConfig(cwd: string, overrides: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env, home = homedir(), projectBoundary?: string): Promise<Config> {
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
  const files = [join(home, '.logox', 'config.toml'), ...projectDirectories.map(path => join(path, '.logox', 'config.toml'))];
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
    catch {throw new Error('配置无效：' + file + '（检查 TOML 格式及 api_key_env）');}
  }
  let environment: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('LOGOX__') || value === undefined) continue;
    const path = key.slice(7).toLowerCase().split('__');
    if (path.some(part => !part || ['__proto__', 'constructor', 'prototype', 'api_key'].includes(part))) throw new Error('环境配置键无效');
    const update: Record<string, unknown> = {};
    let cursor = update;
    for (const part of path.slice(0, -1)) {cursor[part] = {}; cursor = cursor[part] as Record<string, unknown>;}
    cursor[path.at(-1)!] = ['name', 'model', 'base_url', 'api_key_env', 'kind', 'default_model', 'auth_file', 'auth_provider'].includes(path.at(-1)!) ? value : /^(true|false)$/.test(value) ? value === 'true' : /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    environment = merge(environment, update);
  }
  return schema.parse(merge(merge(raw, environment), overrides));
}
export function modelSettings(config: Config, env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const selected = config.providers[config.provider.name] ?? presets[config.provider.name];
  if (!selected && !config.provider.base_url) throw new Error('未知 provider：' + config.provider.name);
  const provider = config.provider;
  const baseUrl = provider.base_url ?? selected!.base_url;
  const keyEnv = provider.api_key_env ?? selected?.api_key_env;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型地址必须是无凭据的 HTTP(S) 地址');
  return {kind: provider.kind ?? selected?.kind ?? 'openai_compat', baseUrl,
    model: provider.model || (selected && 'default_model' in selected ? selected.default_model ?? '' : ''),
    key: keyEnv ? env[keyEnv] ?? '' : '',
    temperature: provider.temperature, maxTokens: provider.max_tokens, timeoutMs: provider.timeout * 1000,
    ...(provider.name === 'deepseek' && url.hostname === 'api.deepseek.com' ? {thinkingControl: true} : {})};
}
