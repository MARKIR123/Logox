export type ExecutionRecoveryKind = 'no_delivery' | 'truncated_text' | 'truncated_tools';

export interface FailedToolReport {
  readonly name: string;
  readonly error: string;
}

/** Guidance appended to the next request when a tool execution or argument validation failed. */
export function toolErrorRecoveryInstruction(failedTools: readonly FailedToolReport[]): string {
  const details = failedTools.map(t => `${t.name} (${t.error.replace(/\s+/g, ' ').trim().slice(0, 140)})`).join('; ');
  return `Previous tool call failed: ${details}.
Diagnose the root cause from the error output before acting.
- Do NOT repeat the exact same call with identical arguments without checking state.
- If a file read or edit failed (e.g. string not found, ambiguous match), use Read to verify current lines and exact content.
- If a command or path failed, check the working directory and verify paths with Glob.
- If arguments failed validation, adjust your call to match the tool schema.`;
}

/** Cross-tool output recovery instructions appended only on retry. */
export function executionRecoveryInstruction(kind: ExecutionRecoveryKind, ownerId: string, adjustment = false): string {
  const next = kind === 'no_delivery'
    ? adjustment && ownerId === 'logox'
      ? 'Pivot the action plan: narrow the current phase or delegate explicit smaller steps to a suitable actor. Deliver concrete artifacts or complete tool calls first.'
      : 'Previous turn returned only thinking or an empty response (output quota exhausted before tools were called). Narrow to the minimum deliverable step, avoid drafting full files in thoughts, and immediately call tools to persist artifacts.'
    : kind === 'truncated_tools'
      ? 'Previous tool arguments were truncated; the entire batch was not executed. Issue smaller, complete tool calls without replaying completed tools.'
      : 'Previous output reached token limits. Continue the current step from the break point using existing text; do not replan or regenerate delivered content.';
  return next + ' Adhere to confirmed goals, active stage, and completed tool results. Do not bypass approval denials or change model effort tiers.';
}
