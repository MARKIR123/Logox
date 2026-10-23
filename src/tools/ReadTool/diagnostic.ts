/**
 * Diagnostic handler for ReadTool.
 */
export function diagnoseRead(args: Record<string, unknown>, rawError: string): string | undefined {
  const filePath = String(args.file_path ?? args.path ?? 'file');

  if (rawError.includes('ENOENT') || rawError.includes('File not found') || rawError.includes('no such file')) {
    return `File "${filePath}" does not exist. Call Glob to locate the actual file path before retrying. Do not guess file names.`;
  }

  if (rawError.includes('exceeds 32 MiB') || rawError.includes('File exceeds') || rawError.includes('too large')) {
    return `File "${filePath}" exceeds single read limit. Call Read("${filePath}", offset, limit) to inspect specific chunks, or use Grep to locate target definitions.`;
  }

  if (rawError.includes('EISDIR') || rawError.includes('is a directory')) {
    return `Path "${filePath}" is a directory, not a file. Call Glob with pattern to inspect directory contents.`;
  }

  if (rawError.includes('Binary') || rawError.includes('UTF-16')) {
    return `File "${filePath}" appears to be binary. Use Shell or specialized tools to inspect binary file contents.`;
  }

  return undefined;
}
