import {currentTaskProgress, type Interaction, type Message, type RuntimeSnapshot} from '../../runtime/contracts.js';
import {isTimelineMessage} from '../../runtime/system-events.js';
import {choiceStyle, type QuestionDraft} from '../interactions/choice-style.js';
import {ownerColor, type ActorStyles} from '../appearance/actor-style.js';
import {palette} from '../appearance/theme.js';
import {cast} from '../../actors/ensemble.js';
import {createBuilder, insetFrame, type SceneAction, type SceneRow} from './scene.js';
import {getToolUI, isVisibleToolMessage} from '../../tools/ui-registry.js';
import {messageToolCall, renderDefaultTool} from './tool-ui.js';
import {clipLine} from '../terminal/text.js';
import stringWidth from 'string-width';
import {inputKind} from '../../runtime/provenance.js';
import {thinkingRequests} from './thinking-groups.js';
import {stepElapsed} from '../../runtime/steps.js';
import {themeRevision} from '../../config/theme-palette.js';
import {stripNarration} from '../../runtime/narration.js';
import {groupToolMessages, type ToolGroup} from './tool-groups.js';
import {pushGroupStage, pushToolGroupCard} from './group-row.js';

export interface StageControls {readonly stopping?: ReadonlySet<string>; readonly focusedStop?: string; readonly hoveredStop?: string; readonly focusedQuestionId?: string}

