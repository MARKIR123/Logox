import {z} from 'zod';

/** The worker's one exit. `question` belongs to `blocked` and to nothing else; the refinement states the fix. */
export const finishSchema = z.strictObject({
  status: z.enum(['done', 'blocked', 'failed']).describe('done, blocked or failed'),
  summary: z.string().trim().min(1).max(600).describe('The answer or what you did, in one or two sentences'),
  evidence: z.array(z.string().min(1).max(300)).max(20).optional().describe('One item per fact: path:line, or a command with its key output'),
  notVerified: z.array(z.string().min(1).max(300)).max(12).optional().describe('What you did not check, could not do, or left outside your brief'),
  question: z.string().trim().min(1).max(600).optional().describe('Only with status blocked: the one question your dispatcher must answer'),
}).superRefine((value, context) => {
  if (value.status === 'blocked' && !value.question) context.addIssue({code: 'custom', path: ['question'],
    message: '`question` is required when status is "blocked": put the one question there, or use status "done" or "failed"'});
  if (value.status !== 'blocked' && value.question !== undefined) context.addIssue({code: 'custom', path: ['question'],
    message: '`question` is only for status "blocked": remove it'});
});

export type FinishArgs = z.infer<typeof finishSchema>;

/** The parsed call, or the refusal text the worker reads (every issue with its field, then the instruction to retry). */
export function parseFinish(raw: string): {readonly ok: true; readonly value: FinishArgs} | {readonly ok: false; readonly text: string} {
  let args: unknown;
  try {args = JSON.parse(raw);} catch {return {ok: false, text: 'Finish refused: the arguments are not valid JSON. Send Finish again with complete arguments.'};}
  const parsed = finishSchema.safeParse(args);
  if (parsed.success) return {ok: true, value: parsed.data};
  return {ok: false, text: 'Finish refused: ' + parsed.error.issues.map(issue => (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('; ') + '. Fix the call and send Finish again.'};
}
