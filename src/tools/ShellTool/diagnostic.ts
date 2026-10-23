/**
 * Diagnostic handler for ShellTool.
 */
export function diagnoseShell(args: Record<string, unknown>, rawError: string): string | undefined {
  const command = String(args.command ?? '').trim();
  const firstCmd = command.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, '') ?? '';
  const isWindows = process.platform === 'win32';

  // Command not found (Exit 127 or PowerShell not recognized)
  if (
    rawError.includes('127') ||
    rawError.includes('is not recognized as the name of a cmdlet') ||
    rawError.includes('command not found') ||
    rawError.includes('not found: command')
  ) {
    return `Command "${firstCmd}" is not installed or not recognized in PATH. Use built-in tools (Read, Grep, or a Node.js script) instead of retrying the missing command.`;
  }

  // Windows PowerShell cross-platform syntax traps
  if (isWindows) {
    if (command.startsWith('export ') || /\bexport\s+[A-Za-z_]/.test(command)) {
      return `Current shell is Windows PowerShell. Set environment variables with $env:VAR = 'val' instead of export.`;
    }
    if (command.startsWith('source ') || /\bsource\s+/.test(command)) {
      return `Current shell is Windows PowerShell. Run scripts directly with .\\script.ps1 instead of source.`;
    }
    if (/\bcat\b.*\|\s*\bgrep\b/.test(command)) {
      return `Current shell is Windows PowerShell. Use Grep tool for content searching and Read tool for inspecting files instead of cat | grep.`;
    }
  }

  // Timeout
  if (rawError.includes('timed out') || rawError.includes('timeout') || rawError.includes('TIMEOUT')) {
    const timeout = args.timeout ? `${args.timeout}ms` : 'configured timeout';
    return `Command execution timed out after ${timeout}. Do NOT rerun identical command in a loop. Check if the process requires interactive input or split the task.`;
  }

  // Git hook rejection
  if (rawError.includes('pre-commit hook') || rawError.includes('hook failed') || rawError.includes('hook declined')) {
    return `Git hook rejected the action. Inspect the linter/test errors printed above, fix the issues in code with Edit, and create a new commit.`;
  }

  return undefined;
}
