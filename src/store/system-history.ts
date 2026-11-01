import {randomUUID} from 'node:crypto';
import type {RuntimeStore} from '../runtime/store.js';
import type {SystemEvent, SystemPresentation} from '../runtime/system-events.js';
import type {Journal} from './journal.js';

/** The UI and persistent history share event identity; temporary sessions buffer first and save after the formal commit. */
export class SystemHistory {
  private readonly pending: SystemEvent[] = [];
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly sessionId: string, private readonly store: RuntimeStore,
    private readonly journal: Journal, private readonly isPersistent: () => boolean) {}
  async restore(): Promise<void> {for (const event of await this.journal.systemEvents(this.sessionId)) this.store.system(event, true);}
  emit(text: string, kind: SystemEvent['kind'] = 'command_result', ownerId = 'logox', activityId?: string, persist = true,
    options?: {presentation?: SystemPresentation; title?: string}): void {
    const event: SystemEvent = {version: 1, id: randomUUID(), sessionId: this.sessionId, ownerId, kind, text,
      time: Date.now(), ...(activityId ? {activityId} : {}),
      ...(options?.presentation !== undefined ? {presentation: options.presentation} : {}),
      ...(options?.title !== undefined ? {title: options.title} : {})};
    this.store.system(event);
    if (!persist) return;
    this.pending.push(event);
    if (this.isPersistent()) void this.flush().catch(() => {
      this.emit('System history save failed; the UI record is kept and will be retried on the next save.', 'task_notice', ownerId, undefined, false);
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
