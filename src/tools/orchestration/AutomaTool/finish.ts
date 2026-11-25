import {z} from 'zod';

/** The worker's structured exit. `parseFinish()` reads it leniently; the schema states the shape models are asked for. */
export const finishSchema = z.strictObject({
  status: z.enum(['done', 'blocked', 'failed']).describe('done, blocked or failed'),
  summary: z.string().trim().min(1).max(600).describe('The answer or what you did, in one or two sentences'),
  evidence: z.array(z.string().min(1).max(300)).max(20).optional().describe('One item per fact: path:line, or a command with its key output'),
  notVerified: z.array(z.string().min(1).max(300)).max(12).optional().describe('What you did not check, could not do, or left outside your brief'),
  question: z.string().trim().min(1).max(600).optional().describe('Only with status blocked: the one question your dispatcher must answer'),
}).superRefine((value, context) => {
  if (value.status === 'blocked' && !value.question) context.addIssue({code: 'custom', path: ['question'],
    message: '`question` is required when status is "blocked": put the one question there, or use status "done" or "failed"'});
});

export type FinishArgs = z.infer<typeof finishSchema>;

const clip = (value: unknown, max: number): unknown => typeof value === 'string' && value.trim().length > max ? value.trim().slice(0, max - 1).trimEnd() + '…' : value;
const list = (value: unknown, items: number, max: number): unknown => Array.isArray(value)
  ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, items).map(item => clip(item, max)) : value;

/**
 * What a worker means, not what it typed: only an unusable status or an empty summary is refused. Unknown fields go, over-long text is cut,
 * lists keep their first items, a `question` beside any status but `blocked` is filler (evals t6, 2026-11-17: refusing it looped for 20+ turns),
 * and `blocked` without one asks its summary.
 */
function lenient(args: Record<string, unknown>): Record<string, unknown> {
  const status = typeof args.status === 'string' ? args.status.trim().toLowerCase() : args.status;
  const out: Record<string, unknown> = {status, summary: clip(args.summary, 600)};
  if (args.evidence !== undefined) out.evidence = list(args.evidence, 20, 300);
  if (args.notVerified !== undefined) out.notVerified = list(args.notVerified, 12, 300);
  const question = typeof args.question === 'string' && args.question.trim() ? clip(args.question, 600) : undefined;
  if (status === 'blocked') out.question = question ?? out.summary;
  return out;
}

/** The parsed call, or the refusal text the worker reads (every issue with its field, then the instruction to retry). */
export function parseFinish(raw: string): {readonly ok: true; readonly value: FinishArgs} | {readonly ok: false; readonly text: string} {
  let args: unknown;
  try {args = JSON.parse(raw);} catch {return {ok: false, text: 'Finish refused: the arguments are not valid JSON. Send Finish again with complete arguments.'};}
  if (args && typeof args === 'object' && !Array.isArray(args)) args = lenient(args as Record<string, unknown>);
  const parsed = finishSchema.safeParse(args);
  if (parsed.success) return {ok: true, value: parsed.data};
  return {ok: false, text: 'Finish refused: ' + parsed.error.issues.map(issue => (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('; ') + '. Fix the call and send Finish again.'};
}
