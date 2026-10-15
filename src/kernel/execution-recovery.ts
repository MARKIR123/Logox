import {createHash} from 'node:crypto';
import type {ToolCall} from '../runtime/messages.js';
import type {ToolResult} from '../tools/tools.js';

export type ExecutionRecoveryKind = 'no_delivery' | 'truncated_text' | 'truncated_tools';
export type ExecutionRecoveryDecision = 'retry' | 'handoff' | 'stop';

/** 输出结束问题，不属于提供商故障；结束执行后由剧团按原根目标接管。 */
export class ExecutionRecoveryError extends Error {
  constructor(readonly kind: ExecutionRecoveryKind, readonly disposition: 'handoff' | 'stop', message?: string) {
    super(message ?? (kind === 'no_delivery' ? '模型只返回思考或空回复，未交付当前步骤成果'
      : kind === 'truncated_tools' ? '工具参数连续截断，未执行不完整调用' : '模型输出连续截断，已保留部分成果'));
    this.name = 'ExecutionRecoveryError';
  }
}

export function executionRecoveryInstruction(kind: ExecutionRecoveryKind, ownerId: string, adjustment = false): string {
  const next = kind === 'no_delivery'
    ? adjustment && ownerId === 'logox'
      ? '改变下一步行动方案：缩小当前阶段，或把明确的小步交给合适 Actor；先交付具体成果或完整工具调用。'
      : '上一请求只有思考或空回复。缩小当前阶段，只做最小可交付步骤，先提交成果或完整工具调用。'
    : kind === 'truncated_tools'
      ? '上一请求的工具参数被截断，整批调用未执行。提交更小、完整的调用，不重放已成功的工具。'
      : '上一请求输出已满。沿已有正文从断点完成当前小步；不要重复规划、回顾或重新生成已交付内容。';
  return next + '沿用已确认目标、当前阶段和已完成工具结果；不绕过审批拒绝，不提高输出额度或改变模型与思考档位。';
}

const coordinationTools = new Set(['dispatch_role', 'craft_actor', 'read_actor', 'borrow_skill', 'update_task_progress',
  'request_assist', 'approve_assist', 'send_message', 'ask_user', 'ask', 'read_skill', 'list_skills']);

/** 参数 JSON 的属性顺序和格式差异不算新进展，重复读取同一结果也不刷新预算。 */
export function toolProgressFingerprint(call: ToolCall, result: ToolResult): string | undefined {
  if (result.isError || coordinationTools.has(call.name)) return;
  let argumentsValue: unknown;
  try {argumentsValue = JSON.parse(call.arguments);} catch {return;}
  return createHash('sha256').update(JSON.stringify([call.name, canonical(argumentsValue), result.text])).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
