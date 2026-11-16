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
import {AnamnesisRunner} from '../anamnesis/runner.js';
import {Anamnesis, type RunKind, type RunResult} from '../anamnesis/service.js';
import {WatermarkStore} from '../anamnesis/watermark.js';
import type {Config} from '../config/config.js';
import {StateFile} from '../config/model-preferences.js';
import type {ContextManager} from '../context/manager.js';
import {memorySection} from '../prompts/memory.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {Provider} from '../runtime/messages.js';
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
  options?: AnamnesisAppOptions | undefined;
}

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
    ...(options.today ? {today: options.today} : {}),
  });
  const service = new Anamnesis(session, store, runner, deps.busy, {
    ...(options.clock ? {clock: options.clock} : {}), ...(options.wall ? {wall: options.wall} : {}),
    recapIdleMs: options.recapIdleMs ?? config.anamnesis.recap_idle_minutes * 60_000,
    dreamIdleMs: options.dreamIdleMs ?? config.anamnesis.dream_idle_minutes * 60_000,
    auto: () => {const current = settings(); return options.disabled ? {recap: false, dream: false} : {recap: current.recap, dream: current.dream};},
  });
  let timer: ReturnType<typeof setInterval> | undefined;

  const api = {
    /** Starts a run now, whatever the idle clock says; throws while tasks run. `done` settles with the outcome and never rejects. */
    runNow: (kind: RunKind): {runId: string; done: Promise<RunResult>} => service.runNow(kind),
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
      await service.close();
    },
  };
  return {api, lifecycle};
}
export type AnamnesisApi = Awaited<ReturnType<typeof createAnamnesis>>['api'];
