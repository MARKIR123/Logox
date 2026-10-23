import {z} from 'zod';

const stageIdRegex = /^[a-z0-9_-]+$/i;

export const inputStageSchema = z.strictObject({
  id: z.string().trim().regex(stageIdRegex).optional().describe('Stage identifier (e.g. "ui", "api"). If omitted, generated automatically from title.'),
  title: z.string().trim().min(1).max(120).describe('Stage milestone title'),
  purpose: z.string().trim().min(1).max(1000).optional().describe('Stage goal or focus. If omitted, defaults to title.'),
  activeForm: z.string().trim().min(1).max(160).optional().describe('Active form in present tense (e.g. "Building UI"). If omitted, derived from title.'),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).optional().describe('Stage status: pending, in_progress, completed, skipped'),
  result: z.string().trim().max(2000).optional().describe('Result description when status is completed'),
  reason: z.string().trim().max(1000).optional().describe('Cancellation reason when status is skipped'),
});

export const updateTaskProgressSchema = z.strictObject({
  stages: z.array(inputStageSchema).min(1).max(32).optional().describe('List of stage milestones to establish or replace'),
  update: z.strictObject({
    id: z.string().trim().min(1).describe('Stage identifier or title to update'),
    status: z.enum(['in_progress', 'completed', 'skipped']).describe('New status for the stage'),
    result: z.string().trim().min(1).max(2000).optional().describe('Result description required when status is completed'),
    reason: z.string().trim().min(1).max(1000).optional().describe('Cancellation reason required when status is skipped'),
  }).optional().describe('Progress status update for a specific stage'),
}).refine(input => input.stages || input.update, 'Please provide stage plan (stages) or stage update (update)');

export type UpdateTaskProgressArgs = z.infer<typeof updateTaskProgressSchema>;
