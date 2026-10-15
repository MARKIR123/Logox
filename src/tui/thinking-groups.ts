import type {Message, Step} from '../runtime/contracts.js';
import {estimateText} from '../context/budget.js';

export interface ThinkingRequest {
  readonly id: string;
  readonly step: Step;
  readonly tokens: number;
}

/** One request owns one clock and one readable card, including older ungrouped records. */
export function thinkingRequests(messages: readonly Message[]): ReadonlyMap<string, ThinkingRequest> {
  return new Map(messages.filter(message => message.kind === 'thinking').map(message => [message.id, {
    id: message.id, step: message.step ?? {title: 'Thinking', state: 'completed', elapsedMs: 0},
    tokens: estimateText(message.text),
  }]));
}
