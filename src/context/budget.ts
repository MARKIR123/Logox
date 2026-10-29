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
function estimateMessage(message: ModelMessage): number {
  if (message.role === 'context') {
    if (message.kind === 'environment-baseline' || message.kind === 'capability-change' && message.data?.baseline === true) return 0;
    return estimateText(runtimeContextText(message)) + 8;
  }
  const images = 'images' in message ? message.images : undefined;
  const textOnly = images?.length ? {...message, images: undefined} : message;
  return estimateText(JSON.stringify(textOnly)) + (images?.length ?? 0) * 1200 + 8;
}
export function estimateRequest(request: ModelRequest): number {
  const expanded = extractDiscoveredToolNames(retainDiscoveryPairs(request.messages, extractDiscoveredToolNames(request.messages)));
  const tools = request.toolDiscovery ? request.tools.filter(tool => !tool.deferLoading || expanded.has(tool.name))
    .map(({deferLoading: _, ...tool}) => tool) : request.tools;
  return estimateText(request.system) + estimateText(JSON.stringify(tools)) + 16 +
    request.messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}
export interface BudgetPolicy {
  reserve_tokens: number; low_watermark_ratio: number;
  max_budget_tokens?: number | undefined; target_budget_tokens?: number | undefined;
}
export function watermarks(model: ModelCapacity, policy: BudgetPolicy) {
  const reserve = Math.min(policy.reserve_tokens, Math.floor(model.window / 4));
  const high = Math.min(model.window - reserve, policy.max_budget_tokens ?? Infinity);
  const low = Math.min(Math.floor(model.window * policy.low_watermark_ratio), policy.target_budget_tokens ?? Infinity, high - 1);
  return {high, low, safety: Math.max(16, Math.min(128, Math.floor(model.window / 32)))};
}
export const usageRecordSchema = z.strictObject({id: z.string().min(1), model: z.string(), category: z.enum(['task', 'summary', 'approval']),
  input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative()}).refine(record => record.cacheRead + record.cacheWrite <= record.input, '缓存用量不能超过总输入');
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
    if (this.records.length) throw new Error('用量只能在首次请求前恢复');
    for (const record of restored) {this.records.push({...record}); this.add(record);}
  }
  usageRecords(): readonly UsageRecord[] {return this.records.map(record => ({...record}));}
  private add(usage: Pick<UsageRecord, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): void {
    this.spent.input += usage.input; this.spent.output += usage.output;
    this.spent.cacheRead += usage.cacheRead; this.spent.cacheWrite += usage.cacheWrite;
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
    const record = {id: randomUUID(), model, category, input: usage.input, output: usage.output, cacheRead, cacheWrite};
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
