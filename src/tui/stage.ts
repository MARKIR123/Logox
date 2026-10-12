import type {ActorId} from '../actors/ensemble.js';
import type {Interaction, Message, RuntimeSnapshot} from '../runtime/contracts.js';
import {choiceStyle, ownerColor, palette, type QuestionDraft} from './cards.js';
import {appendActorCard, createBuilder, insetFrame, type SceneAction, type SceneRow} from './scene.js';

const statuses: Record<string, string> = {
  queued: '排队中', running: '处理中', waiting_input: '待回答', completed: '已完成',
  failed: '失败', cancelled: '已取消', paused: '已暂停',
};
export function stageFoldOpen(snapshot: RuntimeSnapshot, id: string, folds: Readonly<Record<string, boolean>>): boolean {
  return folds[id] ?? snapshot.interactions.some(request => request.status === 'pending' && (request.activityId === id || request.requestId === id));
}
/** 使用 demo 的同一个行构建器，只读取真实消息与活动。 */
export function buildStageRows(snapshot: RuntimeSnapshot, sessionId: string, view: ActorId, width: number,
  folds: Readonly<Record<string, boolean>>, hovered: string | null,
  responses: Readonly<Record<string, QuestionDraft>> = {}): readonly SceneRow[] {
  const builder = createBuilder(width, hovered);
  const messages = snapshot.messages.filter(message => message.sessionId === sessionId && (view === 'logox' || message.ownerId === view));
  const pending = snapshot.interactions.filter(request => request.sessionId === sessionId && request.status === 'pending' && (view === 'logox' || request.ownerId === view));
  const seen = new Set<string>();
  type Frame = Parameters<Parameters<typeof appendActorCard>[1]['renderBody']>[0];
  const open = (id: string) => stageFoldOpen(snapshot, id, folds);
  const body = (message: Message, frame?: Frame) => {
    const rail = ownerColor(message.ownerId);
    if (message.kind) {
      builder.pushOrdinaryCard({id: message.id, kind: message.kind === 'thinking' ? '思考' : '工具调用',
        title: message.text.split('\n')[0]?.slice(0, 100) || '处理中', bodyLines: [message.text],
        open: open(message.id), railColor: rail, ...(frame ? {parentFrame: frame} : {})});
    } else builder.pushProse(message.id, message.text, rail, 'body', frame);
  };
  const interaction = (request: Interaction, parent?: Frame) => {
    const rail = ownerColor(request.ownerId);
    const draft = responses[request.requestId] ?? {questionIndex: 0, selected: request.kind === 'permission' ? 1 : 0, text: '', error: ''};
    const question = request.kind === 'question' ? request.questions[draft.questionIndex] : undefined;
    builder.pushOrdinaryCard({id: request.requestId, kind: request.kind === 'permission' ? '许可' : '提问',
      title: request.title, status: '待回答', bodyLines: [], open: open(request.requestId), railColor: rail,
      ...(parent ? {parentFrame: parent} : {})});
    if (!open(request.requestId)) return;
    const frame = insetFrame(parent ?? {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth}, parent?.bg);
    builder.pushBlank(rail, frame);
    builder.pushProse(request.requestId + '-question', request.kind === 'permission'
      ? request.reason + '\n' + request.tool + ' · ' + JSON.stringify(request.arguments, null, 2)
      : (draft.questionIndex + 1) + '/' + request.questions.length + ' · ' + (question?.question ?? ''), rail, 'body', frame);
    const options = request.kind === 'permission'
      ? [{label: '仅本次允许', description: '只允许这一次工具执行。'}, {label: '拒绝（默认）', description: '保留建议，不执行该工具。'}]
      : [...question?.options ?? [], {label: '自由输入', description: draft.text || '在输入区写下回答。'}];
    for (const [index, option] of options.entries()) {
      const style = choiceStyle(index === draft.selected, rail);
      const action: SceneAction = {kind: 'select_answer', requestId: request.requestId, value: String(index)};
      builder.pushBlank(rail, frame, action);
      builder.pushProse(request.requestId + '-option-' + index, style.marker + option.label, rail, 'body', frame, action, style.color);
      builder.pushProse(request.requestId + '-description-' + index, '  ' + option.description, rail, 'body', frame, action, style.descriptionColor);
    }
    builder.pushBlank(rail, frame);
    if (draft.error) builder.pushProse(request.requestId + '-error', draft.error, rail, 'body', frame, undefined, palette.error);
    builder.pushProse(request.requestId + '-confirm', 'Enter 确认 · Esc 稍后 · Tab 切换焦点', rail, 'body', frame,
      {kind: 'confirm_answer', requestId: request.requestId}, rail);
    builder.pushBlank(rail, frame);
  };
  for (const message of messages) {
    const activity = snapshot.activities.find(item => item.activityId === message.activityId && item.sessionId === sessionId);
    const actor = message.ownerId === 'aletheia' || message.ownerId === 'techne' || message.ownerId === 'kalon';
    if (view === 'logox' && actor && activity) {
      if (seen.has(activity.activityId)) continue;
      seen.add(activity.activityId);
      if (!builder.rows.at(-1)?.action?.owner) builder.pushBlank(palette.accent);
      appendActorCard(builder, {
        id: activity.activityId, owner: message.ownerId as 'aletheia' | 'techne' | 'kalon',
        task: messages.find(item => item.activityId === activity.activityId && item.role === 'user')?.text.split('\n')[0]?.slice(0, 100) ?? activity.title,
        status: activity.stage === '历史记录' ? '历史记录' : statuses[activity.status] ?? activity.status, open: open(activity.activityId), railColor: palette.accent,
        renderBody(frame) {
          for (const item of messages.filter(candidate => candidate.activityId === activity.activityId && candidate.role !== 'user')) body(item, frame);
          for (const request of pending.filter(item => item.activityId === activity.activityId)) interaction(request, frame);
          if (activity.status === 'failed' || activity.status === 'cancelled') builder.pushProse(activity.activityId + '-error', activity.detail, palette.accent, 'body', frame);
        },
      });
      continue;
    }
    if (message.role === 'user') {
      builder.pushBlank();
      builder.pushTurnHeader(message.id + '-who', 'user', message.source);
      builder.pushProse(message.id, message.text, palette.user);
    } else {
      if (!message.kind) {
        builder.pushBlank();
        builder.pushTurnHeader(message.id + '-who', view === 'logox' ? 'logox' : view);
      }
      body(message);
    }
  }
  for (const request of pending.filter(item => !seen.has(item.activityId))) interaction(request);
  for (const activity of snapshot.activities.filter(item => item.sessionId === sessionId && (view === 'logox' || item.ownerId === view))) {
    if (activity.kind === 'anamnesis') {
      builder.pushBlank();
      builder.pushOrdinaryCard({id: activity.activityId, kind: '入梦', title: activity.stage,
        status: statuses[activity.status] ?? activity.status, bodyLines: [activity.detail], ownerId: 'anamnesis',
        open: open(activity.activityId), railColor: palette.accent});
    } else if (activity.ownerId === view && ['failed', 'cancelled', 'running'].includes(activity.status)) {
      builder.pushBlank();
      builder.pushProse(activity.activityId + '-state', (statuses[activity.status] ?? activity.status) + ' · ' + activity.stage + (activity.detail ? '\n' + activity.detail : ''), ownerColor(view));
    }
  }
  return builder.rows;
}
