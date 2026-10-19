import {z} from 'zod';
import {questionSchema} from '../../runtime/contracts.js';
import type {ActorContext} from '../../actors/ensemble.js';
import type {ToolResult} from '../types.js';

export const askUserQuestionSchema = z.strictObject({
  title: z.string().min(1),
  questions: z.array(questionSchema).min(1).max(3),
});

export type AskUserQuestionArgs = z.infer<typeof askUserQuestionSchema>;

export async function executeAskUserQuestion(
  args: AskUserQuestionArgs,
  context: ActorContext
): Promise<ToolResult> {
  context.startTool?.();
  const outcome = await context.ask({kind: 'question', ...args});
  return {
    text: JSON.stringify(outcome),
    isError: outcome.status !== 'answered',
  };
}
