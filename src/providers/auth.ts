import {mkdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';

export const apiKeyCredentialSchema = z.object({
  type: z.literal('api_key'),
  key: z.string().min(1).max(16384),
});

export const oauthCredentialSchema = z.object({
  type: z.literal('oauth'),
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_at: z.number().optional(),
  account_id: z.string().optional(),
});

export const credentialSchema = z.discriminatedUnion('type', [
  apiKeyCredentialSchema,
  oauthCredentialSchema,
]);
export type Credential = z.infer<typeof credentialSchema>;
export type OAuthToken = Omit<z.infer<typeof oauthCredentialSchema>, 'type'>;

const schema = z.record(z.string(), credentialSchema);
type Credentials = z.infer<typeof schema>;

/** 用户凭据独立保存，既不属于项目配置，也不属于会话账本。 */
export class AuthStorage {
  readonly fallbackPath: string | undefined;
  constructor(
    readonly path = join(homedir(), '.logox-ts', 'auth.json'),
    fallbackPath?: string,
  ) {
    this.fallbackPath = fallbackPath ?? (path === join(homedir(), '.logox-ts', 'auth.json') ? join(homedir(), '.logox', 'auth.json') : undefined);
  }
  private async read(): Promise<Credentials> {
    let content: string | undefined;
    try {content = await readFile(this.path, 'utf8');}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.fallbackPath) {
          try {content = await readFile(this.fallbackPath, 'utf8');}
          catch (fallbackErr) {
            if ((fallbackErr as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw new Error('无法读取 LOGOX 认证文件');
          }
        } else {
          return {};
        }
      } else {
        throw new Error('无法读取 LOGOX 认证文件');
      }
    }
    try {return schema.parse(JSON.parse(content));}
    catch {throw new Error('LOGOX 认证文件格式无效；保留原文件，请检查后重试');}
  }

  async credential(provider: string): Promise<Credential | undefined> {
    return (await this.read())[provider];
  }

  async key(provider: string): Promise<string> {
    const cred = (await this.read())[provider];
    if (!cred) return '';
    return cred.type === 'api_key' ? cred.key : cred.access_token;
  }

  async providers(): Promise<string[]> {return Object.keys(await this.read());}

  private async withLock<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const lock = this.path + '.lock';
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700}).catch(() => {throw new Error('无法创建 LOGOX 认证目录');});
    let locked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      signal.throwIfAborted();
      try {await mkdir(lock, {mode: 0o700}); locked = true; break;}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('无法锁定 LOGOX 认证文件');
        await delay(25, undefined, {signal});
      }
    }
    if (!locked) throw new Error('另一个进程正在保存认证，请稍后重试');
    try {
      return await action();
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }

  private async atomicWrite(credentials: Credentials, signal: AbortSignal): Promise<void> {
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(credentials, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      signal.throwIfAborted();
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, {force: true}).catch(() => {});
    }
  }

  async save(provider: string, input: string, signal: AbortSignal): Promise<void> {
    const key = input.trim();
    if (!key || key.length > 16384 || /[\x00-\x20\x7f]/.test(key)) throw new Error('请输入有效的 API key，不能包含空格或控制字符');
    if (!provider || ['__proto__', 'constructor', 'prototype'].includes(provider)) throw new Error('提供商名称无效');
    signal.throwIfAborted();
    await this.withLock(signal, async () => {
      const credentials = await this.read();
      credentials[provider] = {type: 'api_key', key};
      signal.throwIfAborted();
      await this.atomicWrite(credentials, signal);
    });
  }

  async saveOAuth(provider: string, token: OAuthToken, signal: AbortSignal): Promise<void> {
    if (!provider || ['__proto__', 'constructor', 'prototype'].includes(provider)) throw new Error('提供商名称无效');
    signal.throwIfAborted();
    await this.withLock(signal, async () => {
      const credentials = await this.read();
      credentials[provider] = {type: 'oauth', ...token};
      signal.throwIfAborted();
      await this.atomicWrite(credentials, signal);
    });
  }

  async remove(provider: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    await this.withLock(signal, async () => {
      const credentials = await this.read();
      delete credentials[provider];
      signal.throwIfAborted();
      await this.atomicWrite(credentials, signal);
    });
  }
}
