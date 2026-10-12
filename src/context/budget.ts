import {createHash} from 'node:crypto';
import type {ModelRequest, ModelTurn} from '../runtime/messages.js';
import type {ModelCapacity} from './contracts.js';

export function digest(value: unknown): string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function estimateText(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += char.codePointAt(0)! > 0x7f ? 1 : 0.25;
  return Math.ceil(tokens);
}
export function estimateRequest(request: ModelRequest): number {
  return estimateText(request.system) + estimateText(JSON.stringify(request.tools)) + 16 +
    request.messages.reduce((sum, message) => sum + estimateText(JSON.stringify(message)) + 8, 0);
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
/** An anchor belongs to the exact model, rules, tool schemas and projected prefix. */
export class TokenMeter {
  private anchor: {identity: string; prefix: ModelRequest; tokens: number} | undefined;
  readonly spent = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
  estimate(request: ModelRequest, model: ModelCapacity): number {
    const anchor = this.anchor;
    if (anchor?.identity === model.identity && request.messages.length >= anchor.prefix.messages.length &&
      digest({system: request.system, tools: request.tools, messages: request.messages.slice(0, anchor.prefix.messages.length)}) === digest(anchor.prefix)) {
      return anchor.tokens + request.messages.slice(anchor.prefix.messages.length)
        .reduce((sum, message) => sum + estimateText(JSON.stringify(message)) + 8, 0);
    }
    return estimateRequest(request);
  }
  chargeUsage(usage: ModelTurn['usage']): void {
    if (!usage || !Number.isFinite(usage.input + usage.output) || usage.input < 0 || usage.output < 0) return;
    this.spent.input += usage.input; this.spent.output += usage.output;
    this.spent.cacheRead += Math.max(0, usage.cacheRead ?? 0); this.spent.cacheWrite += Math.max(0, usage.cacheWrite ?? 0);
  }
  observe(request: ModelRequest, turn: ModelTurn, model: ModelCapacity): void {
    const usage = turn.usage;
    this.chargeUsage(usage);
    if (!usage || !['complete', 'tools'].includes(turn.stop) || !Number.isFinite(usage.input + usage.output) ||
      usage.input <= 0 || usage.output < 0) {this.anchor = undefined; return;}
    this.anchor = {identity: model.identity, prefix: {system: request.system, tools: request.tools,
      messages: [...request.messages, turn.message]}, tokens: usage.input + usage.output};
  }
  invalidate(): void {this.anchor = undefined;}
}
