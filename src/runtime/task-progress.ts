import {z} from 'zod';
import type {ActorContext} from '../actors/ensemble.js';
import type {ToolResult} from '../tools/tools.js';
import {currentTaskProgress, immutable, taskProgressSchema, type ActivityProgress} from './contracts.js';
import type {ToolDefinition} from './messages.js';
import type {RuntimeStore} from './store.js';
import {updateTaskProgressSchema} from '../tools/orchestration/UpdateTaskProgressTool/UpdateTaskProgressTool.js';
import {UPDATE_TASK_PROGRESS_DESCRIPTION, UPDATE_TASK_PROGRESS_TOOL_NAME} from '../tools/orchestration/UpdateTaskProgressTool/prompt.js';

export const taskProgressTool: ToolDefinition = {
  name: UPDATE_TASK_PROGRESS_TOOL_NAME,
  description: UPDATE_TASK_PROGRESS_DESCRIPTION,
  parameters: z.toJSONSchema(updateTaskProgressSchema, {io: 'input'}),
};

/** Optional actor-authored activity label; runtime owns execution and acceptance status. */
export class TaskProgress {
  private value: ActivityProgress | undefined;
  constructor(private readonly store: RuntimeStore, private readonly context: ActorContext) {
    const current = currentTaskProgress(context.progress ? taskProgressSchema.parse(context.progress) : undefined);
    this.value = current ? immutable(current) : undefined;
  }
  snapshot(): ActivityProgress | undefined {return this.value;}
  instruction(): string {
    return this.value ? 'Current activity label (self-reported, not verification): ' + this.value.label +
      (this.value.detail ? '\n' + this.value.detail : '') : '';
  }
  private assertActive(): void {
    this.context.signal.throwIfAborted();
    const activity = this.store.activities.get(this.context.sessionId, this.context.activityId);
    if (activity && ['completed', 'failed', 'cancelled'].includes(activity.status)) {
      throw new Error('Activity has ended; progress labels are no longer active.');
    }
  }
  async update(arguments_: unknown): Promise<ToolResult> {
    this.context.signal.throwIfAborted();
    try {
      this.assertActive();
      const next = immutable(updateTaskProgressSchema.parse(arguments_));
      await this.context.saveProgress?.(next);
      this.assertActive();
      this.value = next;
      if (this.store.activities.get(this.context.sessionId, this.context.activityId)) {
        this.store.activities.update(this.context.sessionId, this.context.activityId, {progress: next});
      }
      return {text: 'Current activity: ' + next.label + '.', isError: false};
    } catch (error) {
      this.context.signal.throwIfAborted();
      const message = error instanceof z.ZodError
        ? 'Parameter validation failed: ' + error.issues.map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ')
        : error instanceof Error ? error.message : String(error);
      return {text: message, isError: true};
    }
  }
}
