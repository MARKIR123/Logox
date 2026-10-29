import {z} from 'zod';
import type {ActorContext} from '../../actors/ensemble.js';
import type {ToolResult} from '../types.js';

const optionSchema = z.strictObject({
  label: z.string().min(1).describe('The option label displayed to the user'),
  description: z.string().describe('Short explanation of what this option means'),
});

const questionSchema = z.strictObject({
  question: z.string().min(1).describe('The question to ask the user'),
  header: z.string().min(1).max(12).describe('Very short label (max 12 characters) shown as a chip'),
  options: z.array(optionSchema).min(2).max(4).optional().describe('2-4 distinct choices. Omit to collect free text.'),
  multiSelect: z.boolean().optional().describe('Allow selecting multiple options (default false)'),
});

const askUserQuestionArgs = z.strictObject({
  questions: z.array(questionSchema).min(1).max(4).describe('1-4 questions to ask the user'),
});

function legacyQuestions(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = {...(value as Record<string, unknown>)};
  delete record.title;
  if (Array.isArray(record.questions)) {
    record.questions = record.questions.map(question => {
      if (!question || typeof question !== 'object' || Array.isArray(question)) return question;
      const item = {...(question as Record<string, unknown>)};
      delete item.id;
      if (Array.isArray(item.options)) {
        item.options = item.options.map(option => {
          if (!option || typeof option !== 'object' || Array.isArray(option)) return option;
          const entry = {...(option as Record<string, unknown>)};
          delete entry.id;
          if (typeof entry.description !== 'string') entry.description = '';
          return entry;
        });
      }
      return item;
    });
  }
  return record;
}

/** Accepts Claude's parameter shape; legacy title/id fields are stripped. */
export const askUserQuestionSchema = z.preprocess(legacyQuestions, askUserQuestionArgs);

export type AskUserQuestionArgs = z.infer<typeof askUserQuestionArgs>;

export async function executeAskUserQuestion(
  args: AskUserQuestionArgs,
  context: ActorContext
): Promise<ToolResult> {
  context.startTool?.();
  const questions = args.questions.map((question, questionIndex) => ({
    id: 'q' + questionIndex,
    header: question.header,
    question: question.question,
    ...(question.options
      ? {options: question.options.map((option, optionIndex) => ({
        id: 'o' + optionIndex,
        label: option.label,
        description: option.description ?? '',
      }))}
      : {}),
    ...(question.multiSelect !== undefined ? {multiSelect: question.multiSelect} : {}),
  }));
  const outcome = await context.ask({kind: 'question', title: args.questions[0]?.header || 'Question', questions});
  return {
    text: JSON.stringify(outcome),
    isError: outcome.status !== 'answered',
  };
}

export const metadata: import('../metadata.js').ToolMetadataInput = {name: 'AskUserQuestion', category: 'core', roles: 'all', terminalVisibility: 'card', description: 'Present structured clarification questions to user'};
