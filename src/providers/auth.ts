import {mkdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';

const schema = z.record(z.string(), z.object({type: z.literal('api_key'), key: z.string().min(1).max(16384)}));
type Credentials = z.infer<typeof schema>;

/** 用户凭据独立保存，既不属于项目配置，也不属于会话账本。 */
export class AuthStorage {
  constructor(readonly path = join(homedir(), '.logox', 'auth.json')) {}
  private async read(): Promise<Credentials> {
    let content: string;
    try {content = await readFile(this.path, 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('无法读取 LOGOX 认证文件');}
    try {return schema.parse(JSON.parse(content));}
    catch {throw new Error('LOGOX 认证文件格式无效；保留原文件，请检查后重试');}
  }
  async key(provider: string): Promise<string> {return (await this.read())[provider]?.key ?? '';}
  async providers(): Promise<string[]> {return Object.keys(await this.read());}
  async save(provider: string, input: string, signal: AbortSignal): Promise<void> {
    const key = input.trim();
    if (!key || key.length > 16384 || /[\x00-\x20\x7f]/.test(key)) throw new Error('请输入有效的 API key，不能包含空格或控制字符');
    if (!provider || ['__proto__', 'constructor', 'prototype'].includes(provider)) throw new Error('提供商名称无效');
    signal.throwIfAborted();
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
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      const credentials = await this.read();
      credentials[provider] = {type: 'api_key', key};
      signal.throwIfAborted();
      await writeFile(temporary, JSON.stringify(credentials, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      signal.throwIfAborted();
      await rename(temporary, this.path);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith('LOGOX 认证文件格式')) throw error;
      throw new Error('保存 API key 失败，原有认证未被覆盖');
    } finally {
      await rm(temporary, {force: true}).catch(() => {});
      await rmdir(lock).catch(() => {});
    }
  }
}
