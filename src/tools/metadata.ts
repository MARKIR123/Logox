import {z} from 'zod';

export const toolCategorySchema = z.enum(['core', 'protocol', 'coordination', 'orchestration', 'extension']);
export type ToolCategory = z.infer<typeof toolCategorySchema>;

export const toolRolesSchema = z.union([
  z.enum(['all', 'director', 'actors']),
  z.array(z.string().min(1)),
]);
export type ToolRoles = 'all' | 'director' | 'actors' | readonly string[];

export const toolPromptVisibilitySchema = z.enum(['always', 'explicit', 'hidden']);
export type ToolPromptVisibility = z.infer<typeof toolPromptVisibilitySchema>;

export const toolTerminalVisibilitySchema = z.enum(['card', 'notice', 'silent']);
export type ToolTerminalVisibility = z.infer<typeof toolTerminalVisibilitySchema>;

export const toolMetadataSchema = z.strictObject({
  name: z.string().min(1),
  category: toolCategorySchema,
  roles: toolRolesSchema,
  promptVisibility: toolPromptVisibilitySchema,
  terminalVisibility: toolTerminalVisibilitySchema,
  description: z.string().optional(),
});
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;

export const userToolConfigSchema = z.strictObject({
  roles: toolRolesSchema.optional(),
  promptVisibility: toolPromptVisibilitySchema.optional(),
  terminalVisibility: toolTerminalVisibilitySchema.optional(),
});
export type UserToolConfig = z.infer<typeof userToolConfigSchema>;

export function isToolAllowedForActor(roles: ToolRoles, actorId: string): boolean {
  if (roles === 'all') return true;
  if (roles === 'director') return actorId === 'logox';
  if (roles === 'actors') return actorId !== 'logox';
  if (Array.isArray(roles)) return roles.includes(actorId);
  return false;
}
