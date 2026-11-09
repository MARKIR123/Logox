import {z} from 'zod';
import type {ModelMessage} from '../runtime/messages.js';
import {executionEnvironmentSchema} from '../runtime/context-updates.js';
import {roundMemorySchema, taskDeliverySchema} from './round-memory.js';
import {DIRECTOR_STOP_LABEL, USER_INTERRUPT_LABEL} from '../prompts/runtime/interruption.js';

import {roundSummarySchema as summarySchema, type RoundSummary} from '../runtime/contracts.js';
export {summarySchema, type RoundSummary};
export const terminalSchema = z.enum(['completed', 'failed', 'cancelled']);
export type RoundStatus = z.infer<typeof terminalSchema>;
export const roundSchema = z.strictObject({
  activityId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(),
  sourceHash: z.string(), status: terminalSchema, summary: summarySchema,
  ordinal: z.number().int().positive().optional(), memory: roundMemorySchema.optional(),
  sourceLines: z.strictObject({start: z.number().int().positive(), end: z.number().int().positive()}).optional(),
  delivery: taskDeliverySchema.optional(),
});
export type RoundRecord = z.infer<typeof roundSchema>;
export const contextStateSchema = z.strictObject({
  version: z.literal(1), sessionId: z.string(), ownerId: z.string(),
  sourceLength: z.number().int().nonnegative(), sourceHash: z.string(),
  discoveredTools: z.array(z.string()).readonly().optional(),
  environmentBaseline: executionEnvironmentSchema.optional(), environmentCurrent: executionEnvironmentSchema.optional(),
  folded: z.array(z.number().int().nonnegative()),
  archives: z.array(z.strictObject({callIndex: z.number().int().nonnegative(), resultIndex: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/)})),
  memo: z.strictObject({end: z.number().int().positive(), text: z.string().min(1)}).optional(),
  working: z.strictObject({start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1)}).optional(),
  /** Ledger length when this view was compacted: thinking produced before it is no longer sent, because its signature bound the history that compaction replaced. */
  thinkingCut: z.number().int().nonnegative().optional(),
  /** Ledger index below which images were replaced by `[image: <path>]` text, because a request would have exceeded the model's image limit. Only grows. */
  imageCut: z.number().int().positive().optional(),
});
export type ContextState = z.infer<typeof contextStateSchema>;
export interface ModelCapacity {
  identity: string;
  window: number;
  maxOutput?: number;
  /** Most images one request may carry; unset when the provider documents no limit and none is configured. */
  maxImages?: number;
}
import {ROUND_SUMMARY_CONTRACT as summaryInstruction} from '../prompts/charter.js';
import {HISTORY_MEMO_INSTRUCTION} from '../prompts/compaction.js';
export {summaryInstruction, HISTORY_MEMO_INSTRUCTION};

export function memoryFocusInstruction(contract?: string): string {
  return contract?.trim() ? '\nRole memory focus (guidance under the round memory contract):\n' + contract.trim() : '';
}

/** The label of a deliberate stop recorded in these messages, if any (`Interrupted by user` / `Stopped by Director`). */
export function deliberateStopLabel(messages: readonly ModelMessage[]): string | undefined {
  const marker = messages.findLast(message => message.role === 'context' && message.kind === 'interruption');
  if (marker?.role !== 'context') return undefined;
  return marker.data?.by === 'user' ? USER_INTERRUPT_LABEL : marker.data?.by === 'director' ? DIRECTOR_STOP_LABEL : undefined;
}

/** A persona micro-action such as "（核对色板与标尺）" or "(checks the palette)": a whole line wrapped in full-width or ASCII brackets. */
const ACTION_LINE = /^\s*(?:⏵.*|（[^（）\n]{1,160}）|\([^()\n]{1,160}\)|【[^【】\n]{1,160}】)\s*$/;

/** True for a stage line or a whole-line parenthetical aside, which never names a round. */
export function isActionLine(line: string): boolean {return ACTION_LINE.test(line);}

/** The first line that can name a task or round: blank lines and leading bracketed micro-action lines are skipped. */
export function titleLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line && !ACTION_LINE.test(line)) ?? '';
}

/** Drops leading blank and bracketed micro-action lines so a summary starts with substance. */
export function stripLeadingActionLines(text: string): string {
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && (!lines[index]!.trim() || ACTION_LINE.test(lines[index]!))) index++;
  return index === lines.length ? text : lines.slice(index).join('\n');
}

/** Shortens text to at most max characters on a word (or grapheme) boundary and appends an ellipsis. */
export function clampText(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  const room = max - 1;
  let end = 0;
  for (const {index, segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(value)) {
    if (index + segment.length > room) break;
    end = index + segment.length;
  }
  let cut = value.slice(0, end);
  // Mid-word cut: back up to the previous whitespace unless that would discard most of the text.
  if (/\S/.test(value.charAt(end)) && /[^\s]$/.test(cut)) {
    const space = cut.search(/\s\S*$/);
    if (space > room * 0.5) cut = cut.slice(0, space);
  }
  return cut.trimEnd() + '…';
}

export function summarizeRound(messages: readonly ModelMessage[], status: RoundStatus): RoundSummary {
  messages = messages.filter(message => message.role !== 'assistant' || !message.contextExcluded && !message.memoryOnly && !message.textToolCall);
  const final = messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? '';
  const match = /(?:【轮次摘要】|\[Round Summary\])\s*(?:标题|Title)[：:]\s*([^\n]+)\s*(?:报告|Report)[：:]\s*([\s\S]+)$/i.exec(final);
  const parsed = match
    ? summarySchema.safeParse({
        title: (match[1]?.trim().slice(0, 100) || '').trim(),
        report: (match[2]?.trim().slice(0, 1950) || '').trim(),
        source: 'model',
      })
    : undefined;
  if (status === 'completed' && parsed?.success) return parsed.data;
  const goal = messages.find(message => message.role === 'user')?.text ?? '';
  const tools = messages.filter(message => message.role === 'tool').slice(-4)
    .map(message => message.role === 'tool' ? message.name + ': ' + (message.isError ? 'failed/not executed; ' : '') + message.text.slice(0, 140) : '');
  const label = status === 'completed' ? 'Completed' : status === 'cancelled' ? deliberateStopLabel(messages) ?? 'Interrupted; follow-up work needs checking' : 'Failed; needs further handling';
  return {title: (status === 'completed' ? titleLine(final) || label : label).slice(0, 100),
    report: ['Goal: ' + goal.slice(0, 350), 'Status: ' + label, final ? 'Reply: ' + final.slice(-850) : 'No complete assistant reply.',
      ...tools].join('\n').slice(0, 2000), source: 'local'};
}

/** Shares the role contract between the Agent's requestBase and history consolidation. */
export function roleSummaryInstruction(contract?: string): string {
  return summaryInstruction + memoryFocusInstruction(contract);
}
