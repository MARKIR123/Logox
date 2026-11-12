import {z} from 'zod';
import type {ModelMessage} from '../runtime/messages.js';
import type {RoundStatus} from './contracts.js';
import {truncateToTokens} from './budget.js';
import {FINISH_ROUND_SUMMARY_TOKENS, FINISH_ROUND_TITLE_TOKENS, isFinishRound, type FinishRoundArgs} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {canonicalToolName} from '../tools/types.js';
import {stripNarration} from '../runtime/narration.js';

const memoryBody = z.strictObject({
  title: z.string().min(1),
  summary: z.string(),
  source: z.enum(['model', 'runtime', 'legacy']),
});
/** Records written before the two-field shape hold `outcome`, `verification` and `carryForward`; reading joins them into `summary` and never rewrites the file. */
const legacyMemory = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'summary' in value) return value;
  const {outcome, verification, carryForward, ...rest} = value as Record<string, unknown>;
  const parts = [outcome, verification, ...Array.isArray(carryForward) ? carryForward : []].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return {...rest, summary: parts.map(part => part.trim()).join('; ')};
};
export const roundMemorySchema = z.preprocess(legacyMemory, memoryBody);
export type RoundMemory = z.infer<typeof memoryBody>;
export const taskDeliverySchema = z.strictObject({title: z.string().min(1).max(120), text: z.string().min(1)});
export type TaskDelivery = z.infer<typeof taskDeliverySchema>;

const field = (text: string): string => text.replace(/\|/g, '/').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
export function formatRoundIndex(input: {ordinal: number; title: string; summary: string; start: number; end: number}): string {
  if (![input.ordinal, input.start, input.end].every(value => Number.isSafeInteger(value) && value > 0) || input.end < input.start) {
    throw new Error('Round indexes require a positive ordinal and an inclusive physical line range.');
  }
  return `T${input.ordinal}|${field(input.title)}|${field(input.summary)}|${input.start}-${input.end}`;
}

/** The bracket marker that opens a runtime-written summary: stopped by user or Director, failed, completed without a usable `_FinishRound`, or a teammate-started activity that was no round of its own. */
export const ROUND_MARKERS = Object.freeze({cancelled: '[interrupted]', failed: '[failed]', completed: '[runtime]', reply: '[reply]'} as const);
const MARKER_PHRASES = Object.freeze({
  cancelled: 'Stopped before finishing.',
  failed: 'Ended with an error.',
  completed: 'The model gave no round summary.',
  reply: 'Answered a teammate.',
} as const);
const COMMAND_TOKENS = 40, MAX_FILES = 6;

/** What the ledger shows a closed stretch of work did: files changed by successful `Edit`/`Write` calls (first-touch order) and every foreground `Shell` run that reported an exit code. Shared by the round summary and the Director's runtime record. */
export function ledgerFacts(messages: readonly ModelMessage[]): {files: string[]; commands: Array<{text: string; exit: string}>} {
  const files: string[] = [];
  const commands: Array<{text: string; exit: string}> = [];
  const results = new Map<string, Extract<ModelMessage, {role: 'tool'}>>();
  for (const message of messages) if (message.role === 'tool') results.set(message.callId, message);
  for (const message of messages) {
    if (message.role !== 'assistant' || message.contextExcluded || message.toolsExcluded) continue;
    for (const call of message.toolCalls ?? []) {
      const name = canonicalToolName(call.name) ?? call.name, result = results.get(call.id);
      if (!result || result.isError && name !== 'Shell') continue; // a failed Shell run still reports its exit code
      let args: Record<string, unknown>;
      try {args = JSON.parse(call.arguments) as Record<string, unknown>;} catch {continue;}
      if ((name === 'Edit' || name === 'Write') && typeof args.file_path === 'string' && !files.includes(args.file_path)) files.push(args.file_path);
      if (name === 'Shell' && typeof args.command === 'string' && args.run_in_background !== true) {
        const exit = /^Exit code:\s*(-?\d+)/i.exec(result.text)?.[1];
        if (exit !== undefined) commands.push({text: truncateToTokens(args.command.replace(/\s+/g, ' '), COMMAND_TOKENS), exit});
      }
    }
  }
  return {files, commands};
}

