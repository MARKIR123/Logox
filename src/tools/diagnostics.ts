import type {ToolCall} from '../runtime/messages.js';
import type {ToolResult} from './types.js';
import {canonicalToolName} from './types.js';
import {diagnoseEdit} from './EditTool/diagnostic.js';
import {diagnoseRead} from './ReadTool/diagnostic.js';
import {diagnoseWrite} from './WriteTool/diagnostic.js';
import {diagnoseShell} from './ShellTool/diagnostic.js';
import {diagnoseGrep} from './GrepTool/diagnostic.js';
import {diagnoseGlob} from './GlobTool/diagnostic.js';
import {diagnoseUpdateTaskProgress} from './orchestration/UpdateTaskProgressTool/diagnostic.js';
import {diagnoseMcp} from '../extensions/diagnostic.js';
import {diagnoseSendMessage} from './coordination/SendMessageTool/diagnostic.js';

export type DiagnosticFn = (args: Record<string, unknown>, rawError: string) => string | undefined;

export const diagnosticHandlers: Record<string, DiagnosticFn> = {
  Edit: diagnoseEdit,
  Read: diagnoseRead,
  Write: diagnoseWrite,
  Shell: diagnoseShell,
  Grep: diagnoseGrep,
  Glob: diagnoseGlob,
  UpdateTaskProgress: diagnoseUpdateTaskProgress,
  SendMessage: diagnoseSendMessage,
  mcp: diagnoseMcp,
};

/** The missing path: a path argument, else the quoted path the OS error names (`open 'x'`, `cannot access 'x'`); undefined when neither is known. */
export function missingPath(args: Record<string, unknown>, rawError: string): string | undefined {
  const argument = String(args.file_path ?? args.path ?? '').trim();
  if (argument) return argument;
  const quoted = /(?:open|stat|scandir|lstat|access|unlink|mkdir|rmdir|rename|copyfile|readdir|chdir|cannot access|cannot find path)\s*,?\s*['"`]([^'"`\r\n]+)['"`]/i.exec(rawError)
    ?? /['"`]([^'"`\r\n]+)['"`][^\r\n]*(?:ENOENT|no such file or directory)/i.exec(rawError);
  return quoted?.[1]?.trim() || undefined;
}

/**
 * Enriches tool errors with clean, two-part actionable self-healing guidance:
 * [Error Context]. [Actionable Prescription].
 */
export function diagnoseToolError(call: ToolCall, result: ToolResult): ToolResult {
  if (!result.isError) return result;

  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments);
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
  } catch {}

  // Direct MCP names (mcp__<server>__<tool>) share the generic `mcp` handler.
  const direct = /^mcp__(.+?)__(.+)$/.exec(call.name);
  if (direct) args = {...args, __server: direct[1], __tool: direct[2]};
  const canonical = direct ? 'mcp' : canonicalToolName(call.name) ?? call.name;
  const handler = diagnosticHandlers[canonical];

  // 1. Tool-specific diagnostic recipe
  if (handler) {
    const prescription = handler(args, result.text);
    if (prescription) {
      return {...result, text: prescription};
    }
  }

  // 2. Generic Zod parameter validation enhancement
  if (result.text.includes('Parameter validation failed')) {
    return {
      ...result,
      text: `${result.text}. Check the ${call.name} tool schema and supply the required parameters with correct types.`,
    };
  }

  // 3. Generic OS I/O error enhancement (ENOENT, EISDIR, EACCES)
  if (result.text.includes('ENOENT') || result.text.includes('no such file or directory')) {
    const targetPath = missingPath(args, result.text);
    return {
      ...result,
      text: `${targetPath ? `File or path "${targetPath}"` : 'A file or path named in the error'} does not exist. Call Glob to locate the actual path before retrying. Do not guess file names.`,
    };
  }

  return result;
}
