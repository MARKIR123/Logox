import {basename} from 'node:path';
import {type Activity, type Interaction, type Message, currentTaskProgress} from '../../../runtime/contracts.js';
import type {ThinkingRequest} from '../../../tui/timeline/thinking-groups.js';
import {type ActorStyles} from '../../../tui/appearance/actor-style.js';
import type {ToolFrame} from '../../ui-types.js';
import {ownerColor} from '../../../tui/appearance/actor-style.js';
import {palette} from '../../../tui/appearance/theme.js';
import {appendActorCard, type createBuilder, type SceneSegment, insetRailFrame} from '../../../tui/timeline/scene.js';
import {stepElapsed} from '../../../runtime/steps.js';
import {createToolUI, messageToolCall} from '../../../tui/timeline/tool-ui.js';

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
  renderMessage(message: Message, frame: ToolFrame): void;
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

const roleVerbs: Record<string, string> = {
  logox: 'Inspect',
  techne: 'Probe',
  kalon: 'Observe',
  aletheia: 'Audit',
};

function isInspectionMessage(m: Message): {isInspect: boolean; file?: string | undefined} {
  if (m.kind !== 'tool') return {isInspect: false};
  if (m.step?.disposition || m.step?.state === 'failed') return {isInspect: false};
  const call = m.step?.call ?? messageToolCall(m);
  if (!call) return {isInspect: false};
  const name = call.name.toLowerCase();
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments); } catch {}
  const file = typeof args.file_path === 'string' ? args.file_path
    : typeof args.path === 'string' ? args.path
    : typeof args.pattern === 'string' ? args.pattern
    : undefined;
  if (name === 'read' || name === 'glob' || name === 'grep') return {isInspect: true, file};
  if (name === 'mcp') {
    const mcpTool = String(args.tool ?? '').toLowerCase();
    if (mcpTool.includes('navigate') || mcpTool.includes('screenshot') || mcpTool.includes('read') || mcpTool.includes('console') || mcpTool.includes('evaluate')) {
      return {isInspect: true, file: typeof args.url === 'string' ? args.url : file};
    }
  }
  return {isInspect: false};
}

