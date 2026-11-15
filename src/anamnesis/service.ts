/**
 * Anamnesis lifecycle: when the session has been idle long enough it writes a recap note or reviews the transcript into memory (a dream), one run at a time,
 * shown as one actor card. Any user activity aborts the run and removes its card; the next idle period starts a fresh run with a fresh card.
 * What a run does is the driver's business (`runner.ts`); this class owns the clocks, the single-flight rule and the card.
 */
import {randomUUID} from 'node:crypto';
import type {RuntimeStore} from '../runtime/store.js';

export type RunKind = 'recap' | 'dream';
export const ANAMNESIS_OWNER = 'anamnesis';
/** The card title while a run works. */
export const RUNNING_STAGE: Readonly<Record<RunKind, string>> = {recap: 'Writing recap', dream: 'Reviewing the session'};
const FAILED_STAGE: Readonly<Record<RunKind, string>> = {recap: 'Recap failed', dream: 'Dream failed'};
export interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly kind: RunKind;
  /** Started by `runNow`: it ignores the idle clock and the new-material check. */
  readonly manual: boolean;
  readonly signal: AbortSignal;
  /** Updates the card while the run works; throws once the run was aborted. */
  report(stage: string, detail?: string): void;
}
/** What a finished run shows on its card. `empty` marks a dream that found nothing: an automatic one leaves no card behind. */
export interface RunOutcome {stage: string; detail: string; empty?: boolean}
export interface AnamnesisDriver {
  /** True when the kind has material newer than the last run of that kind. */
  material(kind: RunKind): Promise<boolean>;
  /** Does the work, applying its effects only after the model answered; resolves with the card text. Must honour `context.signal`. */
  run(context: RunContext): Promise<RunOutcome>;
}
export type RunResult =
  | {kind: RunKind; status: 'completed'; outcome: RunOutcome}
  | {kind: RunKind; status: 'failed'; error: string}
  | {kind: RunKind; status: 'aborted'; reason: 'pause' | 'close'};
