import {z} from 'zod';
import {effortSchema} from '../config/model-preferences.js';
import {toolCallSchema} from './messages.js';
import {inputKindSchema, type InputKind} from './provenance.js';
import type {SystemEvent, SystemPresentation} from './system-events.js';
import {stopReasonSchema, storedStopSchema} from './stop-reason.js';

const id = z.string().trim().min(1);
export const taskOriginSchema = z.object({parentActivityId: id.optional(), rootActivityId: id.optional(), batchId: id.optional(),
  /** The plan node this task carries out (`src/runtime/plan.ts`); the plan holds the link, the activity keeps the origin. */
  planNode: z.string().trim().min(1).max(40).optional(),
  /** How long the Director expects this task to take (`Actor` task `expect`); the watchdog's first check waits at least this long. */
  expectMinutes: z.number().positive().max(7 * 24 * 60).optional(),
  resumeTaskId: id.optional(), taskTitle: z.string().trim().min(1).max(120).optional(), ownedFiles: z.array(z.string().trim().min(1)).max(32).optional(), acceptance: z.array(z.string().trim().min(1).max(400)).max(12).optional(), after: z.array(id).max(8).optional(), coordinationWake: z.boolean().optional(),
  /** The Director's first dispatch of a new round reopens the previous act of the team stage instead of opening a new one (`src/runtime/team-acts.ts`); only a Director's dispatch carries it. */
  continueAct: z.boolean().optional(), dispatchDepth: z.number().int().nonnegative().optional(), grantExecution: z.boolean().optional(),
  inputKind: inputKindSchema.optional(), authorization: z.array(z.string()).max(8).optional(),
  /** How the work ended (`stop-reason.ts`); while a task is stopping it briefly holds the cause word (`user`, `director_cancel`), and older sessions keep those words. */
  stopReason: storedStopSchema.optional(),
  /** What went wrong, when an error ended the work: one short line, no secrets (`stop-reason.ts:diagnosticOf`). */
  diagnostic: z.string().max(300).optional(),
  /** What the actor's definition was when this work started (`src/actors/fingerprint.ts`); a resume compares it with the current one. Absent in older sessions. */
  fingerprint: z.string().max(400).optional(),
  recovery: z.strictObject({key: id, attempt: z.number().int().nonnegative(), exhausted: z.boolean().optional(),
    actorTask: z.strictObject({ownerId: id, activityId: id}).optional()}).optional()});
export type TaskOriginData = z.infer<typeof taskOriginSchema>;
export const roundSummarySchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  report: z.string().trim().min(1).max(2000),
  source: z.enum(['model', 'local']),
});
export type RoundSummary = z.infer<typeof roundSummarySchema>;
export const activityStatusSchema = z.enum(['queued', 'running', 'waiting_input', 'paused', 'completed', 'failed', 'cancelled']);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export const stepStageSchema = z.strictObject({id, title: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(1000), activeForm: z.string().trim().min(1).max(160)});
export type StepStage = z.infer<typeof stepStageSchema>;
const taskStageSchema = stepStageSchema.extend({status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
  result: z.string().trim().min(1).max(2000).optional(), reason: z.string().trim().min(1).max(1000).optional()})
  .superRefine((stage, ctx) => {
    if (stage.status === 'completed' && !stage.result) ctx.addIssue({code: 'custom', message: 'A completed stage must report actual results'});
    if (stage.status === 'skipped' && !stage.reason) ctx.addIssue({code: 'custom', message: 'A skipped stage must state a reason'});
  });
