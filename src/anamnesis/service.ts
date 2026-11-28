/**
 * Anamnesis lifecycle: the runs (a harvest of one actor's cache, or a manual recap or dream over a transcript) and their cards. There is no idle clock:
 * automatic work happens only through harvests (`src/kernel/harvest-timing.ts` decides when), and a manual run starts when the person asks. A transcript run
 * is single-flight; harvests of different actors may run at the same time (their effects are serialized by the runner). Only a sent message
 * (`foregroundSubmitted`) aborts a run and removes its card; typing never does. What a run does is the driver's business (`runner.ts`).
 */
import {randomUUID} from 'node:crypto';
import {isDirector} from '../runtime/director-id.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {HarvestReport, HarvestSource} from './harvest.js';

export type RunKind = 'recap' | 'dream';
export const ANAMNESIS_OWNER = 'anamnesis';
/** The card title while a run works. */
export const RUNNING_STAGE: Readonly<Record<RunKind, string>> = {recap: 'Writing recap', dream: 'Reviewing the session'};
const FAILED_STAGE: Readonly<Record<RunKind, string>> = {recap: 'Recap failed', dream: 'Dream failed'};
/** A harvest (a fork of an actor's own request) wears the card of the kind it was asked for, with its own titles; a companion's names the actor. */
export const HARVEST_STAGE = 'Harvesting the session';
const HARVEST_FAILED_STAGE = 'Harvest failed';
const harvestStage = (harvest: HarvestSource, text: string) => harvest.owner && !isDirector(harvest.owner) ? (harvest.ownerName ?? harvest.owner) + ': ' + text : text;
export interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly kind: RunKind;
  /** Started by `runNow`: it ignores the new-material check. */
  readonly manual: boolean;
  readonly signal: AbortSignal;
  /** Present when the run is a harvest: it forks this request instead of reading a transcript (`kind` then only says which card flavour the manual run asked for). */
  readonly harvest?: HarvestSource | undefined;
  /** Updates the card while the run works; throws once the run was aborted. */
  report(stage: string, detail?: string): void;
}
/** What a finished run shows on its card. `empty` marks a run that found nothing: an automatic one leaves no card behind. */
export interface RunOutcome {stage: string; detail: string; empty?: boolean; /** What a harvest did, for the application's notice. */ harvest?: HarvestReport}
export interface AnamnesisDriver {
  /** Does the work, applying its effects only after the model answered; resolves with the card text. Must honour `context.signal`. */
  run(context: RunContext): Promise<RunOutcome>;
}
export type RunResult =
  | {kind: RunKind; status: 'completed'; outcome: RunOutcome}
  | {kind: RunKind; status: 'failed'; error: string}
  | {kind: RunKind; status: 'aborted'; reason: 'pause' | 'close'};
