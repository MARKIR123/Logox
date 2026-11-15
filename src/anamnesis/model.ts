/**
 * Which model Anamnesis runs on: the binding stored under the id `anamnesis` in the actor model storage, otherwise the Director's current selection.
 * Anamnesis is not an actor: the id only keys a binding and never appears in the ensemble, the catalog or the model pool.
 */
import type {ActorModel} from '../actors/definitions.js';
import type {ActorModelStorage} from '../actors/actor-models-storage.js';
import type {ThinkingEffort} from '../config/model-preferences.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {Provider} from '../runtime/messages.js';

export const ANAMNESIS_ID = 'anamnesis';
export interface AnamnesisModel {provider: string; model: string; effort?: ThinkingEffort; inherited: boolean}
export interface ResolvedModel extends AnamnesisModel {
  /** Sends the requests (the application's injected provider in tests). */
  readonly respond: Provider;
  /** `JSON.stringify([provider, model])`, the identity a usage record carries. */
  readonly identity: string;
}
export const noUsableModel = (provider: string, model: string) =>
  new Error('Anamnesis has no usable model (' + provider + '/' + model + '). Choose one under /anamnesis.');

/** What the user chose, or what the Director currently runs with (no effort override). Never throws. */
export function anamnesisModel(registry: ProviderRegistry, storage: ActorModelStorage): AnamnesisModel {
  const bound = storage.get(ANAMNESIS_ID);
  if (bound) return {provider: bound.provider, model: bound.model, ...(bound.effort ? {effort: bound.effort} : {}), inherited: false};
  const selected = registry.selection();
  return {provider: selected.provider, model: selected.model, inherited: true};
}

/** Binds a model (or, with undefined, goes back to following the Director). */
export async function bindAnamnesisModel(storage: ActorModelStorage, binding: ActorModel | undefined): Promise<void> {
  await storage.save(ANAMNESIS_ID, binding);
}

/**
 * The provider for one run. A binding whose provider is gone or has no credentials is an error, never a silent switch to another model.
 * `injected` is the application's provider override (tests); it is honoured for the request but the binding must still name a known provider.
 */
export async function resolveModel(registry: ProviderRegistry, storage: ActorModelStorage, injected?: Provider): Promise<ResolvedModel> {
  const chosen = anamnesisModel(registry, storage);
  if (!chosen.model.trim()) throw noUsableModel(chosen.provider, chosen.model || '(none)');
  const identity = JSON.stringify([chosen.provider, chosen.model]);
  if (chosen.inherited) return {...chosen, respond: injected ?? registry.provider(), identity};
  if (!registry.names().includes(chosen.provider)) throw noUsableModel(chosen.provider, chosen.model);
  const candidate = registry.candidate(chosen.provider, chosen.model, chosen.effort);
  if (!injected) {
    try {await candidate.settings(true);} catch {throw noUsableModel(chosen.provider, chosen.model);}
  }
  return {...chosen, respond: injected ?? candidate.provider(), identity};
}
