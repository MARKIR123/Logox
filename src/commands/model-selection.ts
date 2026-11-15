/**
 * Model selection of one session. Owns the session's current provider/model selection (`current()`), the remembered model
 * ids per provider that feed completion, and the in-flight save latch (`selecting`). It persists a selection through
 * `saveSelection`, opens the model, thinking-effort and Automa pickers, and runs the `/model [actor|automa] [model] [effort]`
 * text forms. The one list every picker shows comes from the model pool; this module never builds a second list.
 */
import {join} from 'node:path';
import {z} from 'zod';
import type {ActorCatalog} from '../actors/catalog.js';
import type {ActorServices} from '../actors/services.js';
import type {Receipt} from '../app/state.js';
import type {CommandContext} from '../commands.js';
import {StateFile, preferenceSchema, effortSchema, effortInName, modelLabel, type ThinkingEffort} from '../config/model-preferences.js';
import {likelyToolCapable, marksText} from '../providers/model-marks.js';
import {groupModelsForProvider, resolveActualModel, detectEffortLevels, type GroupedModel} from '../config/model-grouping.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {Resources} from '../resources/manager.js';
import type {CommandResult, PickerItem} from '../runtime/command-surface.js';
import {DIRECTOR_ID, isDirector} from '../runtime/director-id.js';
import type {Tools} from '../tools/tools.js';
import {AUTOMA_VISION_KEY} from '../tools/tool-models.js';
import {INHERIT_CHOICE, MARKS_HINT, bindingChoices, markFields, type ChoiceModel} from './model-choices.js';
import type {CommandSurfaces} from './surfaces.js';

export interface ModelSelectionDeps {
  registry: ProviderRegistry; preferences: StateFile<z.infer<typeof preferenceSchema>>; homeDir: string;
  /** The session selection read at startup. */
  initial: ReturnType<ProviderRegistry['selection']>;
  modelPool: ModelPool; tools: Tools; actors: ActorCatalog; actorServices: ActorServices; resources: Resources;
  surfaces: CommandSurfaces; signal: AbortSignal; receipt: Receipt;
  /** Throws while tasks, compaction, reload or a permission save are running. */
  requireIdle(): void;
  isEnsembleBusy(): boolean;
}

