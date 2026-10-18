import {z} from 'zod';

export const borrowSkillSchema = z.strictObject({
  name: z.string().min(1),
});

export type BorrowSkillArgs = z.infer<typeof borrowSkillSchema>;
