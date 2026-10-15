import {z} from 'zod';
import type {ActorContext} from '../actors/ensemble.js';
import type {ToolResult} from '../tools/tools.js';
import {immutable, stepStageSchema, taskProgressSchema, type StepStage, type TaskProgressSnapshot} from './contracts.js';
import type {ToolDefinition} from './messages.js';
import type {RuntimeStore} from './store.js';

const updateSchema = z.strictObject({
  stages: z.array(stepStageSchema).min(1).max(32).optional(),
  update: z.strictObject({id: z.string().trim().min(1), status: z.enum(['in_progress', 'completed', 'skipped']),
    result: z.string().trim().min(1).max(2000).optional(), reason: z.string().trim().min(1).max(1000).optional()}).optional(),
}).refine(input => input.stages || input.update, '请登记阶段计划或更新阶段状态');

export const taskProgressTool: ToolDefinition = {
  name: 'update_task_progress',
  description: '登记或更新复杂任务的阶段；自然标题，无编号，一次推进一个阶段。完成写 result，取消写 reason。简单任务无需清单。',
  // 请求只携带字段结构，长度与修订边界由 updateSchema 在运行时严格校验。
  parameters: {type: 'object', additionalProperties: false, properties: {
    stages: {type: 'array', items: {type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.keys(stepStageSchema.shape).map(key => [key, {type: 'string'}])), required: Object.keys(stepStageSchema.shape)}},
    update: {type: 'object', additionalProperties: false, properties: {id: {type: 'string'},
      status: {type: 'string', enum: ['in_progress', 'completed', 'skipped']}, result: {type: 'string'}, reason: {type: 'string'}}, required: ['id', 'status']},
  }},
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
    if (!this.value.planned) return '当前目的：梳理目标与制定阶段；复杂任务先登记阶段，未登记不阻塞探查。';
    const stage = this.value.stages.find(stage => stage.id === this.value.activeStageId);
    const completed = this.value.stages.filter(stage => stage.status === 'completed').map(stage => stage.title + '：' + stage.result);
    const pending = this.value.stages.filter(stage => stage.status === 'pending').map(stage => stage.title);
    return ['任务阶段由 update_task_progress 显式维护；工具继承当前阶段目的，不重复声明意图。',
      stage ? '当前阶段：' + stage.title + '。目的：' + stage.purpose : '当前没有进行中的阶段；请补登记当前阶段，不因此停止或拒绝正常工具。',
      completed.length ? '已完成成果：' + completed.join('；') : '', pending.length ? '剩余阶段：' + pending.join('；') : '',
      '完成阶段请报告实际成果，收尾明确完成和剩余工作；阶段变更不代表取得成果。'].filter(Boolean).join('\n');
  }
  async update(arguments_: unknown): Promise<ToolResult> {
    this.context.signal.throwIfAborted();
    try {
      const input = updateSchema.parse(arguments_);
      let stages = this.value.stages.map(stage => ({...stage}));
      if (input.stages) {
        if (new Set(input.stages.map(stage => stage.id)).size !== input.stages.length) throw new Error('阶段 ID 必须唯一');
        for (const previous of stages) {
          const replacement = input.stages.find(stage => stage.id === previous.id);
          if (!replacement) throw new Error('已有阶段不能删除；过时阶段请先注明原因后取消');
          if (['completed', 'skipped'].includes(previous.status) &&
            (replacement.title !== previous.title || replacement.purpose !== previous.purpose || replacement.activeForm !== previous.activeForm)) {
            throw new Error('已完成或取消阶段不能改写');
          }
        }
        stages = input.stages.map(stage => ({...stages.find(previous => previous.id === stage.id), ...stage,
          status: stages.find(previous => previous.id === stage.id)?.status ?? 'pending'}));
      }
      if (input.update) {
        const change = input.update, stage = stages.find(stage => stage.id === change.id);
        if (!stage) throw new Error('阶段不存在：' + change.id);
        if (['completed', 'skipped'].includes(stage.status)) throw new Error('终态阶段不能重新推进或改写成果');
        if (change.status === 'completed' && !change.result) throw new Error('完成阶段必须报告实际成果');
        if (change.status === 'skipped' && !change.reason) throw new Error('取消阶段必须说明原因');
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
      return {text: input.update?.status === 'completed' ? '阶段成果已记录：' + input.update.result :
        input.update?.status === 'skipped' ? '阶段已取消：' + input.update.reason : '阶段计划已更新。' + (activeStageId ? '当前：' + this.current()?.title : ''), isError: false};
    } catch (error) {
      this.context.signal.throwIfAborted();
      const message = error instanceof z.ZodError
        ? '参数校验失败：' + error.issues.map(i => `${i.path.join('.') || '根参数'}: ${i.message}`).join('；')
        : error instanceof Error ? error.message : String(error);
      return {text: message, isError: true};
    }
  }
}
