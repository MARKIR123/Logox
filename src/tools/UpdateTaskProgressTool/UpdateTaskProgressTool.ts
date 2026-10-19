import {z} from 'zod';
import {stepStageSchema} from '../../runtime/contracts.js';

export const updateTaskProgressSchema = z.strictObject({
  stages: z.array(stepStageSchema).min(1).max(32).optional().describe('List of stage milestones to establish or replace'),
  update: z.strictObject({
    id: z.string().trim().min(1).describe('Stage identifier to update'),
    status: z.enum(['in_progress', 'completed', 'skipped']).describe('New status for the stage'),
    result: z.string().trim().min(1).max(2000).optional().describe('Result description required when status is completed'),
    reason: z.string().trim().min(1).max(1000).optional().describe('Cancellation reason required when status is skipped'),
  }).optional().describe('Progress status update for a specific stage'),
}).refine(input => input.stages || input.update, 'Please provide stage plan (stages) or stage update (update)');

export type UpdateTaskProgressArgs = z.infer<typeof updateTaskProgressSchema>;
