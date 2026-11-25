import type {ModelMessage, TurnUsage} from '../runtime/messages.js';
import type {ExecutionRecoveryKind} from './execution-recovery.js';

/** Times a finishing actor is told to answer before it may finish anyway; the asker is then told it ended without replying. */
export const ASK_CLOSE_REMINDERS = 2;
/** Consecutive tool batches refused (restricted tools) before the runtime ends the exchange itself. */
export const REFUSED_BATCH_LIMIT = 2;

/**
 * The loop's mutable flags in one place. Every change goes through a named transition; the loop never assigns a flag directly.
 * The three "something new happened" transitions (`newInput`, `waitEnded`, `replyOwed`) reset different members on purpose.
 */
export class RoundState {
  /** Model round trips since the start or the last granted extension. */
  private requests = 0;
  /** Request-only note for the next request, with the kind that produced it (`undefined` for notes that are not an output recovery). */
  private note = '';
  private noteKind: ExecutionRecoveryKind | undefined;
  private recoveries = 0;
  /** Set once the delivered text is in and the single closing follow-up (asking only for the synopsis) is the next or current request. */
  private closingFollowUp = false;
  private ownedReminders = 0;
  private refused = 0;
  private imagesRetried = false;
  /** Consecutive replies that only repeated runtime text. */
  private echoes = 0;
  private readonly owedSightings = new Map<string, number>();
  private usage: TurnUsage | undefined;
  /** Signatures minted by a model that has since been replaced. */
  readonly foreignSignatures = new Set<string>();

  get iteration(): number {return this.requests;}
  get closing(): boolean {return this.closingFollowUp;}
  get recovery(): string {return this.note;}
  get recoveringKind(): ExecutionRecoveryKind | undefined {return this.noteKind;}
  /** Whether a finishing actor may still be told to answer what it owes. */
  get mayRemindOwed(): boolean {return this.ownedReminders < ASK_CLOSE_REMINDERS;}

  /** The iteration budget is spent (the closing follow-up never counts). */
  iterationsSpent(limit: number): boolean {return !this.closingFollowUp && limit > 0 && this.requests >= limit;}
  /** The user granted another budget. */
  iterationsExtended(): void {this.requests = 0;}
  /** A model request is about to be sent; the closing follow-up is not a round trip. */
  requestSent(): void {if (!this.closingFollowUp) this.requests++;}

  /** New input was taken into history: owed-reply reminders restart, a pending close is withdrawn, and the reminder about the previous step is dropped because the input supersedes it. */
  newInput(): void {
    this.ownedReminders = 0;
    this.closingFollowUp = false; this.note = ''; this.noteKind = undefined;
  }
  /** A wait ended: the same reset as new input. */
  waitEnded(): void {this.newInput();}
  /** The actor still owes a reply: that note replaces any recovery note, the reminder count grows and the close is withdrawn. */
  replyOwed(note: string): void {
    this.ownedReminders++;
    this.note = note; this.noteKind = undefined; this.closingFollowUp = false;
  }

  /** The next request is the single closing follow-up, asking only for the synopsis the delivered reply left out. */
  synopsisRequested(): void {
    this.closingFollowUp = true; this.note = ''; this.noteKind = undefined;
  }

  /** The reply needs a fresh request with this note. `render` receives whether an earlier recovery already happened in this run. */
  recovering(kind: ExecutionRecoveryKind, render: (repeated: boolean) => string): void {
    this.note = render(this.recoveries++ > 0); this.noteKind = kind;
  }
  /** Signatures minted by the replaced model must not be replayed. */
  foreignModelSignatures(signatures: Iterable<string>): void {for (const signature of signatures) this.foreignSignatures.add(signature);}
  /** The task model was replaced: the note changes, the recovery kind (if any) stays. */
  taskModelChanged(note: string): void {this.note = note;}
  /** A tool batch ran normally: the recovery note has been answered. */
  batchRan(): void {this.note = ''; this.noteKind = undefined;}
  /** Counts one tool batch; true when this was the second refused one in a row (the count restarts). */
  batchSettled(refused: boolean): boolean {
    this.refused = refused ? this.refused + 1 : 0;
    if (this.refused < REFUSED_BATCH_LIMIT) return false;
    this.refused = 0;
    return true;
  }

  /** A reply that only repeated runtime text: counts the streak and returns its length. */
  echoed(): number {return ++this.echoes;}
  /** Any other reply ends the echo streak. */
  echoEnded(): void {this.echoes = 0;}

  /** One image-downgrade retry per failure streak: false when it was already spent. */
  imageRetry(): boolean {
    if (this.imagesRetried) return false;
    this.imagesRetried = true;
    return true;
  }
  /** The provider answered: the image retry is available again. */
  providerAnswered(): void {this.imagesRetried = false;}

  /** Counts one more request made while the question `id` is unanswered; returns how many so far. */
  owedSeen(id: string): number {
    const seen = (this.owedSightings.get(id) ?? 0) + 1;
    this.owedSightings.set(id, seen);
    return seen;
  }

  turnStarted(): void {this.usage = undefined;}
  turnMetered(usage: TurnUsage | undefined): void {this.usage = usage;}
  /** The first assistant message persisted for a turn carries its usage into the ledger once. */
  takeUsage(message: ModelMessage): TurnUsage | undefined {
    const usage = message.role === 'assistant' && !message.contextExcluded ? this.usage : undefined;
    if (usage) this.usage = undefined;
    return usage;
  }
}
