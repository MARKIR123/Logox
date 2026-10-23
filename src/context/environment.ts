import {createHash} from 'node:crypto';

export interface ExecutionEnvironment {
  model: string; effort: string; permission: string; directory: string;
  tools: readonly string[]; skills: readonly string[]; rules: string; services: readonly string[];
}
const labels: Record<keyof ExecutionEnvironment, string> = {
  model: 'Task model', effort: 'Thinking effort', permission: 'Permission and action boundary', directory: 'Working directory',
  tools: 'Available tools', skills: 'Role skills', rules: 'Rules version', services: 'Service connections',
};
/** Current state enters every request; UI changes are deduplicated per role. */
export class EnvironmentState {
  private readonly states = new Map<string, ExecutionEnvironment>();
  update(ownerId: string, next: ExecutionEnvironment): {text: string; changes: string} {
    const previous = this.states.get(ownerId);
    const keys = Object.keys(labels) as Array<keyof ExecutionEnvironment>;
    const show = (key: keyof ExecutionEnvironment) => labels[key] + ': ' +
      (Array.isArray(next[key]) ? (next[key] as readonly string[]).join(', ') || 'none' : next[key]);
    const changed = previous ? keys.filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key])) : [];
    this.states.set(ownerId, structuredClone(next));
    return {text: keys.map(show).join('\n'), changes: changed.map(show).join('\n')};
  }
}
export function environmentVersion(text: string): string {return createHash('sha256').update(text).digest('hex').slice(0, 12);}
