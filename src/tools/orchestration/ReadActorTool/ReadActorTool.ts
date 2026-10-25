import {z} from 'zod';

export const readActorSchema = z.strictObject({
  ownerId: z.string().min(1),
  activityId: z.string().optional(),
});

export type ReadActorArgs = z.infer<typeof readActorSchema>;
