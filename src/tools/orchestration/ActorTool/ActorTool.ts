import {z} from 'zod';

export const taskSpecSchema = z.strictObject({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and hyphens, at most 32').optional().describe('Short handle other tasks of this call name in `after` (e.g. "draw-assets"); only needed when one does'),
  ownerId: z.string().describe('Target actor ID (e.g. techne, kalon, aletheia)'),
  title: z.string().trim().min(1).max(120).optional().describe('3-8 word main task title for the actor card and roster'),
  prompt: z.string().trim().min(1).describe('The briefing for a colleague who has not seen your conversation'),
  owns: z.array(z.string().trim().min(1)).max(32).optional().describe('Paths or globs (relative to the project) this task may change; other actors editing them get a coordination note'),
  acceptance: z.array(z.string().trim().min(1).max(400)).max(12).optional().describe('Checks that define done'),
  after: z.array(z.string().trim().min(1)).max(8).optional().describe('Tasks to wait for: an `id` of this call, or the activity id of an earlier task. Never an actor name'),
  node: z.string().trim().min(1).max(40).optional().describe('Plan node id this task carries out (see Plan): the node\'s status then follows this work'),
  resumeTask: z.string().optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const actorSchema = z.strictObject({
  tasks: z.array(taskSpecSchema).max(16).default([]),
  resumeBatch: z.string().optional(),
  continueAct: z.boolean().optional().describe('Rare: true when this first dispatch of a new round is the same piece of work as the last act on the team stage (a follow-up fix, the next step the user asked for in discussion): the act reopens instead of a new one starting. Ignored mid-act'),
  briefCheck: z.enum(['skip']).optional().describe('Set to "skip" to dispatch without the runtime brief check (it runs before a dispatch of two or more tasks, or of a prompt longer than 1500 characters, and returns the gaps it finds without starting anything). Omit it normally; skip only when you are sure a reported gap is not one.'),
}).refine(input => input.tasks.length > 0 || Boolean(input.resumeBatch), 'Specify at least one task or a batch to resume');

export type ActorArgs = z.infer<typeof actorSchema>;

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'Actor', category: 'orchestration', loading: 'eager', roles: 'director', terminalVisibility: 'card', description: 'Dispatch tasks to ensemble actors'};
