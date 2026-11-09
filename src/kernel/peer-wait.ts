import {setTimeout as delay} from 'node:timers/promises';
import {ASK_DEADLOCK_RELEASED, askRecipientEnded} from '../prompts/runtime/recovery.js';
import {asksFor, type AskBoard} from '../runtime/asks.js';
import type {RuntimeStore} from '../runtime/store.js';

const POLL_MS = 1000;
const WATCH_SECONDS = 300;
const ACTIVE = new Set<string>(['queued', 'running', 'waiting_input', 'paused']);

export interface PeerWaitEnvironment {
  readonly store: RuntimeStore;
  readonly sessionId: string;
  readonly activityId: string;
  readonly ownerId: string;
  readonly signal: AbortSignal;
  readonly hasPendingInbox?: (() => boolean) | undefined;
  readonly pollMs?: number;
}

export interface PeerWaitNotice {readonly id: string; readonly text: string}

/**
 * Keeps one run's task open once it has nothing else to do, with no model requests, until a reply arrives or waiting is pointless.
 * Questions have no time limit: a recipient that is still running may be doing exactly what was asked.
 */
export class PeerWait {
  private readonly board: AskBoard;
  private readonly released: PeerWaitNotice[] = [];
  private watch?: {readonly teammates: ReadonlySet<string>; readonly deadline: number} | undefined;

  constructor(private readonly env: PeerWaitEnvironment) {
    this.board = asksFor(env.store);
  }

  private get asks() { return this.env.ownerId === 'logox' ? [] : this.board.awaited(this.env.activityId); }

  get pending(): boolean { return this.asks.length > 0 || this.watch !== undefined; }

  describe(): string {
    const names = [...new Set(this.asks.map(ask => ask.to))];
    return names.length ? 'Waiting for a reply from ' + names.join(', ') : 'Waiting for a teammate to finish';
  }

  /** For an actor that kept polling: keep its task open until any teammate running now has finished. */
  watchAnyTeammate(): void {
    this.watch = {teammates: new Set(this.teammates().map(activity => activity.activityId)), deadline: Date.now() + WATCH_SECONDS * 1000};
  }

  /** Reports and clears what is over. Never waits. */
  take(): readonly PeerWaitNotice[] {
    const notices = this.released.splice(0);
    const active = this.teammates();
    for (const ask of this.asks) {
      if (ask.ended || ask.to !== 'logox' && !active.some(activity => activity.ownerId === ask.to)) {
        this.board.close(ask.id);
        notices.push({id: ask.id, text: askRecipientEnded(ask.to)});
      }
    }
    if (this.watch) {
      const {teammates, deadline} = this.watch;
      const changed = [...teammates].some(id => !active.some(activity => activity.activityId === id)) || !active.length;
      if (changed || Date.now() >= deadline || active.every(activity => this.board.isParked(this.env.sessionId, activity.ownerId))) {
        this.watch = undefined;
        notices.push({id: 'watch-' + Date.now(), text: 'Your tools are back. Check whether what you were waiting for is there.'});
      }
    }
    return notices;
  }

  /** Blocks until something the actor should act on has happened. */
  async park(): Promise<void> {
    const {env, board} = this;
    board.park(env.sessionId, env.ownerId, env.activityId);
    try {
      for (;;) {
        env.signal.throwIfAborted();
        if (env.hasPendingInbox?.()) return;
        const notices = this.take();
        if (notices.length) { this.released.push(...notices); return; }
        if (!this.pending) return;
        const cycle = board.deadlock(env.sessionId, env.activityId);
        // Releasing one member is enough: it replies, and that wakes the others. The lowest id makes every member agree on which.
        if (cycle && [...cycle].sort()[0] === env.activityId) {
          for (const ask of this.asks) {
            board.close(ask.id);
            this.released.push({id: ask.id, text: ASK_DEADLOCK_RELEASED});
          }
          return;
        }
        await delay(env.pollMs ?? POLL_MS, undefined, {signal: env.signal});
      }
    } finally {
      board.unpark(env.sessionId, env.ownerId);
    }
  }

  private teammates() {
    const {env} = this;
    return env.store.getSnapshot().activities.filter(activity => activity.sessionId === env.sessionId && activity.kind === 'actor' &&
      activity.ownerId !== env.ownerId && ACTIVE.has(activity.status));
  }
}
