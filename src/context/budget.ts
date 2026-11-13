import {z} from 'zod';
import {createHash, randomUUID} from 'node:crypto';
import type {ModelMessage, ModelRequest, ModelTurn} from '../runtime/messages.js';
import type {ModelCapacity} from './contracts.js';
import {extractDiscoveredToolNames, retainDiscoveryPairs} from '../tools/discovery.js';
import {runtimeContextText} from '../runtime/context-updates.js';

export function digest(value: unknown): string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function estimateText(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += char.codePointAt(0)! > 0x7f ? 1 : 0.25;
  return Math.ceil(tokens);
}
/** Shortens text to at most `budget` estimated tokens (same weights as `estimateText`), ending with an ellipsis when it was cut. Never throws. */
export function truncateToTokens(text: string, budget: number): string {
  const value = text.trim();
  if (estimateText(value) <= budget) return value;
  const room = Math.max(0, budget - 1);
  let tokens = 0, end = 0;
  for (const char of value) {
    tokens += char.codePointAt(0)! > 0x7f ? 1 : 0.25;
    if (Math.ceil(tokens) > room) break;
    end += char.length;
  }
  return value.slice(0, end).trimEnd() + '…';
}
/** Estimated tokens of one image, used by every request estimate and by the request fingerprint sizes. */
export const IMAGE_TOKENS = 1200;
function estimateMessage(message: ModelMessage): number {
  if (message.role === 'context') {
    if (message.kind === 'environment-baseline' || message.kind === 'capability-change' && message.data?.baseline === true) return 0;
    return estimateText(runtimeContextText(message)) + 8;
  }
  const images = 'images' in message ? message.images : undefined;
  const textOnly = images?.length ? {...message, images: undefined} : message;
  return estimateText(JSON.stringify(textOnly)) + (images?.length ?? 0) * IMAGE_TOKENS + 8;
}
export function estimateRequest(request: ModelRequest): number {
  const expanded = extractDiscoveredToolNames(retainDiscoveryPairs(request.messages, extractDiscoveredToolNames(request.messages)));
  const tools = request.toolDiscovery ? request.tools.filter(tool => !tool.deferLoading || expanded.has(tool.name))
    .map(({deferLoading: _, ...tool}) => tool) : request.tools;
  return estimateText(request.system) + estimateText(JSON.stringify(tools)) + 16 +
    request.messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}
export interface BudgetPolicy {
  reserve_tokens: number; low_watermark_ratio: number; high_watermark_ratio?: number | undefined;
  max_budget_tokens?: number | undefined; target_budget_tokens?: number | undefined;
}
export function watermarks(model: ModelCapacity, policy: BudgetPolicy) {
  const reserve = Math.min(policy.reserve_tokens, Math.floor(model.window / 4));
  const high = Math.min(Math.max(model.window - reserve, Math.floor(model.window * (policy.high_watermark_ratio ?? 0.8))), policy.max_budget_tokens ?? Infinity);
  const low = Math.min(Math.floor(model.window * policy.low_watermark_ratio), policy.target_budget_tokens ?? Infinity, high - 1);
  return {high, low, safety: Math.max(16, Math.min(128, Math.floor(model.window / 32)))};
}
export const usageRecordSchema = z.strictObject({id: z.string().min(1), model: z.string(), category: z.enum(['task', 'summary', 'approval', 'automa', 'keepalive']),
  input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative(),
  /** Part of `cacheWrite` stored with the 1-hour lifetime (billed at 2x instead of 1.25x). */
  cacheWrite1h: z.number().finite().nonnegative().optional()})
  .refine(record => record.cacheRead + record.cacheWrite <= record.input, 'Cache usage cannot exceed total input')
  .refine(record => (record.cacheWrite1h ?? 0) <= record.cacheWrite, 'One-hour cache writes cannot exceed cache writes');
