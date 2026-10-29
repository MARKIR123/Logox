import {createHash} from 'node:crypto';
import type {ModelMessage} from '../runtime/messages.js';
import {createRuntimeContextMessage, executionEnvironmentSchema, type ExecutionEnvironment, type RuntimeContextMessage} from '../runtime/context-updates.js';
export type {ExecutionEnvironment} from '../runtime/context-updates.js';

const labels: Record<keyof ExecutionEnvironment, string> = {
  model: 'Task model', effort: 'Thinking effort', permission: 'Permission and action boundary', directory: 'Working directory',
  scratchpad: 'Scratchpad directory', rules: 'Rules version', services: 'Service connections',
};
export function formatEnvironment(value: ExecutionEnvironment, keys = Object.keys(labels) as Array<keyof ExecutionEnvironment>): string {
  return keys.map(key => labels[key] + ': ' +
    (Array.isArray(value[key]) ? (value[key] as readonly string[]).join(', ') || 'none' : value[key])).join('\n');
}
/** Delivery is determined by the effective ledger, never by a preparation attempt. */
export class EnvironmentState {
  plan(current: ExecutionEnvironment, history: readonly ModelMessage[]): {baseline: ExecutionEnvironment; updates: readonly RuntimeContextMessage[]} {
    const next = executionEnvironmentSchema.parse(current);
    const snapshots = history.flatMap(message => {
      if (message.role !== 'context' || !['environment-baseline', 'environment-change'].includes(message.kind)) return [];
      const parsed = executionEnvironmentSchema.safeParse(message.data);
      return parsed.success ? [parsed.data] : [];
    });
    const baseline = snapshots[0] ?? next, previous = snapshots.at(-1);
    if (!previous) return {baseline, updates: [createRuntimeContextMessage('environment-baseline', formatEnvironment(next), next)]};
    const changed = (Object.keys(labels) as Array<keyof ExecutionEnvironment>).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
    return {baseline, updates: changed.length ? [createRuntimeContextMessage('environment-change', formatEnvironment(next, changed), next)] : []};
  }
}
export function environmentVersion(text: string): string {return createHash('sha256').update(text).digest('hex').slice(0, 12);}
