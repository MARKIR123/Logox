import {z} from 'zod';
import type {ActorContext} from '../actors/ensemble.js';
import type {ToolResult} from '../tools/tools.js';
import {immutable, stepStageSchema, taskProgressSchema, type StepStage, type TaskProgressSnapshot} from './contracts.js';
import type {ToolDefinition} from './messages.js';
import type {RuntimeStore} from './store.js';

import {updateTaskProgressSchema} from '../tools/UpdateTaskProgressTool/UpdateTaskProgressTool.js';
import {UPDATE_TASK_PROGRESS_DESCRIPTION, UPDATE_TASK_PROGRESS_TOOL_NAME} from '../tools/UpdateTaskProgressTool/prompt.js';

const updateSchema = updateTaskProgressSchema;

export const taskProgressTool: ToolDefinition = {
  name: UPDATE_TASK_PROGRESS_TOOL_NAME,
  description: UPDATE_TASK_PROGRESS_DESCRIPTION,
  parameters: z.toJSONSchema(updateTaskProgressSchema, {io: 'input'}),
};
const planning: StepStage = immutable({id: 'planning', title: '梳理目标与制定阶段',
  purpose: '核对已确认目标，探查必要事实并制定简短阶段计划', activeForm: '正在梳理目标与制定阶段'});

/** 模型显式维护任务阶段，步骤只在创建时领取快照；旧步骤永不重新归属。 */
export class TaskProgress {
  private value: TaskProgressSnapshot;
  constructor(private readonly store: RuntimeStore, private readonly context: ActorContext) {
    this.value = immutable(taskProgressSchema.parse(context.progress ?? {planned: false, revision: 0, stages: [], revisions: []}));
  }
  snapshot(): TaskProgressSnapshot {return this.value;}
  current(): StepStage | undefined {
    const stage = this.value.stages.find(stage => stage.id === this.value.activeStageId);
    return stage ? {id: stage.id, title: stage.title, purpose: stage.purpose, activeForm: stage.activeForm} : this.value.planned ? undefined : planning;
  }
  instruction(): string {
    if (!this.value.planned) return 'No task phases are registered yet. Clarify the objective before modifying files.';
    const stage = this.value.stages.find(stage => stage.id === this.value.activeStageId);
    const completed = this.value.stages.filter(stage => stage.status === 'completed').map(stage => stage.title + '：' + stage.result);
    const pending = this.value.stages.filter(stage => stage.status === 'pending').map(stage => stage.title);
    return [stage ? 'Active phase: ' + stage.title + '. Purpose: ' + stage.purpose : 'No phase currently in progress.',
      completed.length ? 'Completed milestones: ' + completed.join('; ') : '', pending.length ? 'Remaining phases: ' + pending.join('; ') : ''].filter(Boolean).join('\n');
  }
  async update(arguments_: unknown): Promise<ToolResult> {
    this.context.signal.throwIfAborted();
    try {
      const input = updateSchema.parse(arguments_);
      let stages = this.value.stages.map(stage => ({...stage}));
      if (input.stages) {
        // Defensive normalization: auto-generate id, purpose, activeForm
        const normalizedInput = input.stages.map((stage, index) => {
          const autoId = stage.id || (stage.title && /^[a-z0-9_-]+$/i.test(stage.title) ? stage.title : `stage-${index + 1}`);
          const purpose = stage.purpose || stage.title;
          const activeForm = stage.activeForm || (stage.title.startsWith('正在') ? stage.title : `正在${stage.title}`);
          const status = stage.status || 'pending';
          const result = stage.result || (status === 'completed' ? 'Done' : undefined);
          const reason = stage.reason || (status === 'skipped' ? 'Skipped' : undefined);
          return {
            id: autoId,
            title: stage.title,
            purpose,
            activeForm,
            status,
            ...(result ? {result} : {}),
            ...(reason ? {reason} : {}),
          };
        });

        if (new Set(normalizedInput.map(stage => stage.id)).size !== normalizedInput.length) throw new Error('Phase milestone ID must be unique');
        for (const previous of stages) {
          const replacement = normalizedInput.find(stage => stage.id === previous.id);
          if (!replacement) throw new Error('Existing phases cannot be deleted; mark obsolete phases as skipped instead');
          if (['completed', 'skipped'].includes(previous.status) &&
            (replacement.title !== previous.title || replacement.purpose !== previous.purpose || replacement.activeForm !== previous.activeForm)) {
            throw new Error('Completed or cancelled phases cannot be rewritten');
          }
        }
        stages = normalizedInput.map(stage => {
          const previous = stages.find(prev => prev.id === stage.id);
          return {
            ...previous,
            ...stage,
            status: stage.status !== 'pending' ? stage.status : (previous?.status ?? 'pending'),
          };
        });
      }
      if (input.update) {
        const change = input.update;
        const stage = stages.find(s => s.id === change.id || s.title.toLowerCase() === change.id.toLowerCase());
        if (!stage) {
          const available = stages.map(s => `"${s.id}" (${s.title})`).join(', ');
          throw new Error(`Phase not found: "${change.id}". Available phases: ${available || 'none'}`);
        }
        if (['completed', 'skipped'].includes(stage.status)) throw new Error('Terminal phase cannot be reopened or rewritten');
        if (change.status === 'completed' && !change.result) throw new Error('Completed phase requires a concrete result (provide result field)');
        if (change.status === 'skipped' && !change.reason) throw new Error('Skipped phase requires a cancellation reason (provide reason field)');
        if (change.status === 'in_progress') for (const other of stages) if (other.id !== stage.id && other.status === 'in_progress') other.status = 'pending';
        stage.status = change.status;
        if (change.result) stage.result = change.result;
        if (change.reason) stage.reason = change.reason;
      }
      const activeStageId = stages.find(stage => stage.status === 'in_progress')?.id;
      const revision = this.value.revision + 1, active = activeStageId ? {activeStageId} : {};
      const next = immutable(taskProgressSchema.parse({planned: true, revision, stages, ...active,
        revisions: [...this.value.revisions, {revision, time: Date.now(), stages, ...active}]}));
      await this.context.saveProgress?.(next);
      this.context.signal.throwIfAborted();
      this.value = next;
      const activity = this.store.activities.get(this.context.sessionId, this.context.activityId);
      if (activity && !['completed', 'failed', 'cancelled'].includes(activity.status)) {
        this.store.activities.update(this.context.sessionId, this.context.activityId, {progress: next});
      }
      const activeStage = stages.find(s => s.id === activeStageId);
      const stageName = activeStage ? activeStage.title : (input.update ? input.update.id : 'updated');
      return {text: `Task progress updated (revision ${revision}). Active phase: ${stageName}.`, isError: false};
    } catch (error) {
      this.context.signal.throwIfAborted();
      const message = error instanceof z.ZodError
        ? 'Parameter validation failed: ' + error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')
        : error instanceof Error ? error.message : String(error);
      return {text: message, isError: true};
    }
  }
}
