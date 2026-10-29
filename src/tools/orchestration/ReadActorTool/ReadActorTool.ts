import {z} from 'zod';

export const readActorSchema = z.strictObject({
  ownerId: z.string().min(1),
  activityId: z.string().optional(),
});

export type ReadActorArgs = z.infer<typeof readActorSchema>;

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'ReadActor', category: 'orchestration', roles: 'director', terminalVisibility: 'card', description: 'Inspect persona details of a specific actor'};
