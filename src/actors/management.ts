import {isDirector} from '../runtime/director-id.js';
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
import {detectEffortLevels} from '../config/model-grouping.js';
import {effortInName} from '../config/model-preferences.js';
import {bindingChoices, type ChoiceModel} from '../commands/model-choices.js';

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
      // A model id that already names its level (`...-high`) is not followed by a second, repeated level.
      const named = effortInName(actor.defaultModel?.model ?? resolved?.model ?? '');
      const effortSuffix = effort && effort !== 'none' && !named ? ' · ' + effort : '';
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
    if (isDirector(id)) throw new Error('Logox uses the current session model; set it with /model');
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
    // The same list Automa's picker shows: see `bindingChoices`.
    const choices = bindingChoices(actor.defaultModel);
    await surfaces.openPicker({
      title: 'Select Model for ' + actor.name,
      description: 'Confirm to apply to this actor only; Esc to cancel',
      current: choices.current,
      ...(poolModels.length > 0 ? {items: choices.items(poolModels)} : {}),
    }, async signal => {
      let models: readonly ChoiceModel[] = poolModels;
      let warning: string | undefined;
      if (models.length === 0) {
        const result = await this.registry.modelCatalog(signal);
        warning = result.issues.join('; ');
        models = result.models.map(m => ({provider: m.provider, id: m.id, thinkingLevels: [...detectEffortLevels(m.id, m.provider)]}));
      }
      return {items: choices.items(models), ...(warning ? {warning} : {})};
    }, async (choice, chosenEffort) => {
      let selectedModel: ActorModel | undefined | null = choices.resolve(choice, chosenEffort);
      if (selectedModel === null) {
        // A choice typed or scripted as raw JSON; `saveDefaultModel` still checks it against the catalog.
        try {
          const parsed = JSON.parse(choice);
          if (Array.isArray(parsed) && parsed.length >= 2) selectedModel = {provider: parsed[0], model: parsed[1]};
          else if (parsed && typeof parsed === 'object') selectedModel = {provider: parsed.provider, model: parsed.model};
        } catch {}
      }
      if (selectedModel === null) throw new Error('Invalid model selection');
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
