import {z} from 'zod';
import {activityProgressSchema} from '../../runtime/contracts.js';

export const updateTaskProgressSchema = activityProgressSchema;
export type UpdateTaskProgressArgs = z.infer<typeof updateTaskProgressSchema>;
