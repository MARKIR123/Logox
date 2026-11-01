import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseYaml} from 'yaml';

/**
 * An importable external credential. The secret is used only at the moment of import and never enters login state snapshots,
 * stage messages or session ledgers; label is a description that is safe to display.
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

/** Maps known credential variable names to Logox provider names; unregistered variables only accept the `<NAME>_API_KEY` form. */
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

/** Read-only discovery of credentials other agents are logged in with; any read failure just means "nothing to import" and does not affect login itself. */
export async function discoverImportable(roots: ImportRoots = {}): Promise<ImportedCredential[]> {
  const codexHome = roots.codexHome ?? join(homedir(), '.codex');
  const dshHome = roots.dshHome ?? join(homedir(), '.dsh');
  const [codex, dsh] = await Promise.all([fromCodex(codexHome), fromDsh(dshHome)]);
  return [...codex, ...dsh];
}
