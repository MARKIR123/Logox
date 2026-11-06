import {readFile} from 'node:fs/promises';
import type {ProviderRegistry} from '../providers/registry.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {CommandSurfaces} from '../commands/surfaces.js';
import type {CommandTab, TabRow} from '../runtime/command-surface.js';
import {row, rowText} from '../commands/tab-rows.js';
import {immutable} from '../runtime/contracts.js';
import {ActorCatalog, assertActorPath} from './catalog.js';
import {actorModelSchema, parseActor, serializeActor, type ActorModel} from './definitions.js';
import type {ContextPolicy} from '../config/config.js';
import {detectEffortLevels, groupModelsForProvider, resolveActualModel, type GroupedModel} from '../config/model-grouping.js';

export interface ActorWriteReview {readonly path: string; readonly content: string; readonly previous: string | undefined; readonly operation: 'craft_actor'}
export interface CraftResult {readonly status: 'saved' | 'denied'; readonly path: string; readonly revision: number}
export class ActorManagement {
  constructor(
    readonly catalog: ActorCatalog,
    private readonly registry: Pick<ProviderRegistry, 'modelCatalog'>,
    private readonly requireIdle: () => void = () => {},
    private readonly policy?: (ownerId: string) => ContextPolicy,
    private readonly modelResolver?: (actorId: string) => {provider: string; model: string; effort?: string; levels?: readonly string[]} | undefined,
    private readonly modelPool?: ModelPool,
  ) {}
  tab(): CommandTab {
    const rows = this.catalog.list().flatMap((actor): TabRow[] => {
      const policy = this.policy?.(actor.id) ?? actor.context;
      const resolved = this.modelResolver?.(actor.id);
      const effort = resolved?.effort;
      const effortSuffix = effort && effort !== 'none' ? ' · ' + effort : '';
      const baseName = actor.defaultModel
        ? actor.defaultModel.provider + '/' + actor.defaultModel.model
        : resolved
          ? resolved.provider + '/' + resolved.model
          : 'None';
      const modelWithEffort = baseName + effortSuffix;
      const modelLine = actor.defaultModel
        ? modelWithEffort
        : 'Inherits session model (' + modelWithEffort + ') (switch via /model ' + actor.id + ')';

      return [
        row.rule(actor.symbol + ' ' + actor.name + ' (' + actor.title + ')'),
        row.field('Description', actor.description),
        row.field('Designated model', modelLine),
        row.field('Context retention', policy.keep_recent_rounds + ' rounds / ' + policy.keep_recent_tools + ' tools'),
        row.field('Context policy', JSON.stringify(policy)),
        row.field('Skills', actor.skills.join(', ') || 'Declared on-demand'),
        row.field('Persona prompt', actor.prompt.slice(0, 150).replace(/\n/g, ' ') + '...'),
        row.blank(),
      ];
    });
    return immutable({id: 'actors', title: 'Ensemble', lines: rows.map(rowText), rows});
  }
  private async previous(id: string): Promise<string | undefined> {
    const path = this.catalog.projectPath(id); await assertActorPath(path);
    try {return await readFile(path, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
  }
  async saveDefaultModel(id: string, model: ActorModel | undefined, signal: AbortSignal): Promise<string> {
    if (id === 'logox') throw new Error('Logox uses the current session model; set it with /model');
    const actor = this.catalog.find(id); if (!actor) throw new Error('Actor not found');
    if (model) {
      const selected = actorModelSchema.parse(model); model = selected;
      this.modelPool?.loadCacheSync();
      const poolModels = this.modelPool?.snapshot() ?? [];
      const foundInPool = poolModels.some(item => item.provider === selected.provider &&
        (item.id === selected.model || item.id.startsWith(selected.model + '-') || selected.model.startsWith(item.id + '-')));
      if (!foundInPool) {
        const result = await this.registry.modelCatalog(signal);
        if (!result.models.some(item => item.provider === selected.provider && item.id === selected.model)) {
          throw new Error('Model not in available catalog: ' + selected.provider + '/' + selected.model);
        }
      }
    }
    const previous = await this.previous(id); signal.throwIfAborted();
    await this.catalog.modelStorage.save(id, model, signal);
    const {defaultModel: _old, ...rest} = previous === undefined ? actor : parseActor(previous);
    const path = await this.catalog.writeProject(id, serializeActor({...rest, ...(model ? {defaultModel: model} : {})}), previous);
    const state = await this.catalog.reload(); if (state.issues.length) throw new Error('File saved, reload failed: ' + state.issues.map(item => item.reason).join('; '));
    return path;
  }
  async openDefaultModel(id: string, surfaces: CommandSurfaces): Promise<void> {
    const actor = this.catalog.find(id); if (!actor) throw new Error('Actor not found');
    this.modelPool?.loadCacheSync();
    const poolModels = this.modelPool?.snapshot() ?? [];
    const groupedMap = new Map<string, GroupedModel>();
    const choices = new Map<string, ActorModel | undefined>([['inherit', undefined]]);

    const buildItems = (models: readonly {provider: string; id: string; window?: number | undefined; thinkingLevels?: readonly string[] | undefined; isOffline?: boolean | undefined}[]) => {
      const items: any[] = [
        {id: 'inherit', label: 'Inherit current session model', description: 'Default'},
      ];
      const providers = [...new Set(models.map(m => m.provider))];
      for (const provider of providers) {
        const providerModels = models.filter(m => m.provider === provider).map(m => m.id);
        const currentModel = actor.defaultModel?.provider === provider ? actor.defaultModel.model : '';
        const groupedList = groupModelsForProvider(providerModels, provider, currentModel);
        for (const grouped of groupedList) {
          const choiceId = JSON.stringify({provider: grouped.provider, model: grouped.baseModel});
          groupedMap.set(choiceId, grouped);
          groupedMap.set(grouped.id, grouped);
          choices.set(choiceId, {provider: grouped.provider, model: grouped.baseModel});
          choices.set(grouped.id, {provider: grouped.provider, model: grouped.baseModel});
          for (const [tier, variantId] of Object.entries(grouped.variantMap)) {
            choices.set(JSON.stringify({provider: grouped.provider, model: variantId}), {provider: grouped.provider, model: variantId});
          }

          const recorded = models.find(m => m.provider === provider && m.id === grouped.baseModel)
            ?? models.find(m => m.provider === provider && (m.id.startsWith(grouped.baseModel + '-') || grouped.baseModel.startsWith(m.id)));
          const effortLevels = recorded?.thinkingLevels ?? grouped.effortLevels;
          const win = recorded?.window ? (Math.round(recorded.window / 1000) + 'k') : '128k';
          const eff = effortLevels && effortLevels.length > 0 ? '✦ ' + effortLevels.filter(l => l !== 'auto').join('/') : '-';
          items.push({
            id: choiceId,
            label: grouped.baseModel,
            description: win + ' · ' + eff + (recorded?.isOffline ? ' [offline]' : ''),
            effort: grouped.currentEffort,
            effortLevels: effortLevels.length > 0 ? effortLevels : undefined,
            group: grouped.provider,
          });
        }
      }
      return items;
    };

    const initialItems = poolModels.length > 0 ? buildItems(poolModels) : [];
    const currentKey = actor.defaultModel
      ? JSON.stringify({provider: actor.defaultModel.provider, model: actor.defaultModel.model})
      : 'inherit';

    await surfaces.openPicker({
      title: 'Select Model for ' + actor.name,
      description: 'Confirm to apply to this actor only; Esc to cancel',
      current: currentKey,
      ...(initialItems.length > 0 ? {items: initialItems} : {}),
    }, async signal => {
      let models = poolModels;
      let warning: string | undefined;
      if (models.length === 0) {
        const result = await this.registry.modelCatalog(signal);
        warning = result.issues.join('; ');
        models = result.models.map(m => ({
          provider: m.provider,
          id: m.id,
          thinkingLevels: [...detectEffortLevels(m.id, m.provider)],
        }));
      }
      const loadedItems = buildItems(models);
      return {items: loadedItems, ...(warning ? {warning} : {})};
    }, async (choice, chosenEffort) => {
      let selectedModel: ActorModel | undefined;
      if (choice === 'inherit') {
        selectedModel = undefined;
      } else if (groupedMap.has(choice)) {
        const grouped = groupedMap.get(choice)!;
        const resolved = resolveActualModel(grouped, chosenEffort);
        selectedModel = {provider: grouped.provider, model: resolved.modelId};
      } else if (choices.has(choice)) {
        selectedModel = choices.get(choice);
      } else {
        try {
          const parsed = JSON.parse(choice);
          if (Array.isArray(parsed) && parsed.length >= 2) {
            selectedModel = {provider: parsed[0], model: parsed[1]};
          } else if (parsed && typeof parsed === 'object') {
            selectedModel = {provider: parsed.provider, model: parsed.model};
          }
        } catch {}
      }
      if (choice !== 'inherit' && !selectedModel) throw new Error('Invalid model selection');
      await this.saveDefaultModel(id, selectedModel, new AbortController().signal);
      return {message: actor.name + ' default model saved', presentation: 'status'};
    });
  }
  async craftActor(content: string, approve: (review: ActorWriteReview) => Promise<boolean>, signal: AbortSignal): Promise<CraftResult> {
    const actor = parseActor(content), path = this.catalog.projectPath(actor.id), previous = await this.previous(actor.id);
    const accepted = await approve(immutable({path, content, previous, operation: 'craft_actor'})); signal.throwIfAborted();
    if (!accepted) return {status: 'denied', path, revision: this.catalog.snapshot().revision};
    await this.catalog.writeProject(actor.id, content, previous);
    const state = await this.catalog.reload(); if (state.issues.length) throw new Error('File saved, but hot reload failed: ' + state.issues.map(item => item.reason).join('; '));
    return {status: 'saved', path, revision: state.revision};
  }
}
