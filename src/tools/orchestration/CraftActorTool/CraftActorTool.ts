import {z} from 'zod';

export const craftActorSchema = z.strictObject({
  content: z.string().min(1).max(65536),
});

export type CraftActorArgs = z.infer<typeof craftActorSchema>;

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'CraftActor', category: 'orchestration', roles: 'director', terminalVisibility: 'card', description: 'Create and register a new persistent actor persona'};
