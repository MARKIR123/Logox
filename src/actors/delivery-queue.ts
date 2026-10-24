import {randomUUID} from 'node:crypto';
import {deliverySchema, deliveryPriority, type Delivery, type DeliveryInput} from '../runtime/delivery.js';
import {immutable, type TaskOriginData} from '../runtime/contracts.js';
import {inputMessage} from '../runtime/provenance.js';
import type {ModelMessage} from '../runtime/messages.js';
import type {HistoryStore, TaskCheckpoint} from '../store/journal.js';

/** Durable admission and boundary receipts, not task acceptance or exactly-once execution. */
export class DeliveryQueue {
  private records: readonly Delivery[] = [];
  private loaded = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly sessionId: string, private readonly history: HistoryStore) {}
  snapshot(): readonly Delivery[] {return this.records;}
  pending(ownerId: string, activityId?: string): readonly Delivery[] {
    return this.records.filter(item => item.status === 'pending' && item.ownerId === ownerId &&
      (!item.targetActivityId || item.targetActivityId === activityId));
  }
  recoveryFor(activityId: string, rootActivityId: string, inherited?: TaskOriginData['recovery']): TaskOriginData['recovery'] {
    return this.records.filter(item => item.status === 'delivered' && item.recipientActivityId === activityId &&
      item.rootActivityId === rootActivityId && item.recoveryGrantActivityId !== activityId).reduce<TaskOriginData['recovery']>((current, item) => {
        const next = item.origin?.recovery;
        if (!next || current?.exhausted && !next.exhausted) return current;
        return !current || next.exhausted || next.attempt >= current.attempt ? next : current;
      }, inherited);
  }
  grantRecovery(rootActivityId: string, activityId: string): Promise<void> {
    return this.run(async () => {
      const next = this.records.map(item => item.rootActivityId === rootActivityId && item.origin?.recovery
        ? {...item, recoveryGrantActivityId: activityId} : item);
      if (next.some((item, index) => item !== this.records[index])) await this.save(next);
    });
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      if (!this.loaded) {
        const saved = await this.history.loadDeliveries?.(this.sessionId) ?? [];
        this.records = immutable(saved.map(item => deliverySchema.parse(item))); this.loaded = true;
      }
      return operation();
    });
    this.tail = next.then(() => {}, () => {});
    return next;
  }
  private async save(records: readonly Delivery[]): Promise<void> {
    await this.history.saveDeliveries?.(this.sessionId, records);
    this.records = immutable([...records]);
  }
  enqueue(input: DeliveryInput): Promise<Delivery> {
    return this.run(async () => {
      const item = deliverySchema.parse({...input, id: input.id ?? randomUUID(), sessionId: this.sessionId,
        time: input.time ?? Date.now(), status: 'pending'});
      const previous = this.records.find(record => record.id === item.id);
      if (previous) return previous;
      const prior = item.kind === 'failure' && item.source === 'logox' ? this.records.map(record =>
        record.status === 'delivered' && record.recipientActivityId === item.sourceActivityId ? {...record, successorId: item.id} : record) : this.records;
      await this.save([...prior, item]);
      return item;
    });
  }
  drain(ownerId: string, activityId: string): Promise<{messages: ModelMessage[]; humanInputs: string[]}> {
    return this.run(async () => {
      const selected = [...this.pending(ownerId, activityId)].filter(item => !item.deferredUntilHuman)
        .sort((a, b) => deliveryPriority[a.kind] - deliveryPriority[b.kind]);
      if (!selected.length) return {messages: [], humanInputs: []};
      const entries = await this.history.load(this.sessionId, ownerId);
      const received = new Set(entries.filter(entry => entry.activityId === activityId).flatMap(entry => entry.deliveryIds ?? []));
      const fresh = selected.filter(item => !received.has(item.id));
      const groups: Delivery[][] = fresh.filter(item => item.kind === 'human_steer').map(item => [item]);
      const coordination = fresh.filter(item => item.kind !== 'human_steer');
      if (coordination.length) groups.push(coordination);
      const messages: ModelMessage[] = [];
      for (const group of groups) {
        const first = group[0]!;
        const human = first.kind === 'human_steer';
        const source = group.length === 1 ? first.source : 'coordination';
        const kind = human ? 'human' : group.every(item => item.inputKind === first.inputKind) ? first.inputKind : 'actor';
        const text = human ? first.text : group.map(item => `[Event ${item.id}; ${item.kind}; source ${item.source}; activity ${item.sourceActivityId ?? 'unspecified'}; root ${item.rootActivityId ?? 'unspecified'}]\n${item.text}`).join('\n\n');
        await this.history.append({version: 1, sessionId: this.sessionId, ownerId, activityId, source, inputKind: kind,
          role: 'user', text, message: {role: 'user', text}, deliveryIds: group.map(item => item.id)});
        messages.push(inputMessage(text, {ownerId, source, inputKind: kind}));
      }
      const ids = new Set(selected.map(item => item.id));
      await this.save(this.records.map(item => ids.has(item.id) ? {...item, status: 'delivered', recipientActivityId: activityId} : item));
      return {messages, humanInputs: selected.filter(item => item.kind === 'human_steer').map(item => item.text)};
    });
  }
  settle(activityId: string, status: string): Promise<void> {
    return this.run(async () => {
      const next = this.records.map(item => {
        if (item.targetActivityId === activityId && item.status === 'pending') return {...item, status: 'cancelled' as const};
        if (item.recipientActivityId === activityId && item.status === 'delivered' && status !== 'completed' && !item.targetActivityId && !item.successorId) {
          const {recipientActivityId: _, ...pending} = item;
          return {...pending, status: 'pending' as const};
        }
        return item;
      });
      if (next.some((item, index) => item !== this.records[index])) await this.save(next);
    });
  }
  recover(tasks: readonly TaskCheckpoint[] = []): Promise<void> {
    return this.run(async () => {
      const next = this.records.map(item => {
        if (item.status === 'pending' && item.targetActivityId) return {...item, status: 'cancelled' as const};
        if (item.status === 'delivered' && !item.targetActivityId && !item.successorId &&
          tasks.find(task => task.activityId === item.recipientActivityId)?.status !== 'completed') {
          const {recipientActivityId: _, ...pending} = item;
          return {...pending, status: 'pending' as const};
        }
        return item;
      });
      if (next.some((item, index) => item !== this.records[index])) await this.save(next);
    });
  }
  releaseDeferred(): Promise<void> {
    return this.run(async () => {
      if (!this.records.some(item => item.status === 'pending' && item.deferredUntilHuman)) return;
      await this.save(this.records.map(item => item.status === 'pending' && item.deferredUntilHuman ? {...item, deferredUntilHuman: false} : item));
    });
  }
  async flush(): Promise<void> {await this.tail;}
}
