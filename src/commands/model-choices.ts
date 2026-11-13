import type {PickerItem} from '../runtime/command-surface.js';
import {effortInName, effortSchema, type ThinkingEffort} from '../config/model-preferences.js';
import {groupModelsForProvider, resolveActualModel, type GroupedModel} from '../config/model-grouping.js';

/** A model as the pool or a live catalog query reports it. */
export interface ChoiceModel {
  readonly provider: string;
  readonly id: string;
  readonly window?: number | undefined;
  readonly thinkingLevels?: readonly string[] | undefined;
  readonly isOffline?: boolean | undefined;
}
/** `effort` is the binding's own thinking effort; absent means the session's. A model id that names its level never carries one. */
export interface ModelBinding {readonly provider: string; readonly model: string; readonly effort?: ThinkingEffort | undefined}
export const INHERIT_CHOICE = 'inherit';

/**
 * The one list every "dedicated model" picker shows (each actor and Automa): `Inherit` first, then the model families of every provider,
 * folded the same way the session model picker folds them, so no picker offers a different pool than another.
 * `items()` may be called again with a fresher model list; `resolve()` understands the ids of every list it produced.
 */
export function bindingChoices(current: ModelBinding | undefined) {
  const families = new Map<string, GroupedModel>();
  const exact = new Map<string, ModelBinding>();
  const rowLevels = new Map<string, readonly string[]>();
  const key = (binding: ModelBinding) => JSON.stringify({provider: binding.provider, model: binding.model});
  return {
    /** The id of the row that stands for the current binding. */
    current: current ? key(current) : INHERIT_CHOICE,
    items(models: readonly ChoiceModel[]): PickerItem[] {
      const items: PickerItem[] = [{id: INHERIT_CHOICE, label: 'Inherit current session model', description: 'Default'}];
      for (const provider of new Set(models.map(model => model.provider))) {
        const ids = models.filter(model => model.provider === provider).map(model => model.id);
        for (const family of groupModelsForProvider(ids, provider, current?.provider === provider ? current.model : '')) {
          const id = key({provider, model: family.baseModel});
          families.set(id, family);
          for (const variant of Object.values(family.variantMap)) exact.set(key({provider, model: variant}), {provider, model: variant});
          const recorded = models.find(model => model.provider === provider && model.id === family.baseModel)
            ?? models.find(model => model.provider === provider && (model.id.startsWith(family.baseModel + '-') || family.baseModel.startsWith(model.id)));
          const levels = recorded?.thinkingLevels ?? family.effortLevels;
          const window = recorded?.window ? Math.round(recorded.window / 1000) + 'k' : '128k';
          rowLevels.set(id, levels);
          // The row of the current binding opens on its own effort (a variant family derives it from the variant's name).
          const bound = current && key(current) === id && current.effort && levels.includes(current.effort) && !effortInName(current.model) ? current.effort : undefined;
          const effort = levels.length ? '✦ ' + levels.filter(level => level !== 'auto').join('/') : '-';
          items.push({id, label: family.baseModel, description: window + ' · ' + effort + (recorded?.isOffline ? ' [offline]' : ''),
            effort: bound ?? family.currentEffort, effortLevels: levels.length ? levels : undefined, group: provider});
        }
      }
      return items;
    },
    /** The binding a picker choice stands for: `undefined` for Inherit, `null` when the choice is not one this list offered. */
    resolve(choice: string, effort?: string): ModelBinding | undefined | null {
      if (choice === INHERIT_CHOICE) return undefined;
      const family = families.get(choice);
      if (family) {
        const model = resolveActualModel(family, effort).modelId;
        // A variant family: the chosen level picks the variant, whose name is the level. A single model: the chosen level is stored when the model has it.
        const single = Object.keys(family.variantMap).length <= 1;
        const parsed = effortSchema.safeParse(effort);
        const level = single && !effortInName(model) && parsed.success && rowLevels.get(choice)?.includes(parsed.data) ? parsed.data : undefined;
        return {provider: family.provider, model, ...(level ? {effort: level} : {})};
      }
      return exact.get(choice) ?? null;
    },
  };
}
