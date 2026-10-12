import {activitySchema, immutable, type Activity, type ActivityStatus} from './contracts.js';

const transitions: Record<ActivityStatus, readonly ActivityStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting_input', 'paused', 'completed', 'failed', 'cancelled'],
  waiting_input: ['running', 'paused', 'failed', 'cancelled'],
  paused: ['running', 'cancelled', 'failed'],
  completed: [], failed: [], cancelled: [],
};
export function activityKey(sessionId: string, activityId: string): string {
  return JSON.stringify([sessionId, activityId]);
}
export class Activities {
  private readonly records = new Map<string, Activity>();
  constructor(private readonly onChange: () => void) {}
  list(): readonly Activity[] { return Object.freeze([...this.records.values()]); }
  get(sessionId: string, activityId: string): Activity | undefined {
    return this.records.get(activityKey(sessionId, activityId));
  }
  create(input: Omit<Activity, 'version'>): Activity {
    const record = immutable(activitySchema.parse({...input, version: 0}));
    const key = activityKey(record.sessionId, record.activityId);
    if (this.records.has(key)) throw new Error('活动身份已存在');
    this.records.set(key, record);
    this.onChange();
    return record;
  }
  update(sessionId: string, activityId: string, patch: Partial<Pick<Activity, 'status' | 'stage' | 'detail'>>): Activity {
    const key = activityKey(sessionId, activityId);
    const current = this.records.get(key);
    if (!current) throw new Error('活动不存在');
    const next = activitySchema.parse({...current, ...patch, version: current.version + 1});
    if (next.status !== current.status && !transitions[current.status].includes(next.status)) {
      throw new Error('无效活动状态转换：' + current.status + ' → ' + next.status);
    }
    if (transitions[current.status].length === 0) throw new Error('已结束活动不能继续更新');
    this.records.set(key, immutable(next));
    this.onChange();
    return next;
  }
}
