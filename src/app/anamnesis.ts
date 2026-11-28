/**
 * Anamnesis wiring of one session: the memory store and its static prompt section, the watermarks beside the journals, the model it runs on,
 * the two automatic switches (user preference over config), the usage it is charged to, and the idle service with its interval.
 * `application.ts` calls `createAnamnesis` once and exposes `api` to commands and the `/anamnesis` page; `lifecycle` is what the container drives.
 */
import {join} from 'node:path';
import {z} from 'zod';
import type {ActorCatalog} from '../actors/catalog.js';
import type {ActorModel} from '../actors/definitions.js';
import {ANAMNESIS_ID, anamnesisModel, bindAnamnesisModel, resolveModel, type AnamnesisModel} from '../anamnesis/model.js';
import {MemoryStore, type MemoryRecord, type MemoryScope} from '../anamnesis/memory.js';
import {changesPage, type HarvestParts, type HarvestReport, type HarvestSource} from '../anamnesis/harvest.js';
import {SkillStore, skillsPage} from '../anamnesis/skills.js';
import {builtinSkillsRoot} from '../resources/manager.js';
import {SHORT_CACHE_MS} from '../providers/cache.js';
import {AnamnesisRunner} from '../anamnesis/runner.js';
import {Anamnesis, type RunKind, type RunResult} from '../anamnesis/service.js';
import {WatermarkStore} from '../anamnesis/watermark.js';
import type {Config} from '../config/config.js';
import {StateFile} from '../config/model-preferences.js';
import type {CliffPlan, ContextManager} from '../context/manager.js';
import {HarvestTiming, type HarvestLifetime, type HarvestRun} from '../kernel/harvest-timing.js';
import type {KeepAliveTarget, KeepAliveWho} from '../kernel/cache-keepalive.js';
import {memorySection} from '../prompts/memory.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {Provider} from '../runtime/messages.js';
import type {NoticeInput} from '../runtime/notices.js';
import {cacheLifetimeFor, modelOfIdentity} from './cache-lifetime.js';
import {DIRECTOR_ID, isDirector} from '../runtime/director-id.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {Journal} from '../store/journal.js';

/** Harvests that finish within this long of each other share one notice. */
export const NOTICE_COALESCE_MS = 3000;
/** Test and embedding hooks. */
export interface AnamnesisAppOptions {
  wall?: () => number;
  /** A headless run: no automatic harvest (a manual `runNow` still works). */
  disabled?: boolean;
  /** `YYYY-MM-DD` shown to the dream as today. */
  today?: () => string;
}
export interface AnamnesisSettings {recap: boolean; dream: boolean}
const settingsSchema = z.strictObject({version: z.literal(1), recap: z.boolean().optional(), dream: z.boolean().optional()});

