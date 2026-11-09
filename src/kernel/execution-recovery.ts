import {createHash} from 'node:crypto';
import type {ToolCall} from '../runtime/messages.js';
import {canonicalToolName} from '../tools/types.js';
import type {ToolResult} from '../tools/tools.js';

export type ExecutionRecoveryKind = 'no_delivery' | 'truncated_text' | 'truncated_tools' | 'text_tool_call';
export type ExecutionRecoveryDecision = 'retry' | 'handoff' | 'stop';

/** Output-ending problems are not provider failures; after execution ends, the ensemble takes over under the original root goal. */
export class ExecutionRecoveryError extends Error {
  constructor(readonly kind: ExecutionRecoveryKind, readonly disposition: 'handoff' | 'stop', message?: string) {
    super(message ?? (kind === 'no_delivery' ? 'Model returned only thinking or an empty reply and delivered nothing for the current step'
      : kind === 'text_tool_call' ? 'The model repeatedly wrote tool calls as plain text; nothing was executed'
      : kind === 'truncated_tools' ? 'Tool arguments were truncated repeatedly; incomplete calls were not executed' : 'Model output was truncated repeatedly; partial results were kept'));
    this.name = 'ExecutionRecoveryError';
  }
}

export {executionRecoveryInstruction} from '../prompts/runtime/recovery.js';

const coordinationTools = new Set(['dispatch_role', 'craft_actor', 'read_actor',
  'SendMessage', 'ask_user', 'ask', 'read_skill', 'list_skills']);

/** Differences in argument JSON key order or formatting do not count as new progress, and re-reading the same result does not refresh the budget. */
export function toolProgressFingerprint(call: ToolCall, result: ToolResult): string | undefined {
  if (result.isError || coordinationTools.has(call.name) || coordinationTools.has(canonicalToolName(call.name) ?? call.name)) return;
  let argumentsValue: unknown;
  try {argumentsValue = JSON.parse(call.arguments);} catch {return;}
  return createHash('sha256').update(JSON.stringify([call.name, canonicalJson(argumentsValue), result.text])).digest('hex');
}

export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}
