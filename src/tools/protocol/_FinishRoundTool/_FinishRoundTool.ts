import {z} from 'zod';
import type {ToolDefinition} from '../../runtime/messages.js';
import {FINISH_ROUND_DESCRIPTION} from './prompt.js';

export const FINISH_ROUND_NAME = '_FinishRound';
export const finishRoundSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).describe('Concise English title; reuse the task report title when applicable'),
  verification: z.string().trim().min(1).max(240).nullable().describe('Actual verification overview, or null when not applicable or unknown'),
  carry_forward: z.array(z.string().trim().min(1).max(240)).max(8).describe('Only material unresolved work, constraints, or limitations; empty when none'),
});
export type FinishRoundArgs = z.infer<typeof finishRoundSchema>;
export const finishRoundTool: ToolDefinition = {name: FINISH_ROUND_NAME, description: FINISH_ROUND_DESCRIPTION, parameters: z.toJSONSchema(finishRoundSchema)};
export const finishRoundPolicy = Object.freeze({terminal: true, replay: 'omit-pair'} as const);
export const isFinishRound = (name: string): boolean => name.toLowerCase() === FINISH_ROUND_NAME.toLowerCase();
