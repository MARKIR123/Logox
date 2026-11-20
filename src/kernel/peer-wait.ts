import {setTimeout as delay} from 'node:timers/promises';
import {ASK_DEADLOCK_RELEASED, askRecipientEnded} from '../prompts/runtime/recovery.js';
import {asksFor, type AskBoard} from '../runtime/asks.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {BackgroundBoard} from '../runtime/background-jobs.js';
import {isDirector} from './director.js';

const POLL_MS = 1000;
const ACTIVE = new Set<string>(['queued', 'running', 'waiting_input', 'paused']);

export interface PeerWaitEnvironment {
  readonly store: RuntimeStore;
  readonly sessionId: string;
  readonly activityId: string;
  readonly ownerId: string;
  readonly signal: AbortSignal;
  readonly hasPendingInbox?: (() => boolean) | undefined;
  readonly pollMs?: number;
  /** The Automa background jobs of this task: while any result is outstanding the task stays open and parks with no model requests. */
  readonly background?: Pick<BackgroundBoard, 'outstanding' | 'flush' | 'nextChange'> | undefined;
}

export interface PeerWaitNotice {readonly id: string; readonly text: string}

/**
 * Keeps one run's task open once it has nothing else to do, with no model requests, until a reply arrives or waiting is pointless.
 * Questions have no time limit: a recipient that is still running may be doing exactly what was asked.
 */
export class PeerWait {
  private readonly board: AskBoard;
  private readonly released: PeerWaitNotice[] = [];

  constructor(private readonly env: PeerWaitEnvironment) {
    this.board = asksFor(env.store);
  }

  private get asks() { return isDirector(this.env.ownerId) ? [] : this.board.awaited(this.env.activityId); }

  /** Background Automa jobs of this task whose results have not reached it. A Director waits for them like any actor: it has no companion to hold its task open. */
  private get jobs() { return this.env.background?.outstanding(this.env.activityId) ?? []; }

  get pending(): boolean { return this.asks.length > 0 || this.jobs.length > 0; }

  describe(): string {
    const names = [...new Set(this.asks.map(ask => ask.to))];
    const jobs = this.jobs.map(job => job.id);
    return [names.length ? 'Waiting for a reply from ' + names.join(', ') : '', jobs.length ? 'Waiting for Automa results: ' + jobs.join(', ') : ''].filter(Boolean).join(' · ');
  }

  /** Reports and clears what is over. Never waits. */
  take(): readonly PeerWaitNotice[] {
    const notices = this.released.splice(0);
    const active = this.teammates();
    for (const ask of this.asks) {
      if (ask.ended || !isDirector(ask.to) && !active.some(activity => activity.ownerId === ask.to)) {
        this.board.close(ask.id);
        notices.push({id: ask.id, text: askRecipientEnded(ask.to)});
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
        // A result that found nobody to receive it (the inbox was closing) is offered again.
        env.background?.flush(env.activityId);
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
        // Background jobs wake the wait the moment one changes; questions are polled.
        if (env.background && !this.asks.length) await env.background.nextChange(env.pollMs ?? POLL_MS, env.signal);
        else await delay(env.pollMs ?? POLL_MS, undefined, {signal: env.signal});
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
