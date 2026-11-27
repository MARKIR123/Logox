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
import {changesPage, type HarvestParts, type HarvestSource} from '../anamnesis/harvest.js';
import {AnamnesisRunner} from '../anamnesis/runner.js';
import {Anamnesis, type RunKind, type RunResult} from '../anamnesis/service.js';
import {WatermarkStore} from '../anamnesis/watermark.js';
import type {Config} from '../config/config.js';
import {StateFile} from '../config/model-preferences.js';
import type {ContextManager} from '../context/manager.js';
import {HarvestTiming, type HarvestRun} from '../kernel/harvest-timing.js';
import type {KeepAliveTarget, KeepAliveWho} from '../kernel/cache-keepalive.js';
import {memorySection} from '../prompts/memory.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {Provider} from '../runtime/messages.js';
import type {NoticeInput} from '../runtime/notices.js';
import {cacheLifetimeFor, modelOfIdentity} from './cache-lifetime.js';
import {DIRECTOR_ID} from '../runtime/director-id.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {Journal} from '../store/journal.js';

/** How often the idle check runs when the application is activated. */
export const ANAMNESIS_TICK_MS = 15_000;
/** Test and embedding hooks: every clock, the interval and the idle thresholds can be replaced. An interval is only started when one is given or the process is not a test. */
export interface AnamnesisAppOptions {
  clock?: () => number;
  wall?: () => number;
  /** Interval of the idle check; without it `activate()` uses `ANAMNESIS_TICK_MS` outside tests and starts nothing inside them. */
  tickMs?: number;
  /** A headless run: no automatic recap or dream and no idle interval (a manual `runNow` still works). */
  disabled?: boolean;
  recapIdleMs?: number;
  dreamIdleMs?: number;
  /** `YYYY-MM-DD` shown to the dream as today. */
  today?: () => string;
}
export interface AnamnesisSettings {recap: boolean; dream: boolean; recapIdleMinutes: number; dreamIdleMinutes: number}
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
    recapIdleMinutes: config.anamnesis.recap_idle_minutes, dreamIdleMinutes: config.anamnesis.dream_idle_minutes});

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
  const runner = new AnamnesisRunner({
    sessionId: session, cwd, journal, memory, watermarks,
    owners: async () => [DIRECTOR_ID, ...actors.list().map(actor => actor.id), ...(await journal.activeTasks(session)).map(task => task.ownerId)],
    model: () => resolveModel(registry, actors.modelStorage, deps.provider),
    charge: async (usage, identity) => {
      await deps.configureMeter(ANAMNESIS_ID);
      contexts.meter({sessionId: session, ownerId: ANAMNESIS_ID}).chargeUsage(usage, identity, 'anamnesis');
    },
    // A harvest rides the Director's own request, so its tokens belong to the Director's meter, in a category of their own.
    chargeHarvest: async (usage, identity) => {
      await deps.configureMeter(DIRECTOR_ID);
      contexts.meter({sessionId: session, ownerId: DIRECTOR_ID}).chargeUsage(usage, identity, 'harvest');
    },
    ...(options.today ? {today: options.today} : {}),
  });
  // The harvest of the Director's last request (see `anamnesis/harvest.ts`): `harvest` owns its timing, `service` its single flight and card.
  const harvest: HarvestTiming = new HarvestTiming({
    lifetime: (who, target) => {const model = modelOfIdentity(target.model); return model ? cacheLifetimeFor(registry, actors, model.provider, model.model, who.ownerId) : undefined;},
    awayMs: () => config.kernel.away_keepalive_minutes * 60_000,
    start: (who, target) => startHarvest(who, target),
  });
  /** One harvest or manual fork in flight as the timing sees it: `finished` also posts the notice. */
  const follow = (started: {runId: string; done: Promise<RunResult>}, startedAt: number): HarvestRun => ({
    cancel: () => {void service.pause();},
    finished: started.done.then(result => {
      if (result.status !== 'completed') return false;
      const report = result.outcome.harvest;
      if (report && (report.recap || report.changes.length)) {
        const count = report.changes.length;
        deps.postNotice({kind: 'read', tone: 'info', id: 'harvest:' + session + ':' + startedAt, parts: [
          {text: 'Harvested ' + clock(report.at)},
          ...(report.recap ? [{text: 'recap', action: {kind: 'jump-activity' as const, activityId: started.runId}}] : []),
          ...(count ? [{text: count + (count === 1 ? ' memory' : ' memories'), action: {kind: 'open-page' as const, title: 'Harvested memory', text: changesPage(report.changes), markdown: true}}] : [])]});
      }
      return true;
    }, () => false),
  });
  const sourceOf = (target: KeepAliveTarget, parts: HarvestParts): HarvestSource | undefined =>
    target.reply && !target.reply.toolCalls?.length ? {request: target.request, reply: target.reply, provider: target.provider, model: target.model, parts} : undefined;
  async function startHarvest(_who: KeepAliveWho, target: KeepAliveTarget): Promise<HarvestRun | undefined> {
    const current = settings();
    if (options.disabled || (!current.recap && !current.dream)) return undefined;
    const parts = await runner.harvestParts({recap: current.recap, memory: current.dream});
    const source = parts.recap || parts.memory ? sourceOf(target, parts) : undefined;
    const started = source && service.startHarvest(source);
    return started ? follow(started, target.startedAt) : undefined;
  }
  const service = new Anamnesis(session, store, runner, deps.busy, {
    deferred: () => harvest.pending(),
    ...(options.clock ? {clock: options.clock} : {}), ...(options.wall ? {wall: options.wall} : {}),
    recapIdleMs: options.recapIdleMs ?? config.anamnesis.recap_idle_minutes * 60_000,
    dreamIdleMs: options.dreamIdleMs ?? config.anamnesis.dream_idle_minutes * 60_000,
    auto: () => {const current = settings(); return options.disabled ? {recap: false, dream: false} : {recap: current.recap, dream: current.dream};},
  });
  let timer: ReturnType<typeof setInterval> | undefined;

  const api = {
    /** Starts a run now, whatever the idle clock says; throws while tasks run. `done` settles with the outcome and never rejects. */
    runNow(kind: RunKind): {runId: string; done: Promise<RunResult>} {
      // While the Director's cache is still warm the run forks its request (the part the kind names); a cold one reads the transcript.
      const warm = harvest.warm(session, DIRECTOR_ID);
      const source = warm && sourceOf(warm.target, {recap: kind === 'recap', memory: kind === 'dream'});
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
    /** Binds a model, or with `undefined` goes back to following the Director. The next run uses it. */
    setAnamnesisModel: (binding: ActorModel | undefined): Promise<void> => bindAnamnesisModel(actors.modelStorage, binding),
    /** The automatic switches (user preference over `[anamnesis]` config) and the idle thresholds. */
    settings,
    /** Persists one automatic switch in `~/.logox/anamnesis.json`; it never affects `runNow`. */
    async setAuto(kind: RunKind, enabled: boolean): Promise<void> {
      await preferenceFile.update(current => ({...current, version: 1 as const, [kind]: enabled}));
      preferences = {...preferences, version: 1, [kind]: enabled};
    },
  };
  const lifecycle = {
    noteDraft: () => service.noteDraft(),
    foregroundSubmitted: () => service.foregroundSubmitted(),
    foregroundFinished: () => service.foregroundFinished(),
    /** The static memory section for the system prompt of every actor. */
    memoryPrompt: () => section,
    refreshMemory,
    /** Timing of the Director's harvest: the cache keeper offers it the last slot of a human wait (`kernel/harvest-timing.ts`). */
    harvest,
    /** Starts the idle interval (unref'd); `fallbackMs` applies when the options give none. Does nothing without an interval. */
    start(fallbackMs?: number) {
      const every = options.tickMs ?? fallbackMs;
      if (timer || every === undefined || options.disabled) return;
      timer = setInterval(() => {void service.tick().catch(() => {});}, every);
      timer.unref();
    },
    tick: () => service.tick(),
    async close() {
      if (timer) {clearInterval(timer); timer = undefined;}
      harvest.dispose();
      await service.close();
    },
  };
  return {api, lifecycle};
}
export type AnamnesisApi = Awaited<ReturnType<typeof createAnamnesis>>['api'];
