/**
 * Diagnostic handler for SendMessageTool.
 */
export function diagnoseSendMessage(args: Record<string, unknown>, rawError: string): string | undefined {
  const target = String(args.to ?? '');

  if (rawError.includes('Unknown') || rawError.includes('not found') || rawError.includes('invalid target') || rawError.includes('非成员')) {
    return `Cannot deliver message to "${target}". Valid recipient actors are: "techne", "aletheia", "kalon", "logox", or "all". Use ListActors to inspect active companions.`;
  }

  return undefined;
}
