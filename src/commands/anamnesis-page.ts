/**
 * `/anamnesis`: the page and its two arguments. The page is a stack of the existing surfaces: a picker of rows (label, current value in muted text),
 * the memory record list (a picker whose rows take two lines), a record page with a `d` action and the page confirmation, and the same model picker
 * the ensemble page uses. Esc goes back one level (`CommandSurfaces` `back`), then closes. Nothing here owns state: every value is read from
 * the Anamnesis API when a level opens, and a change reopens the level it came from.
 */
import type {AnamnesisApi} from '../app/anamnesis.js';
import type {Receipt} from '../app/state.js';
import type {MemoryRecord} from '../anamnesis/memory.js';
import {detectEffortLevels} from '../config/model-grouping.js';
import {modelLabel} from '../config/model-preferences.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {CommandResult, PickerItem, TabRow} from '../runtime/command-surface.js';
import {INHERIT_CHOICE, bindingChoices, type ChoiceModel} from './model-choices.js';
import {row, tabContent} from './tab-rows.js';
import type {CommandSurfaces, PageActions} from './surfaces.js';

export const ANAMNESIS_USAGE = 'Usage: /anamnesis [recap|dream]';
export const RUN_RECEIPTS = {recap: 'Anamnesis is writing a recap.', dream: 'Anamnesis is reviewing the session.'} as const;
export const NO_RECORDS_TEXT = 'No records yet. Anamnesis saves them while the session is idle, and you can ask any actor to remember something.';
export const FOLLOW_LOGOX_LABEL = 'Follow Logox (default)';
type Kind = keyof typeof RUN_RECEIPTS;

export interface AnamnesisPageDeps {
  surfaces: CommandSurfaces;
  anamnesis: AnamnesisApi;
  registry: Pick<ProviderRegistry, 'names' | 'modelCatalog'>;
  modelPool: Pick<ModelPool, 'snapshot'>;
  receipt: Receipt;
}

