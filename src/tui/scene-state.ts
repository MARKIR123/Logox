import type {PortfolioActivities} from '../demo/portfolio.js';
import {portfolioStyleLabels} from '../demo/portfolio.js';
import type {ActorId} from '../actors/ensemble.js';
import type {ActivityStatus, RuntimeSnapshot} from '../runtime/contracts.js';
import type {DemoEvent, DemoSceneState, DemoSceneUi} from './scene.js';

const statusLabels: Record<ActivityStatus, string> = {
  queued: '排队中', running: '处理中', waiting_input: '等待回答', paused: '已暂停',
  completed: '已完成', failed: '执行失败', cancelled: '已取消',
};

// 仅从快照读取业务结果；窗口、草稿选择与折叠仍由界面拥有。
export function projectPortfolioScene(ui: DemoSceneUi, snapshot: RuntimeSnapshot, sessionId: string, ids: PortfolioActivities): DemoSceneState {
  const activities = snapshot.activities.filter(item => item.sessionId === sessionId);
  const interactions = snapshot.interactions.filter(item => item.sessionId === sessionId);
  const permissionRequest = interactions.find(item => item.activityId === ids.techne && item.kind === 'permission');
  const styleRequest = interactions.find(item => item.activityId === ids.kalon && item.kind === 'question');
  const permissionResponse = permissionRequest?.response;
  const permission = permissionResponse?.kind === 'permission' ? permissionResponse.decision === 'allow_once' ? 'allow' : 'deny' : null;
  const styleResponse = styleRequest?.response;
  const answer = styleResponse?.kind === 'question' ? styleResponse.answers.style : undefined;
  const style = answer?.type === 'text' ? answer.text : answer?.type === 'option' && Object.hasOwn(portfolioStyleLabels, answer.optionId)
    ? portfolioStyleLabels[answer.optionId as keyof typeof portfolioStyleLabels] : null;
  const events: DemoEvent[] = [];
  if (permission) events.push({id: 'permission-' + permissionRequest!.requestId, type: 'permission', value: permission});
  if (style) events.push({id: 'style-' + styleRequest!.requestId, type: 'style', text: style});
  for (const message of snapshot.messages) {
    if (message.sessionId !== sessionId || message.role !== 'user' || !message.activityId || Object.values(ids).includes(message.activityId)) continue;
    const activity = activities.find(item => item.activityId === message.activityId);
    if (!activity || !Object.hasOwn(statusLabels, activity.status)) continue;
    const replies = snapshot.messages.filter(item => item.sessionId === sessionId && item.activityId === activity.activityId && item.role === 'assistant').map(item => item.text).join('\n');
    const newline = replies.indexOf('\n');
    const hasDirection = replies.startsWith('（') && newline >= 0;
    const actor = message.ownerId;
    if (!['logox', 'aletheia', 'techne', 'kalon'].includes(actor ?? '')) continue;
    const owner = actor as ActorId;
    const direct = message.source !== undefined && message.source !== 'logox';
    events.push({id: message.id, type: owner === 'logox' ? 'main' : direct ? 'direct' : 'dispatch',
      ...(owner !== 'logox' ? {actor: owner} : {}), text: message.text,
      ...(hasDirection ? {direction: replies.slice(0, newline)} : {}),
      ...(replies ? {reply: hasDirection ? replies.slice(newline + 1) : replies} : {}),
      status: statusLabels[activity.status], activityId: activity.activityId,
      ...(activity.status === 'failed' ? {error: activity.detail} : {}),
    });
  }
  return {...ui, permission, style, events, runtime: {
    techne: activities.find(item => item.activityId === ids.techne)?.status ?? 'queued',
    kalon: activities.find(item => item.activityId === ids.kalon)?.status ?? 'queued',
    background: activities.filter(item => item.kind === 'anamnesis').map(item => ({id: item.activityId, title: item.title, stage: item.stage, detail: item.detail, status: statusLabels[item.status]})),
    ...(permissionRequest ? {permissionRequest} : {}), ...(styleRequest ? {styleRequest} : {}),
  }};
}
