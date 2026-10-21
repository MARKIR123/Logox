import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ProviderRegistry} from './registry.js';
import {detectEffortLevels} from '../config/model-grouping.js';

export const discoveredModelSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  window: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  thinkingLevels: z.array(z.string()).optional(),
  isOffline: z.boolean().optional(),
  lastSeen: z.number().optional(),
});
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

const cacheSchema = z.object({
  version: z.literal(1),
  updatedAt: z.number(),
  models: z.array(discoveredModelSchema),
});

export class ModelPool {
  private models: DiscoveredModel[] = [];

  constructor(
    private readonly registry?: ProviderRegistry,
    readonly cachePath = join(homedir(), '.logox', 'models-store.json'),
  ) {
    this.loadCacheSync();
  }

  setMockModels(models: DiscoveredModel[]): void {
    this.models = [...models];
  }

  snapshot(): readonly DiscoveredModel[] {
    if (!this.models.length) this.loadCacheSync();
    return this.models;
  }

  loadCacheSync(): DiscoveredModel[] {
    // 1. Try primary models-store.json
    try {
      const content = readFileSync(this.cachePath, 'utf8');
      const parsed = cacheSchema.parse(JSON.parse(content.replace(/^﻿/, '')));
      this.models = parsed.models;
      return this.models;
    } catch {}

    // 2. Try legacy models-cache.json
    try {
      const legacyPath = join(dirname(this.cachePath), 'models-cache.json');
      const content = readFileSync(legacyPath, 'utf8');
      const parsed = cacheSchema.parse(JSON.parse(content.replace(/^﻿/, '')));
      this.models = parsed.models;
      return this.models;
    } catch {}

    return this.models;
  }

  async loadCache(): Promise<DiscoveredModel[]> {
    return this.loadCacheSync();
  }

  async saveCache(): Promise<void> {
    await mkdir(dirname(this.cachePath), {recursive: true, mode: 0o700});
    const temporary = this.cachePath + '.' + randomUUID() + '.tmp';
    const payload = cacheSchema.parse({
      version: 1,
      updatedAt: Date.now(),
      models: this.models,
    });
    try {
      await writeFile(temporary, JSON.stringify(payload, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      await rename(temporary, this.cachePath);
    } finally {
      await rm(temporary, {force: true}).catch(() => {});
    }
  }

  async list(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    if (!this.models.length) {
      await this.loadCache();
    }
    if (!this.models.length && this.registry) {
      return await this.refresh(signal);
    }
    return this.models;
  }

  async syncProvider(name: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    if (!this.registry) return this.models;
    const timeoutSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(5000),
    ]);
    try {
      const result = await this.registry.modelsFor(name, timeoutSignal);
      this.models = this.models.filter(m => m.provider !== name);
      for (const modelId of result) {
        const isAntigravity = name === 'antigravity' || name.toLowerCase().includes('proxy');
        const isClaudeOrGemini = modelId.toLowerCase().includes('claude') || modelId.toLowerCase().includes('gemini');
        const window = isAntigravity && isClaudeOrGemini ? 1_000_000 : 128_000;
        const isClaude = modelId.toLowerCase().includes('claude');
        const maxOutput = isAntigravity && isClaudeOrGemini ? (isClaude ? 128_000 : 64_000) : 16_384;
        const levels = detectEffortLevels(modelId, name);
        this.models.push({
          provider: name,
          id: modelId,
          window,
          maxOutput,
          thinkingLevels: levels.length ? [...levels] : undefined,
          isOffline: false,
          lastSeen: Date.now(),
        });
      }
      await this.saveCache().catch(() => {});
    } catch {}
    return this.models;
  }

  async refresh(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    if (!this.registry) return this.models;
    const names = this.registry.names();
    const discovered: DiscoveredModel[] = [];
    const previousByProvider = new Map<string, DiscoveredModel[]>();
    for (const m of this.models) {
      const list = previousByProvider.get(m.provider) ?? [];
      list.push(m);
      previousByProvider.set(m.provider, list);
    }

    await Promise.allSettled(names.map(async name => {
      const timeoutSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(5000),
      ]);
      try {
        const result = await this.registry!.modelsFor(name, timeoutSignal);
        for (const modelId of result) {
          const isAntigravity = name === 'antigravity' || name.toLowerCase().includes('proxy');
          const isClaudeOrGemini = modelId.toLowerCase().includes('claude') || modelId.toLowerCase().includes('gemini');
          const window = isAntigravity && isClaudeOrGemini ? 1_000_000 : 128_000;
          const isClaude = modelId.toLowerCase().includes('claude');
        const maxOutput = isAntigravity && isClaudeOrGemini ? (isClaude ? 128_000 : 64_000) : 16_384;
          const levels = detectEffortLevels(modelId, name);
          discovered.push({
            provider: name,
            id: modelId,
            window,
            maxOutput,
            thinkingLevels: levels.length ? [...levels] : undefined,
            isOffline: false,
            lastSeen: Date.now(),
          });
        }
      } catch {
        // Provider unreachable: retain cached models marked as offline
        const cached = previousByProvider.get(name) ?? [];
        for (const prev of cached) {
          discovered.push({...prev, isOffline: true});
        }
      }
    }));

    if (discovered.length) {
      this.models = discovered;
      await this.saveCache().catch(() => {});
    }
    return this.models;
  }

  resolveShorthand(modelOrShorthand: string, activeProvider: string): {provider: string; model: string} {
    const trimmed = modelOrShorthand.trim();
    if (!trimmed) throw new Error('Please specify a model name');

    // 1. Direct qualified form: provider/model
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx > 0) {
      const provider = trimmed.slice(0, slashIdx);
      const model = trimmed.slice(slashIdx + 1);
      return {provider, model};
    }

    // 2. Search pool
    const matches = this.models.filter(m => m.id === trimmed);
    if (matches.length === 1) {
      return {provider: matches[0]!.provider, model: matches[0]!.id};
    }
    if (matches.length > 1) {
      const activeMatch = matches.find(m => m.provider === activeProvider);
      if (activeMatch) {
        return {provider: activeMatch.provider, model: activeMatch.id};
      }
      const candidates = matches.map(m => `'${m.provider}/${m.id}'`).join(' or ');
      throw new Error(`Ambiguous model '${trimmed}'. Please specify ${candidates}.`);
    }

    // 3. Fallback: if not in discovered pool, assign to activeProvider
    return {provider: activeProvider, model: trimmed};
  }
}