export function createAnamnesisCommand(deps: AnamnesisPageDeps) {
  const {surfaces, anamnesis, registry, modelPool, receipt} = deps;
  /** Opens a level over whatever is open (a row that changes something replaces its own level). */
  const open = async (...args: Parameters<CommandSurfaces['openPicker']>) => {
    if (surfaces.getSnapshot()) surfaces.close();
    await surfaces.openPicker(...args);
  };
  const start = (kind: Kind, source?: string): void => {
    anamnesis.runNow(kind);
    receipt(RUN_RECEIPTS[kind], 'status', undefined, source);
  };
  const modelValue = (): {text: string; warning: boolean} => {
    const model = anamnesis.anamnesisModel(), shown = model.provider + ' / ' + modelLabel(model.model, model.effort);
    if (model.inherited) return {text: 'Follows Logox (' + shown + ')', warning: false};
    return registry.names().includes(model.provider) ? {text: shown, warning: false} : {text: shown + ' · unavailable', warning: true};
  };

  const openRecord = async (record: MemoryRecord, backTo: () => Promise<void>) => {
    const key = record.scope + '/' + record.name;
    const body: TabRow[] = [row.field('Description', record.description), row.field('File', record.filePath ?? ''), row.field('Type', record.type + ' · ' + record.scope), row.blank(), row.heading('Content'),
      ...record.content.split(/\r?\n/).map(line => line.trim() ? row.text(line) : row.blank())];
    const actions: PageActions = {
      onSaveToggles: () => ({}),
      onBack: backTo,
      onTabAction: async (_tab, action) => {
        if (action === 'delete') return {confirm: {action: 'delete_confirmed', prompt: 'Delete ' + key + '? This removes the file.'}};
        if (action !== 'delete_confirmed') return {};
        if (!await anamnesis.forget(record.scope, record.name)) throw new Error(key + ' no longer exists.');
        // The page is replaced by the list, which a late status receipt would not survive, so the receipt is sent here.
        surfaces.close();
        receipt('Deleted ' + key + '.', 'status');
        await backTo();
        return {};
      },
    };
    if (surfaces.getSnapshot()) surfaces.close();
    surfaces.openPage('Memory record · ' + record.name, [{id: 'record', title: record.name, ...tabContent(body),
      actions: [{id: 'delete', label: 'Delete record', key: 'd'}]}], 'record', actions);
  };

  const openRecords = async (focus?: string): Promise<void> => {
    const records = await anamnesis.memories();
    const items: PickerItem[] = records.map(record => ({id: record.scope + '/' + record.name, label: record.name,
      description: record.type + ' · ' + record.scope, detail: record.description}));
    await open({title: 'Memory records', description: records.length ? 'Enter opens a record · Esc back' : '', current: '', ...(focus ? {focus} : {}), items, emptyText: NO_RECORDS_TEXT},
      async () => ({items}), async id => {
        const record = records.find(item => item.scope + '/' + item.name === id);
        if (!record) throw new Error('That record no longer exists.');
        await openRecord(record, async () => {await openRecords(id);});
        return {};
      }, undefined, () => openPage('records'));
  };

  const openModel = async (): Promise<void> => {
    const current = anamnesis.anamnesisModel();
    const choices = bindingChoices(current.inherited ? undefined : {provider: current.provider, model: current.model, ...(current.effort ? {effort: current.effort} : {})});
    const poolModels = modelPool.snapshot();
    const list = (models: readonly ChoiceModel[]): PickerItem[] => choices.items(models).map(item => item.id === INHERIT_CHOICE ? {...item, label: FOLLOW_LOGOX_LABEL} : item);
    await open({title: 'Select Model for Anamnesis', description: 'Confirm to apply to Anamnesis only; Esc to go back', current: choices.current,
      ...(poolModels.length ? {items: list(poolModels)} : {})},
    async signal => {
      let models: readonly ChoiceModel[] = poolModels, warning: string | undefined;
      if (!models.length) {
        const result = await registry.modelCatalog(signal);
        warning = result.issues.join('; ');
        models = result.models.map(model => ({provider: model.provider, id: model.id, thinkingLevels: [...detectEffortLevels(model.id, model.provider)]}));
      }
      return {items: list(models), ...(warning ? {warning} : {})};
    }, async (choice, effort) => {
      const binding = choices.resolve(choice, effort);
      if (binding === null) throw new Error('Invalid model selection');
      await anamnesis.setAnamnesisModel(binding ? {provider: binding.provider, model: binding.model, ...(binding.effort ? {effort: binding.effort} : {})} : undefined);
      receipt(binding ? 'Anamnesis model saved.' : 'Anamnesis follows Logox.', 'status');
      await openPage('model');
      return {};
    }, undefined, () => openPage('model'));
  };

  /** The page: six rows, each with its value read now. `focus` keeps the highlight on the row that was just changed. */
  const openPage = async (focus?: string): Promise<void> => {
    const settings = anamnesis.settings(), running = anamnesis.running() !== undefined, records = await anamnesis.memories();
    const project = records.filter(record => record.scope === 'project').length, user = records.length - project, model = modelValue();
    const items: PickerItem[] = [
      {id: 'recap', label: 'Recap now', description: running ? 'Running…' : 'Write a note on where the work stands'},
      {id: 'dream', label: 'Dream now', description: running ? 'Running…' : 'Review the session and update memory'},
      {id: 'records', label: 'Memory records', description: records.length ? project + ' in this project · ' + user + ' for this user' : 'None yet'},
      {id: 'model', label: 'Model', description: model.text, ...(model.warning ? {valueTone: 'warning' as const} : {})},
      {id: 'auto-recap', label: 'Recap when idle', description: settings.recap ? 'On · after ' + settings.recapIdleMinutes + ' min' : 'Off'},
      {id: 'auto-dream', label: 'Dream when idle', description: settings.dream ? 'On · after ' + settings.dreamIdleMinutes + ' min' : 'Off'},
    ];
    await open({title: 'Anamnesis', description: 'Enter runs, opens or toggles a row · Esc closes', current: '', ...(focus ? {focus} : {}), items},
      async () => ({items}), async (id): Promise<CommandResult> => {
        if (id === 'recap' || id === 'dream') {
          try {anamnesis.runNow(id);}
          catch (error) {return {message: error instanceof Error ? error.message : String(error), kind: 'command_error', presentation: 'status'};}
          return {message: RUN_RECEIPTS[id], presentation: 'status'};
        }
        if (id === 'records') await openRecords();
        else if (id === 'model') await openModel();
        else if (id === 'auto-recap' || id === 'auto-dream') {
          const kind = id === 'auto-recap' ? 'recap' : 'dream';
          await anamnesis.setAuto(kind, !anamnesis.settings()[kind]);
          await openPage(id);
        } else throw new Error('Unknown row.');
        return {};
      });
  };

  return {
    /** `/anamnesis` opens the page; `/anamnesis recap|dream` starts that run at once. Anything else is a usage error. */
    async command(argument: string, source?: string): Promise<void> {
      const word = argument.trim().toLowerCase();
      if (!word) {await openPage(); return;}
      if (word !== 'recap' && word !== 'dream') throw new Error(ANAMNESIS_USAGE);
      start(word, source);
    },
    openPage,
    /** The model picker alone (`/model anamnesis`); Esc goes back to the Anamnesis page. */
    openModel,
  };
}
export type AnamnesisCommand = ReturnType<typeof createAnamnesisCommand>;
