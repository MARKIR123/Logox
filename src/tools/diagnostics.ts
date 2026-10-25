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
};

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

  const canonical = canonicalToolName(call.name) ?? call.name;
  const handler = diagnosticHandlers[canonical];

  // 1. Tool-specific diagnostic recipe
  if (handler) {
    const prescription = handler(args, result.text);
    if (prescription) {
      return {...result, text: prescription};
    }
  }

  // 2. Generic Zod parameter validation enhancement
  if (result.text.includes('Parameter validation failed') || result.text.includes('参数校验失败')) {
    return {
      ...result,
      text: `${result.text}. Check the ${call.name} tool schema and supply the required parameters with correct types.`,
    };
  }

  // 3. Generic OS I/O error enhancement (ENOENT, EISDIR, EACCES)
  if (result.text.includes('ENOENT') || result.text.includes('no such file or directory')) {
    const targetPath = String(args.file_path ?? args.path ?? '');
    return {
      ...result,
      text: `File or path "${targetPath || 'target'}" does not exist. Call Glob to locate the actual path before retrying. Do not guess file names.`,
    };
  }

  return result;
}
