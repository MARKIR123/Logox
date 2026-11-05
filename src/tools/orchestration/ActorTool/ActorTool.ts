import {z} from 'zod';

export const taskSpecSchema = z.strictObject({
  ownerId: z.string().describe('Target actor ID (e.g. techne, kalon, aletheia)'),
  title: z.string().trim().min(1).max(120).optional().describe('Short (3-8 word) main task title shown on the actor card header and active roster'),
  prompt: z.string().trim().min(1).describe('Natural colleague briefing: goal, relevant context/findings, and any boundaries'),
  deliverables: z.array(z.string().trim().min(1).max(400)).max(12).optional().describe('Artifacts this actor produces (files, assets, reports)'),
  owns: z.array(z.string().trim().min(1)).max(32).optional().describe('Paths or globs (relative to the project) this actor may change while the task is active; others get a coordination note when they edit them'),
  interfaces: z.string().trim().min(1).max(4000).optional().describe('Shared contract others rely on: names, IDs, sizes, file formats, APIs'),
  acceptance: z.array(z.string().trim().min(1).max(400)).max(12).optional().describe('Checks that define done'),
  verified: z.array(z.string().trim().min(1).max(400)).max(12).optional().describe('What is already verified or out of scope, for verification tasks'),
  after: z.array(z.string().trim().min(1)).max(8).optional().describe('Actor ids or activity ids this task depends on; it starts only after they complete and receives their reports'),
  files: z.array(z.string().trim().min(1)).max(32).optional().describe('Deprecated alias of owns'),
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

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'Actor', category: 'orchestration', loading: 'eager', roles: 'director', terminalVisibility: 'card', description: 'Dispatch tasks to ensemble actors'};
