import type {ActorContext, ActorExecutor} from '../actors/ensemble.js';
import type {Config} from '../config/config.js';
import type {ToolCall} from '../runtime/messages.js';
import {Resources, type ResourceOptions} from '../resources/manager.js';
import {Tools, type ToolResult} from '../tools/tools.js';
import {Hooks} from './hooks.js';
import {Mcp, type ExtensionApproval} from './mcp.js';

/** 项目级拥有者，可传给重建后的会话；仅最终项目关闭时 close。 */
export class ProjectExtensions {
  readonly resources: Resources;
  readonly mcp: Mcp;
  readonly hooks: Hooks;
  constructor(cwd: string, config: Config, options: ResourceOptions = {}, approve?: ExtensionApproval,
    diagnose?: (text: string) => void) {
    this.resources = new Resources(cwd, options);
    this.mcp = new Mcp(cwd, config.mcp.servers, approve);
    this.hooks = new Hooks(cwd, config.hooks, diagnose, options.home);
  }
  async initialize(): Promise<void> {await Promise.all([this.resources.reload(), this.hooks.initialize()]);}
  async close(): Promise<void> {await Promise.all([this.mcp.close(), this.hooks.close()]);}
}
export function observeTools(tools: Tools, hooks: Hooks): Tools {
  const execute = tools.execute.bind(tools);
  tools.execute = async (call, context) => {
    const result = await execute(call, context);
    observeTool(hooks, call, context, result); return result;
  };
  return tools;
}
export function observeTool(hooks: Hooks, call: ToolCall, context: ActorContext, result: ToolResult): void {
  hooks.emit('post_tool_use', {session_id: context.sessionId, activity_id: context.activityId,
    owner_id: context.ownerId, call_id: call.id, tool: call.name, ok: !result.isError});
}
export function observeExtra(hooks: Hooks, execute: (call: ToolCall, context: ActorContext) => Promise<ToolResult>) {
  return async (call: ToolCall, context: ActorContext): Promise<ToolResult> => {
    const result = await execute(call, context); observeTool(hooks, call, context, result); return result;
  };
}
export function observeTasks<Id extends string>(hooks: Hooks, execute: ActorExecutor<Id>): ActorExecutor<Id> {
  return async (prompt, context) => {
    let ok = false;
    try {await execute(prompt, context); ok = true;}
    finally {hooks.emit('stop', {session_id: context.sessionId, activity_id: context.activityId,
      owner_id: context.ownerId, ok, cancelled: context.signal.aborted});}
  };
}