export type UsageRecord = z.infer<typeof usageRecordSchema>;
/** An anchor belongs to the exact model, rules, tool schemas and projected prefix. */
export class TokenMeter {
  private anchor: {identity: string; prefix: ModelRequest; tokens: number} | undefined;
  readonly spent = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
  private records: UsageRecord[] = [];
  private summaryModel: () => string = () => 'unknown';
  private onCharge: (record: UsageRecord) => void = () => {};
  configureUsage(summaryModel: () => string, onCharge: (record: UsageRecord) => void, restored: readonly UsageRecord[] = []): void {
    this.summaryModel = summaryModel; this.onCharge = onCharge;
    if (this.records.length) throw new Error('Usage can only be restored before the first request');
    for (const record of restored) {this.records.push({...record}); this.add(record);}
  }
  usageRecords(): readonly UsageRecord[] {return this.records.map(record => ({...record}));}
  private add(usage: Pick<UsageRecord, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): void {
    this.spent.input += usage.input; this.spent.output += usage.output;
    this.spent.cacheRead += usage.cacheRead; this.spent.cacheWrite += usage.cacheWrite;
  }
  /** True when the request extends the provider-anchored prefix, so its token count rests on reported usage. */
  anchored(request: ModelRequest, model: ModelCapacity): boolean {
    const anchor = this.anchor;
    return !!anchor && anchor.identity === model.identity && request.messages.length >= anchor.prefix.messages.length &&
      digest({system: request.system, tools: request.tools, ...(request.toolDiscovery ? {toolDiscovery: request.toolDiscovery} : {}), messages: request.messages.slice(0, anchor.prefix.messages.length)}) === digest(anchor.prefix);
  }
  estimate(request: ModelRequest, model: ModelCapacity): number {
    const anchor = this.anchor;
    if (anchor?.identity === model.identity && request.messages.length >= anchor.prefix.messages.length &&
      digest({system: request.system, tools: request.tools, ...(request.toolDiscovery ? {toolDiscovery: request.toolDiscovery} : {}), messages: request.messages.slice(0, anchor.prefix.messages.length)}) === digest(anchor.prefix)) {
      return anchor.tokens + request.messages.slice(anchor.prefix.messages.length)
        .reduce((sum, message) => sum + estimateMessage(message), 0);
    }
    return estimateRequest(request);
  }
  chargeUsage(usage: ModelTurn['usage'], model = this.summaryModel(), category: UsageRecord['category'] = 'summary'): void {
    if (!usage || !Number.isFinite(usage.input + usage.output) || usage.input < 0 || usage.output < 0) return;
    const cacheRead = usage.cacheRead ?? 0, cacheWrite = usage.cacheWrite ?? 0;
    if (![cacheRead, cacheWrite].every(value => Number.isFinite(value) && value >= 0) || cacheRead + cacheWrite > usage.input) return;
    const oneHour = usage.cacheWrite1h ?? 0;
    if (!Number.isFinite(oneHour) || oneHour < 0 || oneHour > cacheWrite) return;
    const record = {id: randomUUID(), model, category, input: usage.input, output: usage.output, cacheRead, cacheWrite, ...(oneHour > 0 ? {cacheWrite1h: oneHour} : {})};
    this.records.push(record); this.add(record); this.onCharge({...record});
  }
  observe(request: ModelRequest, turn: ModelTurn, model: ModelCapacity): void {
    const usage = turn.usage;
    this.chargeUsage(usage, model.identity, 'task');
    if (!usage || !['complete', 'tools'].includes(turn.stop) || !Number.isFinite(usage.input + usage.output) ||
      usage.input <= 0 || usage.output < 0) {this.anchor = undefined; return;}
    this.anchor = {identity: model.identity, prefix: {system: request.system, tools: request.tools,
      ...(request.toolDiscovery ? {toolDiscovery: request.toolDiscovery} : {}),
      messages: [...request.messages, turn.message]}, tokens: usage.input + usage.output};
  }
  invalidate(): void {this.anchor = undefined;}
}
