/**
 * Diagnostic handler for GlobTool.
 */
export function diagnoseGlob(args: Record<string, unknown>, rawError: string): string | undefined {
  const pattern = String(args.pattern ?? '');

  if (rawError.includes('No files found') || rawError.includes('0 files') || rawError.includes('0 file matches')) {
    return `No files matched pattern "${pattern}". Verify the target directory path or use a broader pattern (e.g. "**/*needle*") to locate files.`;
  }

  return undefined;
}
