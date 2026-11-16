import type {ModelMessage, ModelTurn, ToolDefinition} from '../runtime/messages.js';
import {requestMarkerTexts, stripMarkers} from './echo-guard.js';
import {recoverTextCalls} from './text-recovery.js';

/**
 * The one step every model turn passes through right after the provider answered, for actors (`src/kernel/model-turn.ts`) and Automa workers
 * (`src/kernel/worker-run.ts`) alike. It only reads the assistant's visible reply text (never reasoning, tool results or user messages):
 * 1. runtime text the model repeated is removed from the reply (`echo-guard.ts`); a reply that was only that, with no tool call, is marked `echo`;
 * 2. when the response has no structured tool call, tools were offered, and the remaining text writes a call to an offered tool, the call is
 *    recovered (`text-recovery.ts`) and the turn becomes an ordinary tool turn (`stop: 'tools'`, `recovered: n`).
 * Markers go first so a call quoted inside echoed runtime text (a file the model was shown) is never run. A turn with nothing to change is returned as is.
 */
export function refineTurn(turn: ModelTurn, request: {readonly tools: readonly ToolDefinition[]; readonly messages: readonly ModelMessage[]}): ModelTurn {
  const original = turn.message.text;
  if (!original.trim()) return turn;
  const calls = turn.message.toolCalls ?? [];
  const stripped = stripMarkers(original, requestMarkerTexts(request.messages));
  let text = stripped.text;
  if (!calls.length && request.tools.length && !stripped.pure) {
    const recovered = recoverTextCalls(text, request.tools);
    if (recovered) return {...turn, stop: 'tools', recovered: recovered.calls.length, message: {...turn.message, text: recovered.text, toolCalls: recovered.calls}};
  }
  if (!stripped.matched) return turn;
  const echo = !calls.length && stripped.pure;
  if (echo) text = '';
  return {...turn, message: {...turn.message, text}, ...(echo ? {echo: true as const} : {})};
}
