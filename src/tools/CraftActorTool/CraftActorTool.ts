import {z} from 'zod';

export const craftActorSchema = z.strictObject({
  content: z.string().min(1).max(65536),
});

export type CraftActorArgs = z.infer<typeof craftActorSchema>;