export function renderActivity(context: ActorActivityContext): void {
  const {builder, activity, roles, messages} = context;
  const color = context.railColor ?? ownerColor(activity.ownerId, roles);
  const roleColor = ownerColor(activity.ownerId, roles);
  const actionVerb = roleVerbs[activity.ownerId.toLowerCase()] ?? 'Inspect';

  appendActorCard(builder, {id: activity.activityId, owner: activity.ownerId, roles,
    task: context.title, status: context.status, active: context.active, open: context.open, railColor: color,
    ...(['queued', 'running', 'waiting_input', 'paused'].includes(activity.status) ? {stop: context.stop} : {}),
    renderBody(frame) {
      const actorTreeFrame = insetRailFrame(frame, roleColor);
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
          open: goalOpen,
          railColor: color,
          parentFrame: actorTreeFrame,
          renderBody(inner) {
            builder.pushMarkdown(goalId + '-body', context.originalPrompt, color, inner);
          },
        });
      }
      const lastAssistantMessage = messages.filter(m => m.role === 'assistant' && !m.kind).at(-1);
      const isReportDeliveredInTranscript = lastAssistantMessage && activity.summary?.report &&
        (lastAssistantMessage.text.trim() === activity.summary.report.trim() ||
         lastAssistantMessage.text.includes(activity.summary.report.trim().slice(0, 80)));

      if (activity.summary && !isReportDeliveredInTranscript) {
        builder.pushMarkdown(activity.activityId + '-summary', activity.summary.report, color, actorTreeFrame);
      }

      // Group consecutive inspection tools (Read, Glob, Grep, read-only MCP)
      const renderableItems: Array<
        | {type: 'message'; message: Message}
        | {type: 'inspect_group'; id: string; messages: Message[]; files: string[]; elapsedMs: number; running: boolean; error: boolean}
      > = [];

      let currentGroup: {messages: Message[]; files: string[]; elapsedMs: number; running: boolean; error: boolean} | null = null;

      const flushGroup = () => {
        if (!currentGroup) return;
        if (currentGroup.messages.length >= 2) {
          const first = currentGroup.messages[0]!;
          renderableItems.push({
            type: 'inspect_group',
            id: first.id + '-group',
            messages: currentGroup.messages,
            files: [...new Set(currentGroup.files.filter(Boolean))],
            elapsedMs: currentGroup.elapsedMs,
            running: currentGroup.running,
            error: currentGroup.error,
          });
        } else {
          for (const m of currentGroup.messages) {
            renderableItems.push({type: 'message', message: m});
          }
        }
        currentGroup = null;
      };

      const nextToolIsInspect = (startIndex: number): boolean => {
        for (let j = startIndex; j < messages.length; j++) {
          const m = messages[j]!;
          if ((m.role as string) === 'context') continue;
          if (m.role === 'user') return false;
          if (m.inputKind === 'collaboration' || m.inputKind === 'collaboration_interrupt') return false;
          if (m.role === 'assistant' && !m.kind && m.text && m.text.trim().length > 60) return false;
          const inspect = isInspectionMessage(m);
          if (inspect.isInspect) return true;
          if (m.kind === 'tool' || (m.role as string) === 'tool') return false;
        }
        return false;
      };

      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        if (message.inputKind === 'collaboration_interrupt' || message.inputKind === 'collaboration') {
          flushGroup();
          renderableItems.push({type: 'message', message});
          continue;
        }
        if (!context.detailed || message.role === 'user' || (message.role === 'system' && ['failed', 'cancelled'].includes(activity.status))) {
          continue;
        }
        if ((message.role as string) === 'context') {
          continue;
        }
        if (message.role === 'assistant' && !message.kind && (!message.text || !message.text.trim())) {
          continue;
        }
        const inspect = isInspectionMessage(message);
        if (inspect.isInspect) {
          currentGroup ??= {messages: [], files: [], elapsedMs: 0, running: false, error: false};
          currentGroup.messages.push(message);
          if (inspect.file) currentGroup.files.push(inspect.file);
          currentGroup.elapsedMs += message.step?.elapsedMs ?? 0;
          if (message.step?.state === 'running') currentGroup.running = true;
          if (message.step?.state === 'failed' || message.step?.disposition === 'error') currentGroup.error = true;
        } else {
          if (currentGroup && currentGroup.messages.length > 0 && nextToolIsInspect(index)) {
            continue;
          }
          flushGroup();
          renderableItems.push({type: 'message', message});
        }
      }
      flushGroup();

      let currentPhaseFrame: ToolFrame = actorTreeFrame;
      let inPhase = false;

      for (let i = 0; i < renderableItems.length; i++) {
        const item = renderableItems[i]!;
        const nextItem = renderableItems[i + 1];

        if (item.type === 'inspect_group') {
          if (!inPhase) {
            const symbol = roles[activity.ownerId]?.symbol || '◈';
            const subTitle = currentTaskProgress(activity.progress)?.label?.trim();
            const autoIntent = (subTitle && subTitle !== activity.taskTitle?.trim())
              ? subTitle
              : `${actionVerb} relevant files and project structure`;
            builder.pushFramedLine(item.id + '-auto-intent', color, [
              {text: symbol + ' ', color: roleColor, bold: true, selectionKey: item.id + ':intent_symbol'},
              {text: autoIntent, color: palette.fg, bold: false, selectionKey: item.id + ':intent_text'}
            ], frame);
            currentPhaseFrame = insetRailFrame(frame, roleColor);
            inPhase = true;
          }
          const groupOpen = context.isOpen ? context.isOpen(item.id) : false;
          const displayFiles = item.files.slice(0, 3).map(f => {
            const leaf = f.replace(/\\/g, '/').split('/').pop() || f;
            return leaf.length > 25 ? leaf.slice(0, 22) + '...' : leaf;
          }).join(', ') + (item.files.length > 3 ? '...' : '');
          const duration = item.elapsedMs > 0 ? ` · ${(item.elapsedMs / 1000).toFixed(1)}s` : '';
          const groupTitle = `${actionVerb} ${item.files.length || item.messages.length} files${displayFiles ? ' · ' + displayFiles : ''}${duration}`;

          const titleSegments: SceneSegment[] = [
            {text: (groupOpen ? '▾ ' : '▸ ') + actionVerb + ' ', color: item.running ? roleColor : palette.muted, bold: item.running, selectionKey: item.id + ':arrow'},
            {text: `${item.files.length || item.messages.length} files`, color: item.running ? palette.fg : palette.muted, bold: item.running, selectionKey: item.id + ':count'},
            ...(displayFiles ? [{text: ' · ', color: palette.muted}, {text: displayFiles, color: item.running ? palette.fg : palette.muted, selectionKey: item.id + ':files'}] : []),
          ];

          builder.pushOrdinaryCard({
            id: item.id,
            ownerId: activity.ownerId,
            kind: 'Tool',
            title: groupTitle,
            titleSegments,
            status: duration.replace(/^ · /, ''),
            bodyLines: [],
            open: groupOpen,
            railColor: roleColor,
            parentFrame: inPhase ? currentPhaseFrame : frame,
            ...(item.running ? {step: {state: 'running' as const, title: groupTitle, elapsedMs: item.elapsedMs}} : {}),
            renderBody(inner) {
              for (const m of item.messages) {
                context.renderMessage(m, inner);
              }
            },
          });
          continue;
        }

        const message = item.message;
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
            railColor: senderColor,
            parentFrame: actorTreeFrame,
            renderBody(inner) {
              if (cleanBody) builder.pushMarkdown(message.id + '-body', cleanBody, senderColor, inner);
            },
          });
        } else if (message.role === 'assistant' && !message.kind && message.text.trim()) {
          const lines = message.text.trim().split(/\r?\n/);
          const firstLine = lines[0]!.trim();
          const isNextTool = nextItem && (nextItem.type === 'inspect_group' || (nextItem.type === 'message' && (nextItem.message.kind === 'tool' || (nextItem.message.role as string) === 'tool')));
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
                builder.pushMarkdown(message.id + '-body', remaining, color, currentPhaseFrame);
              }
            }
          } else {
            context.renderMessage(message, inPhase ? currentPhaseFrame : actorTreeFrame);
          }
        } else if (message.kind === 'tool' || (message.role as string) === 'tool') {
          if (!inPhase) {
            const call = message.step?.call ?? messageToolCall(message);
            const toolName = call?.name?.toLowerCase() ?? '';
            const symbol = roles[activity.ownerId]?.symbol || '◈';
            const subTitle = currentTaskProgress(activity.progress)?.label?.trim();
            let autoIntent = (subTitle && subTitle !== activity.taskTitle?.trim()) ? subTitle : 'Starting operation';
            if (!subTitle || subTitle === activity.taskTitle?.trim()) {
              if (toolName === 'edit' || toolName === 'write') {
                autoIntent = 'Implementing and adjusting code';
              } else if (toolName === 'shell') {
                autoIntent = 'Running commands and verifying tests';
              } else if (toolName === 'mcp') {
                autoIntent = 'Verifying browser view and interaction';
              }
            }
            builder.pushFramedLine(message.id + '-auto-intent', color, [
              {text: symbol + ' ', color: roleColor, bold: true, selectionKey: message.id + ':intent_symbol'},
              {text: autoIntent, color: palette.fg, bold: false, selectionKey: message.id + ':intent_text'}
            ], frame);
            currentPhaseFrame = insetRailFrame(frame, roleColor);
            inPhase = true;
          }
          context.renderMessage(message, currentPhaseFrame);
        } else {
          context.renderMessage(message, inPhase ? currentPhaseFrame : actorTreeFrame);
        }
      }
      if (context.detailed) for (const request of context.pending) context.renderInteraction(request, actorTreeFrame);
      if (['failed', 'cancelled'].includes(activity.status)) builder.pushProse(activity.activityId + '-error', activity.detail, palette.muted, 'body', actorTreeFrame, undefined, palette.muted);
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
