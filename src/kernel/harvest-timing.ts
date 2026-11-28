/**
 * When an actor's harvest (`src/anamnesis/harvest.ts`) runs. The harvest moment is the actor's cache cliff, once it is settled.
 * - The Director: the cliff while the human is awaited and nothing else is open. The timing reuses `CacheKeeper` instead of repeating its arithmetic: when
 *   the keeper warms the Director's cache for the returning human it offers its last slot (`slot`) and that slot's request is the harvest instead of a
 *   1-token ping; otherwise (no warm-ups planned, a provider the keeper cannot replay, an unknown lifetime) this class keeps one timer at
 *   `warmDelayMs(ttl)` after the last real request.
 * - A companion: always the timer, at its own cliff, and only when it is settled (no open activity of that actor, nothing certain to wake it). A peer wait
 *   is never harvested: the actor is certain to wake and its cache is still useful.
 * A real request of the actor (`woke`) cancels everything, a running harvest included. Whether there is anything to harvest, and the run itself, belong
 * to the caller (`start`).
 */
import type {CacheLifetime} from '../providers/cache.js';
import {isDirector} from '../runtime/director-id.js';
import {warmDelayMs, type KeepAliveHarvest, type KeepAliveTarget, type KeepAliveWho} from './cache-keepalive.js';

/** A started harvest: `finished` resolves true when it applied its answer, false when it failed or was cancelled. */
export interface HarvestRun {readonly finished: Promise<boolean>; cancel(): void}
/** What the footer shows of an actor's harvest. */
export type HarvestPhase = {readonly state: 'running'} | {readonly state: 'done'; readonly at: number};

/** A lifetime the harvest plans with; `assumed` marks a guess for a model whose lifetime is unknown (it times an automatic harvest, never a manual fork). */
export type HarvestLifetime = CacheLifetime & {readonly assumed?: true};
export interface HarvestTimingOptions {
  /** The cache lifetime of the request. */
  lifetime(who: KeepAliveWho, target: KeepAliveTarget): HarvestLifetime | undefined;
  /** Starts the harvest when it has something to do and nothing blocks it; undefined when it declines. */
  start(who: KeepAliveWho, target: KeepAliveTarget): Promise<HarvestRun | undefined>;
  now?: () => number;
}
/** What the keeper side knows, bound once it exists. */
export interface KeeperFacts {
  /** True when the actor is settled for a harvest: the Director awaits the human with nothing else open; a companion has no open activity and no wake-up certain. */
  settled(who: KeepAliveWho): boolean;
  /** When the actor's cache was last refreshed (a real request or a warm-up). */
  touchedAt(who: Pick<KeepAliveWho, 'sessionId' | 'ownerId'>): number | undefined;
}
interface Slot {
  readonly who: KeepAliveWho; readonly target: KeepAliveTarget; generation: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  /** A keeper slot is still expected (Director with warm-ups). */
  pending: boolean;
  run?: HarvestRun | undefined;
  doneAt?: number | undefined;
}
const keyOf = (who: Pick<KeepAliveWho, 'sessionId' | 'ownerId'>) => who.sessionId + '\n' + who.ownerId;

export class HarvestTiming implements KeepAliveHarvest {
  private readonly slots = new Map<string, Slot>();
  private facts: KeeperFacts | undefined;
  /** Set by the host: called whenever `phase()` may have changed (the footer re-reads). */
  onChange: (() => void) | undefined;
  private readonly now: () => number;
  constructor(private readonly options: HarvestTimingOptions) {this.now = options.now ?? Date.now;}
  attach(facts: KeeperFacts): void {this.facts = facts;}