const legacyTaskProgressSchema = z.strictObject({planned: z.boolean(), revision: z.number().int().nonnegative(),
  stages: z.array(taskStageSchema).max(32), activeStageId: id.optional(),
  revisions: z.array(z.strictObject({revision: z.number().int().positive(), time: z.number(), stages: z.array(taskStageSchema).max(32),
    activeStageId: id.optional()}))})
  .superRefine((progress, ctx) => {
    const ids = progress.stages.map(stage => stage.id), active = progress.stages.filter(stage => stage.status === 'in_progress');
    if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: 'Stage IDs must be unique'});
    if (active.length > 1 || active[0]?.id !== progress.activeStageId) ctx.addIssue({code: 'custom', message: 'Only one stage can be active at a time'});
    if (!progress.planned && progress.stages.length > 0) ctx.addIssue({code: 'custom', message: 'Stages cannot exist without a registered plan'});
  });
/** How many declared stages an activity's progress keeps (read from older ledgers; no longer written). */
export const STAGE_HISTORY_LIMIT = 30;
export const activityProgressSchema = z.strictObject({
  label: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/, 'Use a single-line activity label'),
  detail: z.string().trim().min(1).max(1000).optional(),
  /** The stages older sessions declared, oldest first. Legacy: parsed and ignored, never written. */
  stageHistory: z.array(z.string().max(160)).max(STAGE_HISTORY_LIMIT).optional(),
});
export type ActivityProgress = z.infer<typeof activityProgressSchema>;
// Legacy milestones remain readable as historical data, never rewritten on load.
export const taskProgressSchema = z.union([activityProgressSchema, legacyTaskProgressSchema]);
export type TaskProgressSnapshot = z.infer<typeof taskProgressSchema>;
export function currentTaskProgress(progress: TaskProgressSnapshot | undefined): ActivityProgress | undefined {
  if (!progress) return undefined;
  if ('label' in progress) return progress;
  const stage = progress.stages.find(stage => stage.id === progress.activeStageId);
  return stage ? {label: stage.activeForm, detail: stage.purpose} : undefined;
}
export const taskModelSchema = z.strictObject({
  initial: z.strictObject({provider: id, model: id, effort: effortSchema.optional()}), actual: z.strictObject({provider: id, model: id, effort: effortSchema.optional()}),
  inherited: z.boolean(), switched: z.boolean(), phase: z.enum(['started', 'confirming', 'ready', 'completed', 'failed', 'cancelled']),
});
export const activitySchema = z.strictObject({
  sessionId: id, activityId: id, ownerId: id,
  kind: z.enum(['director', 'actor', 'anamnesis']),
  title: z.string().min(1), status: activityStatusSchema,
  stage: z.string(), detail: z.string(), version: z.number().int().nonnegative(),
  phase: z.enum(['model', 'text', 'tool', 'approval', 'question', 'retry', 'compacting', 'finalizing']).optional(),
  /** Wall-clock start (ms) of the reconnect wait while `phase` is `retry`; the card clock of `Reconnecting (n/m)`. Cleared with the phase. */
  retrySince: z.number().optional(),
  summary: roundSummarySchema.optional(),
  progress: taskProgressSchema.optional(),
  taskModel: taskModelSchema.optional(),
  /** Wall-clock creation time (ms). Set only by Anamnesis, whose card is placed among the messages by it; other activities are placed by their messages. */
  createdAt: z.number().optional(),
  /** Wall-clock times (ms) the activity first ran and ended, stamped by the store; absent in older sessions. */
  startedAt: z.number().optional(), finishedAt: z.number().optional(),
  ...taskOriginSchema.shape,
});
export type Activity = z.infer<typeof activitySchema>;
const optionSchema = z.strictObject({id, label: z.string().min(1), description: z.string()});
export const questionSchema = z.strictObject({
  id, header: z.string().min(1).max(12), question: z.string().min(1),
  options: z.array(optionSchema).min(2).max(24).optional(),
  multiSelect: z.boolean().optional(),
  /** Extra context line rendered under the question body. */
  detail: z.string().optional(),
  /** URL the question refers to; shown as one dim line. */
  link: z.string().optional(),
  /** Mask the typed answer (one bullet per code point); the answer itself stays real. */
  secret: z.boolean().optional(),
  /** Hide the free-text row for purely option-driven questions (local wizards). Ignored when there are no options. */
  hideCustomInput: z.boolean().optional(),
}).superRefine((question, ctx) => {
  const ids = question.options?.map(option => option.id) ?? [];
  if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: 'Option IDs must be unique'});
});
const identity = {sessionId: id, activityId: id, ownerId: id};
export const interactionInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...identity, kind: z.literal('question'), title: z.string().min(1),
    questions: z.array(questionSchema).min(1).max(3),
  }).superRefine((input, ctx) => {
    const ids = input.questions.map(question => question.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: 'Question IDs must be unique'});
  }),
  z.strictObject({
    ...identity, kind: z.literal('permission'), title: z.string().min(1),
    tool: id, arguments: z.record(z.string(), z.json()), reason: z.string().min(1),
    /** Permission mode in force, shown faint on the card. */
    mode: z.string().min(1).optional(),
    /** The static rule a session/project grant would create; absent when no rule could cover the call. */
    suggestion: z.strictObject({tool: id, pattern: z.string().min(1), label: z.string().min(1)}).optional(),
  }),
]);
export type InteractionInput = z.infer<typeof interactionInputSchema>;
export const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...identity, requestId: id, kind: z.literal('question'),
    answers: z.record(z.string(), z.discriminatedUnion('type', [
      z.strictObject({type: z.literal('option'), optionId: id}),
      z.strictObject({type: z.literal('options'), optionIds: z.array(id).min(1)}),
      z.strictObject({type: z.literal('text'), text: z.string().trim().min(1)}),
    ])),
  }),
  z.strictObject({
    ...identity, requestId: id, kind: z.literal('permission'),
    decision: z.enum(['allow_once', 'allow_session', 'allow_project', 'deny']),
    /** Why the user denied; returned to the model with the denial. */
    note: z.string().trim().min(1).max(500).optional(),
  }),
]);
export type InteractionResponse = z.infer<typeof responseSchema>;
export type Answer = Extract<InteractionResponse, {kind: 'question'}>['answers'][string];
export type Interaction = InteractionInput & {
  requestId: string;
  status: 'pending' | 'answered' | 'cancelled';
  response?: InteractionResponse;
  reason?: string;
};
export type InteractionOutcome =
  | {status: 'answered'; response: InteractionResponse}
  | {status: 'cancelled'; reason: string};
