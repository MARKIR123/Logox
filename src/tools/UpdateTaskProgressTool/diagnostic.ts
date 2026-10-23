/**
 * Diagnostic handler for UpdateTaskProgressTool.
 */
export function diagnoseUpdateTaskProgress(args: Record<string, unknown>, rawError: string): string | undefined {
  if (rawError.includes('阶段不存在') || rawError.includes('Phase not found')) {
    return `${rawError} Use an existing phase ID or title, or register a new phase via stages.`;
  }

  if (rawError.includes('完成阶段必须报告实际成果') || rawError.includes('requires a concrete result')) {
    return `Cannot complete phase without reporting results. Call UpdateTaskProgress with update: { id: "...", status: "completed", result: "Describe what was accomplished..." }.`;
  }

  if (rawError.includes('取消阶段必须说明原因') || rawError.includes('requires a cancellation reason')) {
    return `Cannot skip phase without specifying reason. Call UpdateTaskProgress with update: { id: "...", status: "skipped", reason: "Explain why phase is skipped..." }.`;
  }

  return undefined;
}