/** A summary the runtime writes from the round's ledger entries: changed files, the last Shell command with its exit status, and for a completed round the opening of the delivered answer. A completed `reply` is marked `[reply]` instead of `[runtime]`. */
export function runtimeRoundSummary(messages: readonly ModelMessage[], status: RoundStatus, reply = false): string {
  const kind = reply && status === 'completed' ? 'reply' : status;
  const {files, commands} = ledgerFacts(messages);
  const command = commands.at(-1);
  const facts = [
    files.length ? 'Changed ' + files.slice(0, MAX_FILES).join(', ') + (files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : '') + '.' : '',
    command ? `Last command "${command.text}" exit ${command.exit}.` : '',
  ].filter(Boolean);
  // A round that completed without a model summary still delivered an answer: its opening is the closest thing to the model's own conclusion.
  const answer = kind === 'completed' ? messages.findLast(message => message.role === 'assistant' && !message.contextExcluded && !message.memoryOnly &&
    !message.textToolCall && stripNarration(message.text).trim()) : undefined;
  if (answer) facts.push('Answer began: ' + stripNarration(answer.text).replace(/\s+/g, ' ').trim());
  return truncateToTokens(ROUND_MARKERS[kind] + ' ' + (facts.length ? facts.join(' ') : MARKER_PHRASES[kind]), FINISH_ROUND_SUMMARY_TOKENS);
}

/**
 * The accepted form of `_FinishRound` arguments, or undefined when no usable summary exists. Lenient by design:
 * unknown fields are ignored, over-long values are truncated, a missing title is filled with `fallbackTitle`, and the legacy
 * `outcome`, `verification` and `carry_forward` fields are joined into `summary` when it is absent.
 */
export function normalizeFinishRound(raw: string, fallbackTitle = ''): FinishRoundArgs | undefined {
  let value: unknown;
  try {value = JSON.parse(raw);} catch {return undefined;}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const args = value as Record<string, unknown>;
  const text = (item: unknown): string => typeof item === 'string' ? item.trim() : '';
  let summary = text(args.summary);
  if (!summary) summary = [args.outcome, args.verification, ...Array.isArray(args.carry_forward) ? args.carry_forward : []].map(text).filter(Boolean).join('; ');
  if (!summary) return undefined;
  const title = text(args.title) || text(fallbackTitle) || 'Round';
  return {title: truncateToTokens(title, FINISH_ROUND_TITLE_TOKENS), summary: truncateToTokens(summary, FINISH_ROUND_SUMMARY_TOKENS)};
}

export function omitInternalToolPairs(messages: readonly ModelMessage[]): ModelMessage[] {
  const omitted = new Set(messages.flatMap(message => message.role === 'assistant'
    ? (message.toolCalls ?? []).filter(call => isFinishRound(call.name)).map(call => call.id) : []));
  const projected: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool' && (omitted.has(message.callId) || isFinishRound(message.name))) continue;
    if (message.role !== 'assistant') {projected.push(message); continue;}
    if (!message.memoryOnly && !message.toolCalls?.some(call => omitted.has(call.id))) {projected.push(message); continue;}
    const {toolCalls, memoryOnly, ...body} = message;
    const rest = memoryOnly ? {...body, text: ''} : body;
    const retained = (toolCalls ?? []).filter(call => !omitted.has(call.id));
    if (retained.length) projected.push({...rest, toolCalls: retained});
    else if (rest.text.trim()) projected.push(rest);
  }
  return projected;
}

export function extractRoundMemory(messages: readonly ModelMessage[], finalizerCallId?: string | null): RoundMemory | undefined {
  if (finalizerCallId === null) return undefined;
  // Modern closures name the accepted call; only legacy callers infer it from journal order.
  const lastInput = finalizerCallId === undefined ? messages.findLastIndex(message => message.role === 'user') : -1;
  for (let index = messages.length - 1; index > lastInput; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || message.contextExcluded || message.toolsExcluded) continue;
    for (const call of [...message.toolCalls ?? []].reverse()) {
      if (!isFinishRound(call.name) || finalizerCallId !== undefined && call.id !== finalizerCallId) continue;
      const receipt = messages.slice(index + 1).find(item => item.role === 'tool' && item.callId === call.id);
      if (receipt?.role !== 'tool' || receipt.isError || !isFinishRound(receipt.name)) continue;
      const parsed = normalizeFinishRound(call.arguments);
      if (parsed) return {...parsed, source: 'model'};
    }
  }
  return undefined;
}
