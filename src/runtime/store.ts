import {randomUUID} from 'node:crypto';
import {Activities} from './activities.js';
import {Interactions} from './interactions.js';
import {immutable, type Message, type RuntimeSnapshot} from './contracts.js';

export class RuntimeStore {
  private readonly listeners = new Set<() => void>();
  private readonly messages: Message[] = [];
  private snapshot: RuntimeSnapshot = immutable({revision: 0, activities: [], interactions: [], messages: []});
  readonly activities = new Activities(() => this.publish());
  readonly interactions = new Interactions(() => this.publish());
  readonly getSnapshot = (): RuntimeSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  message(sessionId: string, ownerId: string, role: Message['role'], text: string, origin: Pick<Message, 'activityId' | 'source' | 'kind'> = {}): string {
    const id = randomUUID();
    this.messages.push(immutable({id, sessionId, ownerId, role, text, ...origin}));
    this.publish();
    return id;
  }
  appendMessage(id: string, text: string): void {
    const index = this.messages.findIndex(message => message.id === id);
    const message = this.messages[index];
    if (!message) throw new Error('消息不存在');
    this.messages[index] = immutable({...message, text: message.text + text});
    this.publish();
  }
  private publish(): void {
    this.snapshot = immutable({
      revision: this.snapshot.revision + 1,
      activities: [...this.activities.list()],
      interactions: [...this.interactions.list()],
      messages: [...this.messages],
    });
    for (const listener of this.listeners) listener();
  }
}
