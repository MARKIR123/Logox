import {basename} from 'node:path';
import {type Activity, type Interaction, type Message, currentTaskProgress} from '../../../runtime/contracts.js';
import type {ThinkingRequest} from '../../../tui/timeline/thinking-groups.js';
import {type ActorStyles} from '../../../tui/appearance/actor-style.js';
import type {ToolFrame} from '../../ui-types.js';
import {ownerColor} from '../../../tui/appearance/actor-style.js';
import {palette} from '../../../tui/appearance/theme.js';
import {appendActorCard, type createBuilder, type SceneSegment, insetRailFrame} from '../../../tui/timeline/scene.js';
import {stepElapsed} from '../../../runtime/steps.js';
import type {ToolCall} from '../../../runtime/messages.js';
import type {ToolUI} from '../../ui-types.js';
import {callLabel, createToolUI, hiddenToolUI} from '../../../tui/timeline/tool-ui.js';
import {stripNarration} from '../../../runtime/narration.js';
import {groupToolMessages} from '../../../tui/timeline/tool-groups.js';
import {pushStageLine, pushToolGroupCard} from '../../../tui/timeline/group-row.js';

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
  isOpen?: ((id: string) => boolean) | undefined;
  messages: readonly Message[];
  pending: readonly Interaction[];
  thinking: ReadonlyMap<string, ThinkingRequest>;
  originalPrompt: string;
  detailed: boolean;
  stop: {disabled: boolean; focused: boolean; hovered: boolean};
  /** Folds all thinking of the card into one row (first row inside an open card). */
  renderThinking?: ((messages: readonly Message[], frame: ToolFrame, activityId: string, ownerId: string) => void) | undefined;
  /** `run` (merged same-file edits) renders as one row; the first message carries the card. */
  renderMessage(message: Message, frame: ToolFrame, run?: readonly Message[]): void;
  renderInteraction(request: Interaction, frame: ToolFrame): void;
}

function parseIncomingCollaboration(message: Message, roles: ActorStyles) {
  const match = /^\[(?:Message|Broadcast) from ([^\]·]+?)(?: · ([^\]]+))?\]\r?\n?([\s\S]*)$/u.exec(message.text);
  const rawSender = (match?.[1]?.trim() || message.source || 'peer').toLowerCase();
  const role = roles[rawSender];
  const senderLabel = role ? `${role.symbol} ${role.name}` : rawSender;
  const summary = match?.[2]?.trim() || '';
  const cleanBody = (match ? match[3]! : message.text).trim();
  const lines = cleanBody ? cleanBody.split(/\r?\n/).length : 0;
  return {rawSender, senderLabel, summary, cleanBody, lines};
}