  armed(who: KeepAliveWho, target: KeepAliveTarget, warming: boolean): void {
    const key = keyOf(who);
    this.drop(key);
    const reply = target.reply, life = reply && !reply.toolCalls?.length ? this.options.lifetime(who, target) : undefined;
    const delay = life ? warmDelayMs(life.ms) : undefined;
    const slot: Slot = {who, target, generation: 0, pending: false};
    this.slots.set(key, slot);
    if (!life || delay === undefined) return;
    // The keeper offers the Director its last slot when it warms for the human; every other case has the timer.
    const keeperSlot = warming && isDirector(who.ownerId);
    if (keeperSlot) slot.pending = true;
    else {
      const generation = slot.generation;
      slot.timer = setTimeout(() => {void this.fire(key, generation);}, Math.max(0, target.startedAt + delay - this.now()));
      slot.timer.unref?.();
    }
  }
  /** The keeper's last slot of a human wait. */
  async slot(who: KeepAliveWho, target: KeepAliveTarget): Promise<boolean> {
    const slot = this.slots.get(keyOf(who));
    return slot?.pending === true ? this.attempt(slot, target) : false;
  }
  released(who: Pick<KeepAliveWho, 'sessionId' | 'ownerId'>): void {
    const slot = this.slots.get(keyOf(who));
    if (slot?.pending) slot.pending = false;
  }
  woke(who: Pick<KeepAliveWho, 'sessionId' | 'ownerId'>): void {
    const key = keyOf(who);
    if (this.slots.has(key)) {this.drop(key); this.onChange?.();}
  }
  private drop(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.generation++;
    clearTimeout(slot.timer);
    slot.run?.cancel();
    this.slots.delete(key);
  }
  private async fire(key: string, generation: number): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot || slot.generation !== generation) return;
    slot.timer = undefined;
    await this.attempt(slot);
  }
  /** Starts the harvest if the cache is still inside its lifetime and the actor is settled. */
  private async attempt(slot: Slot, target = slot.target): Promise<boolean> {
    const {who} = slot, life = this.options.lifetime(who, target), generation = slot.generation;
    if (!life || this.now() >= target.startedAt + life.ms || !this.facts?.settled(who)) return false;
    const run = await this.options.start(who, target);
    if (!run) return false;
    if (slot.generation !== generation) {run.cancel(); return false;}
    this.adopt(slot, run);
    return true;
  }
  private adopt(slot: Slot, run: HarvestRun): void {
    slot.run = run; slot.pending = false; slot.doneAt = undefined;
    this.onChange?.();
    void run.finished.then(applied => {
      if (slot.run !== run) return;
      slot.run = undefined;
      if (applied) slot.doneAt = this.now();
      this.onChange?.();
    });
  }
  /** Follows a harvest started elsewhere (a manual `/anamnesis` run) so the footer shows it. */
  follow(who: KeepAliveWho, run: HarvestRun): void {
    const slot = this.slots.get(keyOf(who));
    if (slot) this.adopt(slot, run);
  }
  /** The latest real request of the actor with the cache still warm, or undefined: what a manual run may fork. */
  warm(sessionId: string, ownerId: string): {who: KeepAliveWho; target: KeepAliveTarget} | undefined {
    const slot = this.slots.get(keyOf({sessionId, ownerId}));
    if (!slot?.target.reply || slot.target.reply.toolCalls?.length) return undefined;
    const life = this.options.lifetime(slot.who, slot.target), touched = Math.max(slot.target.startedAt, this.facts?.touchedAt(slot.who) ?? 0);
    return life && !life.assumed && this.now() < touched + life.ms ? {who: slot.who, target: slot.target} : undefined;
  }
  /** `running` while the harvest works, `done` (with its time) after it applied, until the actor's next real request. */
  phase(who: Pick<KeepAliveWho, 'sessionId' | 'ownerId'>): HarvestPhase | undefined {
    const slot = this.slots.get(keyOf(who));
    return slot?.run ? {state: 'running'} : slot?.doneAt !== undefined ? {state: 'done', at: slot.doneAt} : undefined;
  }
  dispose(): void {for (const key of [...this.slots.keys()]) this.drop(key);}
}