export interface AnamnesisOptions {
  /** Monotonic milliseconds; default `performance.now()`. */
  clock?: () => number;
  /** Wall-clock milliseconds stamped on the card (`createdAt`, which places it among the messages); default `Date.now()`. */
  wall?: () => number;
  recapIdleMs?: number;
  dreamIdleMs?: number;
  /** The two automatic switches, read at every tick. A switch off disables only the trigger, never `runNow`. */
  auto?: () => {recap: boolean; dream: boolean};
}
interface Run {runId: string; kind: RunKind; controller: AbortController; done: Promise<RunResult>}
export class Anamnesis {
  private current: Run | undefined;
  private closed = false;
  private checking = false;
  private lastActivity: number;
  /** Bumps with every user activity: a "no material" answer stays valid until the next one (material only grows while the user works). */
  private epoch = 0;
  private readonly empty = new Map<RunKind, number>();
  private readonly failedAt = new Map<RunKind, number>();
  private failedCard: string | undefined;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private readonly idleMs: Record<RunKind, number>;
  private readonly auto: () => {recap: boolean; dream: boolean};
  constructor(readonly sessionId: string, private readonly store: RuntimeStore, private readonly driver: AnamnesisDriver,
    private readonly foregroundBusy: () => boolean, options: AnamnesisOptions = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.wall = options.wall ?? (() => Date.now());
    this.idleMs = {recap: options.recapIdleMs ?? 5 * 60_000, dream: options.dreamIdleMs ?? 30 * 60_000};
    this.auto = options.auto ?? (() => ({recap: true, dream: true}));
    this.lastActivity = this.clock();
  }
  /** A keystroke in the composer. */
  noteDraft(): void {this.touch();}
  /** The user sent something: any run in flight stops now and nothing it had not applied is applied. */
  async foregroundSubmitted(): Promise<void> {
    this.touch();
    await this.pause();
  }
  foregroundFinished(): void {this.touch();}
  private touch(): void {this.lastActivity = this.clock(); this.epoch++;}
  /** The kind running now, if any. */
  running(): RunKind | undefined {return this.current?.kind;}
  /** Runs the one kind that is due, if any. Called by the application's interval; cheap when nothing is due. */
  async tick(): Promise<void> {
    if (this.closed || this.current || this.checking || this.foregroundBusy() || this.interactionPending()) return;
    const switches = this.auto(), idle = this.clock() - this.lastActivity, epoch = this.epoch;
    const due = (kind: RunKind) => switches[kind] && idle >= this.idleMs[kind] && this.clock() - (this.failedAt.get(kind) ?? -Infinity) >= this.idleMs[kind];
    const kinds = (['recap', 'dream'] as const).filter(due);
    if (!kinds.length) return;
    this.checking = true;
    let next: RunKind | undefined;
    try {
      // A recap with new material goes first; a dream whose recap was already shown does not wait for another.
      for (const kind of kinds) {
        if (this.empty.get(kind) === epoch) continue;
        if (await this.driver.material(kind)) {next = kind; break;}
        this.empty.set(kind, epoch);
      }
    } catch {
      return;
    } finally {this.checking = false;}
    if (!next || this.closed || this.current || epoch !== this.epoch || this.foregroundBusy()) return;
    void this.begin(next, false).done;
  }
  /** Starts a run regardless of the idle clock and of new material; refuses while the foreground works. */
  runNow(kind: RunKind): {runId: string; done: Promise<RunResult>} {
    if (this.closed) throw new Error('Anamnesis is closed.');
    if (this.foregroundBusy()) throw new Error('Anamnesis cannot run while tasks are running. Wait for them to finish or cancel them.');
    if (this.current) throw new Error('Anamnesis is already running (' + RUNNING_STAGE[this.current.kind].toLowerCase() + ').');
    this.failedAt.delete(kind);
    return this.begin(kind, true);
  }
  private begin(kind: RunKind, manual: boolean): {runId: string; done: Promise<RunResult>} {
    const runId = randomUUID();
    // A failure card gives way to the next attempt, so a long outage does not pile cards up.
    if (this.failedCard) {this.store.activities.remove(this.sessionId, this.failedCard); this.failedCard = undefined;}
    const controller = new AbortController();
    this.store.activities.create({sessionId: this.sessionId, activityId: runId, ownerId: ANAMNESIS_OWNER, kind: 'anamnesis',
      title: 'Anamnesis', status: 'running', stage: RUNNING_STAGE[kind], detail: '', createdAt: this.wall()});
    // Deferring the driver ensures current is installed even when it fails synchronously.
    const done = Promise.resolve().then(() => this.execute(runId, kind, manual, controller));
    this.current = {runId, kind, controller, done};
    return {runId, done};
  }
  async pause(): Promise<void> {
    const run = this.current;
    if (!run) return;
    run.controller.abort('pause');
    await run.done;
  }
  async close(): Promise<void> {
    this.closed = true;
    const run = this.current;
    if (!run) return;
    run.controller.abort('close');
    await run.done;
  }
  private interactionPending(): boolean {return this.store.interactions.list().some(request => request.status === 'pending');}
  private async execute(runId: string, kind: RunKind, manual: boolean, controller: AbortController): Promise<RunResult> {
    const {signal} = controller;
    try {
      signal.throwIfAborted();
      const outcome = await this.driver.run({runId, sessionId: this.sessionId, kind, manual, signal,
        report: (stage, detail = '') => {
          signal.throwIfAborted();
          this.store.activities.update(this.sessionId, runId, {stage, detail});
        }});
      // The driver applies its effects before it resolves, so an answer that arrives is shown even if the abort came in the same moment.
      if (outcome.empty && !manual) this.store.activities.remove(this.sessionId, runId);
      else this.store.activities.update(this.sessionId, runId, {status: 'completed', stage: outcome.stage, detail: outcome.detail});
      return {kind, status: 'completed', outcome};
    } catch (error) {
      if (signal.aborted) {
        // An interrupted run leaves nothing behind: the next idle period starts a fresh run with a fresh card.
        this.store.activities.remove(this.sessionId, runId);
        return {kind, status: 'aborted', reason: signal.reason === 'pause' ? 'pause' : 'close'};
      }
      const message = error instanceof Error ? error.message : String(error);
      this.failedAt.set(kind, this.clock());
      this.failedCard = runId;
      this.store.activities.update(this.sessionId, runId, {status: 'failed', stage: FAILED_STAGE[kind], detail: message});
      return {kind, status: 'failed', error: message};
    } finally {
      this.current = undefined;
    }
  }
}
