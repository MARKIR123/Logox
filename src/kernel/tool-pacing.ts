import {AUTOMA_STREAK_NOTE} from '../prompts/runtime/recovery.js';
import type {ToolCall} from '../runtime/messages.js';
import {isReadOnlyTool} from '../tools/catalog.js';
import type {ToolResult} from '../tools/tools.js';

/** Consecutive read-only calls before the single Automa reminder of a run. */
export const AUTOMA_STREAK = 6;


/** Watches one agent run's tool calls: a model that never thinks of Automa gets one reminder at the moment it would help. */
export class ToolPacing {
  private streak = 0;
  private reminded = false;

  /** Returns a request-only note for the model's next request, if any. A waiting Director never gets one. */
  observe(call: ToolCall, result: ToolResult, state: {readonly directorWaiting: boolean; readonly automaOffered: boolean}): string | undefined {
    if (!isReadOnlyTool(call.name)) { this.streak = 0; return; }
    if (result.isError || state.directorWaiting) return;
    if (++this.streak < AUTOMA_STREAK || this.reminded || !state.automaOffered) return;
    this.reminded = true;
    return AUTOMA_STREAK_NOTE;
  }
}
