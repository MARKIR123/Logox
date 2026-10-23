/**
 * Diagnostic handler for GrepTool.
 */
export function diagnoseGrep(args: Record<string, unknown>, rawError: string): string | undefined {
  const pattern = String(args.pattern ?? '');

  if (rawError.includes('No matches found') || rawError.includes('0 matches')) {
    return `No matches found for pattern "${pattern}". Do NOT repeat identical search. Check file extensions, broaden regex pattern, or try case-insensitive search with -i: true.`;
  }

  if (rawError.includes('regex parse error') || rawError.includes('syntax error') || rawError.includes('unclosed')) {
    return `Invalid regular expression pattern "${pattern}". Note that ripgrep requires escaping literal braces (e.g. \\{\\}). Fix regex syntax before retrying.`;
  }

  return undefined;
}
