import {randomUUID} from 'node:crypto';
import {RuntimeStore} from '../runtime/store.js';

export interface DreamContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  report(stage: string, detail: string): void;
}
export type DreamRunner = (context: DreamContext) => Promise<void>;
interface Run {runId: string; controller: AbortController; done: Promise<void>}
export class Anamnesis {
  private current: Run | undefined;
  private closed = false;
  private lastActivity: number;
  private resumeId: string | undefined;
  constructor(readonly sessionId: string, private readonly store: RuntimeStore,
    private readonly runner: DreamRunner, private readonly foregroundBusy: () => boolean,
    private readonly clock: () => number = () => performance.now(), private readonly idleMs = 30_000) {
    this.lastActivity = clock();
  }
  noteDraft(): void { this.lastActivity = this.clock(); }
  async foregroundSubmitted(): Promise<void> {
    this.lastActivity = this.clock();
    await this.pause();
  }
  foregroundFinished(): void { this.lastActivity = this.clock(); }
  async tick(hasNewMaterial: boolean): Promise<void> {
    if (!hasNewMaterial || this.closed || this.current || this.foregroundBusy() ||
        this.store.interactions.list().some(request => request.status === 'pending') ||
        this.clock() - this.lastActivity < this.idleMs) return;
    this.start();
  }
  start(): {runId: string; done: Promise<void>} {
    if (this.closed || this.current || this.foregroundBusy()) throw new Error('Cannot start dreaming right now');
    const runId = this.resumeId ?? randomUUID();
    this.resumeId = undefined;
    const controller = new AbortController();
    if (this.store.activities.get(this.sessionId, runId)) {
      this.store.activities.update(this.sessionId, runId, {status: 'running', stage: 'Resuming dream', detail: ''});
    } else this.store.activities.create({
      sessionId: this.sessionId, activityId: runId, ownerId: 'anamnesis', kind: 'anamnesis',
      title: 'Anamnesis', status: 'running', stage: 'Preparing review', detail: '',
    });
    // Deferring the runner ensures current is installed even when it fails synchronously.
    const done = Promise.resolve().then(() => this.run(runId, controller));
    this.current = {runId, controller, done};
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
  private async run(runId: string, controller: AbortController): Promise<void> {
    const {signal} = controller;
    try {
      signal.throwIfAborted();
      await this.runner({
        runId, sessionId: this.sessionId, signal,
        report: (stage, detail) => {
          signal.throwIfAborted();
          this.store.activities.update(this.sessionId, runId, {stage, detail});
        },
      });
      signal.throwIfAborted();
      this.store.activities.update(this.sessionId, runId, {status: 'completed', stage: 'Run complete'});
    } catch (error) {
      const paused = signal.aborted && signal.reason === 'pause';
      if (paused) this.resumeId = runId;
      this.store.activities.update(this.sessionId, runId, {
        status: signal.aborted ? (paused ? 'paused' : 'cancelled') : 'failed',
        stage: paused ? 'Waiting to resume' : signal.aborted ? 'Closed' : 'Dream failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally { this.current = undefined; }
  }
}
