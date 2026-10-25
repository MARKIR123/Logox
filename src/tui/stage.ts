import {currentTaskProgress, type Interaction, type Message, type RuntimeSnapshot} from '../runtime/contracts.js';
import {choiceStyle, ownerColor, palette, type QuestionDraft, type ActorStyles} from './cards.js';
import {cast} from '../actors/ensemble.js';
import {createBuilder, insetFrame, type SceneAction, type SceneRow} from './scene.js';
import {getToolUI, isVisibleToolMessage} from '../tools/ui-registry.js';
import {messageToolCall, renderDefaultTool} from './tool-ui.js';
import {clipLine} from './viewport.js';
import stringWidth from 'string-width';
import {inputKind} from '../runtime/provenance.js';
import {thinkingRequests} from './thinking-groups.js';
import {stepElapsed} from '../runtime/steps.js';

export interface StageControls {readonly stopping?: ReadonlySet<string>; readonly focusedStop?: string; readonly hoveredStop?: string}

const statuses: Record<string, string> = {
  queued: 'Queued', running: '处理中', waiting_input: '待回答', completed: '已完成',
  failed: '失败', cancelled: '已取消', paused: '已暂停',
};
function activityTitle(activity: RuntimeSnapshot['activities'][number]): string {
  const reason = activity.status === 'failed' ? activity.detail.split('\n')[0]?.replace(/^失败原因：/, '').trim() : '';
  const current = currentTaskProgress(activity.progress);
  return reason || (['running', 'waiting_input', 'paused'].includes(activity.status) ? current?.label : undefined) || activity.summary?.title || activity.title;
}
function activityStatus(activity: RuntimeSnapshot['activities'][number]): string {
  return activity.status === 'running' && ['接续中', '调整中'].includes(activity.stage)
    ? activity.stage : activity.stage === '历史记录' ? '历史记录' : statuses[activity.status] ?? activity.status;
}
// Runtime messages are immutable; streaming replaces only the changed message.
// Weak ownership releases old streams/history; keep at most two layouts per message on resize.
const messageLayouts = new WeakMap<Message, Map<string, readonly SceneRow[]>>();
// Like Claude Code's Messages grouping useMemo, semantic projection depends on
// immutable messages/activity state, never on viewport, hover or fold state.
const projections = new WeakMap<RuntimeSnapshot, Map<string, ReturnType<typeof projectMessages>>>();
function projectMessages(snapshot: RuntimeSnapshot, sessionId: string, view: string) {
  const messages = snapshot.messages.filter(message => message.sessionId === sessionId && (view === 'logox' || message.ownerId === view) &&
    isVisibleToolMessage(message) && !(message.ownerId === 'logox' && message.role === 'user' && inputKind(message) === 'actor'));
  const activities = new Map(snapshot.activities.filter(item => item.sessionId === sessionId).map(item => [item.activityId, item]));
  const grouped = new Map<string, Message[]>();
  for (const message of messages) if (message.activityId) {
    const group = grouped.get(message.activityId) ?? [];
    group.push(message); grouped.set(message.activityId, group);
  }
  const thinking = thinkingRequests(messages);
  return {messages, activities, grouped, thinking};
}
function messageProjection(snapshot: RuntimeSnapshot, sessionId: string, view: string) {
  let views = projections.get(snapshot);
  if (!views) {views = new Map(); projections.set(snapshot, views);}
  const key = JSON.stringify([sessionId, view]);
  let projection = views.get(key);
  if (!projection) {projection = projectMessages(snapshot, sessionId, view); views.set(key, projection);}
  return projection;
}
export function stageFoldOpen(snapshot: RuntimeSnapshot, id: string, folds: Readonly<Record<string, boolean>>): boolean {
  return folds[id] ?? snapshot.interactions.some(request => request.status === 'pending' && (request.activityId === id || request.requestId === id));
}
/** 使用 demo 的同一个行构建器，只读取真实消息与活动。 */
export function buildStageRows(snapshot: RuntimeSnapshot, sessionId: string, view: string, width: number,
  folds: Readonly<Record<string, boolean>>, hovered: string | null,
  responses: Readonly<Record<string, QuestionDraft>> = {}, roles: ActorStyles = cast, controls: StageControls = {}): readonly SceneRow[] {
  const builder = createBuilder(width, hovered, roles);
  const {messages, activities, grouped, thinking} = messageProjection(snapshot, sessionId, view);
  const pending = snapshot.interactions.filter(request => request.sessionId === sessionId && request.status === 'pending' && (view === 'logox' || request.ownerId === view));
  const requests = new Map<string, Interaction[]>();
  for (const request of pending) {
    const group = requests.get(request.activityId) ?? [];
    group.push(request); requests.set(request.activityId, group);
  }
  const animated = (activity: RuntimeSnapshot['activities'][number]) => activity.status === 'running' &&
    !['approval', 'question', 'retry'].includes(activity.phase ?? '') && !requests.has(activity.activityId) &&
    !(grouped.get(activity.activityId) ?? []).some(message => message.step?.state === 'waiting');
  const seen = new Set<string>();
  type Frame = Parameters<typeof insetFrame>[0];
  const open = (id: string) => stageFoldOpen(snapshot, id, folds);
  const body = (message: Message, frame?: Frame) => {
    const activity = message.activityId ? activities.get(message.activityId) : undefined;
    const request = thinking.get(message.id);
    if (request) {
      const hasContent = Boolean(message.text.trim() || (request.tokens && request.tokens > 0) || request.step.note);
      if (request.step.state === 'completed' && !hasContent) {
        return;
      }
      builder.pushOrdinaryCard({id: request.id, ownerId: message.ownerId, kind: 'Thinking', title: 'Thinking', bodyLines: [],
        step: request.step, tokens: request.tokens, open: open(request.id), railColor: ownerColor(message.ownerId, roles),
        ...(frame ? {parentFrame: frame} : {}),
        renderBody(inner) {
          if (request.step.note) builder.pushProse(message.id + '-note', request.step.note, ownerColor(message.ownerId, roles), 'body', inner, undefined, palette.muted);
          if (message.text) builder.pushProse(message.id + '-body-0', message.text, ownerColor(message.ownerId, roles), 'body', inner);
          if (request.step.state === 'cancelled') builder.pushProse(request.id + '-stopped', '已停止', palette.muted, 'body', inner);
          if (request.step.state === 'failed') {
            const finalRequest = message.activityId ? grouped.get(message.activityId)?.findLast(item => item.kind === 'thinking') : undefined;
            const detail = activity?.status === 'failed' && finalRequest?.id === message.id ? activity.detail : undefined;
            if (detail) builder.pushProse(request.id + '-error', detail, palette.error, 'body', inner, undefined, palette.error);
          }
        }});
      return;
    }
    const isUser = message.role === 'user' && inputKind(message) !== 'director' && inputKind(message) !== 'collaboration';
    const isSystem = message.role === 'system' || (message.role === 'notice' && (!message.ownerId || message.ownerId === 'system'));
    const actorColor = ownerColor(message.ownerId, roles);
    const rail = isUser ? palette.user : isSystem ? palette.muted : actorColor;
    const key = JSON.stringify([width, frame, rail, Boolean(message.kind && open(message.id)), hovered === message.id]);
    let layouts = messageLayouts.get(message);
    if (!layouts) {layouts = new Map(); messageLayouts.set(message, layouts);}
    let rows = layouts.get(key);
    if (!rows) {
      const chunk = createBuilder(width, hovered, roles);
      if (message.kind === 'tool') {
        const call = messageToolCall(message);
        const ui = getToolUI(call?.name ?? '');
        (ui.render ?? renderDefaultTool)({builder: chunk, message, ...(call ? {call} : {}),
          ...(frame ? {frame} : {}), open: open(message.id), accent: rail});
      } else if (message.kind) chunk.pushOrdinaryCard({id: message.id, ownerId: message.ownerId, kind: 'Thinking',
        title: message.step?.title ?? 'Thinking', bodyLines: [message.text],
        ...(message.step ? {step: message.step} : {}),
        open: open(message.id), railColor: rail, ...(frame ? {parentFrame: frame} : {})});
      else if (message.role === 'assistant') chunk.pushMarkdown(message.id, message.text, rail, frame);
      else chunk.pushProse(message.id, message.text, rail, 'body', frame, undefined, isSystem ? palette.muted : undefined);
      rows = chunk.rows;
      if (layouts.size >= 4) layouts.delete(layouts.keys().next().value!);
      layouts.set(key, rows);
    }
    for (const row of rows) builder.rows.push(row);
  };
  const activeStop = (activityId: string) => ({disabled: controls.stopping?.has(activityId) ?? false,
    focused: controls.focusedStop === activityId, hovered: controls.hoveredStop === activityId});
  const actorGoal = (activity: RuntimeSnapshot['activities'][number]): string => {
    let original = activity;
    const visited = new Set<string>([activity.activityId]);
    while (original.resumeTaskId && !visited.has(original.resumeTaskId)) {
      const previous = activities.get(original.resumeTaskId);
      if (!previous || previous.ownerId !== activity.ownerId) break;
      visited.add(previous.activityId); original = previous;
    }
    return grouped.get(original.activityId)?.find(message => message.role === 'user' && message.text.trim())?.text ?? original.title;
  };
  const failure = (activityId: string) => {
    const activity = activities.get(activityId);
    if (!activity || !['failed', 'cancelled'].includes(activity.status)) return;
    builder.pushBlank(palette.muted);
    const kind = statuses[activity.status] ?? activity.status;
    builder.pushOrdinaryCard({id: activityId, kind: statuses[activity.status] ?? activity.status,
      title: clipLine(activityTitle(activity), Math.max(1, builder.contentWidth - 4 - stringWidth(kind) - 3)),
      bodyLines: [activity.detail], open: open(activityId), railColor: palette.muted, toneColor: palette.muted});
  };
  const interaction = (request: Interaction, parent?: Frame) => {
    const rail = ownerColor(request.ownerId, roles);
    const draft = responses[request.requestId] ?? {questionIndex: 0, selected: request.kind === 'permission' ? 1 : 0, text: '', error: ''};
    if (request.kind === 'question') {
      getToolUI('AskUserQuestion').interaction?.render({builder, request, draft, answers: {},
        ...(parent ? {frame: parent} : {}), open: open(request.requestId), accent: rail});
      return;
    }
    builder.pushOrdinaryCard({id: request.requestId, kind: '许可', title: request.title, status: '待回答', bodyLines: [], open: open(request.requestId), railColor: rail,
      ...(parent ? {parentFrame: parent} : {})});
    if (!open(request.requestId)) return;
    const frame = insetFrame(parent ?? {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth}, parent?.bg);
    builder.pushBlank(rail, frame);
    builder.pushProse(request.requestId + '-question', request.reason + '\n' + request.tool + ' · ' + JSON.stringify(request.arguments, null, 2), rail, 'body', frame);
    const options = [{label: '仅本次允许', description: '只允许这一次工具执行。'}, {label: '拒绝（默认）', description: '保留建议，不执行该工具。'}];
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
    const activity = message.activityId ? activities.get(message.activityId) : undefined;
    const actor = activity?.kind === 'actor';
    if (!message.kind && (message.role === 'system' || message.role === 'notice') && activity && ['failed', 'cancelled'].includes(activity.status) && !actor) {
      if (grouped.get(activity.activityId)?.at(-1)?.id === message.id) failure(activity.activityId);
      continue;
    }
    if (view === 'logox' && actor && activity) {
      if (seen.has(activity.activityId)) continue;
      seen.add(activity.activityId);
      const actorColor = ownerColor(activity.ownerId, roles);
      if (!builder.rows.at(-1)?.action?.owner) builder.pushBlank(actorColor);
      getToolUI('Actor').renderActivity?.({builder, activity, roles, title: activityTitle(activity), status: activityStatus(activity),
        active: animated(activity), open: open(activity.activityId), stop: activeStop(activity.activityId),
        messages: grouped.get(activity.activityId) ?? [], pending: requests.get(activity.activityId) ?? [],
        thinking, originalPrompt: actorGoal(activity), detailed: true, renderMessage: body, renderInteraction: interaction});
      continue;
    }
    if (actor && activity && !seen.has(activity.activityId)) {
      seen.add(activity.activityId);
      if (view !== 'logox' && activity.status === 'completed') {
        // 在 actor 自己的对话窗口中，已完成的任务不重复渲染自引用的外层 Actor 卡片，直接呈现对话正文。
      } else {
        getToolUI('Actor').renderActivity?.({builder, activity, roles, title: activityTitle(activity), status: activityStatus(activity),
          active: animated(activity), open: open(activity.activityId), stop: activeStop(activity.activityId),
          messages: grouped.get(activity.activityId) ?? [], pending: [], thinking, originalPrompt: actorGoal(activity),
          detailed: false, renderMessage: body, renderInteraction: interaction});
      }
    }
    if (actor && activity && view !== 'logox' && message.role === 'system' && ['failed', 'cancelled'].includes(activity.status)) continue;
    if (message.role === 'user') {
      builder.pushBlank();
      const source = inputKind(message);
      const queued = source === 'human' && activity && ['queued', 'paused'].includes(activity.status);
      builder.pushTurnHeader(message.id + '-who', source === 'director' || source === 'collaboration' ? message.source ?? message.ownerId : 'user',
        queued ? 'Queued' : source === 'director' ? 'Assignment' : source === 'collaboration' ? 'Collaboration' : message.source);
      body(message);
    } else {
      if (!message.kind) {
        builder.pushBlank();
        const isSystem = message.role === 'system' || (message.role === 'notice' && (!message.ownerId || message.ownerId === 'system'));
        if (!isSystem) {
          const who = message.ownerId || (view === 'logox' ? 'logox' : view);
          builder.pushTurnHeader(message.id + '-who', who);
        }
      }
      body(message);
    }
    if (activity && !actor && grouped.get(activity.activityId)?.at(-1)?.id === message.id) failure(activity.activityId);
  }
  for (const request of pending.filter(item => !seen.has(item.activityId))) interaction(request);
  for (const activity of snapshot.activities.filter(item => item.sessionId === sessionId && (view === 'logox' || item.ownerId === view))) {
    if (activity.kind === 'anamnesis') {
      builder.pushBlank();
      builder.pushOrdinaryCard({id: activity.activityId, kind: '入梦', title: activity.stage,
        status: statuses[activity.status] ?? activity.status, bodyLines: [activity.detail], ownerId: 'anamnesis',
        open: open(activity.activityId), railColor: palette.accent});
    } else if (!grouped.has(activity.activityId) && activity.ownerId === view) {
      failure(activity.activityId);
    }
  }
  return builder.rows;
}
