/**
 * Diagnostic handler for WriteTool.
 */
export function diagnoseWrite(args: Record<string, unknown>, rawError: string): string | undefined {
  const filePath = String(args.file_path ?? args.path ?? 'file');

  if (rawError.includes('EISDIR') || rawError.includes('is a directory')) {
    return `Path "${filePath}" is a directory. Specify a full file path including filename.`;
  }

  if (rawError.includes('EACCES') || rawError.includes('EPERM') || rawError.includes('Permission denied')) {
    return `Permission denied writing to "${filePath}". Check directory access permissions or whether the file is locked by another process.`;
  }

  if (rawError.includes('ENOENT') || rawError.includes('no such file')) {
    return `Cannot write to "${filePath}" because parent directory does not exist. Verify the path structure before retrying.`;
  }

  return undefined;
}
