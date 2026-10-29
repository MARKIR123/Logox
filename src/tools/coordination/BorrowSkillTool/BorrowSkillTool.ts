import {z} from 'zod';

export const borrowSkillSchema = z.strictObject({
  name: z.string().min(1),
});

export type BorrowSkillArgs = z.infer<typeof borrowSkillSchema>;

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'BorrowSkill', category: 'coordination', roles: 'actors', terminalVisibility: 'card', description: 'Borrow a specialized skill on demand'};
