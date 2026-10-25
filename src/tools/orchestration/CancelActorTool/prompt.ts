export const CANCEL_ACTOR_TOOL_NAME = 'CancelActor';

export const CANCEL_ACTOR_DESCRIPTION =
  'Intervene and cancel a stuck tool call or an entire activity for a subagent. Scope "tool" kills the currently blocked tool process tree, injects the reason back as an error, and preserves the subagent\'s context to continue self-correction. Scope "activity" terminates the active round.';
