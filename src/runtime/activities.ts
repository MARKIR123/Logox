import {activitySchema, immutable, type Activity, type ActivityStatus} from './contracts.js';

const transitions: Record<ActivityStatus, readonly ActivityStatus[]> = {
  queued: ['running', 'paused', 'cancelled', 'failed'],
  running: ['waiting_input', 'paused', 'completed', 'failed', 'cancelled'],
  waiting_input: ['running', 'paused', 'failed', 'cancelled'],
  paused: ['queued', 'running', 'cancelled', 'failed'],
  completed: [], failed: [], cancelled: [],
};
export function activityKey(sessionId: string, activityId: string): string {
  return JSON.stringify([sessionId, activityId]);
}
export class Activities {
  private readonly records = new Map<string, Activity>();
  constructor(private readonly onChange: () => void) {}
  list(): readonly Activity[] { return Object.freeze([...this.records.values()]); }
  clearSession(sessionId: string): void {
    const entries = [...this.records].filter(([, activity]) => activity.sessionId === sessionId);
    if (entries.some(([, activity]) => transitions[activity.status].length > 0)) throw new Error('Activities have not finished; the display cannot be cleared');
    for (const [key] of entries) this.records.delete(key);
    this.onChange();
  }
  get(sessionId: string, activityId: string): Activity | undefined {
    return this.records.get(activityKey(sessionId, activityId));
  }
  create(input: Omit<Activity, 'version'>): Activity {
    const record = immutable(activitySchema.parse({...input, version: 0}));
    const key = activityKey(record.sessionId, record.activityId);
    if (this.records.has(key)) throw new Error('Activity identity already exists');
    this.records.set(key, record);
    this.onChange();
    return record;
  }
  update(sessionId: string, activityId: string, patch: Partial<Pick<Activity, 'status' | 'stage' | 'detail' | 'title' | 'summary' | 'taskModel' | 'stopReason' | 'phase' | 'progress'>>): Activity {
    const key = activityKey(sessionId, activityId);
    const current = this.records.get(key);
    if (!current) throw new Error('Activity not found');
    const next = activitySchema.parse({...current, ...patch, version: current.version + 1});
    if (next.status !== current.status && !transitions[current.status].includes(next.status)) {
      throw new Error('Invalid activity status transition: ' + current.status + ' → ' + next.status);
    }
    if (transitions[current.status].length === 0) throw new Error('A finished activity cannot be updated further');
    this.records.set(key, immutable(next));
    this.onChange();
    return next;
  }
}