export function createModelSelection(deps: ModelSelectionDeps) {
  const {registry, preferences, homeDir, modelPool, tools, actors, actorServices, resources, surfaces, signal, receipt, requireIdle, isEnsembleBusy} = deps;
  let settings = deps.initial;
  const modelCandidates = new Map<string, readonly string[]>();
  let selecting = false;
  let selectionDone: Promise<void> | undefined;
  const saveSelection = async (next: ProviderRegistry) => {
    requireIdle(); selecting = true;
    selectionDone = (async () => {
      try {
        const selection = next.selection();
        const globalPref = new StateFile(join(homeDir, '.logox', 'model-preferences.json'), preferenceSchema);
        await globalPref.save({version: 1, provider: selection.provider, model: selection.model, effort: next.thinking().effort}).catch(() => {});
        await preferences.save({version: 1, provider: selection.provider, model: selection.model, effort: next.thinking().effort});
        registry.adopt(next); settings = registry.selection();
      } finally {selecting = false;}
    })();
    await selectionDone;
  };
  const saveEffort = async (effort: ThinkingEffort) => {
    const next = registry.candidate(settings.provider, settings.model);
    next.selectEffort(effort); await saveSelection(next);
  };
  const openThinking = () => {
    const thinking = registry.thinking();
    void surfaces.openPicker({title: 'Thinking Effort', description: 'Available effort tiers for current model; auto uses provider default', current: thinking.effort},
      async () => ({items: thinking.levels.map(id => ({id, label: id}))}), async id => {
        await saveEffort(effortSchema.parse(id)); return {message: 'Thinking effort: ' + id + ' (saved)', presentation: 'status'};
      });
  };
  /** Remembers the model ids of every provider in a pool listing for `/model` completion. */
  const remember = (poolModels: ReturnType<ModelPool['snapshot']>) => {
    for (const provider of new Set(poolModels.map(item => item.provider))) {
      modelCandidates.set(provider, poolModels.filter(item => item.provider === provider).map(item => item.id));
    }
  };
  const openModels = (forActor = 'Logox') => {
    const marks = modelPool.marks;
    const groupedMap = new Map<string, GroupedModel>();
    const currentBase = (() => {
      const match = /^(.*?)-(low|medium|high|xhigh|extra-low|max|tiered|thinking)$/.exec(settings.model);
      return match ? match[1]! : settings.model;
    })();
    /** One picker row per model family of every provider in the listing. */
    const itemsFor = (poolModels: ReturnType<ModelPool['snapshot']>): PickerItem[] => {
      const items: PickerItem[] = [];
      const providers = [...new Set(poolModels.map(m => m.provider))];
      for (const provider of providers) {
        const providerModels = poolModels.filter(m => m.provider === provider).map(m => m.id);
        const currentForThisProvider = settings.provider === provider ? settings.model : '';
        const groupedList = groupModelsForProvider(providerModels, provider, currentForThisProvider);
        if (!groupedList.length) continue;
        for (const grouped of groupedList) {
          groupedMap.set(grouped.id, grouped);
          const currentThinkingEffort = registry.thinking().effort;
          const currentEffort = (settings.provider === grouped.provider && settings.model === grouped.baseModel && currentThinkingEffort)
            ? currentThinkingEffort
            : grouped.currentEffort;
          const recorded = poolModels.find(m => m.provider === provider && m.id === grouped.baseModel)
            ?? poolModels.find(m => m.provider === provider && (m.id.startsWith(grouped.baseModel + '-') || grouped.baseModel.startsWith(m.id)));
          const effortLevels = recorded?.thinkingLevels ?? grouped.effortLevels;
          const win = recorded?.window ? (Math.round(recorded.window / 1000) + 'k') : '128k';
          const eff = effortLevels && effortLevels.length > 0
            ? '✦ ' + effortLevels.filter((l: string) => l !== 'auto').join('/')
            : '-';
          items.push({
            id: grouped.id,
            label: grouped.baseModel,
            description: win + ' · ' + eff + (recorded?.isOffline ? ' · offline' : ''),
            effort: currentEffort,
            effortLevels: effortLevels.length > 0 ? effortLevels : undefined,
            group: provider,
            ...markFields(provider, grouped.baseModel, marks),
          });
        }
      }
      return items;
    };
    // 1. Immediately read from local model store (0ms, zero network)
    modelPool.loadCacheSync();
    const cached = modelPool.snapshot();
    remember(cached);
    const items = itemsFor(cached);

    void surfaces.openPicker({
      title: 'Select Model for ' + forActor,
      description: 'Model families grouped by provider · Tab switches provider · ' + MARKS_HINT,
      emptyText: 'No models available. Run /login to connect a provider, then /providers and press r to refresh its model list.',
      current: JSON.stringify([settings.provider, currentBase]),
      items,
    },
      async pickerSignal => {
        if (items.length) {
          return {items, warning: ''};
        }
        const poolModels = await modelPool.list(AbortSignal.any([pickerSignal, signal]));
        remember(poolModels);
        const freshItems = itemsFor(poolModels);
        return {
          items: freshItems,
          warning: !freshItems.length ? 'No models available. Run /login or configure a provider.' : '',
        };
      },
      async (id, chosenEffort) => {
        requireIdle();
        const grouped = groupedMap.get(id);
        let provider: string;
        let actualModel: string;
        let effort: string | undefined;

        if (grouped) {
          provider = grouped.provider;
          const resolved = resolveActualModel(grouped, chosenEffort);
          actualModel = resolved.modelId;
          effort = resolved.effort;
        } else {
          const parsed = z.tuple([z.string(), z.string()]).parse(JSON.parse(id));
          provider = parsed[0];
          actualModel = parsed[1];
          effort = chosenEffort;
        }

        const candidate = registry.candidate(provider, actualModel);
        if (effort) {
          const parsedEffort = effortSchema.safeParse(effort);
          if (parsedEffort.success) {
            try { candidate.selectEffort(parsedEffort.data); } catch {}
          }
        }
        await saveSelection(candidate);
        return {message: 'Current model: ' + provider + ' / ' + actualModel + (effort ? ' · Thinking effort: ' + effort : ''), presentation: 'status'};
      }, undefined, undefined, marks.pickerMarks());
  };
  /**
   * A typed model name must name a model: a provider must exist, and when the pool knows that provider's models the name must be one of them.
   * Without this a typo (or a word such as an unknown target) became the session model of the active provider.
   */
  const requireKnown = (resolved: {provider: string; model: string}): void => {
    if (!registry.names().includes(resolved.provider)) throw new Error('Unknown provider "' + resolved.provider + '". Use /model to pick a model.');
    modelPool.loadCacheSync();
    const listed = modelPool.snapshot().filter(model => model.provider === resolved.provider);
    if (listed.length && !listed.some(model => model.id === resolved.model))
      throw new Error('Unknown model "' + resolved.model + '" for ' + resolved.provider + '. Use /model to pick one, or /models to list them.');
  };
  /** `/model <actor|automa> <model> [effort]`: a trailing thinking level is split off the model text. */
  const withEffort = (text: string): {text: string; effort?: ThinkingEffort} => {
    const parts = text.trim().split(/\s+/), last = parts.length > 1 ? effortSchema.safeParse(parts[parts.length - 1]!.toLowerCase()) : undefined;
    return last?.success ? {text: parts.slice(0, -1).join(' '), effort: last.data} : {text};
  };
  /** The binding to store; an effort the model does not declare is an error here (the picker only offers declared ones), and a model id that names its level stores none. */
  const bindingFor = (provider: string, model: string, effort: ThinkingEffort | undefined): {provider: string; model: string; effort?: ThinkingEffort} => {
    requireKnown({provider, model});
    if (!effort || effortInName(model)) return {provider, model};
    const levels = registry.candidate(provider, model).thinking().levels;
    if (!levels.includes(effort)) throw new Error(provider + '/' + model + ' does not support thinking effort "' + effort + '" (available: ' + levels.join(', ') + ')');
    return {provider, model, effort};
  };
  /** Opens a level of the `/model automa` page over whatever is open (a row that changes something replaces its own level). */
  const openLevel = async (...args: Parameters<typeof surfaces.openPicker>) => {
    if (surfaces.getSnapshot()) surfaces.close();
    await surfaces.openPicker(...args);
  };
  /**
   * The model list of one Automa row: the list every actor's model picker shows (`bindingChoices`) with the row's own first item and filter.
   * Choosing a model saves it under `key`, says so, and returns to the page on the row that changed; Esc returns without saving.
   */
  const openAutomaChoice = async (row: 'worker' | 'vision') => {
    const key = row === 'worker' ? 'automa' : AUTOMA_VISION_KEY, bound = tools.modelStorage.get(key), marks = modelPool.marks;
    modelPool.loadCacheSync();
    const poolModels = modelPool.snapshot();
    const choices = bindingChoices(bound, marks);
    const session = registry.selection();
    /** The cheapest T2 model of the session's provider that can run tools, moved to the top and labelled; nothing is bound by it. */
    const recommend = (items: PickerItem[]): PickerItem[] => {
      const price = (item: PickerItem) => item.markKey ? marks.price(session.provider, item.markKey.slice(session.provider.length + 1)) : undefined;
      const best = items.filter(item => item.group === session.provider && item.marks?.tier === 2 && likelyToolCapable(item.label))
        .sort((a, b) => (price(a) ?? Infinity) - (price(b) ?? Infinity) || a.label.localeCompare(b.label))[0];
      if (!best) return items;
      return [items[0]!, {...best, label: best.label + ' · recommended'}, ...items.slice(1).filter(item => item.id !== best.id)];
    };
    const list = (models: readonly ChoiceModel[]): PickerItem[] => {
      const items = choices.items(models).map(item => item.id !== INHERIT_CHOICE ? item : row === 'worker'
        ? {...item, label: 'Follow Logox (' + session.provider + ' / ' + session.model + ')'}
        : {...item, label: 'None', description: 'Jobs marked vision fail when the worker model cannot see images'});
      return row === 'vision' ? items.filter(item => item.id === INHERIT_CHOICE || item.marks?.vision) : bound ? items : recommend(items);
    };
    await openLevel({
      title: row === 'worker' ? 'Select Worker Model for Automa' : 'Select Vision Fallback for Automa',
      description: (row === 'worker' ? 'Automa workers use this model; Esc to go back · ' : 'Used for jobs marked vision when the worker model cannot see images; Esc to go back · ') + MARKS_HINT,
      current: choices.current,
      ...(poolModels.length > 0 ? {items: list(poolModels)} : {}),
    }, async pickerSignal => {
      let models: readonly ChoiceModel[] = poolModels;
      let warning: string | undefined;
      if (models.length === 0) {
        const result = await registry.modelCatalog(pickerSignal);
        warning = result.issues.join('; ');
        models = result.models.map(m => ({provider: m.provider, id: m.id, thinkingLevels: [...detectEffortLevels(m.id, m.provider)]}));
      }
      return {items: list(models), ...(warning ? {warning} : {})};
    }, async (choice, chosenEffort) => {
      const chosen = choices.resolve(choice, chosenEffort);
      if (chosen === null) throw new Error('Invalid model selection');
      await tools.modelStorage.save(key, chosen, signal);
      const shown = chosen ? chosen.provider + '/' + chosen.model + (chosen.effort ? ' · ' + chosen.effort : '') : '';
      receipt(row === 'worker' ? (chosen ? 'Automa model set to: ' + shown : 'Automa model set to inherit session model')
        : (chosen ? 'Automa vision fallback set to: ' + shown : 'Automa has no vision fallback.'), 'status');
      await openAutomaPage(row);
      return {};
    }, undefined, () => openAutomaPage(row), marks.pickerMarks());
  };
  /** `/model automa`: the worker model and the vision fallback, each row with its value read now. */
  const openAutomaPage = async (focus?: string): Promise<void> => {
    const marks = modelPool.marks, worker = tools.modelStorage.get('automa'), vision = tools.modelStorage.get(AUTOMA_VISION_KEY), session = registry.selection();
    const shownBinding = (binding: {provider: string; model: string; effort?: ThinkingEffort | undefined}) =>
      binding.provider + ' / ' + modelLabel(binding.model, binding.effort) + ' · ' + marksText(marks.marks(binding.provider, binding.model));
    const effective = worker ?? (session.model ? {provider: session.provider, model: session.model} : undefined);
    const workerSees = effective ? marks.vision(effective.provider, effective.model) : true;
    const workerText = worker ? shownBinding(worker) : 'Follows Logox (' + (session.model ? session.provider + ' / ' + session.model + ' · ' + marksText(marks.marks(session.provider, session.model)) : 'no model selected') + ')';
    const visionBlind = vision ? !marks.vision(vision.provider, vision.model) : !workerSees;
    const visionText = vision ? shownBinding(vision) + (visionBlind ? ' · cannot see images' : '') : 'None' + (visionBlind ? ' · vision jobs will fail' : '');
    const items: PickerItem[] = [
      {id: 'worker', label: 'Worker model', description: workerText},
      {id: 'vision', label: 'Vision fallback', description: visionText, ...(visionBlind ? {valueTone: 'warning' as const} : {})},
    ];
    await openLevel({title: 'Automa', description: 'Enter changes a row · Esc closes', current: '', ...(focus ? {focus} : {}), items},
      async () => ({items}), async (id): Promise<CommandResult> => {
        if (id !== 'worker' && id !== 'vision') throw new Error('Unknown row.');
        await openAutomaChoice(id);
        return {};
      });
  };
  /** `/model` and `/model <actor|automa|model> ...` typed by the human; `source` is the window it came from. */
  const modelCommand = async (text: string, source: string): Promise<void> => {
    const rawArg = text === '/model' ? '' : text.slice(7).trim();
    const firstToken = rawArg.split(/\s+/)[0]?.toLowerCase();
    const targetActor = firstToken ? actors.find(firstToken) : undefined;

    if (text === '/model') {
      if (!isDirector(source) && actors.find(source)) {
        await actorServices.management.openDefaultModel(source, surfaces);
        return;
      }
      openModels(actors.find(DIRECTOR_ID)?.name ?? 'Logox');
      return;
    }

    if (firstToken === 'automa') {
      const specificModel = rawArg.slice(firstToken.length).trim();
      if (specificModel) {
        if (specificModel.toLowerCase() === 'inherit') {
          await tools.modelStorage.save('automa', undefined, signal);
          receipt('Automa model set to inherit session model', 'status', undefined, source);
          return;
        }
        const spec = withEffort(specificModel), resolved = modelPool.resolveShorthand(spec.text, settings.provider);
        const binding = bindingFor(resolved.provider, resolved.model, spec.effort);
        await tools.modelStorage.save('automa', binding, signal);
        receipt('Automa model set to: ' + resolved.provider + '/' + resolved.model + (binding.effort ? ' · ' + binding.effort : ''), 'status', undefined, source);
        return;
      }
      await openAutomaPage();
      return;
    }

    if (targetActor) {
      const specificModel = rawArg.slice(firstToken!.length).trim();
      if (specificModel) {
        const spec = withEffort(specificModel), resolved = modelPool.resolveShorthand(spec.text, settings.provider);
        const binding = bindingFor(resolved.provider, resolved.model, spec.effort);
        await actorServices.management.saveDefaultModel(targetActor.id, binding, signal);
        receipt('Actor ' + targetActor.name + ' model set to: ' + resolved.provider + '/' + resolved.model + (binding.effort ? ' · ' + binding.effort : ''), 'status', undefined, source);
        return;
      }
      if (isDirector(targetActor.id)) {
        openModels(targetActor.name);
        return;
      }
      await actorServices.management.openDefaultModel(targetActor.id, surfaces);
      return;
    }

    if (isEnsembleBusy()) throw new Error('Tasks are running. Wait or cancel before switching model.');
    const model = rawArg;
    if (!model) throw new Error('Please specify a model name');
    const resolved = modelPool.resolveShorthand(model, settings.provider);
    requireKnown(resolved);
    await saveSelection(registry.candidate(resolved.provider, resolved.model));
    receipt('Current model: ' + resolved.provider + '/' + resolved.model, 'status', undefined, source);
  };
  /** Completion data for the command line: providers, actors and every model id seen so far. */
  const completionContext = (): CommandContext => {
    const knownPresets: Record<string, string[]> = {
      openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-4-turbo'],
      antigravity: ['gemini-3.8-flash', 'claude-sonnet-4-6', 'gemini-3.7-flash', 'claude-opus-4-6', 'gemini-3.1-pro-high', 'gpt-oss-120b-medium'],
      deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
      anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    };
    const providerModels = modelCandidates.get(settings.provider) ?? knownPresets[settings.provider] ?? [];
    return {providers: registry.names(), loginProviders: registry.loginNames(), customCommands: resources.snapshot().commands,
      actors: actors.list().map(actor => actor.id),
      actorDetails: actors.list().map(actor => ({id: actor.id, name: actor.name, title: actor.title})),
      models: [...new Set([settings.model, ...providerModels,
        ...[...modelCandidates].flatMap(([provider, models]) => models.map(model => provider + '/' + model))].filter(Boolean))]};
  };
  return {
    /** The session selection (provider, model, base URL); replaced by every saved selection. */
    current: () => settings,
    saveSelection, saveEffort, openThinking, openModels, openAutomaPage, modelCommand, completionContext,
    /** `<model> [effort]` typed after a target, checked like `/model <actor> <model> [effort]` (for targets owned elsewhere, such as Anamnesis). */
    typedBinding: (text: string) => {const spec = withEffort(text), resolved = modelPool.resolveShorthand(spec.text, settings.provider);
      return bindingFor(resolved.provider, resolved.model, spec.effort);},
    /** True while a selection is being saved; part of the application's busy test. */
    isSelecting: () => selecting,
    /** The latest save, awaited on close. */
    selectionDone: () => selectionDone,
    /** Remembers the model ids a `/models` query returned for one provider. */
    rememberProvider: (provider: string, models: readonly string[]) => {modelCandidates.set(provider, models);},
    /** The `/models` text: one model per line with its `T1`-`T4` and vision marks at the end of the row. */
    markedList: (provider: string, models: readonly string[]): string =>
      models.map(model => model + '  ' + marksText(modelPool.marks.marks(provider, model))).join('\n'),
  };
}
export type ModelSelection = ReturnType<typeof createModelSelection>;
