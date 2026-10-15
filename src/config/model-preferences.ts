import {readFile, rm, writeFile} from 'node:fs/promises';
import {replaceFile} from '../store/replace-file.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {withFileLock} from '../store/file-lock.js';

export const effortSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'max']);
export type ThinkingEffort = z.infer<typeof effortSchema>;
export const preferenceSchema = z.strictObject({version: z.literal(1),
  provider: z.string().min(1).max(256), model: z.string().max(1024), effort: effortSchema});
export type ModelPreference = z.infer<typeof preferenceSchema>;
/** 独立状态文件；锁内重读，损坏时不覆盖。 */
export class StateFile<T> {
  constructor(readonly path: string, private readonly schema: z.ZodType<T>) {}
  async read(): Promise<T | undefined> {
    let content: string;
    try {content = await readFile(this.path, 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('无法读取状态文件：' + this.path);}
    try {return this.schema.parse(JSON.parse(content));}
    catch {throw new Error('状态文件格式无效，原文件保留：' + this.path);}
  }
  async save(value: T): Promise<void> {
    await this.update(() => value);
  }
  async update(transform: (current: T | undefined) => T): Promise<void> {
    await withFileLock(this.path, async () => {
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      try {
        const parsed = this.schema.parse(transform(await this.read()));
        await writeFile(temporary, JSON.stringify(parsed) + '\n', {flag: 'wx', mode: 0o600});
        await replaceFile(temporary, this.path);
      } catch (error) {
        throw new Error('保存状态失败，当前选择及原文件保留：' + this.path, {cause: error});
      } finally {await rm(temporary, {force: true}).catch(() => {}); }
    });
  }
}
