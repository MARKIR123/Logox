import type {ActorCatalog} from './actors/catalog.js';
import type {TaskModels} from './actors/task-models.js';
import type {Config} from './config/config.js';
import type {ContextManager} from './context/manager.js';
import type {PermissionEngine} from './permissions/engine.js';
import type {ProviderRegistry} from './providers/registry.js';
import type {RuntimeStore} from './runtime/store.js';
import type {StageStatus} from './runtime/stage-status.js';

const states = {queued: '排队中', running: '运行中', waiting_input: '待回答', paused: '已暂停',
  completed: '已完成', failed: '失败', cancelled: '已停止'};
export function stageStatus(options: {sessionId: string; cwd: string; store: RuntimeStore; actors: ActorCatalog;
  taskModels: TaskModels; registry: ProviderRegistry; contexts: ContextManager; permissions: PermissionEngine; config: Config},
  ownerId: string): StageStatus {
  const {sessionId, cwd, store, actors, registry, taskModels, contexts, permissions, config} = options;
  const activities = store.getSnapshot().activities.filter(activity => activity.ownerId === ownerId);
  const recent = [...activities].reverse();
  const active = recent.find(activity => ['running', 'waiting_input'].includes(activity.status)) ??
    recent.find(activity => ['queued', 'paused'].includes(activity.status));
  const selected = active?.taskModel?.actual ?? (ownerId === 'logox' ? undefined : actors.find(ownerId)?.defaultModel) ?? registry.selection();
  let effort = '不支持';
  try {const thinking = active?.taskModel ? taskModels.thinking({sessionId, ownerId}) : registry.candidate(selected.provider, selected.model).thinking();
    effort = thinking.levels.length > 1 ? thinking.effort : '不支持';} catch {}
  const identity = {sessionId, ownerId}, context = contexts.status(identity), records = contexts.meter(identity).usageRecords();
  let cost = 0, currency: string | undefined, known = records.length > 0;
  for (const record of records) {
    let key = record.model;
    try {const parts: unknown = JSON.parse(record.model); if (Array.isArray(parts)) key = String(parts[0]) + '/' + String(parts[1]);} catch {}
    const price = config.models[key]?.prices;
    const buckets = [[record.input - record.cacheRead - record.cacheWrite, price?.input], [record.output, price?.output],
      [record.cacheRead, price?.cache_read], [record.cacheWrite, price?.cache_write]] as const;
    if (!price || currency && currency !== price.currency || buckets.some(([tokens, rate]) => tokens > 0 && rate === undefined)) known = false;
    currency ??= price?.currency;
    cost += buckets.reduce((sum, [tokens, rate]) => sum + tokens * (rate ?? 0) / 1e6, 0);
  }
  const spent = contexts.meter(identity).spent;
  const actor = actors.find(ownerId);
  return {ownerId, name: actor?.name ?? ownerId, ...(actor?.color ? {color: actor.color} : {}), model: {provider: selected.provider, model: selected.model},
    effort, permission: permissions.mode, state: active ? states[active.status] : '就绪',
    ...(context ? {context: {tokens: context.input, window: context.window}} : {}), tokens: spent.input + spent.output,
    ...(known ? {cost, ...(currency ? {costCurrency: currency} : {})} : {}), session: sessionId, project: cwd};
}
