import {z} from 'zod';
import type {ToolResult} from '../../types.js';
import type {ActivityStatus, RuntimeSnapshot} from '../../../runtime/contracts.js';
import {toolFacts} from '../../../actors/facts.js';

export const listActorsSchema = z.strictObject({});
export type ListActorsArgs = z.infer<typeof listActorsSchema>;
export interface ActorStatusReport {
  id: string; name: string; status: 'busy' | 'idle'; activityStatus?: ActivityStatus;
  stage?: string; activityId?: string; currentTool?: string; tool_id?: string; toolElapsed?: string;
  queuedCount?: number; recentTools?: ReturnType<typeof toolFacts>['recentTools'];
}
const DEFAULT_NAMES: Record<string, string> = {logox: 'Logox', techne: 'Techne', aletheia: 'Aletheia', kalon: 'Kalon'};

export function executeListActors(_args: ListActorsArgs, context: {
  caller: string; getSnapshot: () => RuntimeSnapshot; roles?: Record<string, {name: string; title?: string}>;
}): ToolResult {
  const isDirector = context.caller === 'logox' || context.caller === 'director';
  const snapshot = context.getSnapshot();
  const ids = [...new Set([...Object.keys(context.roles ?? DEFAULT_NAMES), ...snapshot.activities.map(activity => activity.ownerId)])]
    .filter(id => id !== context.caller && !(isDirector && id === 'logox'));
  const actors: ActorStatusReport[] = ids.map(id => {
    const activities = snapshot.activities.filter(activity => activity.ownerId === id);
    const active = activities.findLast(activity => ['running', 'waiting_input'].includes(activity.status)) ??
      activities.find(activity => ['queued', 'paused'].includes(activity.status));
    const base = {id, name: context.roles?.[id]?.name ?? DEFAULT_NAMES[id] ?? id};
    if (!active) {
      const latest = activities.at(-1);
      return {...base, status: 'idle', stage: 'idle', ...(isDirector && latest ? {
        activityStatus: latest.status, activityId: latest.activityId, recentTools: toolFacts(snapshot, latest.activityId).recentTools,
      } : {})};
    }
    const state = {...base, status: 'busy' as const, activityStatus: active.status, stage: active.stage || active.status};
    if (!isDirector) return state;
    return {...state, activityId: active.activityId, queuedCount: activities.filter(activity => activity.status === 'queued').length,
      ...toolFacts(snapshot, active.activityId)};
  });
  return {text: JSON.stringify({actors}, null, 2), isError: false};
}

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'ListActors', category: 'coordination', roles: 'all', terminalVisibility: 'card', description: 'List available actors in the active ensemble'};
