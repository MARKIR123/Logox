import {DIRECTOR_ID, isDirector} from '../../runtime/director-id.js';
import {currentTaskProgress, type Interaction, type Message, type RuntimeSnapshot, type Step} from '../../runtime/contracts.js';
import {isOutageWake} from '../../runtime/outage.js';
import {isTimelineMessage} from '../../runtime/system-events.js';
import {choiceStyle, type QuestionDraft} from '../interactions/choice-style.js';
import {ownerColor, ownerHeader, type ActorStyles} from '../appearance/actor-style.js';
import {approvalHint, approvalModel, noteSegments, optionLabelWidth, optionSegments, riskSegments, targetSegments} from '../interactions/approval-view.js';
import {palette} from '../appearance/theme.js';
import {cast} from '../../actors/ensemble.js';
import {compactParagraphs, createBuilder, insetFrame, type FrameWrap, type RowBuilder, type SceneAction, type SceneRow, type SceneSegment, type TurnActivity} from './scene.js';
import {CANCELLABLE_TOOLS, expanderId, pushExpander, TOOL_BODY_LINES} from './tool-card.js';
import {faintColor} from '../appearance/colors.js';
import wrapAnsi from 'wrap-ansi';
import {getToolUI, isVisibleToolMessage} from '../../tools/ui-registry.js';
import {hiddenFromView, pairSendMessages} from '../../tools/coordination/SendMessageTool/pairing.js';
import {messageToolCall, renderDefaultTool} from './tool-ui.js';
import {clipLine} from '../terminal/text.js';
import stringWidth from 'string-width';
import {inputKind} from '../../runtime/provenance.js';
import {thinkingRequests} from './thinking-groups.js';
import {stepElapsed} from '../../runtime/steps.js';
import {themeRevision} from '../../config/theme-palette.js';
import {uiSettings} from '../../config/ui-settings.js';
import {userLabelRevision} from '../../config/user-profile.js';
import {extractNarration, stripNarration} from '../../runtime/narration.js';
import {groupToolMessages, type EditRun, type StageLine, type ToolGroup} from './tool-groups.js';
import {renderEditRun} from '../../tools/EditTool/UI.js';
import {pushStageLine, pushToolGroupCard} from './group-row.js';

/** Opens each thought in a thinking body (Claude Code's thinking marker); continuation rows hang under the text. */
const THOUGHT_MARK = '∴ ';

export interface StageControls {readonly stopping?: ReadonlySet<string>; readonly focusedStop?: string; readonly hoveredStop?: string; readonly focusedQuestionId?: string}

