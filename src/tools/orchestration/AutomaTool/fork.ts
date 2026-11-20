import type {ModelMessage, ModelRequest, Provider} from '../../../runtime/messages.js';
import {FORK_DIRECTIVE, FORK_RESULT_TEXT, FORK_SIBLING_RESULT_TEXT} from './prompt.js';

export type ForkProvider = Pick<Provider, 'respond'> & Partial<Pick<Provider, 'capabilities' | 'resolveCapabilities'>>;
type AssistantMessage = Extract<ModelMessage, {role: 'assistant'}>;

/**
 * The request of an actor's turn that produced a tool call, exactly as it was sent, with the turn it got back. Captured by the kernel when the batch's
 * calls are executed (`src/kernel/tool-batch.ts:runToolBatch()`), never rebuilt, so a fork starts from the very bytes the dispatcher's own next request
 * would extend.
 */
export interface ParentTurn {
  readonly request: ModelRequest;
  /** The assistant message as the ledger holds it (calls and reasoning as the model produced them). */
  readonly message: AssistantMessage;
  /** The provider object that answered this request: same model, same thinking effort. */
  readonly provider: ForkProvider;
  /** The model identity of the dispatcher's task (for usage records); empty when the kernel had none. */
  readonly model: string;
}

/** Everything the jobs of one fork dispatch share: the request frame (system, tools and every other field), the messages that precede the directive, the provider. */
export interface ForkBase {
  /** The parent's request without its messages; `system`, `tools`, `cacheKey` and every option are the parent's, byte for byte. */
  readonly frame: Omit<ModelRequest, 'messages'>;
  /** The parent's messages, its assistant turn and the tool results: identical for every fork of the dispatch. */
  readonly prefix: readonly ModelMessage[];
  readonly provider: ForkProvider;
  readonly model: string;
  /** Images are sent when the parent's request sent them. */
  readonly vision: boolean;
}

/** Fields of the parent's request that only label diagnostics of that actor's own turn; a fork leaves them out (they never reach the provider's cache). */
const DIAGNOSTIC_FIELDS = ['dumpDir', 'fingerprint', 'purpose'] as const;

/**
 * The shared part of every fork of the call `callId`: the parent's request, its assistant message, and a tool result for each of that message's calls: the fixed
 * text for the dispatching call, another fixed text for any sibling call. Pure: the same turn gives the same bytes.
 */
export function forkBase(turn: ParentTurn, callId: string): ForkBase {
  const {messages, ...frame} = turn.request;
  for (const field of DIAGNOSTIC_FIELDS) delete (frame as Record<string, unknown>)[field];
  const results: ModelMessage[] = (turn.message.toolCalls ?? []).map(call => ({role: 'tool', callId: call.id, name: call.name,
    text: call.id === callId ? FORK_RESULT_TEXT : FORK_SIBLING_RESULT_TEXT, isError: false}));
  return {frame, prefix: [...messages, turn.message, ...results], provider: turn.provider, model: turn.model, vision: turn.request.supportsVision !== false};
}

/** The user message that opens one fork: the directive, then the title and the job's own text (brief, scope, acceptance, grant) as a normal job gets it. */
export function forkOpening(title: string, jobText: string): string {
  return FORK_DIRECTIVE + '\n\nTitle: ' + title.replace(/\s+/g, ' ').trim() + '\n\n' + jobText;
}
