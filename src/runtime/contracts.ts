import {z} from 'zod';
import {toolCallSchema} from './messages.js';
import {inputKindSchema, type InputKind} from './provenance.js';

const id = z.string().trim().min(1);
export const taskOriginSchema = z.object({parentActivityId: id.optional(), rootActivityId: id.optional(), batchId: id.optional(),
  resumeTaskId: id.optional(),
  inputKind: inputKindSchema.optional(), authorization: z.array(z.string()).max(8).optional(),
  stopReason: z.enum(['user', 'shutdown', 'interrupted', 'director_cancel']).optional(),
  recovery: z.strictObject({key: id, attempt: z.number().int().nonnegative(), exhausted: z.boolean().optional()}).optional()});
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
    if (stage.status === 'completed' && !stage.result) ctx.addIssue({code: 'custom', message: '完成阶段必须报告实际成果'});
    if (stage.status === 'skipped' && !stage.reason) ctx.addIssue({code: 'custom', message: '取消阶段必须说明原因'});
  });
export const taskProgressSchema = z.strictObject({planned: z.boolean(), revision: z.number().int().nonnegative(),
  stages: z.array(taskStageSchema).max(32), activeStageId: id.optional(),
  revisions: z.array(z.strictObject({revision: z.number().int().positive(), time: z.number(), stages: z.array(taskStageSchema).max(32),
    activeStageId: id.optional()}))})
  .superRefine((progress, ctx) => {
    const ids = progress.stages.map(stage => stage.id), active = progress.stages.filter(stage => stage.status === 'in_progress');
    if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: '阶段 ID 必须唯一'});
    if (active.length > 1 || active[0]?.id !== progress.activeStageId) ctx.addIssue({code: 'custom', message: '一次只能推进一个当前阶段'});
    if (!progress.planned && progress.stages.length > 0) ctx.addIssue({code: 'custom', message: '未登记计划不能包含阶段'});
  });
export type TaskProgressSnapshot = z.infer<typeof taskProgressSchema>;
export const taskModelSchema = z.strictObject({
  initial: z.strictObject({provider: id, model: id}), actual: z.strictObject({provider: id, model: id}),
  inherited: z.boolean(), switched: z.boolean(), phase: z.enum(['started', 'confirming', 'ready', 'completed', 'failed', 'cancelled']),
});
export const activitySchema = z.strictObject({
  sessionId: id, activityId: id, ownerId: id,
  kind: z.enum(['director', 'actor', 'anamnesis']),
  title: z.string().min(1), status: activityStatusSchema,
  stage: z.string(), detail: z.string(), version: z.number().int().nonnegative(),
  phase: z.enum(['model', 'text', 'tool', 'approval', 'question', 'retry', 'finalizing']).optional(),
  summary: roundSummarySchema.optional(),
  progress: taskProgressSchema.optional(),
  taskModel: taskModelSchema.optional(),
  ...taskOriginSchema.shape,
});
export type Activity = z.infer<typeof activitySchema>;
const optionSchema = z.strictObject({id, label: z.string().min(1), description: z.string()});
export const questionSchema = z.strictObject({
  id, header: z.string().min(1).max(12), question: z.string().min(1),
  options: z.array(optionSchema).min(2).max(4).optional(),
  multiSelect: z.boolean().optional(),
}).superRefine((question, ctx) => {
  const ids = question.options?.map(option => option.id) ?? [];
  if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: '选项 ID 必须唯一'});
});
const identity = {sessionId: id, activityId: id, ownerId: id};
export const interactionInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...identity, kind: z.literal('question'), title: z.string().min(1),
    questions: z.array(questionSchema).min(1).max(3),
  }).superRefine((input, ctx) => {
    const ids = input.questions.map(question => question.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: '问题 ID 必须唯一'});
  }),
  z.strictObject({
    ...identity, kind: z.literal('permission'), title: z.string().min(1),
    tool: id, arguments: z.record(z.string(), z.json()), reason: z.string().min(1),
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
    decision: z.enum(['allow_once', 'deny']),
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
}
export const stepSchema = z.strictObject({title: z.string(), callId: z.string().optional(), call: toolCallSchema.optional(),
  stage: stepStageSchema.optional(), disposition: z.enum(['denied', 'error']).optional(), note: z.string().max(1000).optional(),
  groupId: z.string().optional(), groupState: z.enum(['completed', 'failed', 'cancelled']).optional(),
  state: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
  elapsedMs: z.number().nonnegative(), runningSince: z.number().optional(), waiting: z.string().optional()});
export type Step = z.infer<typeof stepSchema>;
export interface RuntimeSnapshot {
  readonly revision: number;
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
