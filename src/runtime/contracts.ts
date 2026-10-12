import {z} from 'zod';

const id = z.string().trim().min(1);
export const activityStatusSchema = z.enum(['queued', 'running', 'waiting_input', 'paused', 'completed', 'failed', 'cancelled']);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export const activitySchema = z.strictObject({
  sessionId: id, activityId: id, ownerId: id,
  kind: z.enum(['director', 'actor', 'anamnesis']),
  title: z.string().min(1), status: activityStatusSchema,
  stage: z.string(), detail: z.string(), version: z.number().int().nonnegative(),
});
export type Activity = z.infer<typeof activitySchema>;
const optionSchema = z.strictObject({id, label: z.string().min(1), description: z.string()});
export const questionSchema = z.strictObject({
  id, header: z.string().min(1).max(12), question: z.string().min(1),
  options: z.array(optionSchema).min(2).max(4).optional(),
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
  readonly role: 'user' | 'assistant' | 'notice';
  readonly text: string;
  readonly kind?: 'thinking' | 'tool';
  readonly activityId?: string;
  readonly source?: string;
}
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
