import {mkdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {actorIdSchema, actorModelSchema, type ActorModel} from './definitions.js';

const storageSchema = z.record(actorIdSchema, actorModelSchema);
export type ActorModelMap = z.infer<typeof storageSchema>;

export class ActorModelStorage {
  private cache: ActorModelMap = {};

  constructor(
    readonly path = join(homedir(), '.logox-ts', 'actor-models.json'),
    readonly fallbackPath = join(homedir(), '.logox', 'actor-models.json'),
  ) {
    this.loadSync();
  }

  loadSync(): ActorModelMap {
    for (const p of [this.path, this.fallbackPath]) {
      try {
        const raw = readFileSync(p, 'utf8').replace(/^﻿/, '');
        const parsed = storageSchema.parse(JSON.parse(raw));
        this.cache = {...this.cache, ...parsed};
        return this.cache;
      } catch {}
    }
    return this.cache;
  }

  async read(): Promise<ActorModelMap> {
    const merged: ActorModelMap = {};
    for (const p of [this.fallbackPath, this.path]) {
      try {
        const raw = (await readFile(p, 'utf8')).replace(/^﻿/, '');
        const parsed = storageSchema.parse(JSON.parse(raw));
        Object.assign(merged, parsed);
      } catch {}
    }
    this.cache = merged;
    return merged;
  }

  get(actorId: string): ActorModel | undefined {
    return this.cache[actorId];
  }

  all(): Readonly<ActorModelMap> {
    return this.cache;
  }

  async save(actorId: string, model: ActorModel | undefined, signal: AbortSignal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    await this.withLock(signal, async () => {
      const map = await this.read();
      if (model) {
        map[actorId] = actorModelSchema.parse(model);
      } else {
        delete map[actorId];
      }
      this.cache = map;
      await this.atomicWrite(map, signal);
    });
  }

  private async withLock<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const lock = this.path + '.lock';
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700}).catch(() => {
      throw new Error('Failed to create storage directory');
    });
    let locked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      signal.throwIfAborted();
      try {
        await mkdir(lock, {mode: 0o700});
        locked = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Failed to lock actor models file');
        await delay(25, undefined, {signal});
      }
    }
    if (!locked) throw new Error('Lock timeout: another process is saving actor models');
    try {
      return await action();
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }

  private async atomicWrite(map: ActorModelMap, signal: AbortSignal): Promise<void> {
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