const statuses: Record<string, string> = {
  queued: 'Queued', running: 'Running', waiting_input: 'Awaiting answer', completed: 'Completed',
  failed: 'Failed', cancelled: 'Stopped', paused: 'Paused',
};
function isTimelineError(message: Message): boolean {
  return message.role === 'system' && !message.activityId && message.systemPresentation === 'timeline' &&
    (message.systemEventKind === 'command_error' || message.systemEventKind === 'model_error');
}
function activityTitle(activity: RuntimeSnapshot['activities'][number], activityMessages?: readonly Message[]): string {
  const reason = activity.status === 'failed' ? activity.detail.split('\n')[0]?.replace(/^Failure reason: /, '').trim() : '';
  if (reason) return reason;
  const current = currentTaskProgress(activity.progress);
  const mainTitle = activity.taskTitle?.trim();
  if (['running', 'waiting_input', 'paused'].includes(activity.status)) {
    const activeTool = activityMessages?.findLast(m => (m.kind === 'tool' || (m.role as string) === 'tool') && m.step &&
      ['running', 'waiting'].includes(m.step.state) &&
      !['LoadTools', '_FinishRound', '_GitStatus', 'UpdateTaskProgress'].includes(m.step.call?.name ?? ''))?.step?.title;
    const subTitle = current?.label?.trim() || (mainTitle ? activeTool?.trim().slice(0, 60) : undefined);
    if (mainTitle && subTitle && subTitle !== mainTitle) return `${mainTitle} · ${subTitle}`;
    return mainTitle || subTitle || activity.summary?.title || activity.title;
  }
  return mainTitle || activity.summary?.title || activity.title;
}
function activityStatus(activity: RuntimeSnapshot['activities'][number]): string {
  return activity.status === 'running' && ['Resuming', 'Adjusting'].includes(activity.stage)
    ? activity.stage : activity.stage === 'History' ? 'History' : statuses[activity.status] ?? activity.status;
}
// Runtime messages are immutable; streaming replaces only the changed message.
// Weak ownership releases old streams/history; keep at most two layouts per message on resize.
const messageLayouts = new WeakMap<Message, Map<string, readonly SceneRow[]>>();
// Like Claude Code's Messages grouping useMemo, semantic projection depends on
// immutable messages/activity state, never on viewport, hover or fold state.
const projections = new WeakMap<RuntimeSnapshot, Map<string, ReturnType<typeof projectMessages>>>();
function projectMessages(snapshot: RuntimeSnapshot, sessionId: string, view: string) {
  const candidates = snapshot.messages.filter(message => message.sessionId === sessionId && (view === 'logox' || message.ownerId === view) &&
    isTimelineMessage(message) && isVisibleToolMessage(message) && !(message.ownerId === 'logox' && message.role === 'user' && inputKind(message) === 'actor'));
  // Narration-only messages are never drawn, but they still mark stage changes for tool grouping.
  const messages = candidates.filter(message => !(message.role === 'assistant' && !message.kind && !stripNarration(message.text).trim()));
  const activities = new Map(snapshot.activities.filter(item => item.sessionId === sessionId).map(item => [item.activityId, item]));
  const grouped = new Map<string, Message[]>();
  for (const message of messages) if (message.activityId) {
    const group = grouped.get(message.activityId) ?? [];
    group.push(message); grouped.set(message.activityId, group);
  }
  const thinking = thinkingRequests(messages);
  // Actor cards also receive narration-only messages so a `⏵` stage can label the next tool group.
  const staged = new Map<string, Message[]>();
  for (const message of candidates) if (message.activityId) {
    const group = staged.get(message.activityId) ?? [];
    group.push(message); staged.set(message.activityId, group);
  }
  return {messages, candidates, staged, activities, grouped, thinking};
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
/** Uses the demo's row builder but reads only real messages and activities. */
export function buildStageRows(snapshot: RuntimeSnapshot, sessionId: string, view: string, width: number,
  folds: Readonly<Record<string, boolean>>, hovered: string | null,
  responses: Readonly<Record<string, QuestionDraft>> = {}, roles: ActorStyles = cast, controls: StageControls = {}): readonly SceneRow[] {
  const builder = createBuilder(width, hovered, roles);
  const {messages, candidates, staged, activities, grouped, thinking} = messageProjection(snapshot, sessionId, view);
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
  // The rail belongs to the surface, not the subagent: everything shown in the
  // Director's timeline is orchestrated by the Director, so it carries the
  // Director accent. An actor's own window keeps that actor's color.
  const viewColor = view === 'logox' ? palette.accent : ownerColor(view, roles);
  const railFor = (ownerId: string) => ownerId === 'anamnesis' ? palette.anamnesis : viewColor;
  const body = (message: Message, frame?: Frame) => {
    const activity = message.activityId ? activities.get(message.activityId) : undefined;
    const request = thinking.get(message.id);
    if (request) {
      const hasContent = Boolean(message.text.trim() || (request.tokens && request.tokens > 0) || request.step.note);
      if (request.step.state === 'completed' && !hasContent) {
        return;
      }
      builder.pushOrdinaryCard({id: request.id, ownerId: message.ownerId, kind: 'Thinking', title: 'Thinking', bodyLines: [],
        step: request.step, tokens: request.tokens, open: open(request.id), railColor: railFor(message.ownerId),
        ...(frame ? {parentFrame: frame} : {}),
        renderBody(inner) {
          if (request.step.note) builder.pushProse(message.id + '-note', request.step.note, railFor(message.ownerId), 'body', inner, undefined, palette.muted);
          if (message.text) builder.pushProse(message.id + '-body-0', message.text, railFor(message.ownerId), 'body', inner);
          if (request.step.state === 'cancelled') builder.pushProse(request.id + '-stopped', 'Stopped', palette.muted, 'body', inner);
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
    const actorColor = railFor(message.ownerId);
    const rail = isUser ? palette.user : isSystem ? palette.system : actorColor;
    const systemError = isTimelineError(message);
    const frameKey = frame ? frame.innerWidth + ':' + (frame.bg ?? '') : '';
    const key = JSON.stringify([themeRevision(), width, frameKey, rail, Boolean((message.kind || systemError) && open(message.id)), hovered === message.id]);
    let layouts = messageLayouts.get(message);
    if (!layouts) {layouts = new Map(); messageLayouts.set(message, layouts);}
    let rows = layouts.get(key);
    if (!rows) {
      const chunk = createBuilder(width, hovered, roles);
      if (systemError) {
        const innerWidth = Math.max(1, (frame?.innerWidth ?? chunk.contentWidth) - 4);
        const kind = clipLine('Error', innerWidth);
        const summary = (message.systemTitle || message.text).split(/\r?\n/).find(line => line.trim())?.trim() || 'Request failed';
        chunk.pushOrdinaryCard({id: message.id, kind,
          title: clipLine(summary, Math.max(0, innerWidth - stringWidth(kind) - 3)), bodyLines: [],
          open: open(message.id), railColor: rail, toneColor: palette.error, ...(frame ? {parentFrame: frame} : {}),
          renderBody(inner) {chunk.pushProse(message.id, message.text, rail, 'body', inner, undefined, palette.error);}});
      } else if (message.kind === 'tool' || (message.role as string) === 'tool') {
        const call = messageToolCall(message);
        const ui = getToolUI(call?.name ?? '');
        (ui.render ?? renderDefaultTool)({builder: chunk, message, ...(call ? {call} : {}),
          ...(frame ? {frame} : {}), open: open(message.id), accent: rail});
      } else if (message.kind) chunk.pushOrdinaryCard({id: message.id, ownerId: message.ownerId, kind: 'Thinking',
        title: message.step?.title ?? 'Thinking', bodyLines: [message.text],
        ...(message.step ? {step: message.step} : {}),
        open: open(message.id), railColor: rail, ...(frame ? {parentFrame: frame} : {})});
      else if (message.role === 'assistant' || (message.role === 'user' && (inputKind(message) === 'director' || inputKind(message) === 'collaboration'))) chunk.pushMarkdown(message.id, stripNarration(message.text), rail, frame);
      else chunk.pushProse(message.id, stripNarration(message.text), rail, 'body', frame, undefined, isSystem ? palette.system : undefined);
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
    // The focused question is rendered in the dedicated panel above the composer.
    if (request.requestId === controls.focusedQuestionId) return;
    const rail = railFor(request.ownerId);
    const draft = responses[request.requestId] ?? {questionIndex: 0, selected: request.kind === 'permission' ? 1 : 0, text: '', error: ''};
    if (request.kind === 'question') {
      getToolUI('AskUserQuestion').interaction?.render({builder, request, draft, answers: {},
        ...(parent ? {frame: parent} : {}), open: open(request.requestId), accent: rail});
      return;
    }
    builder.pushOrdinaryCard({id: request.requestId, kind: 'Permission', title: request.title, status: 'Awaiting answer', bodyLines: [], open: open(request.requestId), railColor: rail,
      ...(parent ? {parentFrame: parent} : {})});
    if (!open(request.requestId)) return;
    const frame = insetFrame(parent ?? {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth}, parent?.bg);
    builder.pushBlank(rail, frame);
    builder.pushProse(request.requestId + '-question', request.reason + '\n' + request.tool + ' · ' + JSON.stringify(request.arguments, null, 2), rail, 'body', frame);
    const options = [{label: 'Allow once', description: 'Allow this tool run only once.'}, {label: 'Deny (default)', description: 'Keep the suggestion; do not run the tool.'}];
    for (const [index, option] of options.entries()) {
      const style = choiceStyle(index === draft.selected, rail);
      const action: SceneAction = {kind: 'select_answer', requestId: request.requestId, value: String(index)};
      builder.pushBlank(rail, frame, action);
      builder.pushFramedLine(request.requestId + '-option-' + index, rail, [
        {text: style.marker, color: style.markerColor, selectionOffset: 0},
        {text: option.label, color: style.color, selectionOffset: style.marker.length},
      ], frame, action);
      builder.pushProse(request.requestId + '-description-' + index, ' '.repeat(style.indent) + option.description, rail, 'body', frame, action, style.descriptionColor);
    }
    builder.pushBlank(rail, frame);
    if (draft.error) builder.pushProse(request.requestId + '-error', draft.error, rail, 'body', frame, undefined, palette.error);
    builder.pushProse(request.requestId + '-confirm', 'Enter Confirm · Esc Later · Tab Switch focus', rail, 'body', frame,
      {kind: 'confirm_answer', requestId: request.requestId}, rail);
    builder.pushBlank(rail, frame);
  };
  // Runs of collapsible calls (Read/Grep/Glob/Shell/browser reads) fold into one group row; actor cards split runs.
  const groupAt = new Map<string, ToolGroup>();
  const absorbed = new Set<string>();
  {
    let run: Message[] = [];
    const flushRun = () => {
      for (const item of groupToolMessages(run, {stages: true})) if (item.type === 'group') {
        groupAt.set(item.messages[0]!.id, item);
        for (const member of item.messages.slice(1)) absorbed.add(member.id);
      }
      run = [];
    };
    for (const message of candidates) {
      if (message.activityId && activities.get(message.activityId)?.kind === 'actor') flushRun(); else run.push(message);
    }
    flushRun();
  }
  for (const message of messages) {
    const activity = message.activityId ? activities.get(message.activityId) : undefined;
    const actor = activity?.kind === 'actor';
    if (!actor && (absorbed.has(message.id) || groupAt.has(message.id))) {
      const group = groupAt.get(message.id);
      if (group) {
        const rail = railFor(message.ownerId);
        pushGroupStage(builder, group, rail, ownerColor(message.ownerId, roles), roles[message.ownerId]?.symbol ?? '◈');
        pushToolGroupCard(builder, group, {ownerId: message.ownerId, open: open(group.id), railColor: rail, verbs: roles[message.ownerId]?.activityVerbs,
          renderChild: (child, inner) => body(child, inner)});
      }
      if (activity && grouped.get(activity.activityId)?.at(-1)?.id === message.id) failure(activity.activityId);
      continue;
    }
    if (!message.kind && (message.role === 'system' || message.role === 'notice') && activity && ['failed', 'cancelled'].includes(activity.status) && !actor) {
      if (grouped.get(activity.activityId)?.at(-1)?.id === message.id) failure(activity.activityId);
      continue;
    }
    if (view === 'logox' && actor && activity) {
      if (seen.has(activity.activityId)) continue;
      seen.add(activity.activityId);
      if (!builder.rows.at(-1)?.action?.owner) builder.pushBlank(viewColor);
      getToolUI('Actor').renderActivity?.({builder, activity, roles, railColor: viewColor, title: activityTitle(activity, grouped.get(activity.activityId)), status: activityStatus(activity),
        active: animated(activity), open: open(activity.activityId), isOpen: open, stop: activeStop(activity.activityId),
        messages: staged.get(activity.activityId) ?? [], pending: requests.get(activity.activityId) ?? [],
        thinking, originalPrompt: actorGoal(activity), detailed: true, renderMessage: body, renderInteraction: interaction});
      continue;
    }
    if (actor && activity && !seen.has(activity.activityId)) {
      seen.add(activity.activityId);
      if (view !== 'logox' && activity.status === 'completed') {
        // In an actor's own thread, completed tasks skip the self-referencing outer Actor card and show the conversation body directly.
      } else {
        getToolUI('Actor').renderActivity?.({builder, activity, roles, railColor: viewColor, title: activityTitle(activity, grouped.get(activity.activityId)), status: activityStatus(activity),
          active: animated(activity), open: open(activity.activityId), isOpen: open, stop: activeStop(activity.activityId),
          messages: staged.get(activity.activityId) ?? [], pending: [], thinking, originalPrompt: actorGoal(activity),
          detailed: false, renderMessage: body, renderInteraction: interaction});
      }
    }
    if (actor && activity && view !== 'logox' && message.role === 'system' && ['failed', 'cancelled'].includes(activity.status)) continue;
    if (message.role === 'user') {
      const source = inputKind(message);
      if (source === 'collaboration' || source === 'collaboration_interrupt') {
        const match = /^\[(?:Message|Broadcast) from ([^\]·]+?)(?: · ([^\]]+))?\]\r?\n?([\s\S]*)$/u.exec(message.text);
        const rawSender = (match?.[1]?.trim() || message.source || 'peer').toLowerCase();
        const role = roles[rawSender];
        const senderLabel = role ? `${role.symbol} ${role.name}` : rawSender;
        const summary = match?.[2]?.trim() || '';
        const cleanBody = (match ? match[3]! : message.text).trim();
        const lines = cleanBody ? cleanBody.split(/\r?\n/).length : 0;
        const isInterrupt = source === 'collaboration_interrupt';
        const senderColor = isInterrupt ? palette.directorIntervention : ownerColor(rawSender, roles);
        const prefix = isInterrupt ? 'Interrupt from ' : 'Message from ';
        const title = `${prefix}${senderLabel}${summary ? ` · ${summary}` : ''}`;
        builder.pushBlank(viewColor);
        builder.pushOrdinaryCard({
          id: message.id,
          ownerId: rawSender,
          kind: 'Tool',
          title,
          titleSegments: [
            {text: prefix, color: palette.muted, selectionKey: message.id + ':title', selectionOffset: 0},
            {text: senderLabel, color: senderColor, bold: true, selectionKey: message.id + ':title_sender'},
            ...(summary ? [{text: ` · ${summary}`, color: palette.fg, selectionKey: message.id + ':title_summary'}] : []),
          ],
          status: lines > 0 ? `${lines} line${lines === 1 ? '' : 's'}` : '',
          bodyLines: [],
          open: open(message.id),
          railColor: senderColor,
          renderBody(inner) {
            if (cleanBody) builder.pushMarkdown(message.id + '-body', cleanBody, senderColor, inner);
          },
        });
        continue;
      }
      builder.pushBlank(viewColor);
      const queued = source === 'human' && activity && ['queued', 'paused'].includes(activity.status);
      builder.pushTurnHeader(message.id + '-who', source === 'director' ? message.source ?? message.ownerId : 'user',
        queued ? 'Queued' : source === 'director' ? 'Assignment' : message.source);
      body(message);
    } else {
      if (!message.kind) {
        builder.pushBlank(viewColor);
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
      builder.pushOrdinaryCard({id: activity.activityId, kind: 'Anamnesis', title: activity.stage,
        status: statuses[activity.status] ?? activity.status, bodyLines: [activity.detail], ownerId: 'anamnesis',
        open: open(activity.activityId), railColor: palette.accent});
    } else if (!grouped.has(activity.activityId) && activity.ownerId === view) {
      failure(activity.activityId);
    }
  }
  return builder.rows;
}
