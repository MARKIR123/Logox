/**
 * Footer status and usage metering of one session. Owns the status revision (`bumpStatus` and everything that changes the
 * footer without touching the store or the statusbar preferences), the lazily started git source, the set of
 * subscription-billed providers, and the once-per-owner restore of persisted usage into each context meter. The application
 * container and the pages read the status through the functions returned here and never keep their own copy.
 */
import {appendFile, mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {ActorCatalog} from '../actors/catalog.js';
import type {TaskModels} from '../actors/task-models.js';
import {actorUsage, stageStatus, type StageStatusOptions} from '../application-status.js';
import type {Config} from '../config/config.js';
import type {StatusbarPreferences} from '../config/statusbar-preferences.js';
import type {ContextManager} from '../context/manager.js';
import {turnUsageOf} from '../context/cost.js';
import type {UsageLedger} from '../context/usage.js';
import {GitStatusSource} from '../extensions/git-status.js';
import type {PermissionEngine} from '../permissions/engine.js';
import type {ProviderRegistry} from '../providers/registry.js';
import {DIRECTOR_ID} from '../runtime/director-id.js';
import type {RuntimeStore} from '../runtime/store.js';

export interface SessionStatusDeps {
  session: string; cwd: string; stateDir: string; config: Config;
  store: RuntimeStore; actors: ActorCatalog; registry: ProviderRegistry; taskModels: TaskModels; contexts: ContextManager;
  permissions: PermissionEngine; statusbar: StatusbarPreferences; usage: UsageLedger;
}

export function createSessionStatus(deps: SessionStatusDeps) {
  const {session, cwd, stateDir, config, store, actors, registry, taskModels, contexts, permissions, statusbar, usage} = deps;
  // Status revision: anything that changes the footer without touching the store or statusbar preferences bumps it.
  let statusTick = 0;
  const statusListeners = new Set<() => void>();
  const bumpStatus = () => {statusTick++; for (const listener of [...statusListeners]) listener();};
  const gitStatus = new GitStatusSource(cwd, bumpStatus);
  // The git module is off by default: only spawn git once the user enables it.
  const gitEnabled = () => statusbar.getSnapshot().modules.some(module => module.id === 'git' && module.enabled);
  let gitStarted = false;
  const startGit = () => {if (!gitStarted && gitEnabled()) {gitStarted = true; gitStatus.start();}};
  startGit();
  const stopGitWatch = statusbar.subscribe(startGit);
  const subscriptionProviders = new Set<string>();
  let subscriptionsDone: Promise<void> = Promise.resolve();
  const refreshSubscriptions = () => {subscriptionsDone = (async () => {
    const found = new Set<string>();
    for (const name of await registry.auth.providers()) if ((await registry.auth.credential(name))?.type === 'oauth') found.add(name);
    subscriptionProviders.clear(); for (const name of found) subscriptionProviders.add(name);
    bumpStatus();
  })().catch(() => {});};
  refreshSubscriptions();
  const meterReady = new Map<string, Promise<void>>();
  /** Restores one owner's persisted usage into its meter exactly once, however many callers race. */
  function configureMeter(ownerId: string): Promise<void> {
    let ready = meterReady.get(ownerId);
    if (!ready) {
      ready = (async () => {
        const meter = contexts.meter({sessionId: session, ownerId});
        meter.configureUsage(() => taskModels.summarizer({sessionId: session, ownerId}).model.identity,
          record => {
            usage.record(session, ownerId, record); bumpStatus();
            // Automa turns are stored on their automa.jsonl events; summary and approval calls get an append-only session-level line.
            if (record.category === 'summary' || record.category === 'approval' || record.category === 'keepalive') {
              const turn = turnUsageOf(record, record.model, config);
              if (turn) {
                const file = join(stateDir, 'sessions', session, 'usage.jsonl');
                void mkdir(dirname(file), {recursive: true}).then(() => appendFile(file, JSON.stringify({version: 1, time: Date.now(), ownerId, category: record.category, usage: turn}) + String.fromCharCode(10))).catch(() => {});
              }
            }
          }, await usage.read(session, ownerId));
        bumpStatus();
      })();
      meterReady.set(ownerId, ready);
    }
    return ready;
  }
  // A resumed session shows its totals and context readings before any actor runs.
  const meterRestore = Promise.all([DIRECTOR_ID, ...actors.list().map(item => item.id)].map(async ownerId => {
    await configureMeter(ownerId);
    await contexts.restoreReading({sessionId: session, ownerId});
  })).then(bumpStatus).catch(() => {});
  /** The one set of inputs every status reading (footer, pages, /ensemble usage) is computed from. */
  const options: StageStatusOptions = {sessionId: session, cwd, store, actors, registry, taskModels, contexts, permissions, config,
    subscriptions: () => subscriptionProviders, git: () => gitStatus.get()};
  return {
    bumpStatus, refreshSubscriptions, configureMeter, meterRestore, options,
    status: (ownerId: string) => stageStatus(options, ownerId),
    actorUsage: (ownerId: string) => actorUsage(options, ownerId),
    sessionUsageRecords: () => [...contexts.sessionMeters(session).values()].flatMap(meter => meter.usageRecords()),
    /** The settling refresh of the subscription list; read at close time because every refresh replaces it. */
    subscriptionsDone: () => subscriptionsDone,
    revision: () => store.getSnapshot().revision + ':' + statusbar.getSnapshot().revision + ':' + statusTick,
    subscribe(listener: () => void) {
      const stopStore = store.subscribe(() => {if (gitStarted) gitStatus.touch(); listener();}), stopPreferences = statusbar.subscribe(listener);
      statusListeners.add(listener);
      return () => {stopStore(); stopPreferences(); statusListeners.delete(listener);};
    },
    /** Stops watching git and closes the source. */
    async closeGit() {stopGitWatch(); await gitStatus.close();},
  };
}
export type SessionStatus = ReturnType<typeof createSessionStatus>;
