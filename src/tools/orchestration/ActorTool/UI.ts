import type {Activity, Interaction, Message} from '../../../runtime/contracts.js';
import type {ThinkingRequest} from '../../../tui/timeline/thinking-groups.js';
import {type ActorStyles} from '../../../tui/appearance/actor-style.js';
import type {ToolFrame} from '../../ui-types.js';
import {ownerColor} from '../../../tui/appearance/actor-style.js';
import {palette} from '../../../tui/appearance/theme.js';
import {appendActorCard, type createBuilder} from '../../../tui/timeline/scene.js';
import {stepElapsed} from '../../../runtime/steps.js';
import {createToolUI} from '../../../tui/timeline/tool-ui.js';

export interface ActorActivityContext {
  builder: ReturnType<typeof createBuilder>;
  activity: Activity;
  roles: ActorStyles;
  /** Rail of the surrounding surface (Director accent in the main timeline). */
  railColor?: string | undefined;
  title: string;
  status: string;
  active: boolean;
  open: boolean;
  messages: readonly Message[];
  pending: readonly Interaction[];
  thinking: ReadonlyMap<string, ThinkingRequest>;
  originalPrompt: string;
  detailed: boolean;
  stop: {disabled: boolean; focused: boolean; hovered: boolean};
  renderMessage(message: Message, frame: ToolFrame): void;
  renderInteraction(request: Interaction, frame: ToolFrame): void;
}
export function renderActivity(context: ActorActivityContext): void {
  const {builder, activity, roles, messages} = context;
  const color = context.railColor ?? ownerColor(activity.ownerId, roles);
  appendActorCard(builder, {id: activity.activityId, owner: activity.ownerId, roles,
    task: context.title, status: context.status, active: context.active, open: context.open, railColor: color,
    ...(['queued', 'running', 'waiting_input', 'paused'].includes(activity.status) ? {stop: context.stop} : {}),
    renderBody(frame) {
      builder.pushProse(activity.activityId + '-goal', 'Goal: ' + context.originalPrompt, color, 'body', frame);
      const requests = messages.flatMap(message => {const request = context.thinking.get(message.id); return request ? [request] : [];});
      if (requests.length) builder.pushProse(activity.activityId + '-usage',
        'Thinking: ' + Math.round(requests.reduce((sum, request) => sum + stepElapsed(request.step, Date.now()), 0) / 1000) + 's · ' +
        requests.reduce((sum, request) => sum + request.tokens, 0) + ' Tokens', color, 'body', frame, undefined, palette.muted);
      if (context.detailed && activity.taskModel) {
        const model = activity.taskModel;
        builder.pushProse(activity.activityId + '-model', 'Task model: ' + model.actual.provider + '/' + model.actual.model +
          (model.switched ? ' · switched from ' + model.initial.provider + '/' + model.initial.model : ''), color, 'body', frame);
      }
      if (activity.summary) builder.pushProse(activity.activityId + '-summary', activity.summary.report, color, 'body', frame);
      for (const message of messages) {
        if (message.inputKind === 'collaboration_interrupt') {
          builder.pushBlank(color, frame);
          builder.pushProse(message.id + '-interrupt', message.text, palette.directorIntervention, 'body', frame, undefined, palette.directorIntervention);
          builder.pushBlank(color, frame);
        } else if (message.inputKind === 'collaboration') {
          const senderColor = message.source ? ownerColor(message.source, roles) : color;
          builder.pushBlank(color, frame);
          builder.pushProse(message.id + '-collab', message.text, senderColor, 'body', frame, undefined, senderColor);
          builder.pushBlank(color, frame);
        } else if (context.detailed && message.role !== 'user' && !(message.role === 'system' && ['failed', 'cancelled'].includes(activity.status))) {
          context.renderMessage(message, frame);
        }
      }
      if (context.detailed) for (const request of context.pending) context.renderInteraction(request, frame);
      if (['failed', 'cancelled'].includes(activity.status)) builder.pushProse(activity.activityId + '-error', activity.detail, palette.muted, 'body', frame, undefined, palette.muted);
    }});
}
const base = createToolUI(['actor', 'ownerId']);
export const UI = {...base, renderActivity, title(call: Parameters<typeof base.title>[0]) {
  try {
    const args: unknown = JSON.parse(call.arguments);
    const tasks = args && typeof args === 'object' ? (args as Record<string, unknown>).tasks : undefined;
    const task = Array.isArray(tasks) && tasks[0] && typeof tasks[0] === 'object' ? tasks[0] as Record<string, unknown> : undefined;
    if (task && typeof task.ownerId === 'string') {
      const mainTitle = typeof task.title === 'string' ? task.title
        : typeof task.description === 'string' ? task.description
        : typeof task.goal === 'string' ? task.goal
        : typeof task.prompt === 'string' ? task.prompt : '';
      const detail = mainTitle.replace(/\s+/g, ' ').trim().slice(0, 60);
      return 'Actor · ' + task.ownerId + (detail ? ' (' + detail + ')' : '');
    }
  } catch {}
  return base.title(call);
}};
