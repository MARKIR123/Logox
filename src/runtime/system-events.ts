import {z} from 'zod';

export const systemEventSchema = z.strictObject({version: z.literal(1), id: z.string().uuid(),
  sessionId: z.string().min(1), ownerId: z.string().min(1), time: z.number().finite(),
  kind: z.enum(['command_result', 'command_error', 'model_error', 'environment_change', 'task_notice']),
  text: z.string(), activityId: z.string().optional()});
export type SystemEvent = z.infer<typeof systemEventSchema>;