export interface Message {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly role: 'user' | 'assistant' | 'notice' | 'system';
  readonly text: string;
  readonly kind?: 'thinking' | 'tool';
  readonly activityId?: string;
  readonly source?: string;
  readonly inputKind?: InputKind;
  readonly step?: Step;
  readonly time?: number;
  readonly systemPresentation?: SystemPresentation;
  readonly systemEventKind?: SystemEvent['kind'];
  readonly systemTitle?: string;
  readonly systemReplay?: boolean;
}
const automaJobStateSchema = z.strictObject({
  /** The worker's readable id (`T1`), which a later `continue` names. */
  id: z.string().optional(),
  /** The optional short handle the dispatcher gave the job (`scout`); a later call may name the worker by it. */
  name: z.string().optional(),
  title: z.string(),
  /** The plan node the job carries out (`Automa` job field `node`). */
  node: z.string().optional(),
  /** `fork`: a copy of the dispatcher with its whole context (`fork: true`), not a worker with a brief. Absent for a worker. */
  kind: z.literal('fork').optional(),
  /** `waiting`: ordered after jobs that have not ended yet (`after`); `skipped`: never started because a job it follows did not end `done`. */
  state: z.enum(['queued', 'running', 'done', 'blocked', 'failed', 'cancelled', 'denied', 'interrupted', 'waiting', 'skipped']),
  /** Ids of the jobs this one follows. */
  after: z.array(z.string()).optional(),
  /** Background jobs: the result reached the dispatcher as a message (absent while it is outstanding, and for jobs of a waited dispatch). */
  delivered: z.boolean().optional(),
  elapsedMs: z.number().nonnegative(),
  /** Set while running; the renderer samples its own clock from it. */
  startedAt: z.number().optional(),
  /** The call in progress right now. */
  tool: z.string().optional(),
  calls: z.array(z.strictObject({name: z.string(), title: z.string(), state: z.enum(['running', 'completed', 'failed'])})),
  receipt: z.string().optional(),
  /** The route (`read` or `code`) and model the job ran on, and how it ended (`stop-reason.ts`); set when it settles. */
  route: z.enum(['read', 'code', 'vision']).optional(), model: z.string().optional(), stopReason: stopReasonSchema.optional(),
  /** What the worker handed back through Finish, for the delegation record. */
  summary: z.string().optional(), evidence: z.array(z.string()).optional(), notVerified: z.array(z.string()).optional(), question: z.string().optional(),
});
export const automaSwarmSchema = z.strictObject({name: z.string(), jobs: z.array(automaJobStateSchema),
  /** The dispatch runs in the background: its tool step ended at once and the card keeps updating. */
  background: z.boolean().optional(),
  /** The Director's dispatch reopens the previous act of the team stage (`src/runtime/team-acts.ts`). */
  continueAct: z.boolean().optional()});
