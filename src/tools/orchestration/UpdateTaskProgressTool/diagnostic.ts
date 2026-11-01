/** Tool-local guidance for obsolete milestone arguments and invalid activity labels. */
export function diagnoseUpdateTaskProgress(args: Record<string, unknown>, rawError: string): string | undefined {
  if (rawError.includes('Parameter validation failed')) {
    return `${rawError} Supply a short, single-line label and optional detail; omit stages, status, result, and reason.`;
  }
  if (rawError.includes('Activity has ended')) {
    return `${rawError} Deliver the report without another progress update.`;
  }
  return undefined;
}
