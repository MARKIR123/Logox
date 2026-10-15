import {randomUUID} from 'node:crypto';
import type {RuntimeStore} from '../runtime/store.js';
import type {SystemEvent} from '../runtime/system-events.js';
import type {Journal} from './journal.js';

/** 界面和持久历史共享事件身份；临时会话先缓冲，正式提交后保存。 */
export class SystemHistory {
  private readonly pending: SystemEvent[] = [];
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly sessionId: string, private readonly store: RuntimeStore,
    private readonly journal: Journal, private readonly isPersistent: () => boolean) {}
  async restore(): Promise<void> {for (const event of await this.journal.systemEvents(this.sessionId)) this.store.system(event);}
  emit(text: string, kind: SystemEvent['kind'] = 'command_result', ownerId = 'logox', activityId?: string, persist = true): void {
    const event: SystemEvent = {version: 1, id: randomUUID(), sessionId: this.sessionId, ownerId, kind, text,
      time: Date.now(), ...(activityId ? {activityId} : {})};
    this.store.system(event);
    if (!persist) return;
    this.pending.push(event);
    if (this.isPersistent()) void this.flush().catch(() => {
      this.emit('系统记录保存失败，界面记录保留；下次保存时重试。', 'task_notice', ownerId, undefined, false);
    });
  }
  flush(): Promise<void> {
    if (!this.isPersistent()) return Promise.resolve();
    const operation = this.tail.then(async () => {
      while (this.pending.length) {await this.journal.appendSystem(this.pending[0]!); this.pending.shift();}
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
