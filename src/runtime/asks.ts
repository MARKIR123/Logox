import {randomUUID} from 'node:crypto';
import type {RuntimeStore} from './store.js';

/** An open question from one actor to another: `SendMessage` with `type: 'ask'`. Only `type: 'reply'` closes it. */
export interface Ask {
  readonly id: string;
  readonly sessionId: string;
  readonly from: string;
  readonly fromActivityId: string;
  readonly to: string;
  readonly label: string;
  readonly openedAt: number;
  /** The recipient's run ended, naturally or not, after this question reached it. */
  ended?: boolean;
}

/** Who owes whom a reply, and who has nothing left to do but wait. In memory because a restart ends the runs on both sides. */
export class AskBoard {
  private asks: Ask[] = [];
  private readonly parked = new Map<string, string>();

  open(ask: Omit<Ask, 'id' | 'openedAt'>): Ask {
    const opened: Ask = {...ask, id: randomUUID(), openedAt: Date.now()};
    this.asks.push(opened);
    return opened;
  }

  /** `responder` sent a final reply to `asker`. */
  answer(sessionId: string, responder: string, asker: string): void {
    this.asks = this.asks.filter(ask => !(ask.sessionId === sessionId && ask.to === responder && ask.from === asker));
  }

  /** Questions this actor still has to answer. */
  owed(sessionId: string, ownerId: string): readonly Ask[] {
    return this.asks.filter(ask => ask.sessionId === sessionId && ask.to === ownerId && !ask.ended);
  }

  /** Replies this activity is still expecting. */
  awaited(activityId: string): readonly Ask[] {
    return this.asks.filter(ask => ask.fromActivityId === activityId);
  }

  close(id: string): void {
    this.asks = this.asks.filter(ask => ask.id !== id);
  }

  /** The asking activity is gone, so nobody is owed anything any more. */
  dropAsker(activityId: string): void {
    this.asks = this.asks.filter(ask => ask.fromActivityId !== activityId);
  }

  /** The recipient's run ended: release everyone whose question had reached it. Later questions wait for its next run. */
  endRecipient(sessionId: string, ownerId: string, reachedBy: number): void {
    for (const ask of this.asks) if (ask.sessionId === sessionId && ask.to === ownerId && ask.openedAt <= reachedBy) ask.ended = true;
    // The Director has no task to hold open, so nobody is parked on its questions.
    this.asks = this.asks.filter(ask => !(ask.ended && ask.from === 'logox'));
  }

  park(sessionId: string, ownerId: string, activityId: string): void { this.parked.set(sessionId + ':' + ownerId, activityId); }
  unpark(sessionId: string, ownerId: string): void { this.parked.delete(sessionId + ':' + ownerId); }
  isParked(sessionId: string, ownerId: string): boolean { return this.parked.has(sessionId + ':' + ownerId); }

  /**
   * Follows who waits on whom from a parked activity. Returns the activities involved when nobody reachable can ever answer,
   * which only a cycle can cause, and nothing while a recipient is still free to act. The Director always counts as free.
   */
  deadlock(sessionId: string, activityId: string): readonly string[] | undefined {
    const visited = new Set<string>();
    const blocked = (id: string): boolean => {
      if (visited.has(id)) return true;
      visited.add(id);
      const waits = this.awaited(id);
      return waits.length > 0 && waits.every(ask => {
        const next = this.parked.get(sessionId + ':' + ask.to);
        return ask.to !== 'logox' && next !== undefined && blocked(next);
      });
    };
    return blocked(activityId) ? [...visited] : undefined;
  }
}

const boards = new WeakMap<RuntimeStore, AskBoard>();

export function asksFor(store: RuntimeStore): AskBoard {
  let board = boards.get(store);
  if (!board) { board = new AskBoard(); boards.set(store, board); }
  return board;
}