const statuses: Record<string, string> = {
  queued: 'Queued', running: 'Running', waiting_input: 'Awaiting answer', completed: 'Completed',
  failed: 'Failed', cancelled: 'Stopped', paused: 'Paused',
};
function isTimelineError(message: Message): boolean {
  return message.role === 'system' && !message.activityId && message.systemPresentation === 'timeline' &&
    (message.systemEventKind === 'command_error' || message.systemEventKind === 'model_error');
}
/** `<main title> · <subtitle>`: while running the subtitle is a temporary state (`override`) or else the current `⏵` stage; once finished it keeps the last stage. Never a tool title. */
function activityTitle(activity: RuntimeSnapshot['activities'][number], activityMessages?: readonly Message[], override?: string): string {
  const reason = activity.status === 'failed' ? activity.detail.split('\n')[0]?.replace(/^Failure reason: /, '').trim() : '';
  if (reason) return reason;
  const running = ['running', 'waiting_input', 'paused'].includes(activity.status);
  const mainTitle = activity.taskTitle?.trim();
  const narrated = activityMessages?.findLast(m => m.role === 'assistant' && !m.kind && extractNarration(m.text))?.text;
  const subTitle = (running ? override : undefined) || (narrated ? extractNarration(narrated)?.narration : undefined) ||
    (running ? currentTaskProgress(activity.progress)?.label?.trim() : undefined);
  if (mainTitle && subTitle && subTitle !== mainTitle) return `${mainTitle} · ${subTitle}`;
  return mainTitle || (running ? subTitle : undefined) || activity.summary?.title || activity.title;
}
/** The retry counter the agent loop reports as `Connection interrupted. Retrying (1/5)...`. */
function retryLabel(detail: string): string {
  const counter = /Retrying \((\d+)\/(\d+)\)/i.exec(detail) ?? /retrying \((\d+)\)/i.exec(detail);
  return counter ? `Retrying (${counter[1]}${counter[2] ? '/' + counter[2] : ''})` : 'Retrying';
}
function activityStatus(activity: RuntimeSnapshot['activities'][number]): string {
  if (activity.status === 'queued' && activity.stage.startsWith('Waiting on ')) return activity.stage;
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
  const candidates = snapshot.messages.filter(message => message.sessionId === sessionId && (isDirector(view) || message.ownerId === view) &&
    isTimelineMessage(message) && isVisibleToolMessage(message) && !hiddenFromView(message, view) && !(isDirector(message.ownerId) && message.role === 'user' && inputKind(message) === 'actor'));
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
  // Asks and their replies are matched over the whole session: a reply in one actor's window needs the question from another's.
  const pairs = pairSendMessages(snapshot.messages.filter(message => message.sessionId === sessionId), snapshot.activities.filter(item => item.sessionId === sessionId));
  return {messages, candidates, staged, activities, grouped, thinking, pairs};
}
function messageProjection(snapshot: RuntimeSnapshot, sessionId: string, view: string) {
  let views = projections.get(snapshot);
  if (!views) {views = new Map(); projections.set(snapshot, views);}
  const key = JSON.stringify([sessionId, view]);
  let projection = views.get(key);
  if (!projection) {projection = projectMessages(snapshot, sessionId, view); views.set(key, projection);}
  return projection;
}
/** Rows of a finished thought shown by `Thinking display: preview` before the `… N more lines` expander. */
const PREVIEW_THOUGHT_LINES = 3;
const thinkingIds = new WeakMap<RuntimeSnapshot, ReadonlySet<string>>();
/** True when `id` is a thought message; `Thinking display` preview and full open those cards by default. */
function isThinkingId(snapshot: RuntimeSnapshot, id: string): boolean {
  let ids = thinkingIds.get(snapshot);
  if (!ids) {ids = new Set(snapshot.messages.filter(message => message.kind === 'thinking').map(message => message.id)); thinkingIds.set(snapshot, ids);}
  return ids.has(id);
}
export function stageFoldOpen(snapshot: RuntimeSnapshot, id: string, folds: Readonly<Record<string, boolean>>): boolean {
  return folds[id] ?? (snapshot.interactions.some(request => request.status === 'pending' && (request.activityId === id || request.requestId === id))
    || uiSettings().thinkingDisplay !== 'folded' && isThinkingId(snapshot, id));
}
/** Uses the demo's row builder but reads only real messages and activities. */
export function buildStageRows(snapshot: RuntimeSnapshot, sessionId: string, view: string, width: number,
  folds: Readonly<Record<string, boolean>>, hovered: string | null,
  responses: Readonly<Record<string, QuestionDraft>> = {}, roles: ActorStyles = cast, controls: StageControls = {}): readonly SceneRow[] {
  const viewColor = isDirector(view) ? palette.accent : ownerColor(view, roles);
  const builder = createBuilder(width, hovered, roles, viewColor);
  const {messages, candidates, staged, activities, grouped, thinking, pairs} = messageProjection(snapshot, sessionId, view);
  const pending = snapshot.interactions.filter(request => request.sessionId === sessionId && request.status === 'pending' && (isDirector(view) || request.ownerId === view));
  const requests = new Map<string, Interaction[]>();
  for (const request of pending) {
    const group = requests.get(request.activityId) ?? [];
    group.push(request); requests.set(request.activityId, group);
  }
  const animated = (activity: RuntimeSnapshot['activities'][number]) => activity.status === 'running' &&
    !['approval', 'question', 'retry'].includes(activity.phase ?? '') && !requests.has(activity.activityId) &&
    !(grouped.get(activity.activityId) ?? []).some(message => message.step?.state === 'waiting');
  /** A temporary state that replaces the stage text while it holds: pending answer/approval, provider retry, compaction. */
  const temporaryState = (ownerId: string, activityId?: string): {label: string} | undefined => {
    const asked = pending.find(request => activityId ? request.activityId === activityId : request.ownerId === ownerId);
    if (asked) return {label: asked.kind === 'permission' ? 'Awaiting approval' : 'Awaiting your answer'};
    const mine = snapshot.activities.filter(item => item.sessionId === sessionId && ['running', 'waiting_input'].includes(item.status) &&
      (activityId ? item.activityId === activityId : item.ownerId === ownerId));
    const compacting = mine.find(item => item.phase === 'compacting' || item.stage === 'Compacting context');
    if (compacting) return {label: 'Compacting context'};
    const retrying = mine.find(item => item.phase === 'retry');
    if (retrying) return {label: retryLabel(retrying.detail)};
    return undefined;
  };
  const seen = new Set<string>();
  type Frame = Parameters<typeof insetFrame>[0];
  const open = (id: string) => stageFoldOpen(snapshot, id, folds);
  // The rail belongs to the surface, not the subagent: everything shown in the
  // Director's timeline is orchestrated by the Director, so it carries the
  // Director accent. An actor's own window keeps that actor's color.
  const railFor = (ownerId: string) => ownerId === 'anamnesis' ? palette.anamnesis : viewColor;
  // Tool-owned nested folds (swarm jobs) change a message layout without changing the message.
  const nestedKey = (message: Message): string => {
    // A tool body's `… N more lines` expander is a fold of its own (`<id>-more`) that also changes the layout.
    const more = (open(message.id + '-more') ? 'm' : '') + (hovered === message.id + '-more' ? 'h' : '');
    const jobs = message.step?.swarm?.jobs;
    if (!jobs) return more;
    const prefix = message.id + '-job-';
    return more + jobs.map((_, index) => (open(prefix + index) ? '1' : '0') + (open(prefix + index + '-more') ? 'm' : '')).join('') + '|' + (hovered?.startsWith(prefix) ? hovered : '');
  };
  const body = (message: Message, frame?: Frame, runArg?: readonly Message[]) => {
    const activity = message.activityId ? activities.get(message.activityId) : undefined;
    // Thinking never draws between tools: each round (and each open actor card) folds it into one row under its header.
    if (thinking.has(message.id)) return;
    const isUser = message.role === 'user' && inputKind(message) !== 'director' && inputKind(message) !== 'collaboration';
    const isSystem = message.role === 'system' || (message.role === 'notice' && (!message.ownerId || message.ownerId === 'system'));
    const actorColor = railFor(message.ownerId);
    const rail = isUser ? palette.user : isSystem ? palette.system : actorColor;
    // Text accents follow who wrote the text, not the surface: an actor's report keeps its colour in the Director window; briefs keep their author's.
    const author = message.role === 'assistant' ? message.ownerId : inputKind(message) === 'collaboration' && message.source ? message.source.toLowerCase() : DIRECTOR_ID;
    const accent = isUser || isSystem ? rail : ownerColor(author, roles);
    const systemError = isTimelineError(message);
    const frameKey = (frame ? frame.innerWidth + ':' + (frame.bg ?? '') : '') + '|' + (frame?.surfaceColor ?? viewColor);
    // A running, stoppable tool draws its `■ Stop` state (stopping, focused, hovered) into the row.
    const stoppable = message.step?.state === 'running' && Boolean(message.step.call) && CANCELLABLE_TOOLS.has(message.step.call!.name);
    const stop = {disabled: controls.stopping?.has(message.id) ?? false, focused: controls.focusedStop === message.id, hovered: controls.hoveredStop === message.id};
    const run = runArg ?? editRuns.get(message.id)?.messages;
    const runKey = run ? run.map(item => item.id + ':' + (item.step?.state ?? '') + ':' + (item.step?.elapsedMs ?? 0) + ':' + item.text.length).join('|') : null;
    const key = JSON.stringify([themeRevision(), userLabelRevision(), width, frameKey, rail, accent, Boolean((message.kind || systemError) && open(message.id)), hovered === message.id, nestedKey(message), pairs.get(message.id) ?? null, stoppable ? stop : null, runKey]);
    let layouts = messageLayouts.get(message);
    if (!layouts) {layouts = new Map(); messageLayouts.set(message, layouts);}
    let rows = layouts.get(key);
    if (!rows) {
      const chunk = createBuilder(width, hovered, roles, viewColor);
      if (systemError) {
        const innerWidth = Math.max(1, (frame?.innerWidth ?? chunk.contentWidth) - 4);
        const kind = clipLine('Error', innerWidth);
        const summary = (message.systemTitle || message.text).split(/\r?\n/).find(line => line.trim())?.trim() || 'Request failed';
        chunk.pushOrdinaryCard({id: message.id, kind,
          title: clipLine(summary, Math.max(0, innerWidth - stringWidth(kind) - 3)), bodyLines: [],
          open: open(message.id), railColor: rail, toneColor: palette.error, ...(frame ? {parentFrame: frame} : {}),
          renderBody(inner) {chunk.pushProse(message.id, message.text, rail, 'body', inner, undefined, palette.error);}});
      } else if (run && run.length > 1) {
        renderEditRun({builder: chunk, message, ...(frame ? {frame} : {}), open: open(message.id), isOpen: open, accent: rail}, run);
      } else if (message.kind === 'tool' || (message.role as string) === 'tool') {
        const call = messageToolCall(message);
        const ui = getToolUI(call?.name ?? '');
        (ui.render ?? renderDefaultTool)({builder: chunk, message, ...(call ? {call} : {}),
          ...(frame ? {frame} : {}), open: open(message.id), isOpen: open, accent: rail, ...(stoppable ? {stop} : {}), ...(pairs.has(message.id) ? {pairing: pairs.get(message.id)!} : {})});
      } else if (message.kind) chunk.pushOrdinaryCard({id: message.id, ownerId: message.ownerId, kind: 'Thinking',
        title: message.step?.title ?? 'Thinking', bodyLines: [compactParagraphs(message.text)],
        ...(message.step ? {step: message.step} : {}),
        open: open(message.id), railColor: rail, ...(frame ? {parentFrame: frame} : {})});
      else if (message.role === 'assistant' || (message.role === 'user' && (inputKind(message) === 'director' || inputKind(message) === 'collaboration'))) chunk.pushMarkdown(message.id, stripNarration(message.text), rail, frame, accent);
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
    if (!activity || !['failed', 'cancelled'].includes(activity.status) || isOutageWake(activity)) return;
    builder.pushBlank(palette.muted);
    const kind = statuses[activity.status] ?? activity.status;
    const room = Math.max(1, builder.contentWidth - 4 - stringWidth(kind) - 3);
    const title = clipLine(activityTitle(activity), room);
    // The first detail line is the title; the body shows the diagnostic lines (provider, model, HTTP status, excerpt) and repeats the title only when it was clipped.
    const [first = '', ...rest] = activity.detail.split('\n');
    const bodyLines = [...title === first.replace(/^Failure reason: /, '').trim() ? [] : [first], ...rest].filter(line => line.trim());
    builder.pushOrdinaryCard({id: activityId, kind, title, bodyLines, open: open(activityId), railColor: palette.muted, toneColor: palette.muted});
  };
  const interaction = (request: Interaction, parent?: Frame) => {
    // The focused question is rendered in the dedicated panel above the composer.
    if (request.requestId === controls.focusedQuestionId) return;
    const rail = railFor(request.ownerId);
    const draft = responses[request.requestId] ?? {questionIndex: 0, selected: 0, text: '', error: ''};
    if (request.kind === 'question') {
      getToolUI('AskUserQuestion').interaction?.render({builder, request, draft, answers: {},
        ...(parent ? {frame: parent} : {}), open: open(request.requestId), accent: rail});
      return;
    }
    const actorName = ownerHeader(request.ownerId, roles).replace(/^\S+\s+/, ''), model = approvalModel(request, actorName);
    builder.pushOrdinaryCard({id: request.requestId, kind: 'Approval', title: actorName + ' wants to run · ' + model.tool, status: 'Awaiting approval', bodyLines: [], open: open(request.requestId), railColor: rail,
      ...(parent ? {parentFrame: parent} : {})});
    if (!open(request.requestId)) return;
    const frame = insetFrame(parent ?? {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth}, parent?.bg);
    const segments = (parts: ReturnType<typeof targetSegments>): SceneSegment[] => parts.map(part => ({text: part.text, color: part.color, ...part.bold ? {bold: true} : {}, ...part.italic ? {italic: true} : {}}));
    builder.pushBlank(rail, frame);
    // The command wraps in full (capped by the model); the reason and mode follow on their own line.
    builder.pushProse(request.requestId + '-target', (model.target.kind === 'shell' ? '$ ' : '') + model.target.text, rail, 'body', frame, undefined, palette.path);
    builder.pushFramedLine(request.requestId + '-risk', rail, segments(riskSegments(model)), frame);
    const labelWidth = optionLabelWidth(model);
    for (const [index, option] of model.options.entries()) {
      const action: SceneAction = {kind: 'select_answer', requestId: request.requestId, value: String(index)};
      builder.pushBlank(rail, frame, action);
      builder.pushFramedLine(request.requestId + '-option-' + index, rail, segments(optionSegments(option, index === draft.selected, labelWidth, rail)), frame, action);
      if (option.id === 'deny' && draft.noting) builder.pushFramedLine(request.requestId + '-note', rail, segments([{text: '    ', color: palette.muted}, ...noteSegments(actorName, draft.text)]), frame, action);
    }
    builder.pushBlank(rail, frame);
    if (draft.error) builder.pushProse(request.requestId + '-error', draft.error, rail, 'body', frame, undefined, palette.error);
    builder.pushProse(request.requestId + '-confirm', approvalHint(draft.noting === true), rail, 'body', frame,
      {kind: 'confirm_answer', requestId: request.requestId}, faintColor());
    builder.pushBlank(rail, frame);
  };
  // Runs of collapsible calls (Read/Grep/Glob/Shell/browser reads) fold into one group row.
  // An actor card draws once, at its activity's first message, so only that message splits a run; later ones draw nothing here.
  const groupAt = new Map<string, ToolGroup>();
  const absorbed = new Set<string>();
  const stageAt = new Map<string, StageLine[]>(); // `⏵` stages, keyed by the first drawn message they precede
  const editRuns = new Map<string, EditRun>(); // merged same-file edits, keyed by the first edit's message id
  const editAbsorbed = new Set<string>();
  {
    const drawn = new Set(messages.map(message => message.id));
    let run: Message[] = [];
    const drawnCards = new Set<string>();
    const flushRun = (boundary?: string) => {
      let waiting: StageLine[] = [];
      const attach = (id: string) => {
        if (!waiting.length) return;
        stageAt.set(id, [...stageAt.get(id) ?? [], ...waiting]); waiting = [];
      };
      for (const item of groupToolMessages(run, {stages: true})) {
        if (item.type === 'stage') waiting.push(item);
        else if (item.type === 'group') {
          attach(item.messages[0]!.id);
          groupAt.set(item.messages[0]!.id, item);
          for (const member of item.messages.slice(1)) absorbed.add(member.id);
        } else if (item.type === 'edits') {
          attach(item.messages[0]!.id);
          editRuns.set(item.messages[0]!.id, item);
          for (const member of item.messages.slice(1)) editAbsorbed.add(member.id);
        } else if (drawn.has(item.message.id)) attach(item.message.id);
      }
      if (boundary) attach(boundary); // a stage right before an actor card
      run = [];
    };
    for (const message of candidates) {
      if (!message.activityId || activities.get(message.activityId)?.kind !== 'actor' || !isDirector(view)) { run.push(message); continue; }
      if (drawnCards.has(message.activityId)) continue;
      drawnCards.add(message.activityId);
      flushRun(message.id);
    }
    flushRun();
  }
  // --- Speaker rounds: one header per speaker turn, with the thinking of the round folded into one row under it. ---
  interface Round {
    readonly who: string; readonly id: string; readonly insertAt: number; readonly since: number;
    readonly thinking: Message[]; readonly messages: Message[]; readonly actors: Map<string, RuntimeSnapshot['activities'][number]>;
  }
  let round: Round | null = null;
  let lastUserTime: number | undefined;
  // 'UpdateTaskProgress' stays for ledgers saved before the tool was removed.
  const hiddenSteps = ['LoadTools', '_FinishRound', '_GitStatus', 'UpdateTaskProgress', 'Actor'];
  let finalRound = false;
  const describeRound = (r: Round, until: number): TurnActivity | undefined => {
    const thinkingNow = r.messages.some(m => m.kind === 'thinking' && m.step?.state === 'running');
    const tool = r.messages.findLast(m => m.kind === 'tool' && m.step && ['running', 'waiting'].includes(m.step.state) && !hiddenSteps.includes(m.step.call?.name ?? ''));
    const waiting = [...r.actors.values()].filter(item => ['running', 'waiting_input', 'queued'].includes(item.status));
    // The activity-level check covers the gaps between steps (context compaction, a pending model call) but only for the newest round.
    const live = thinkingNow || !!tool || waiting.length > 0 || r.messages.some(m => m.step && ['running', 'waiting'].includes(m.step.state)) ||
      (finalRound && r.messages.some(m => m.activityId && ['running', 'waiting_input'].includes(activities.get(m.activityId)?.status ?? '') &&
        (activities.get(m.activityId)?.kind !== 'actor' || !isDirector(view))));
    // The round's latest `⏵` stage (quiet text once the round is done).
    const stage = candidates.findLast(m => m.ownerId === r.who && m.role === 'assistant' && !m.kind && (m.time ?? 0) >= r.since && (m.time ?? 0) <= until && extractNarration(m.text))?.text;
    const intent = stage ? extractNarration(stage)?.narration.replace(/\s+/g, ' ').trim() : undefined;
    if (!live) return intent ? {label: intent} : undefined;
    const temporary = temporaryState(r.who);
    if (temporary) return {label: temporary.label};
    if (!thinkingNow && !tool && waiting.length) {
      const names = waiting.map(item => roles[item.ownerId]?.name ?? item.ownerId);
      return {label: 'Waiting on ' + (names.length > 2 ? names.slice(0, 2).join(', ') + ` +${names.length - 2}` : names.join(', '))};
    }
    return intent ? {label: intent} : undefined;
  };
  /** `Writing Edit(file.svg) · 14.2k chars`: what a request is doing while a tool call's arguments stream in. */
  const draftingLabel = (drafting: NonNullable<Step['drafting']>): string => {
    const file = drafting.target?.split(/[\\/]/).filter(Boolean).at(-1);
    const chars = drafting.chars < 1000 ? String(drafting.chars) : (drafting.chars / 1000).toFixed(drafting.chars < 100_000 ? 1 : 0) + 'k';
    return `Writing ${drafting.tool}${file ? '(' + file + ')' : ''} · ${chars} chars`;
  };
  /** One expandable row for all the thinking of a round or card: `Thought 6 times · 1m 18s · 1,032 tokens`. */
  const pushThinking = (target: RowBuilder, items: readonly Message[], frame?: FrameWrap, ownerId?: string) => {
    const requests = items.flatMap(item => {
      const request = thinking.get(item.id);
      if (!request) return [];
      const live = request.step.state === 'running';
      return live || item.text.trim() || request.tokens > 0 || request.step.note ? [{item, request}] : [];
    });
    if (!requests.length) return;
    const id = requests[0]!.item.id; // the fold id is the first thought's message id, so the row maps back to its activity
    const now = Date.now();
    const live = requests.some(entry => entry.request.step.state === 'running');
    const totalMs = requests.reduce((sum, entry) => sum + stepElapsed(entry.request.step, now), 0);
    const tokens = requests.reduce((sum, entry) => sum + entry.request.tokens, 0);
    // A running thought stays folded unless the reader opened it; finished ones follow `Thinking display`.
    const isOpen = live ? folds[id] ?? false : open(id);
    const bodyCap = uiSettings().thinkingDisplay === 'preview' ? PREVIEW_THOUGHT_LINES : TOOL_BODY_LINES;
    const lead = isOpen ? '▾ ' : '▸ ';
    const duration = (ms: number) => { const total = Math.round(ms / 1000); return total < 60 ? total + 's' : Math.floor(total / 60) + 'm ' + String(total % 60).padStart(2, '0') + 's'; };
    const tokenText = tokens > 0 ? tokens.toLocaleString('en-US') + ' tokens' : '';
    const count = requests.length;
    const label = live ? 'Thinking' : count === 1 ? 'Thought for ' + duration(totalMs) : `Thought ${count} times · ${duration(totalMs)}`;
    const text = lead + label + (!live && tokenText ? ' · ' + tokenText : '');
    const runningStep = live ? (() => {
      const running = requests.filter(entry => entry.request.step.state === 'running').map(entry => entry.request.step);
      const since = Math.min(...running.map(step => step.runningSince ?? now));
      // The live clock is the current request only; completed thoughts stay in the finished `Thought N times` total.
      const current = running.reduce((sum, step) => sum + step.elapsedMs, 0);
      return {title: text, state: 'running', elapsedMs: current, runningSince: since} as Step;
    })() : undefined;
    // A finished row is an italic summary (`Thought 6 times · …`); a running one keeps the actor's own thinking glyph, `Thinking` with the shimmer and the live clock.
    const summary: readonly SceneSegment[] = [{text, color: isOpen ? palette.fg : palette.muted, italic: true, selectionKey: id + ':title', selectionOffset: 0}];
    const drafting = requests.findLast(entry => entry.request.step.state === 'running' && entry.request.step.drafting)?.request.step.drafting;
    const liveLabel = drafting ? draftingLabel(drafting) : 'Thinking';
    const liveSegments: readonly SceneSegment[] = [{text: liveLabel, italic: true, selectionKey: id + ':title', selectionOffset: 0}];
    target.pushOrdinaryCard({id, ownerId: ownerId ?? DIRECTOR_ID, kind: live ? 'Thinking' : 'Tool', title: live ? liveLabel : text, expandable: !live, bodyLines: [], open: isOpen,
      railColor: viewColor, ...(frame ? {parentFrame: frame} : {}), ...(runningStep ? {step: runningStep} : {}),
      titleSegments: live ? liveSegments : summary,
      renderBody(inner) {
        const faint = faintColor();
        // One body for all the thoughts: rows are counted across them and share the single `… N more lines` expander.
        // Each thought opens with a faint `∴ ` and wraps under a hanging indent; a blank row separates one thought from the next.
        // A recovery note stays one selectable prose block counted as its wrapped lines.
        const rows: {id: string; weight: number; segments?: SceneSegment[]; prose?: string; blank?: true}[] = [];
        const textWidth = Math.max(1, inner.innerWidth - THOUGHT_MARK.length);
        let first = true;
        for (const [index, entry] of requests.entries()) {
          const note = entry.request.step.note?.trim() ? compactParagraphs(entry.request.step.note) : '';
          if (!entry.item.text.trim() && !note) continue;
          if (!first) rows.push({id: `${id}-gap${index}`, weight: 1, blank: true});
          first = false;
          if (note) rows.push({id: entry.item.id + '-note', weight: wrapAnsi(note, inner.innerWidth, {hard: true, trim: false}).split('\n').length, prose: note});
          if (!entry.item.text.trim()) continue;
          let lineIndex = 0;
          for (const paragraph of compactParagraphs(entry.item.text).split('\n')) for (const line of wrapAnsi(paragraph, textWidth, {hard: true, trim: false}).split('\n')) {
            rows.push({id: `${id}-t${index}-${lineIndex}`, weight: 1, segments: [
              {text: lineIndex === 0 ? THOUGHT_MARK : ' '.repeat(THOUGHT_MARK.length), color: faint},
              {text: line, color: palette.muted, italic: true}]});
            lineIndex++;
          }
        }
        const expanded = open(expanderId(id));
        const total = rows.reduce((sum, row) => sum + row.weight, 0);
        const collapsible = total > bodyCap;
        let used = 0, shown = 0;
        for (const row of rows) {
          if (collapsible && !expanded && shown > 0 && used + row.weight > bodyCap) break;
          used += row.weight; shown++;
          if (row.blank) target.pushBlank(viewColor, inner);
          else if (row.prose !== undefined) target.pushProse(row.id, row.prose, viewColor, 'body', inner, undefined, palette.muted);
          else target.pushFramedLine(row.id, viewColor, row.segments ?? [], inner);
        }
        if (collapsible) pushExpander(target, id, viewColor, inner, total - used, expanded ? 'less' : 'lines');
      }});
  };
  const renderThinking = (items: readonly Message[], frame: FrameWrap, _activityId: string, ownerId: string) =>
    pushThinking(builder, items, frame, ownerId);
  const flushRound = (until = Infinity) => {
    if (!round) return;
    const r: Round = round; round = null;
    const chunk = createBuilder(width, hovered, roles, viewColor);
    const state = describeRound(r, until);
    chunk.pushTurnHeader(r.id + '-who', r.who, undefined, undefined, state);
    pushThinking(chunk, r.thinking, undefined, r.who);
    builder.rows.splice(r.insertAt, 0, ...chunk.rows);
  };
  const ensureRound = (who: string, message: Message): Round => {
    if (round?.who === who) return round;
    flushRound(message.time);
    builder.pushBlank(); // between rounds: no rail, no speaker owns it
    round = {who, id: message.id, insertAt: builder.rows.length, since: lastUserTime ?? message.time ?? Date.now(), thinking: [], messages: [], actors: new Map()};
    return round;
  };
  /** Blank row between prose and a card; consecutive folded cards and tool rows stack tightly. */
  const gapBefore = (card: boolean): boolean => {
    const last = builder.rows.at(-1);
    const current: Round | null = round;
    if (!last || last.tone === 'spacer' || (current && builder.rows.length === current.insertAt)) return false;
    if (last.bg) return true;
    if (last.action?.owner) return !card;
    return !last.action;
  };
  for (const message of messages) {
    const activity = message.activityId ? activities.get(message.activityId) : undefined;
    const actor = activity?.kind === 'actor';
    const source = message.role === 'user' ? inputKind(message) : undefined;
    const collaboration = source === 'collaboration' || source === 'collaboration_interrupt';
    const humanLike = message.role === 'user' && !collaboration && !(isDirector(view) && actor);
    const systemLike = !message.kind && (message.role === 'system' || (message.role === 'notice' && (!message.ownerId || message.ownerId === 'system')));
    if (!humanLike && !systemLike) {
      const who = actor && isDirector(view) ? DIRECTOR_ID : message.ownerId || view;
      const current = ensureRound(who, message);
      if (actor && activity && isDirector(view)) current.actors.set(activity.activityId, activity);
      else {
        current.messages.push(message);
        if (message.kind === 'thinking') current.thinking.push(message);
      }
    }
    if (!humanLike && !systemLike) for (const line of stageAt.get(message.id) ?? []) pushStageLine(builder, line, railFor(message.ownerId));
    if (editAbsorbed.has(message.id)) continue;
    if ((!actor || !isDirector(view)) && (absorbed.has(message.id) || groupAt.has(message.id))) {
      const group = groupAt.get(message.id);
      if (group) {
        const rail = railFor(message.ownerId);
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
    if (isDirector(view) && actor && activity) {
      if (seen.has(activity.activityId)) continue;
      seen.add(activity.activityId);
      if (gapBefore(true)) builder.pushBlank(viewColor);
      getToolUI('Actor').renderActivity?.({builder, activity, roles, railColor: viewColor, title: activityTitle(activity, staged.get(activity.activityId), temporaryState(activity.ownerId, activity.activityId)?.label), status: activityStatus(activity),
        active: animated(activity), open: open(activity.activityId), isOpen: open, stop: activeStop(activity.activityId),
        messages: staged.get(activity.activityId) ?? [], pending: requests.get(activity.activityId) ?? [], renderThinking,
        thinking, originalPrompt: actorGoal(activity), detailed: true, renderMessage: body, renderInteraction: interaction});
      continue;
    }
    if (actor && activity && !seen.has(activity.activityId)) {
      seen.add(activity.activityId);
      if (!isDirector(view) && activity.status === 'completed') {
        // In an actor's own thread, completed tasks skip the self-referencing outer Actor card and show the conversation body directly.
      } else {
        getToolUI('Actor').renderActivity?.({builder, activity, roles, railColor: viewColor, title: activityTitle(activity, staged.get(activity.activityId), temporaryState(activity.ownerId, activity.activityId)?.label), status: activityStatus(activity),
          active: animated(activity), open: open(activity.activityId), isOpen: open, stop: activeStop(activity.activityId),
          messages: staged.get(activity.activityId) ?? [], pending: [], renderThinking, thinking, originalPrompt: actorGoal(activity),
          detailed: false, renderMessage: body, renderInteraction: interaction});
      }
    }
    if (actor && activity && !isDirector(view) && message.role === 'system' && ['failed', 'cancelled'].includes(activity.status)) continue;
    if (message.role === 'user') {
      if (collaboration) {
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
        if (gapBefore(true)) builder.pushBlank(viewColor);
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
          railColor: viewColor,
          renderBody(inner) {
            if (cleanBody) builder.pushMarkdown(message.id + '-body', cleanBody, senderColor, inner, senderColor);
          },
        });
        continue;
      }
      // A steered message arrived inside a running round: it stays a row of that round instead of closing it.
      const steered = source === 'human' && message.source === 'steered';
      if (!steered) {flushRound(message.time); lastUserTime = message.time;}
      builder.pushBlank();
      const queued = source === 'human' && activity && ['queued', 'paused'].includes(activity.status);
      builder.pushTurnHeader(message.id + '-who', source === 'director' ? message.source ?? message.ownerId : 'user',
        steered ? 'steered' : queued ? 'Queued' : source === 'director' ? 'Assignment' : message.source);
      body(message);
    } else {
      if (systemLike) {
        flushRound(message.time);
        builder.pushBlank();
      } else if (!message.kind && !(isDirector(view) && actor) && gapBefore(false)) builder.pushBlank(viewColor);
      body(message);
    }
    if (activity && !actor && grouped.get(activity.activityId)?.at(-1)?.id === message.id) failure(activity.activityId);
  }
  finalRound = true;
  flushRound();
  finalRound = false;
  for (const request of pending.filter(item => !seen.has(item.activityId))) interaction(request);
  for (const activity of snapshot.activities.filter(item => item.sessionId === sessionId && (isDirector(view) || item.ownerId === view))) {
    if (activity.kind === 'anamnesis') {
      builder.pushBlank();
      builder.pushOrdinaryCard({id: activity.activityId, kind: 'Anamnesis', title: activity.stage,
        status: statuses[activity.status] ?? activity.status, bodyLines: [activity.detail], ownerId: 'anamnesis',
        open: open(activity.activityId), railColor: palette.accent});
    } else if (!grouped.has(activity.activityId) && activity.ownerId === view) {
      failure(activity.activityId);
    }
  }
  // The timeline never opens with spacer rows (a gap only separates content).
  let lead = 0;
  while (lead < builder.rows.length && builder.rows[lead]!.tone === 'spacer') lead++;
  return lead ? builder.rows.slice(lead) : builder.rows;
}
