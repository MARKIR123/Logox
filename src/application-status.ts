import {isDirector} from './runtime/director-id.js';
import type {ActorCatalog} from './actors/catalog.js';
import type {TaskModels} from './actors/task-models.js';
import type {Config} from './config/config.js';
import {costOf, modelPrice} from './context/cost.js';
import type {UsageRecord} from './context/budget.js';
import type {ContextManager} from './context/manager.js';
import type {PermissionEngine} from './permissions/engine.js';
import type {ProviderRegistry} from './providers/registry.js';
import type {RuntimeStore} from './runtime/store.js';
import {modelTable} from './providers/model-table.js';
import type {GitStatus, StageStatus, TokenTotals} from './runtime/stage-status.js';

const states = {queued: 'Queued', running: 'Running', waiting_input: 'Awaiting answer', paused: 'Paused',
  completed: 'Completed', failed: 'Failed', cancelled: 'Stopped'};
const live = ['queued', 'running', 'waiting_input', 'paused'];
function totals(records: Iterable<UsageRecord>): TokenTotals {
  let input = 0, output = 0, cached = 0;
  for (const record of records) {input += record.input - record.cacheRead; output += record.output; cached += record.cacheRead;}
  return {input, output, cached};
}
export interface StageStatusOptions {
  sessionId: string; cwd: string; store: RuntimeStore; actors: ActorCatalog; taskModels: TaskModels; registry: ProviderRegistry;
  contexts: ContextManager; permissions: PermissionEngine; config: Config;
  /** Providers billed by subscription (OAuth sign-in); their cost is never shown. */
  subscriptions?: () => ReadonlySet<string>;
  git?: () => GitStatus | undefined;
}
/** Run state of one window: the live activity, else what the window's companions are doing, else how its latest activity ended. */
export function windowState(store: RuntimeStore, ownerId: string): string {
  const snapshot = store.getSnapshot();
  const own = snapshot.activities.filter(activity => activity.ownerId === ownerId && activity.kind !== 'anamnesis').reverse();
  const active = own.find(activity => ['running', 'waiting_input'].includes(activity.status)) ?? own.find(activity => ['queued', 'paused'].includes(activity.status));
  if (active?.status === 'waiting_input') {
    const asking = snapshot.interactions.find(item => item.status === 'pending' && item.ownerId === ownerId);
    return asking?.kind === 'permission' ? 'Awaiting permission' : 'Awaiting answer';
  }
  if (active) return states[active.status];
  if (isDirector(ownerId)) {
    const busy = new Set(snapshot.activities.filter(activity => !isDirector(activity.ownerId) && activity.kind === 'actor' && live.includes(activity.status)).map(activity => activity.ownerId));
    if (busy.size) return 'Waiting on ' + busy.size + (busy.size === 1 ? ' actor' : ' actors');
  }
  return own[0] ? states[own[0].status] : 'Ready';
}
export function stageStatus(options: StageStatusOptions, ownerId: string): StageStatus {
  const {sessionId, cwd, store, actors, registry, taskModels, contexts, permissions, config} = options;
  const activities = store.getSnapshot().activities.filter(activity => activity.ownerId === ownerId);
  const recent = [...activities].reverse();
  const active = recent.find(activity => ['running', 'waiting_input'].includes(activity.status)) ??
    recent.find(activity => ['queued', 'paused'].includes(activity.status));
  const identity = {sessionId, ownerId};
  // Same path as the runtime: a running task reports its actual model, an idle window the model its next task would start with.
  let selected: {provider: string; model: string};
  try {selected = active?.taskModel ? taskModels.selection(identity) : taskModels.idleSelection(ownerId);}
  catch {selected = registry.selection();}
  let effort = 'Unsupported', effortError: string | undefined;
  try {
    const thinking = active?.taskModel ? taskModels.thinking(identity) : registry.candidate(selected.provider, selected.model).thinking();
    effort = thinking.levels.length > 1 ? thinking.effort : 'Unsupported';
  } catch (error) {effort = 'Unavailable'; effortError = error instanceof Error ? error.message : String(error);}
  const reading = contexts.status(identity), meter = contexts.meter(identity);
  const metersBySession = [...contexts.sessionMeters(sessionId).values()];
  const sessionRecords = metersBySession.flatMap(item => item.usageRecords());
  const windowTotals = totals(meter.usageRecords()), session = totals(sessionRecords);
  const subscriptions = options.subscriptions?.() ?? new Set<string>();
  const cost = costOf(sessionRecords, config, provider => subscriptions.has(provider));
  const actor = actors.find(ownerId);
  const git = options.git?.();
  const hit = modelTable.resolve(selected.provider, selected.model, {catalogs: config.catalogs}), price = modelPrice(config, selected.provider, selected.model);
  const window = reading?.window ?? hit?.model.window;
  const modelInfo = {...(window ? {window} : {}), ...(hit?.model.maxOutput ? {maxOutput: hit.model.maxOutput} : {}),
    ...(price ? {currency: price.currency, ...(price.input !== undefined ? {input: price.input} : {}), ...(price.output !== undefined ? {output: price.output} : {}),
      ...(price.cache_read !== undefined ? {cacheRead: price.cache_read} : {}), ...(price.subscription ? {subscription: true} : {})} : {})};
  return {ownerId, name: actor?.name ?? ownerId, ...(actor?.color ? {color: actor.color} : {}), model: {provider: selected.provider, model: selected.model}, modelInfo,
    effort, ...(effortError ? {effortError} : {}), permission: permissions.mode, state: windowState(store, ownerId),
    ...(reading ? {context: {tokens: reading.input, window: reading.window, high: reading.high, estimated: reading.estimated, over: reading.input > reading.window,
      ...(reading.categories ? {categories: reading.categories} : {})}} : {}),
    tokens: session.input + session.output, usage: {window: windowTotals, session},
    ...(cost ? {cost: cost.amount, costCurrency: cost.currency, ...(cost.partial ? {costPartial: true} : {})} : {}),
    ...(git ? {git} : {}), session: sessionId, project: cwd};
}
/** Tokens and cost of one actor's window in this session (the /ensemble "This session" block). */
export function actorUsage(options: StageStatusOptions, ownerId: string): {input: number; output: number; cost?: string} {
  const records = options.contexts.meter({sessionId: options.sessionId, ownerId}).usageRecords();
  const sum = totals(records), subscriptions = options.subscriptions?.() ?? new Set<string>();
  const cost = costOf(records, options.config, provider => subscriptions.has(provider));
  return {input: sum.input, output: sum.output, ...(cost ? {cost: (cost.partial ? '~' : '') + cost.currency + ' ' + cost.amount.toFixed(4)} : {})};
}
