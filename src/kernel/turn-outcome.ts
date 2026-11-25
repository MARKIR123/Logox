import type {ModelTurn} from '../runtime/messages.js';
import {textToolCallName} from './text-tool-call.js';

/** The part of a model turn the classification reads. */
export interface TurnShape {
  readonly stop: ModelTurn['stop'];
  readonly message: {readonly text: string; readonly toolCalls?: readonly {readonly name: string; readonly arguments: string}[] | undefined};
  /** The reply was only runtime text the model repeated (`turn-refine.ts`); its text is already empty. */
  readonly echo?: true | undefined;
}

export interface TurnFacts {
  /** This request was the closing follow-up, which asks only for the round's synopsis. */
  readonly closing: boolean;
  /** A peer reply is awaited, this actor still owes a reply, or results of its background Automa jobs are outstanding (`PeerWait.pending`). */
  readonly peerPending: boolean;
  /** A Director with dispatched work still open. */
  readonly directorWaiting: boolean;
  /** Tools offered in this request; only these count when a call is written as text. */
  readonly offered: readonly {readonly name: string}[];
}

/**
 * What one model turn is, in the order the loop tests it (earlier kinds win):
 * - `closing_with_calls`: the closing follow-up came back with calls; none runs. `truncated` as for `tools`.
 * - `tools`: a business tool batch; `truncated` when the stop was not `tools` or an argument is not JSON.
 * - `text_tool_call`: a call written as plain text; nothing ran.
 * - `echo`: the reply only repeated runtime text; nothing is delivered and the loop continues with a reminder.
 * - `closing_reply`: the closing follow-up came back without calls (with or without the synopsis).
 * - `empty_awaiting_peer`: empty reply while a peer wait is pending or a reply is owed.
 * - `empty_director_waiting`: empty reply from a Director waiting on companions.
 * - `no_delivery`: empty reply otherwise (stop `complete` or `length`).
 * - `truncated_text`: text cut off by the output limit.
 * - `delivered`: complete text.
 * - `abnormal_stop`: stop `tools` without calls, or `other`.
 */
export type TurnOutcome =
  | {readonly kind: 'closing_with_calls'; readonly truncated: boolean}
  | {readonly kind: 'tools'; readonly truncated: boolean}
  | {readonly kind: 'text_tool_call'}
  | {readonly kind: 'echo'}
  | {readonly kind: 'closing_reply'}
  | {readonly kind: 'empty_awaiting_peer'}
  | {readonly kind: 'empty_director_waiting'}
  | {readonly kind: 'no_delivery'}
  | {readonly kind: 'truncated_text'}
  | {readonly kind: 'delivered'}
  | {readonly kind: 'abnormal_stop'};

/** A call serialized as plain text executed nothing. */
export function isTextToolCall(turn: TurnShape, closing: boolean, offered: readonly {readonly name: string}[]): boolean {
  return turn.stop === 'complete' && !turn.message.toolCalls?.length && !closing && !!textToolCallName(turn.message.text, offered);
}

const unparsable = (call: {readonly arguments: string}): boolean => {
  try {JSON.parse(call.arguments); return false;} catch {return true;}
};

export function classifyTurn(turn: TurnShape, facts: TurnFacts): TurnOutcome {
  const calls = turn.message.toolCalls ?? [];
  const truncated = turn.stop !== 'tools' || calls.some(unparsable);
  if (facts.closing && calls.length) return {kind: 'closing_with_calls', truncated};
  if (calls.length) return {kind: 'tools', truncated};
  if (isTextToolCall(turn, facts.closing, facts.offered)) return {kind: 'text_tool_call'};
  if (turn.echo && !facts.closing) return {kind: 'echo'};
  if (facts.closing) return {kind: 'closing_reply'};
  const empty = !turn.message.text.trim();
  if (turn.stop === 'complete' && empty && facts.peerPending) return {kind: 'empty_awaiting_peer'};
  if (turn.stop === 'complete' && empty && facts.directorWaiting) return {kind: 'empty_director_waiting'};
  if (empty && (turn.stop === 'complete' || turn.stop === 'length')) return {kind: 'no_delivery'};
  if (turn.stop === 'length') return {kind: 'truncated_text'};
  if (turn.stop === 'complete') return {kind: 'delivered'};
  return {kind: 'abnormal_stop'};
}
