import type {ActorCatalog} from '../actors/catalog.js';
import {cacheLifetime, roleCacheRetention, type CacheLifetime} from '../providers/cache.js';
import type {ProviderRegistry} from '../providers/registry.js';

/** Lifetime of an actor's prompt cache for one model, as the request it sends sets it; undefined when unknown or the model cannot be resolved. */
export function cacheLifetimeFor(registry: ProviderRegistry, actors: ActorCatalog, provider: string, model: string, ownerId: string): CacheLifetime | undefined {
  try {
    const actor = actors.find(ownerId);
    return cacheLifetime(registry.configuredSettings(provider, model),
      {cacheRetention: {role: roleCacheRetention(ownerId), ...(actor?.cacheRetention ? {actor: actor.cacheRetention} : {})}});
  } catch {return undefined;}
}
/** The provider and model of a usage-record identity (`JSON.stringify([provider, model, ...])`), or undefined when it is not one. */
export function modelOfIdentity(identity: string): {provider: string; model: string} | undefined {
  try {
    const value: unknown = JSON.parse(identity);
    return Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string' ? {provider: value[0], model: value[1]} : undefined;
  } catch {return undefined;}
}
