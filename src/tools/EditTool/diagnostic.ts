/**
 * Diagnostic handler for EditTool.
 * Transforms low-level match errors into actionable two-part guidance:
 * [Error Context]. [Actionable Prescription].
 */
export function diagnoseEdit(args: Record<string, unknown>, rawError: string): string | undefined {
  const filePath = String(args.file_path ?? args.path ?? 'file');
  const oldString = String(args.old_string ?? args.old_text ?? '');
  const preview = oldString.length > 60 ? oldString.slice(0, 57).replace(/\s+/g, ' ') + '...' : oldString.replace(/\s+/g, ' ');

  if (rawError.includes('String to replace not found') || rawError.includes('not found in file') || rawError.includes('could not find')) {
    return `String "${preview}" not found in file "${filePath}". Call Read("${filePath}") on surrounding lines to verify current indentation and exact characters before retrying. Do not guess.`;
  }

  const multiMatch = /Multiple matches found.*?\((\d+)\)/i.exec(rawError) || /Found (\d+) matches/i.exec(rawError);
  if (multiMatch || rawError.includes('Multiple matches')) {
    const count = multiMatch ? multiMatch[1] : 'multiple';
    return `Found ${count} matches for "${preview}" in "${filePath}". Include 2-4 surrounding lines of context in old_string to make it uniquely identifiable, or set replace_all: true if intended.`;
  }

  if (rawError.includes('Binary') || rawError.includes('UTF-16')) {
    return `Cannot edit binary or UTF-16 file "${filePath}". Use specialized scripts or commands to handle non-UTF-8 files.`;
  }

  return undefined;
}