export interface AnamnesisOptions {
  /** Wall-clock milliseconds stamped on the card (`createdAt`, which places it among the messages); default `Date.now()`. */
  wall?: () => number;
}
interface Run {runId: string; kind: RunKind; controller: AbortController; done: Promise<RunResult>; harvest?: HarvestSource | undefined}
export class Anamnesis {
  /** The transcript run (manual recap or dream), if any. */
  private current: Run | undefined;
  /** Harvests in flight, by run id. */
  private readonly harvests = new Map<string, Run>();
  private closed = false;
  private failedCard: string | undefined;
  private readonly wall: () => number;
  constructor(readonly sessionId: string, private readonly store: RuntimeStore, private readonly driver: AnamnesisDriver,
    private readonly foregroundBusy: () => boolean, options: AnamnesisOptions = {}) {
    this.wall = options.wall ?? (() => Date.now());
  }
  /** A keystroke in the composer: nothing. Typing never aborts, cancels or postpones a run (kept as the surfaces' hook). */
  noteDraft(): void {}
  /** The user sent something: every run in flight stops now and nothing it had not applied is applied. */
  async foregroundSubmitted(): Promise<void> {await this.pause();}
  /** A task finished: nothing (there is no idle clock). */
  foregroundFinished(): void {}
  /** The kind running now, if any (a harvest counts as the kind it was asked for). */
  running(): RunKind | undefined {return this.current?.kind ?? this.harvests.values().next().value?.kind;}
  /** Runs a manual recap or dream; with `harvest` it forks that request instead of reading the transcript. Refuses while the foreground works. */
  runNow(kind: RunKind, harvest?: HarvestSource): {runId: string; done: Promise<RunResult>} {
    if (this.closed) throw new Error('Anamnesis is closed.');
    if (this.foregroundBusy()) throw new Error('Anamnesis cannot run while tasks are running. Wait for them to finish or cancel them.');
    const busy = this.current ?? this.harvests.values().next().value;
    if (busy) throw new Error('Anamnesis is already running (' + (busy.harvest ? HARVEST_STAGE : RUNNING_STAGE[busy.kind]).toLowerCase() + ').');
    return this.begin(kind, true, harvest);
  }
  /**
   * Starts the harvest of one actor's last request (the cache keeper or the harvest timer decided it is time). Undefined when something blocks it: the
   * service is closed, a transcript run works, that actor already has a harvest, an approval or question of the actor (any, for the Director) is
   * waiting, or (Director only) a task is in flight. A harvest never queues. A companion's harvest ignores the Director being busy.
   */
  startHarvest(harvest: HarvestSource): {runId: string; done: Promise<RunResult>} | undefined {
    const owner = harvest.owner ?? 'logox', director = isDirector(owner);
    if (this.closed || this.current || (director && this.foregroundBusy())) return undefined;
    if ([...this.harvests.values()].some(run => (run.harvest?.owner ?? 'logox') === owner)) return undefined;
    if (this.store.interactions.list().some(request => request.status === 'pending' && (director || request.ownerId === owner))) return undefined;
    return this.begin(harvest.parts.recap ? 'recap' : 'dream', false, harvest);
  }
  private begin(kind: RunKind, manual: boolean, harvest?: HarvestSource): {runId: string; done: Promise<RunResult>} {
    const runId = randomUUID();
    // A failure card gives way to the next attempt, so a long outage does not pile cards up.
    if (this.failedCard) {this.store.activities.remove(this.sessionId, this.failedCard); this.failedCard = undefined;}
    const controller = new AbortController();
    this.store.activities.create({sessionId: this.sessionId, activityId: runId, ownerId: ANAMNESIS_OWNER, kind: 'anamnesis',
      title: 'Anamnesis', status: 'running', stage: harvest ? harvestStage(harvest, HARVEST_STAGE) : RUNNING_STAGE[kind], detail: '', createdAt: this.wall()});
    // Deferring the driver ensures the run is registered even when it fails synchronously.
    const done = Promise.resolve().then(() => this.execute(runId, kind, manual, controller, harvest)).finally(() => {
      if (this.current?.runId === runId) this.current = undefined;
      this.harvests.delete(runId);
    });
    const run: Run = {runId, kind, controller, done, harvest};
    if (harvest && !manual) this.harvests.set(runId, run); else this.current = run;
    return {runId, done};
  }
  /** Aborts one run (a harvest whose actor made a new real request); its card goes away and nothing is applied. */
  cancel(runId: string): void {
    const run = this.current?.runId === runId ? this.current : this.harvests.get(runId);
    run?.controller.abort('pause');
  }
  /** Aborts every run in flight and waits for them to leave. */
  async pause(): Promise<void> {
    const runs = [...(this.current ? [this.current] : []), ...this.harvests.values()];
    for (const run of runs) run.controller.abort('pause');
    await Promise.all(runs.map(run => run.done));
  }
  async close(): Promise<void> {
    this.closed = true;
    const runs = [...(this.current ? [this.current] : []), ...this.harvests.values()];
    for (const run of runs) run.controller.abort('close');
    await Promise.all(runs.map(run => run.done));
  }
  private async execute(runId: string, kind: RunKind, manual: boolean, controller: AbortController, harvest?: HarvestSource): Promise<RunResult> {
    const {signal} = controller;
    try {
      signal.throwIfAborted();
      const outcome = await this.driver.run({runId, sessionId: this.sessionId, kind, manual, signal, ...(harvest ? {harvest} : {}),
        report: (stage, detail = '') => {
          signal.throwIfAborted();
          this.store.activities.update(this.sessionId, runId, {stage, detail});
        }});
      // The driver applies its effects before it resolves, so an answer that arrives is shown even if the abort came in the same moment.
      if (outcome.empty && !manual) this.store.activities.remove(this.sessionId, runId);
      else this.store.activities.update(this.sessionId, runId, {status: 'completed', stage: harvest ? harvestStage(harvest, outcome.stage) : outcome.stage, detail: outcome.detail});
      return {kind, status: 'completed', outcome};
    } catch (error) {
      if (signal.aborted) {
        // An interrupted run leaves nothing behind.
        this.store.activities.remove(this.sessionId, runId);
        return {kind, status: 'aborted', reason: signal.reason === 'pause' ? 'pause' : 'close'};
      }
      const message = error instanceof Error ? error.message : String(error);
      this.failedCard = runId;
      this.store.activities.update(this.sessionId, runId, {status: 'failed', stage: harvest ? harvestStage(harvest, HARVEST_FAILED_STAGE) : FAILED_STAGE[kind], detail: message});
      return {kind, status: 'failed', error: message};
    }
  }
}
