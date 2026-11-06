import type {ModelMessage, ModelRequest} from '../runtime/messages.js';
import {runtimeContextText} from '../runtime/context-updates.js';

/** Where the tokens of one request come from, in display order. */
export const contextCategories = ['system', 'prompt', 'assistant', 'thinking', 'tools'] as const;
export type ContextCategory = typeof contextCategories[number];
/** Whole tokens per category; the parts always sum to the accurate context total they were allocated from. */
export type ContextBreakdown = Readonly<Record<ContextCategory, number>>;

/** CJK-aware local estimate used only as a relative weight: ASCII about 1/4 token per char, CJK about 1/1.4, anything else 1/2. */
export function weightText(text: string): number {
  let weight = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    weight += code <= 0x7f ? 0.25
      : (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x2fa1f) ? 1 / 1.4 : 0.5;
  }
  return weight;
}
const IMAGE_WEIGHT = 1200;
function imageWeight(message: ModelMessage): number {return 'images' in message && message.images ? message.images.length * IMAGE_WEIGHT : 0;}

/** Local estimates per category for one request (system prompt and tool schemas count as system). */
export function categoryWeights(request: Pick<ModelRequest, 'system' | 'tools' | 'messages'>, extra: readonly ModelMessage[] = []): Record<ContextCategory, number> {
  const weights: Record<ContextCategory, number> = {system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0};
  weights.system = weightText(request.system) + weightText(JSON.stringify(request.tools.filter(tool => !tool.deferLoading)));
  for (const message of [...request.messages, ...extra]) {
    if (message.role === 'context') weights.prompt += weightText(runtimeContextText(message));
    else if (message.role === 'user') weights.prompt += weightText(message.text) + imageWeight(message);
    else if (message.role === 'assistant') {
      weights.assistant += weightText(message.text) + (message.toolCalls ?? []).reduce((sum, call) => sum + weightText(call.name) + weightText(call.arguments), 0);
      weights.thinking += weightText(message.reasoning ?? '');
    } else weights.tools += weightText(message.name) + weightText(message.text) + imageWeight(message);
  }
  return weights;
}

/** Largest-remainder allocation: whole numbers that sum exactly to `total`, in proportion to `weights`. Undefined when there is nothing to split. */
export function allocateContext(total: number, weights: Readonly<Record<ContextCategory, number>>): ContextBreakdown | undefined {
  const whole = Math.round(total), sum = contextCategories.reduce((acc, key) => acc + Math.max(0, weights[key]), 0);
  if (!Number.isFinite(whole) || whole <= 0 || !(sum > 0)) return undefined;
  const shares = contextCategories.map(key => {
    const exact = Math.max(0, weights[key]) / sum * whole;
    return {key, base: Math.floor(exact), rest: exact - Math.floor(exact)};
  });
  let left = whole - shares.reduce((acc, item) => acc + item.base, 0);
  for (const item of [...shares].sort((a, b) => b.rest - a.rest)) {if (left <= 0) break; item.base++; left--;}
  return Object.fromEntries(shares.map(item => [item.key, item.base])) as ContextBreakdown;
}
