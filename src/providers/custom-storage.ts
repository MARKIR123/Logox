import {mkdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';

export const customProviderSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'Provider name must be alphanumeric with dashes/underscores'),
  base_url: z.string().url(),
  kind: z.enum(['openai_compat', 'anthropic']).default('openai_compat'),
  default_model: z.string().optional(),
  api: z.enum(['completions', 'responses']).optional(),
  models: z.array(z.string().min(1)).optional(),
  catalog: z.boolean().optional(),
});
export type CustomProviderRecord = z.infer<typeof customProviderSchema>;

const customStorageSchema = z.record(z.string(), customProviderSchema);
type CustomStorageMap = z.infer<typeof customStorageSchema>;

export class CustomProviderStorage {
  constructor(readonly path = join(homedir(), '.logox', 'custom-providers.json')) {}

  private async read(): Promise<CustomStorageMap> {
    try {
      const content = await readFile(this.path, 'utf8');
      return customStorageSchema.parse(JSON.parse(content.replace(/^﻿/, '')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('Failed to read custom providers file: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  async list(): Promise<CustomProviderRecord[]> {
    const map = await this.read();
    return Object.values(map);
  }

  async get(name: string): Promise<CustomProviderRecord | undefined> {
    const map = await this.read();
    return map[name];
  }

  async save(record: CustomProviderRecord, signal: AbortSignal = new AbortController().signal): Promise<void> {
    const safe = customProviderSchema.parse(record);
    await this.withLock(signal, async () => {
      const map = await this.read();
      map[safe.name] = safe;
      await this.atomicWrite(map, signal);
    });
  }

  async remove(name: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.withLock(signal, async () => {
      const map = await this.read();
      delete map[name];
      await this.atomicWrite(map, signal);
    });
  }

  private async withLock<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const lock = this.path + '.lock';
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
    let locked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      signal.throwIfAborted();
      try {
        await mkdir(lock, {mode: 0o700});
        locked = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot lock custom providers file');
        await delay(25, undefined, {signal});
      }
    }
    if (!locked) throw new Error('Lock timeout on custom providers file');
    try {
      return await action();
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }

  private async atomicWrite(map: CustomStorageMap, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(map, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      signal.throwIfAborted();
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, {force: true}).catch(() => {});
    }
  }
}
