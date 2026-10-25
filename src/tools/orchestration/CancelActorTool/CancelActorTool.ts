import {z} from 'zod';
import type {ToolResult} from '../../types.js';

export const cancelActorSchema = z.strictObject({
  actor: z.string().min(1).describe('Target actor name: "techne", "kalon", or "aletheia"'),
  scope: z.enum(['tool', 'activity']).describe('Scope of cancellation: "tool" to abort only the currently stuck tool command, "activity" to cancel the whole round'),
  tool_id: z.string().optional().describe('Optional specific tool call ID to abort (defaults to current running tool)'),
  reason: z.string().trim().min(1).max(2000).describe('Specific reason for cancellation, passed to the actor so it knows why the tool was terminated'),
});

export type CancelActorArgs = z.infer<typeof cancelActorSchema>;

export function executeCancelActor(
  args: CancelActorArgs,
  context: {
    caller: string;
    cancelTool: (actorId: string, toolId?: string, reason?: string) => {success: boolean; message: string};
    cancelActivity: (actorId: string, reason?: string) => {success: boolean; message: string};
  },
): ToolResult {
  if (context.caller !== 'logox' && context.caller !== 'director') {
    return {
      text: 'Permission denied: Only Director Logox has authority to cancel actor execution.',
      isError: true,
      disposition: 'denied',
    };
  }

  const {actor, scope, tool_id, reason} = args;

  if (scope === 'tool') {
    const outcome = context.cancelTool(actor, tool_id, reason);
    return {
      text: outcome.message,
      isError: !outcome.success,
    };
  }

  if (scope === 'activity') {
    const outcome = context.cancelActivity(actor, reason);
    return {
      text: outcome.message,
      isError: !outcome.success,
    };
  }

  return {
    text: `Unsupported cancellation scope: ${scope}`,
    isError: true,
  };
}