export type AutomaJobState = z.infer<typeof automaJobStateSchema>;
export type AutomaSwarm = z.infer<typeof automaSwarmSchema>;
export const stepSchema = z.strictObject({title: z.string(), callId: z.string().optional(), call: toolCallSchema.optional(),
  swarm: automaSwarmSchema.optional(),
  /** Live only: the tool call this request is still streaming arguments for. Never kept on a finished step. */
  drafting: z.strictObject({tool: z.string(), target: z.string().optional(), chars: z.number().nonnegative()}).optional(),
  terminalVisibility: z.enum(['card', 'notice', 'silent']).optional(),
  /** A request attempt the connection dropped on and the loop is retrying: it ended `failed`, its row reads `interrupted after <time>`. */
  interrupted: z.boolean().optional(),
  stage: stepStageSchema.optional(), disposition: z.enum(['denied', 'error']).optional(), note: z.string().max(1000).optional(),
  groupId: z.string().optional(), groupState: z.enum(['completed', 'failed', 'cancelled']).optional(),
  state: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
  elapsedMs: z.number().nonnegative(), runningSince: z.number().optional(), waiting: z.string().optional()});
export type Step = z.infer<typeof stepSchema>;
export type StepEnd = 'completed' | 'failed' | 'cancelled';
/**
 * Closes a step that never got a terminal record: no live clock, no waiting reason. `at` bounds the time counted since it
 * started (default: now), so a step restored from an old ledger does not claim the hours since.
 */
export function settleStep(step: Step, state: StepEnd, at = Date.now()): Step {
  if (step.state === 'completed' || step.state === 'failed' || step.state === 'cancelled') return step;
  const {runningSince, waiting: _, drafting: __, ...rest} = step;
  return {...rest, state, elapsedMs: step.elapsedMs + (step.state === 'running' && runningSince !== undefined ? Math.max(0, at - runningSince) : 0)};
}
/** A human message held back because its target was mid-round; it is not part of the timeline until it is delivered or steered. */
export interface PendingInput {
  readonly id: string; readonly sessionId: string;
  /** The actor that will receive it. */
  readonly ownerId: string;
  /** The window it was typed in. */
  readonly windowId: string;
  readonly text: string; readonly time: number;
  /** Loaded from a previous process: it stays held until the human sends or discards it, and never auto-delivers. */
  readonly restored?: true;
}
export interface RuntimeSnapshot {
  readonly revision: number;
  readonly pending: readonly PendingInput[];
  readonly activities: readonly Activity[];
  readonly interactions: readonly Interaction[];
  readonly messages: readonly Message[];
}

export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