export function renderActivity(context: ActorActivityContext): void {
  const {builder, activity, roles, messages} = context;
  const color = context.railColor ?? ownerColor(activity.ownerId, roles);
  const roleColor = ownerColor(activity.ownerId, roles);

  appendActorCard(builder, {id: activity.activityId, owner: activity.ownerId, roles,
    task: context.title, status: context.status, active: context.active, open: context.open, railColor: color,
    ...(['queued', 'running', 'waiting_input', 'paused'].includes(activity.status) ? {stop: context.stop} : {}),
    renderBody(frame, _color, _action, outer) {
      const actorTreeFrame = insetRailFrame(outer, roleColor);
      if (context.detailed && context.renderThinking) context.renderThinking(messages.filter(m => m.kind === 'thinking'), actorTreeFrame, activity.activityId, activity.ownerId);
      if (context.originalPrompt && context.originalPrompt.trim()) {
        const goalId = activity.activityId + '-goal';
        const goalOpen = context.isOpen ? context.isOpen(goalId) : false;
        const sender = activity.inputKind === 'collaboration' || activity.inputKind === 'collaboration_interrupt'
          ? 'peer'
          : 'logox';
        const senderRole = roles[sender];
        const senderLabel = senderRole ? `${senderRole.symbol} ${senderRole.name}` : sender === 'logox' ? '◈ Logox' : sender;
        const senderColor = senderRole ? senderRole.color : sender === 'logox' ? palette.accent : roleColor;
        const goalTitle = `Task from ${senderLabel}`;

        builder.pushOrdinaryCard({
          id: goalId,
          ownerId: sender,
          kind: 'Task',
          title: goalTitle,
          titleSegments: [
            {text: (goalOpen ? '▾ ' : '▸ ') + 'Task from ', color: palette.muted, selectionKey: goalId + ':title_prefix'},
            {text: senderLabel, color: senderColor, bold: true, selectionKey: goalId + ':title_sender'},
          ],
          status: 'Full brief',
          bodyLines: [],
          expandable: true,
          open: goalOpen,
          railColor: color,
          parentFrame: actorTreeFrame,
          renderBody(inner) {
            builder.pushMarkdown(goalId + '-body', context.originalPrompt, color, inner, senderColor);
          },
        });
      }
      const lastAssistantMessage = messages.filter(m => m.role === 'assistant' && !m.kind && stripNarration(m.text).trim()).at(-1);
      const isReportDeliveredInTranscript = lastAssistantMessage && activity.summary?.report &&
        (stripNarration(lastAssistantMessage.text).trim() === activity.summary.report.trim() ||
         lastAssistantMessage.text.includes(activity.summary.report.trim().slice(0, 80)));

      if (activity.summary && !isReportDeliveredInTranscript) {
        builder.pushMarkdown(activity.activityId + '-summary', activity.summary.report, color, actorTreeFrame, roleColor);
      }

      const renderableItems = groupToolMessages(messages.filter(message => {
        if (message.inputKind === 'collaboration_interrupt' || message.inputKind === 'collaboration') return true;
        if (!context.detailed || message.role === 'user' || (message.role === 'system' && ['failed', 'cancelled'].includes(activity.status))) return false;
        if ((message.role as string) === 'context') return false;
        return !(message.role === 'assistant' && !message.kind && (!message.text || !message.text.trim()));
      }), {stages: true});

      let currentPhaseFrame: ToolFrame = actorTreeFrame;
      let inPhase = false;

      for (let i = 0; i < renderableItems.length; i++) {
        const item = renderableItems[i]!;
        const nextItem = renderableItems[i + 1];

        if (item.type === 'group') {
          pushToolGroupCard(builder, item, {
            ownerId: activity.ownerId, open: context.isOpen ? context.isOpen(item.id) : false,
            railColor: color, parentFrame: inPhase ? currentPhaseFrame : actorTreeFrame,
            verbs: roles[activity.ownerId]?.activityVerbs,
            renderChild: (m, inner) => context.renderMessage(m, inner),
          });
          continue;
        }

        if (item.type === 'stage') {
          // The model's `⏵` line is its own prose row between the rows around it; the outer rail keeps the surface colour.
          pushStageLine(builder, item, color, inPhase ? currentPhaseFrame : actorTreeFrame);
          continue;
        }
        if (item.type === 'edits') {
          context.renderMessage(item.messages[0]!, inPhase ? currentPhaseFrame : actorTreeFrame, item.messages);
          continue;
        }
        const message = item.message;
        if (message.role === 'assistant' && !message.kind && !stripNarration(message.text).trim()) continue; // stage marker only; it labels the next group
        if (message.inputKind === 'collaboration_interrupt' || message.inputKind === 'collaboration') {
          inPhase = false;
          currentPhaseFrame = frame;
          const isInterrupt = message.inputKind === 'collaboration_interrupt';
          const {rawSender, senderLabel, summary, cleanBody, lines} = parseIncomingCollaboration(message, roles);
          const senderColor = isInterrupt ? palette.directorIntervention : ownerColor(rawSender, roles);
          const prefix = isInterrupt ? 'Interrupt from ' : 'Message from ';
          const title = `${prefix}${senderLabel}${summary ? ` · ${summary}` : ''}`;
          const titleSegments: SceneSegment[] = [
            {text: prefix, color: palette.muted, selectionKey: message.id + ':title', selectionOffset: 0},
            {text: senderLabel, color: senderColor, bold: true, selectionKey: message.id + ':title_sender'},
            ...(summary ? [{text: ` · ${summary}`, color: palette.fg, selectionKey: message.id + ':title_summary'}] : []),
          ];
          const cardOpen = context.isOpen ? context.isOpen(message.id) : false;
          builder.pushOrdinaryCard({
            id: message.id,
            ownerId: rawSender,
            kind: 'Tool',
            title,
            titleSegments,
            status: lines > 0 ? `${lines} line${lines === 1 ? '' : 's'}` : '',
            bodyLines: [],
            open: cardOpen,
            railColor: color,
            parentFrame: actorTreeFrame,
            renderBody(inner) {
              if (cleanBody) builder.pushMarkdown(message.id + '-body', cleanBody, senderColor, inner, senderColor);
            },
          });
        } else if (message.role === 'assistant' && !message.kind && message.text.trim()) {
          const lines = message.text.trim().split(/\r?\n/);
          const firstLine = lines[0]!.trim();
          const isNextTool = nextItem && (nextItem.type === 'group' || nextItem.type === 'edits' || (nextItem.type === 'stage' || nextItem.type === 'message' && (nextItem.message.kind === 'tool' || (nextItem.message.role as string) === 'tool')));
          const symbol = roles[activity.ownerId]?.symbol || '◈';
          const isExplicitPhase = firstLine.startsWith(symbol) || /^#{1,4}\s+/.test(firstLine);
          if (isNextTool && isExplicitPhase && firstLine.length <= 80) {
            const cleanText = firstLine.startsWith(symbol) ? firstLine.slice(symbol.length).trim() : firstLine.replace(/^#{1,4}\s+/, '').trim();
            builder.pushFramedLine(message.id + '-intent', color, [
              {text: symbol + ' ', color: roleColor, bold: true, selectionKey: message.id + ':intent_symbol'},
              {text: cleanText, color: palette.fg, bold: false, selectionKey: message.id + ':intent_text'}
            ], frame);
            currentPhaseFrame = insetRailFrame(frame, roleColor);
            inPhase = true;
            if (lines.length > 1) {
              const remaining = lines.slice(1).join('\n').trim();
              if (remaining) {
                builder.pushMarkdown(message.id + '-body', remaining, color, currentPhaseFrame, roleColor);
              }
            }
          } else {
            context.renderMessage(message, inPhase ? currentPhaseFrame : actorTreeFrame);
          }
        } else if (message.kind === 'tool' || (message.role as string) === 'tool') {
          context.renderMessage(message, inPhase ? currentPhaseFrame : actorTreeFrame);
        } else {
          context.renderMessage(message, inPhase ? currentPhaseFrame : actorTreeFrame);
        }
      }
      if (context.detailed) for (const request of context.pending) context.renderInteraction(request, actorTreeFrame);
      if (['failed', 'cancelled'].includes(activity.status)) builder.pushProse(activity.activityId + '-error', activity.detail, palette.muted, 'body', actorTreeFrame, undefined, palette.muted);
    }});
}
const base = createToolUI(['actor', 'ownerId']);
function dispatchTarget(call: ToolCall): string {
  try {
    const args: unknown = JSON.parse(call.arguments);
    const tasks = args && typeof args === 'object' ? (args as Record<string, unknown>).tasks : undefined;
    const owners = Array.isArray(tasks) ? tasks.map(task => task && typeof task === 'object' ? (task as Record<string, unknown>).ownerId : undefined).filter((owner): owner is string => typeof owner === 'string') : [];
    if (owners.length) return 'Actor(' + [...new Set(owners)].join(', ') + ')';
  } catch {}
  return callLabel('Actor', ['actor', 'ownerId'])(call);
}

/** The dispatch call draws nothing on success (the actor card is the surface); a failed dispatch shows one quiet row. */
const visible: ToolUI = {...base, renderActivity, title(call: Parameters<typeof base.title>[0]) {
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

export const UI: ToolUI = hiddenToolUI(visible, dispatchTarget);
