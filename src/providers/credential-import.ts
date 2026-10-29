import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseYaml} from 'yaml';

/**
 * 一条可导入的外部凭据。secret 只在导入瞬间使用，绝不进入登录状态快照、
 * 舞台消息或会话账本；label 是可安全展示的描述。
 */
export interface ImportedCredential {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly kind: 'api_key' | 'oauth';
  readonly secret: string;
  readonly accountId?: string | undefined;
}

export interface ImportRoots {
  readonly codexHome?: string | undefined;
  readonly dshHome?: string | undefined;
}

/** 已知的凭据变量名到 Logox 提供商名的映射；未登记的变量只接受 `<NAME>_API_KEY` 形式。 */
const refProviders: Record<string, string> = {
  DEEPSEEK_API_KEY: 'deepseek',
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  XAI_API_KEY: 'xai',
  GROK_API_KEY: 'xai',
};

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {return undefined;}
}

async function fromCodex(home: string): Promise<ImportedCredential[]> {
  const auth = await readJsonObject(join(home, 'auth.json'));
  if (!auth) return [];
  const found: ImportedCredential[] = [];
  const tokens = auth['tokens'];
  const token = tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens as Record<string, unknown> : undefined;
  const access = typeof token?.['access_token'] === 'string' ? token['access_token'].trim() : '';
  if (access) {
    found.push({
      id: 'codex:oauth',
      label: 'Codex · ChatGPT account',
      provider: 'openai',
      kind: 'oauth',
      secret: access,
      ...(typeof token?.['account_id'] === 'string' && token['account_id'] ? {accountId: token['account_id']} : {}),
    });
  }
  const key = typeof auth['OPENAI_API_KEY'] === 'string' ? auth['OPENAI_API_KEY'].trim() : '';
  if (key) found.push({id: 'codex:api_key', label: 'Codex · OPENAI_API_KEY', provider: 'openai', kind: 'api_key', secret: key});
  return found;
}

async function fromDsh(home: string): Promise<ImportedCredential[]> {
  let text: string;
  try {text = await readFile(join(home, '.credentials.yaml'), 'utf8');} catch {return [];}
  let parsed: unknown;
  try {parsed = parseYaml(text);} catch {return [];}
  const refs = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as {refs?: unknown}).refs : undefined;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return [];
  const found: ImportedCredential[] = [];
  for (const [ref, value] of Object.entries(refs as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const provider = refProviders[ref] ?? (/^[A-Z0-9_]+_API_KEY$/.test(ref) ? ref.slice(0, -'_API_KEY'.length).toLowerCase() : '');
    if (!provider) continue;
    found.push({id: 'dsh:' + ref, label: 'dsh credentials · ' + ref, provider, kind: 'api_key', secret: value.trim()});
  }
  return found;
}

/** 只读发现其他 agent 已登录的凭据；任何读取失败都只是“没有可导入项”，不影响登录本身。 */
export async function discoverImportable(roots: ImportRoots = {}): Promise<ImportedCredential[]> {
  const codexHome = roots.codexHome ?? join(homedir(), '.codex');
  const dshHome = roots.dshHome ?? join(homedir(), '.dsh');
  const [codex, dsh] = await Promise.all([fromCodex(codexHome), fromDsh(dshHome)]);
  return [...codex, ...dsh];
}
