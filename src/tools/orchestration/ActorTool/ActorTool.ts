import {z} from 'zod';

export const taskSpecSchema = z.strictObject({
  ownerId: z.string().describe('Target actor ID (e.g. techne, kalon, aletheia)'),
  title: z.string().trim().min(1).max(120).optional().describe('Short (3-8 word) main task title shown on the actor card header and active roster'),
  prompt: z.string().trim().min(1).describe('Natural colleague briefing: goal, relevant context/findings, and any boundaries'),
  skills: z.array(z.string()).max(16).optional(),
  resumeTask: z.string().optional(),
  description: z.string().optional(),
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

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'Actor', category: 'orchestration', roles: 'director', terminalVisibility: 'card', description: 'Dispatch tasks to ensemble actors'};
