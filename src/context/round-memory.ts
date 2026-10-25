import {z} from 'zod';
import type {ModelMessage} from '../runtime/messages.js';
import type {RoundStatus} from './contracts.js';
import {finishRoundSchema, isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';

export const roundMemorySchema = z.strictObject({
  title: z.string().min(1).max(120),
  verification: z.string().max(240).nullable(),
  carryForward: z.array(z.string().min(1).max(240)).max(8),
  source: z.enum(['model', 'runtime', 'legacy']),
});
export type RoundMemory = z.infer<typeof roundMemorySchema>;
export const taskDeliverySchema = z.strictObject({title: z.string().min(1).max(120), text: z.string().min(1)});
export type TaskDelivery = z.infer<typeof taskDeliverySchema>;

const field = (text: string): string => text.replace(/\|/g, '/').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
export function formatRoundIndex(input: {ordinal: number; title: string; status: RoundStatus; verification: string | null; carryForward: readonly string[]; start: number; end: number}): string {
  if (![input.ordinal, input.start, input.end].every(value => Number.isSafeInteger(value) && value > 0) || input.end < input.start) {
    throw new Error('Round indexes require a positive ordinal and an inclusive physical line range.');
  }
  const status = {completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled'}[input.status];
  const verification = input.verification ? field(input.verification) : '';
  const carry = input.carryForward.map(field).filter(Boolean).join('; ');
  return `${input.ordinal} | ${field(input.title)} | ${status}${verification ? '; ' + verification : ''}${carry ? ' | ' + carry + ' | ' : ' || '}${input.start}:${input.end}`;
}

export function omitInternalToolPairs(messages: readonly ModelMessage[], preserveCallIds: ReadonlySet<string> = new Set()): ModelMessage[] {
  const omitted = new Set(messages.flatMap(message => message.role === 'assistant'
    ? (message.toolCalls ?? []).filter(call => isFinishRound(call.name) && !preserveCallIds.has(call.id)).map(call => call.id) : []));
  const projected: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool' && (omitted.has(message.callId) || isFinishRound(message.name) && !preserveCallIds.has(message.callId))) continue;
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
      try {
        const parsed = finishRoundSchema.safeParse(JSON.parse(call.arguments));
        if (parsed.success) return {title: parsed.data.title, verification: parsed.data.verification, carryForward: parsed.data.carry_forward, source: 'model'};
      } catch {}
    }
  }
  return undefined;
}