export interface AnamnesisAppDeps {
  session: string; cwd: string; homeDir: string; stateDir: string; config: Config;
  store: RuntimeStore; journal: Journal; actors: ActorCatalog; registry: ProviderRegistry;
  /** The application's provider override (tests); requests go through it. */
  provider?: Provider | undefined;
  /** The foreground works: tasks, compaction, reload or a model save. */
  busy(): boolean;
  configureMeter(ownerId: string): Promise<void>;
  contexts: ContextManager;
  /** Posts a persistent read notice (the harvest's `Harvested 23:39 · recap · 2 memories`); the board exists after this module is built, so it is only called later. */
  postNotice(input: NoticeInput): void;
  options?: AnamnesisAppOptions | undefined;
}
const clock = (at: number): string => {const date = new Date(at); return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');};

export async function createAnamnesis(deps: AnamnesisAppDeps) {
  const {session, cwd, homeDir, stateDir, config, store, journal, actors, registry, contexts} = deps, options = deps.options ?? {};
  const memory = new MemoryStore(cwd, homeDir);
  const watermarks = new WatermarkStore(join(stateDir, 'sessions', session));
  const preferenceFile = new StateFile(join(homeDir, '.logox', 'anamnesis.json'), settingsSchema);
  let preferences: z.infer<typeof settingsSchema> | undefined;
  try {preferences = await preferenceFile.read();} catch {preferences = undefined;}
  const settings = (): AnamnesisSettings => ({recap: preferences?.recap ?? config.anamnesis.recap, dream: preferences?.dream ?? config.anamnesis.dream,
  });

  // The memory section is read once per session (and on /reload) and kept as one string, so the prompt prefix never changes underneath the cache.
  const folders = {project: memory.dirFor('project'), user: memory.dirFor('user')};
  let section = '';
  const refreshMemory = async () => {
    let records: readonly MemoryRecord[] = [];
    try {records = await memory.list();} catch {records = [];}
    section = memorySection({projectMemoryDir: folders.project, userMemoryDir: folders.user, records});
  };
  await refreshMemory();

  // Usage lands on the meter of the owner `anamnesis` (restored from the usage ledger like any other owner), so `/usage` lists it.
  void deps.configureMeter(ANAMNESIS_ID).catch(() => {});
  const skills = new SkillStore({user: join(homeDir, '.logox', 'skills'), project: join(cwd, '.logox', 'skills'), builtin: builtinSkillsRoot()}, options.today);
  const runner = new AnamnesisRunner({
    sessionId: session, cwd, journal, memory, watermarks,
    owners: async () => [DIRECTOR_ID, ...actors.list().map(actor => actor.id), ...(await journal.activeTasks(session)).map(task => task.ownerId)],
    model: () => resolveModel(registry, actors.modelStorage, deps.provider),
    charge: async (usage, identity) => {
      await deps.configureMeter(ANAMNESIS_ID);
      contexts.meter({sessionId: session, ownerId: ANAMNESIS_ID}).chargeUsage(usage, identity, 'anamnesis');
    },
    // A harvest rides the harvested actor's own request, so its tokens belong to that actor's meter, in a category of their own.
    chargeHarvest: async (usage, identity, ownerId) => {
      await deps.configureMeter(ownerId);
      contexts.meter({sessionId: session, ownerId}).chargeUsage(usage, identity, 'harvest');
    },
    skills,
    stageFold: async (ownerId, plan, text, request, touchedAt) => {
      const staged = await contexts.stageFold({sessionId: session, ownerId}, plan, text, request, touchedAt);
      return staged && {before: staged.before, after: staged.after, window: staged.window};
    },
    ...(options.today ? {today: options.today} : {}),
  });
  // The harvest of one actor's last request (see `anamnesis/harvest.ts`): `harvest` owns its timing, `service` its runs and cards.
  const lifetimeOf = (who: KeepAliveWho, target: KeepAliveTarget): HarvestLifetime => {
    const model = modelOfIdentity(target.model);
    // A model whose cache lifetime is unknown is harvested automatically as if it were the 5 minutes `providers/http.ts` assumes for keep-alive.
    // A manual run still reads the transcript for it (`HarvestTiming.warm()` ignores an assumed lifetime).
    return (model ? cacheLifetimeFor(registry, actors, model.provider, model.model, who.ownerId) : undefined) ?? {ms: SHORT_CACHE_MS, confidence: 'estimated', assumed: true};
  };
  const harvest: HarvestTiming = new HarvestTiming({
    lifetime: lifetimeOf,
    start: (who, target) => startHarvest(who, target),
  });
  const nameOf = (ownerId: string) => actors.find(ownerId)?.name ?? ownerId;
  // Harvests that finish close together share one notice (replaced by id): `Harvested 23:39 · Logox, Techne · recap · 3 memories · 1 skill · compacted 52% → 21%  [Keep full context]`.
  type FoldStatus = 'pending' | 'applied' | 'kept' | 'discarded' | 'restored';
  interface Finished {report: HarvestReport; runId: string; fold?: {status: FoldStatus; before: number; after: number; window: number}}
  interface Group {id: string; last: number; items: Finished[]}
  let group: Group | undefined;
  /** The harvest that staged the latest cliff compaction of each actor: its notice follows the fold's fate. */
  const folds = new Map<string, {item: Finished; group: Group}>();
  const render = (current: Group, at: number): void => {
    const items = current.items, names = [...new Set(items.map(item => item.report.ownerName))], many = names.length > 1;
    const changes = items.flatMap(item => item.report.changes.map(change => ({item, change}))), learned = items.flatMap(item => item.report.skills.map(change => ({item, change})));
    const page = <T,>(entries: {item: Finished; change: T}[], draw: (changes: T[]) => string) => many
      ? names.map(name => ({name, own: entries.filter(entry => entry.item.report.ownerName === name).map(entry => entry.change)})).filter(each => each.own.length)
        .map(each => '# ' + each.name + '\n\n' + draw(each.own)).join('\n\n')
      : draw(entries.map(entry => entry.change));
    const recap = items.find(item => item.report.recap);
    const count = (n: number, one: string, more: string) => n + ' ' + (n === 1 ? one : more);
    const folded = items.filter(item => item.fold), several = folded.length > 1;
    const percent = (tokens: number, window: number) => Math.round(tokens / window * 100) + '%';
    const foldParts = folded.flatMap(item => {
      const fold = item.fold!, who = several ? ' (' + item.report.ownerName + ')' : '', label = (several ? item.report.ownerName + ' ' : '') + 'compacted ' + percent(fold.before, fold.window) + ' → ' + percent(fold.after, fold.window);
      const button = (text: string, op: 'keep' | 'restore') => ({text: text + who, button: true as const, action: {kind: 'command' as const, name: 'fold', args: op + ' ' + item.report.owner}});
      if (fold.status === 'pending') return [{text: label}, button('Keep full context', 'keep')];
      if (fold.status === 'applied') return [{text: label}, button('Restore full context', 'restore')];
      return [{text: (several ? item.report.ownerName + ': ' : '') + (fold.status === 'kept' ? 'full context kept' : fold.status === 'restored' ? 'full context restored' : 'compaction not applied')}];
    });
    deps.postNotice({kind: 'read', tone: 'info', id: current.id, parts: [
      {text: 'Harvested ' + clock(at)},
      ...(many || items.some(item => !isDirector(item.report.owner)) ? [{text: names.join(', ')}] : []),
      ...(recap ? [{text: 'recap', action: {kind: 'jump-activity' as const, activityId: recap.runId}}] : []),
      ...(changes.length ? [{text: count(changes.length, 'memory', 'memories'), action: {kind: 'open-page' as const, title: 'Harvested memory', text: page(changes, changesPage), markdown: true}}] : []),
      ...(learned.length ? [{text: count(learned.length, 'skill', 'skills'), action: {kind: 'open-page' as const, title: 'Learned skills', text: page(learned, skillsPage), markdown: true}}] : []),
      ...foldParts]});
  };
  const announce = (finished: Finished, startedAt: number): void => {
    const {report} = finished;
    if (!report.recap && !report.changes.length && !report.skills.length && !report.fold) return;
    if (!group || report.at - group.last > NOTICE_COALESCE_MS) group = {id: 'harvest:' + session + ':' + startedAt, last: report.at, items: []};
    if (report.fold) finished.fold = {status: 'pending', ...report.fold};
    group.items.push(finished); group.last = report.at;
    if (finished.fold) folds.set(report.owner, {item: finished, group});
    render(group, report.at);
  };
  // The context manager tells what became of a staged compaction; the notice that offered it changes its button.
  contexts.foldListener = (identity, event) => {
    const entry = folds.get(identity.ownerId);
    if (!entry?.item.fold || event === 'staged') return;
    entry.item.fold.status = event;
    render(entry.group, entry.item.report.at);
  };
  /** One harvest or manual fork in flight as the timing sees it: `finished` also posts the notice. */
  const follow = (started: {runId: string; done: Promise<RunResult>}, startedAt: number): HarvestRun => ({
    cancel: () => service.cancel(started.runId),
    finished: started.done.then(result => {
      if (result.status !== 'completed') return false;
      if (result.outcome.harvest) announce({report: result.outcome.harvest, runId: started.runId}, startedAt);
      return true;
    }, () => false),
  });
  const sourceOf = (target: KeepAliveTarget, parts: HarvestParts, owner: string, fold?: CliffPlan): HarvestSource | undefined =>
    target.reply && !target.reply.toolCalls?.length ? {request: target.request, reply: target.reply, provider: target.provider, model: target.model, parts, owner, ownerName: nameOf(owner), ...(fold ? {fold} : {})} : undefined;
  async function startHarvest(who: KeepAliveWho, target: KeepAliveTarget): Promise<HarvestRun | undefined> {
    const current = settings();
    if (options.disabled || (!current.recap && !current.dream)) return undefined;
    const parts = await runner.harvestParts({recap: current.recap, memory: current.dream}, who.ownerId);
    // The overview of the older closed rounds rides along when the setting is on, the context is large enough and no peer work is pending (never otherwise).
    const fold = parts.recap || parts.memory ? await contexts.cliffPlan({sessionId: session, ownerId: who.ownerId}, target.request) : undefined;
    const source = parts.recap || parts.memory ? sourceOf(target, fold ? {...parts, compaction: true} : parts, who.ownerId, fold) : undefined;
    const started = source && service.startHarvest(source);
    return started ? follow(started, target.startedAt) : undefined;
  }
  const service = new Anamnesis(session, store, runner, deps.busy, {...(options.wall ? {wall: options.wall} : {})});

  const api = {
    /** Starts a run now; throws while tasks run. `done` settles with the outcome and never rejects. While the Director's cache is warm it forks its request, otherwise it reads the transcript. */
    runNow(kind: RunKind): {runId: string; done: Promise<RunResult>} {
      const warm = harvest.warm(session, DIRECTOR_ID);
      const dream = kind === 'dream', source = warm && sourceOf(warm.target, {recap: kind === 'recap', memory: dream, skills: dream}, DIRECTOR_ID);
      if (!warm || !source) return service.runNow(kind);
      const started = service.runNow(kind, source);
      harvest.follow(warm.who, follow(started, warm.target.startedAt));
      return started;
    },
    /** The kind running now, if any. */
    running: (): RunKind | undefined => service.running(),
    /** Every record of both folders, project first, then by name. */
    memories: (): Promise<readonly MemoryRecord[]> => memory.list(),
    /** Deletes one record file; false when it did not exist. The prompt section keeps its list until the next session or `/reload`. */
    forget: (scope: MemoryScope, name: string): Promise<boolean> => memory.delete(name, scope),
    /** The two memory folders (absolute). */
    folders: (): {project: string; user: string} => ({...folders}),
    /** The binding of Anamnesis, or the Director's selection (`inherited: true`). */
    anamnesisModel: (): AnamnesisModel => anamnesisModel(registry, actors.modelStorage),
    /** Binds a model, or with `undefined` goes back to following the Director. The next transcript run uses it (a harvest uses the harvested actor's own model). */
    setAnamnesisModel: (binding: ActorModel | undefined): Promise<void> => bindAnamnesisModel(actors.modelStorage, binding),
    /** The two switches (user preference over `[anamnesis]` config): they gate the parts of an automatic harvest. */
    settings,
    /** Persists one switch in `~/.logox/anamnesis.json`; it never affects `runNow`. */
    async setAuto(kind: RunKind, enabled: boolean): Promise<void> {
      await preferenceFile.update(current => ({...current, version: 1 as const, [kind]: enabled}));
      preferences = {...preferences, version: 1, [kind]: enabled};
    },
  };
  const lifecycle = {
    /** A keystroke: nothing happens (only a sent message interrupts a run). */
    noteDraft: () => service.noteDraft(),
    foregroundSubmitted: () => service.foregroundSubmitted(),
    /** The static memory section for the system prompt of every actor. */
    memoryPrompt: () => section,
    refreshMemory,
    /** Timing of every actor's harvest: the cache keeper offers the Director the last slot of a human wait, a companion has its own timer (`kernel/harvest-timing.ts`). */
    harvest,
    async close() {
      harvest.dispose();
      await service.close();
    },
  };
  return {api, lifecycle};
}
export type AnamnesisApi = Awaited<ReturnType<typeof createAnamnesis>>['api'];
