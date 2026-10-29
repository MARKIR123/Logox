import {z} from 'zod';

export const toolCategorySchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/);
export type ToolCategory = z.infer<typeof toolCategorySchema>;

export const toolRolesSchema = z.union([
  z.enum(['all', 'director', 'actors']),
  z.array(z.string().min(1)),
]);
export type ToolRoles = 'all' | 'director' | 'actors' | readonly string[];

export const toolLoadingSchema = z.enum(['eager', 'deferred']);
export type ToolLoading = z.infer<typeof toolLoadingSchema>;

export const toolPromptVisibilitySchema = z.enum(['always', 'explicit', 'summary', 'hidden']);
export type ToolPromptVisibility = z.infer<typeof toolPromptVisibilitySchema>;

export const toolTerminalVisibilitySchema = z.enum(['card', 'notice', 'silent']);
export type ToolTerminalVisibility = z.infer<typeof toolTerminalVisibilitySchema>;

export const toolMetadataSchema = z.strictObject({
  name: z.string().min(1),
  category: toolCategorySchema,
  roles: toolRolesSchema,
  loading: toolLoadingSchema.optional(),
  promptVisibility: toolPromptVisibilitySchema.optional(),
  terminalVisibility: toolTerminalVisibilitySchema,
  description: z.string().optional(),
}).transform(meta => ({...meta,
  loading: meta.loading ?? (meta.category === 'core' ? 'eager' : 'deferred'),
  promptVisibility: meta.promptVisibility ?? (meta.category === 'core' ? 'always' : 'summary')}));
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;
export type ToolMetadataInput = z.input<typeof toolMetadataSchema>;

export const userToolConfigSchema = z.strictObject({
  loading: toolLoadingSchema.optional(),
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
