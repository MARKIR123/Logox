import {z} from 'zod';

export const taskSpecSchema = z.strictObject({
  ownerId: z.string().describe('Target actor ID (e.g. techne, kalon, aletheia)'),
  title: z.string().trim().min(1).max(120).optional().describe('3-8 word main task title for the actor card and roster'),
  prompt: z.string().trim().min(1).describe('The briefing for a colleague who has not seen your conversation'),
  owns: z.array(z.string().trim().min(1)).max(32).optional().describe('Paths or globs (relative to the project) this task may change; other actors editing them get a coordination note'),
  acceptance: z.array(z.string().trim().min(1).max(400)).max(12).optional().describe('Checks that define done'),
  after: z.array(z.string().trim().min(1)).max(8).optional().describe('Actor ids or activity ids to wait for'),
  resumeTask: z.string().optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const actorSchema = z.strictObject({
  tasks: z.array(taskSpecSchema).max(16).default([]),
  resumeBatch: z.string().optional(),
}).refine(input => input.tasks.length > 0 || Boolean(input.resumeBatch), 'Specify at least one task or a batch to resume');

export type ActorArgs = z.infer<typeof actorSchema>;

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'Actor', category: 'orchestration', loading: 'eager', roles: 'director', terminalVisibility: 'card', description: 'Dispatch tasks to ensemble actors'};
