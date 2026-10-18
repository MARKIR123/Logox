import {z} from 'zod';

export const taskSpecSchema = z.strictObject({
  ownerId: z.string(),
  prompt: z.string().trim().min(1),
  skills: z.array(z.string()).max(16).optional(),
  resumeTask: z.string().optional(),
  goal: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  minDeliverable: z.string().optional(),
  stopCondition: z.string().optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const actorSchema = z.strictObject({
  tasks: z.array(taskSpecSchema).max(16).default([]),
  resumeBatch: z.string().optional(),
}).refine(input => input.tasks.length > 0 || Boolean(input.resumeBatch), 'Specify at least one task or a batch to resume');

export type ActorArgs = z.infer<typeof actorSchema>;
