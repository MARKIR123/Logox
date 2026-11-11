import {z} from 'zod';
import type {ToolDefinition} from '../../../runtime/messages.js';
import {FINISH_ROUND_DESCRIPTION} from './prompt.js';

export const FINISH_ROUND_NAME = '_FinishRound';
/** Estimated-token caps (`src/context/budget.ts:estimateText`); the runtime truncates over-long values instead of rejecting them. */
export const FINISH_ROUND_TITLE_TOKENS = 30;
export const FINISH_ROUND_SUMMARY_TOKENS = 200;
export const finishRoundSchema = z.object({
  title: z.string().trim().min(1).describe('Short name for this round; reuse the task report title when applicable'),
  summary: z.string().trim().min(1).describe('What was concluded or changed, the files involved, what was verified, and what remains'),
});
export type FinishRoundArgs = z.infer<typeof finishRoundSchema>;
export const finishRoundTool: ToolDefinition = {name: FINISH_ROUND_NAME, description: FINISH_ROUND_DESCRIPTION, parameters: z.toJSONSchema(finishRoundSchema)};
export const finishRoundPolicy = Object.freeze({terminal: true, replay: 'omit-pair'} as const);
export const isFinishRound = (name: string): boolean => name.toLowerCase() === FINISH_ROUND_NAME.toLowerCase();

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: '_FinishRound', category: 'protocol', loading: 'eager', roles: 'all', terminalVisibility: 'silent', description: 'Record internal round memory and deliver turn'};
