import type {ActorExecutor} from '../actors/ensemble.js';
import type {TaskModels} from '../actors/task-models.js';
import type {AskBoard} from '../runtime/asks.js';
import type {ModelMessage} from '../runtime/messages.js';
import type {Step} from '../runtime/contracts.js';
import type {Steps} from '../runtime/steps.js';
import type {RoundEffect} from '../runtime/round-scope.js';
import type {AgentOptions} from './agent.js';
import type {ExecutionRecoveryKind} from './execution-recovery.js';
import type {PeerWait} from './peer-wait.js';
import type {RoundState} from './round-state.js';
import type {RepeatGuard} from './repeat-guard.js';
import type {ToolPacing} from './tool-pacing.js';

export type RunContext = Parameters<ActorExecutor<string>>[1];

/** Everything one agent run shares between the orchestrator and its steps. `context` is replaced when inbound input carries new recovery metadata. */
export interface AgentRun {
  readonly options: AgentOptions;
  context: RunContext;
  readonly messages: ModelMessage[];
  readonly steps: Steps;
  readonly state: RoundState;
  /** The latest `⏵` line the actor wrote; only a fallback title for `_FinishRound` (the card never reads it). */
  readonly narration: {latest?: string | undefined};
  readonly asks: AskBoard;
  readonly wait: PeerWait;
  readonly pacing: ToolPacing;
  readonly repeat: RepeatGuard;
  readonly taskModel: Awaited<ReturnType<TaskModels['begin']>> | undefined;
  readonly approvalHandled: ReadonlySet<string>;
  readonly concurrency: number;
  /** The actor still owes a reply it may be reminded of. */
  owesReply(): boolean;
  /** Before the activity ends: tells the actor to answer what it owes, or parks it while a reply is awaited. True when the loop must continue. */
  holdClose(): Promise<boolean>;
  /** An output problem (empty, truncated, text call): asks the recovery policy, notes the step and either arms a retry or throws. */
  recoverOutput(kind: ExecutionRecoveryKind, thinkingId: string): Promise<void>;
  persist(message: ModelMessage, step?: Step): Promise<void>;
  /** Takes queued input into history; true when something arrived (the request must be rebuilt). */
  drainInbox(closing?: boolean): Promise<boolean>;
  observeProgress(fingerprint: string): Promise<boolean> | boolean;
  directorWaiting(): boolean;
  effect(): RoundEffect;
}
