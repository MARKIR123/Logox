import {readFile} from 'node:fs/promises';
import type {ProviderRegistry} from '../providers/registry.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {CommandSurfaces} from '../commands/surfaces.js';
import type {CommandTab} from '../runtime/command-surface.js';
import {immutable} from '../runtime/contracts.js';
import {ActorCatalog, assertActorPath} from './catalog.js';
import {actorModelSchema, parseActor, serializeActor, type ActorModel} from './definitions.js';
import type {ContextPolicy} from '../config/config.js';
import {detectEffortLevels} from '../config/model-grouping.js';

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
    return immutable({id: 'actors', title: 'Ensemble', lines: this.catalog.list().flatMap(actor => {
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
        '── ' + actor.symbol + ' ' + actor.name + ' (' + actor.title + ') ' + '─'.repeat(30),
        'Description: ' + actor.description,
        'Designated model: ' + modelLine,
        'Context retention: ' + policy.keep_recent_rounds + ' rounds / ' + policy.keep_recent_tools + ' tools',
        'Context policy: ' + JSON.stringify(policy),
        'Skills: ' + (actor.skills.join(', ') || 'Declared on-demand'),
        'Persona prompt: ' + actor.prompt.slice(0, 150).replace(/\n/g, ' ') + '...',
        '',
      ];
    })});
  }
  private async previous(id: string): Promise<string | undefined> {
    const path = this.catalog.projectPath(id); await assertActorPath(path);
    try {return await readFile(path, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
  }
  async saveDefaultModel(id: string, model: ActorModel | undefined, signal: AbortSignal): Promise<string> {
    if (id === 'logox') throw new Error('Logox 使用当前会话模型，请通过 /model 设置');
    const actor = this.catalog.find(id); if (!actor) throw new Error('角色不存在');
    if (model) {
      const selected = actorModelSchema.parse(model); model = selected;
      const poolModels = this.modelPool?.snapshot() ?? [];
      const foundInPool = poolModels.some(item => item.provider === selected.provider && item.id === selected.model);
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
    const poolModels = this.modelPool?.snapshot() ?? [];
    const choices = new Map<string, ActorModel | undefined>([['inherit', undefined]]);
    for (const item of poolModels) {
      choices.set(JSON.stringify({provider: item.provider, model: item.id}), {provider: item.provider, model: item.id});
    }
    const initialItems = [
      {id: 'inherit', label: 'Inherit current session model', description: 'Default'},
      ...poolModels.map(item => {
        const choiceId = JSON.stringify({provider: item.provider, model: item.id});
        const levels = item.thinkingLevels ?? detectEffortLevels(item.id, item.provider);
        const win = item.window ? (Math.round(item.window / 1000) + 'k') : '128k';
        const eff = levels.length > 0 ? '✦ ' + levels.filter(l => l !== 'auto').join('/') : '-';
        return {
          id: choiceId,
          label: item.id,
          description: win + ' · ' + eff + (item.isOffline ? ' [offline]' : ''),
          effort: levels.includes('high') ? 'high' : (levels[0] ?? 'auto'),
          effortLevels: levels.length > 0 ? levels : undefined,
          group: item.provider,
        };
      }),
    ];
    await surfaces.openPicker({
      title: 'Select Model for ' + actor.name,
      description: 'Confirm to apply to this actor only; Esc to cancel',
      current: actor.defaultModel ? JSON.stringify(actor.defaultModel) : 'inherit',
      ...(poolModels.length > 0 ? {items: initialItems} : {}),
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
      for (const item of models) {
        choices.set(JSON.stringify({provider: item.provider, model: item.id}), {provider: item.provider, model: item.id});
      }
      const loadedItems = [
        {id: 'inherit', label: 'Inherit current session model', description: 'Default'},
        ...models.map(item => {
          const choiceId = JSON.stringify({provider: item.provider, model: item.id});
          const levels = item.thinkingLevels ?? detectEffortLevels(item.id, item.provider);
          const win = item.window ? (Math.round(item.window / 1000) + 'k') : '128k';
          const eff = levels.length > 0 ? '✦ ' + levels.filter(l => l !== 'auto').join('/') : '-';
          return {
            id: choiceId,
            label: item.id,
            description: win + ' · ' + eff + (item.isOffline ? ' [offline]' : ''),
            effort: levels.includes('high') ? 'high' : (levels[0] ?? 'auto'),
            effortLevels: levels.length > 0 ? levels : undefined,
            group: item.provider,
          };
        }),
      ];
      return {items: loadedItems, ...(warning ? {warning} : {})};
    }, async choice => {
      if (!choices.has(choice)) throw new Error('Invalid model selection');
      await this.saveDefaultModel(id, choices.get(choice), new AbortController().signal);
      return {message: actor.name + ' default model saved', presentation: 'silent'};
    });
  }
  async craftActor(content: string, approve: (review: ActorWriteReview) => Promise<boolean>, signal: AbortSignal): Promise<CraftResult> {
    const actor = parseActor(content), path = this.catalog.projectPath(actor.id), previous = await this.previous(actor.id);
    const accepted = await approve(immutable({path, content, previous, operation: 'craft_actor'})); signal.throwIfAborted();
    if (!accepted) return {status: 'denied', path, revision: this.catalog.snapshot().revision};
    await this.catalog.writeProject(actor.id, content, previous);
    const state = await this.catalog.reload(); if (state.issues.length) throw new Error('文件已保存，热载失败：' + state.issues.map(item => item.reason).join('；'));
    return {status: 'saved', path, revision: state.revision};
  }
}
