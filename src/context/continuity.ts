import type {ModelMessage} from '../runtime/messages.js';
import {executionEnvironmentSchema, type RuntimeContextMessage} from '../runtime/context-updates.js';
import {collectDiscoveredTools} from '../tools/discovery.js';
import {formatEnvironment} from './environment.js';

/** Snapshots always derive from the effective ledger, never from a different branch's side state. */
export function contextSnapshot(messages: readonly ModelMessage[]) {
  const environments = messages.flatMap(message => {
    if (message.role !== 'context' || !['environment-baseline', 'environment-change'].includes(message.kind)) return [];
    const parsed = executionEnvironmentSchema.safeParse(message.data);
    return parsed.success ? [parsed.data] : [];
  });
  return {discoveredTools: collectDiscoveredTools(messages), ...(environments.length ? {
    environmentBaseline: environments[0]!, environmentCurrent: environments.at(-1)!,
  } : {})};
}

/** Preserve effective host facts at the removed range's position, before subsequent live updates. */
export function retainRuntimeContext(messages: readonly ModelMessage[], activityId?: string): readonly RuntimeContextMessage[] {
  const selected = new Map<string, {index: number; message: RuntimeContextMessage}>();
  messages.forEach((message, index) => {
    if (message.role !== 'context' || message.kind === 'ledger') return;
    let key: string, retained = message;
    if (message.kind === 'environment-baseline') key = message.kind;
    else if (message.kind === 'environment-change') {
      key = message.kind;
      retained = {...message, text: 'Restored execution environment:\n' + formatEnvironment(executionEnvironmentSchema.parse(message.data))};
    } else if (message.kind === 'capability-change') key = message.kind + ':' + String(message.data?.scope ?? '') + ':' + String(message.data?.baseline === true);
    else {
      if (!activityId || message.data?.activityId !== activityId) return;
      key = message.kind + ':' + String(message.data?.slot ?? '');
    }
    selected.set(key, {index, message: retained});
  });
  return [...selected.values()].sort((a, b) => a.index - b.index).map(item => item.message);
}
