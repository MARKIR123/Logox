import {useContext, useEffect, useInsertionEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Box, Text, useApp, useCursor, useInput, usePaste, useStdin, useStdout, useWindowSize, type DOMElement} from 'ink';
import stringWidth from 'string-width';
import {TerminalPlaneContext} from './terminal.js';
import {RuntimeStore} from '../runtime/store.js';
import {emptyCommandContext, type CommandContext} from '../commands.js';
import {applyCommandSuggestion, commandSuggestions, completionQuery, type CommandSuggestion} from './completion.js';
import type {CommandSurfaces} from '../commands/surfaces.js';
import {Picker} from './picker.js';
import {TabbedPage} from './tabbed-page.js';
import type {LoginFlow} from '../providers/login.js';
import type {StageStatus} from '../runtime/stage-status.js';
import type {SubmitDelivery} from '../application.js';
import type {StatusbarPreferences} from '../config/statusbar-preferences.js';
import {statusbarText, statusbarParts} from './statusbar.js';
import {inputDeliveryHint} from './input-delivery.js';
import {MouseContext, type MouseSubscriber} from './mouse.js';
import {LoginDialog} from './login.js';
import {useContentHeight} from './metrics.js';
import {CommandMenu} from './command-menu.js';
import type {PortfolioActivities} from '../demo/portfolio.js';
import {buildStageRows, stageFoldOpen} from './stage.js';
import {projectPortfolioScene} from './scene-state.js';
import {answerEnvelope} from '../runtime/interactions.js';
import type {Answer, Interaction} from '../runtime/contracts.js';
import {cast, type ActorId} from '../actors/ensemble.js';
import {ActivityCard, InteractionCard, ownerColor, ownerHeader, palette, safeText, type QuestionDraft, type ActorStyle, type ActorStyles} from './cards.js';
import {cursorAt, emptyDraft, erase, inputViewport, insert, layoutInput, move, moveToLineEdge, moveVertical, type Draft} from './editor.js';
import {
  buildDemoSceneRows,
  hoveredCardAt,
  actionAt,
  demoRoles,
  defaultSceneFoldOpen,
  INITIAL_DEMO_DRAFT,
  initialDemoSceneState,
  isFoldOpen,
  type DemoSceneUi,
  type SceneRow,
  type SceneAction,
} from './scene.js';
import {
  clipLine,
  extractSelection,
  osc52Clipboard,
  parseSgrMouse,
  timelineRows,
  viewport,
  normalizeSelection,
  type Anchor,
  type Row,
  type SgrMouseEvent,
} from './viewport.js';

import {contentPoint, selectionRange, selectionInViewport, type ContentSelection} from './selection.js';
import {decorateRow, presentedSegments} from './row-presentation.js';
import {getInteractionUI} from '../tools/ui-registry.js';
import type {ToolInteractionAction} from '../tools/ui-types.js';

interface ResponseDraft extends QuestionDraft {answers: Record<string, Answer>; editor: Draft}
function interactionState(request: Interaction, response: ResponseDraft) {
  return {request, draft: {...response, text: response.editor.text}, answers: response.answers};
}
function reduceResponse(request: Interaction, response: ResponseDraft, action: ToolInteractionAction): ResponseDraft {
  const next = getInteractionUI(request)?.reduce(interactionState(request, response), action);
  if (!next) return response;
  return {...response, ...next.draft, answers: next.answers,
    editor: next.draft.questionIndex !== response.questionIndex ? emptyDraft : response.editor};
}
function initialResponse(request: Interaction): ResponseDraft {
  return {questionIndex: 0, selected: request.kind === 'permission' ? 1 : 0, text: '', error: '', answers: {}, editor: emptyDraft};
}
export interface AppProps {
  store: RuntimeStore;
  authentication?: LoginFlow;
  surfaces?: CommandSurfaces;
  getCommandContext?: () => CommandContext;
  getActors?: () => readonly (ActorStyle & {id: string})[];
  getStatus?: (ownerId: string) => StageStatus;
  statusbar?: StatusbarPreferences;
  registerInterrupt?: (handler: () => void) => () => void;
  sessionId: string;
  demoScene?: boolean;
  stage?: boolean;
  scenario?: PortfolioActivities;
  onSubmit(text: string, source?: string, delivery?: SubmitDelivery): Promise<void>;
  getQueuedCount?(ownerId: string): number;
  onCancel(activityId: string): void;
  onDraft?(): void;
  onClose(): Promise<void>;
}
const foldableDemoIds = ['main-thinking', 'main-tool', 'main-aletheia', 'main-aletheia-reads', 'main-techne', 'main-kalon', 'main-memory'] as const;

const noLoginSubscription = () => () => {};
const noLoginSnapshot = () => null;

export function App({store, authentication, surfaces, getCommandContext, getActors, getStatus, statusbar, registerInterrupt, sessionId, demoScene = false, stage = false, scenario, onSubmit, getQueuedCount, onCancel, onClose, onDraft}: AppProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const definitions = getActors?.();
  const roles = useMemo<ActorStyles>(() => {
    if (!definitions) return cast;
    const roles: Record<string, ActorStyle> = Object.fromEntries(definitions.map(role => [role.id, role]));
    for (const activity of snapshot.activities) if (activity.kind === 'actor' && !roles[activity.ownerId])
      roles[activity.ownerId] = {symbol: '◇', name: activity.ownerId, title: '历史角色', color: palette.accent};
    return roles;
  }, [definitions, snapshot.activities]);
  const loginState = useSyncExternalStore(authentication?.subscribe ?? noLoginSubscription, authentication?.getSnapshot ?? noLoginSnapshot);
  const surface = useSyncExternalStore(surfaces?.subscribe ?? noLoginSubscription, surfaces?.getSnapshot ?? noLoginSnapshot);
  const layout = useSyncExternalStore(statusbar?.subscribe ?? noLoginSubscription, statusbar?.getSnapshot ?? noLoginSnapshot);
  const {columns, rows} = useWindowSize();
  const width = Math.max(1, columns - 1);
  const screenRows = Math.max(1, rows);
  const {exit} = useApp();
  const {stdin} = useStdin();
  const {stdout} = useStdout();
  const {setCursorPosition} = useCursor();

  const [sceneUi, setScene] = useState<DemoSceneUi>(initialDemoSceneState);
  const scene = useMemo(() => scenario ? projectPortfolioScene(sceneUi, snapshot, sessionId, scenario) : {...initialDemoSceneState, ...sceneUi}, [sceneUi, snapshot, sessionId, scenario]);
  const [customDraft, setCustomDraft] = useState<Draft>(emptyDraft);
  const [editingCustom, setEditingCustom] = useState(false);
  const [cardCursor, setCardCursor] = useState(4); // defaults to main-techne

  const [activeWindow, setActiveWindow] = useState('logox');
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => ({
    logox: demoScene ? insert(emptyDraft, INITIAL_DEMO_DRAFT) : emptyDraft,
    aletheia: emptyDraft,
    techne: emptyDraft,
    kalon: emptyDraft,
  }));
  const topAnchor: Anchor | null = demoScene ? {messageId: '__top__', line: 0} : null;
  const plane = useContext(TerminalPlaneContext);
  const [, refreshReading] = useState(0);
  const anchors = useRef<Record<string, Anchor | null>>({
    logox: topAnchor,
    aletheia: topAnchor,
    techne: topAnchor,
    kalon: topAnchor,
  });
  const [hoveredFoldId, setHoveredFoldId] = useState<string | null>(null);
  const hoveredFoldIdRef = useRef<string | null>(null);
  const contentSelection = useRef<ContentSelection | null>(null);
  const gesture = useRef<{x: number; y: number; dragged: boolean; action?: SceneAction; row?: SceneRow; lastDragX?: number; lastDragY?: number} | null>(null);
  const lastHoverRef = useRef<{x: number; y: number}>({x: -1, y: -1});
  const edgeTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const edgePointer = useRef<{x: number; y: number} | null>(null);
  const stopEdgeScroll = () => {if (edgeTimer.current) clearInterval(edgeTimer.current); edgeTimer.current = undefined; edgePointer.current = null;};
  const clearSelection = () => {contentSelection.current = null; gesture.current = null; stopEdgeScroll(); presentReading();};
  useEffect(() => () => stopEdgeScroll(), []);
  const [focus, setFocus] = useState<'input' | 'question' | 'stop'>('input');
  const [focusedStop, setFocusedStop] = useState('');
  const [hoveredStop, setHoveredStop] = useState('');
  const hoveredStopRef = useRef('');
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const stoppingIds = useRef(new Set<string>());
  const [selectedRequestId, setSelectedRequestId] = useState('');
  const [responses, setResponses] = useState<Record<string, ResponseDraft>>({});
  const [expanded, setExpanded] = useState(false);
  const [selectedActivityId, setSelectedActivityId] = useState('');
  const [detailOffset, setDetailOffset] = useState(0);
  const [notice, setNotice] = useState('');
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [completion, setCompletion] = useState({query: '', selected: 0, dismissed: false});
  const exitDeadline = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flash = (text: string, duration = 1800) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text); noticeTimer.current = setTimeout(() => setNotice(''), duration);
  };
  useEffect(() => () => {if (noticeTimer.current) clearTimeout(noticeTimer.current);}, []);

  const currentView = demoScene ? scene.view : activeWindow;
  const draft = drafts[currentView] ?? emptyDraft;
  const anchor = anchors.current[currentView] ?? null;
  const setDraft = (fn: (current: Draft) => Draft) => {
    setDrafts(prev => ({...prev, [currentView]: fn(prev[currentView] ?? emptyDraft)}));
  };
  const setAnchor = (next: Anchor | null) => {
    anchors.current[currentView] = next;
    presentReading();
  };
  const switchView = (target: string) => {
    if (demoScene) setScene(prev => ({...prev, view: target as ActorId}));
    else setActiveWindow(target);
    setSelectedActivityId('');
    setEditingCustom(false);
    clearSelection();
    setHoveredFoldId(null);
    hoveredFoldIdRef.current = null;
    hoveredStopRef.current = '';
    setHoveredStop(''); setFocus('input');
  };

  const pending = snapshot.interactions.filter(request =>
    request.sessionId === sessionId &&
    request.status === 'pending' &&
    (currentView === 'logox' || request.ownerId === currentView)
  );
  const request = pending.find(item => item.requestId === selectedRequestId) ?? pending[0];
  const inlineRequest = stage && request || demoScene && request && (request.activityId === scenario?.techne || request.activityId === scenario?.kalon);
  const response = request ? responses[request.requestId] ?? initialResponse(request) : undefined;
  const activities = snapshot.activities.filter(activity =>
    activity.sessionId === sessionId &&
    (currentView === 'logox' || activity.ownerId === currentView)
  );
  const activity = activities.find(item => item.activityId === selectedActivityId) ??
    activities.find(item => item.status === 'waiting_input') ??
    activities.findLast(item => ['running', 'queued', 'paused'].includes(item.status)) ??
    activities.at(-1);

  const visibleMessages = useMemo(() => snapshot.messages.filter(message =>
    message.sessionId === sessionId &&
    (currentView === 'logox' || message.ownerId === currentView)
  ), [snapshot.messages, sessionId, currentView]);

  const messageRows: readonly Row[] = useMemo(() => {
    if (demoScene) return buildDemoSceneRows(scene, width, hoveredFoldId);
    if (stage) return buildStageRows(snapshot, sessionId, currentView, width, sceneUi.folds, hoveredFoldId, responses, roles,
      {stopping, focusedStop: focus === 'stop' ? focusedStop : '', hoveredStop});
    return timelineRows(visibleMessages, width);
  }, [demoScene, stage, responses, snapshot, sessionId, currentView, sceneUi.folds, scene, visibleMessages, width, hoveredFoldId, roles, stopping, focusedStop, focus, hoveredStop]);

  const foldIds = [...new Set(messageRows.flatMap(row => (row as SceneRow).action?.foldId ? [(row as SceneRow).action!.foldId!] : []))];
  const foldActivityId = (id: string | undefined) => {
    if (!id) return '';
    const direct = activities.find(item => item.activityId === id);
    if (direct) return direct.activityId;
    return snapshot.messages.findLast(message => message.id === id || message.step?.groupId === id)?.activityId ?? '';
  };
  const liveWindowTasks = activities.filter(item => item.ownerId === currentView && ['running', 'waiting_input'].includes(item.status));
  const selectedSteerTask = selectedActivityId ? activities.find(item => item.activityId === selectedActivityId)
    : liveWindowTasks.length === 1 ? liveWindowTasks[0] : undefined;
  const steerTarget = selectedSteerTask && ['running', 'waiting_input'].includes(selectedSteerTask.status) ? selectedSteerTask : undefined;
  const own = currentView !== 'logox';
  const statusLeft = notice
    ? notice
    : getStatus ? statusbarText(getStatus(currentView), width, layout?.modules)
    : demoScene
      ? own
        ? `${demoRoles[currentView as 'aletheia' | 'techne' | 'kalon'].symbol} ${demoRoles[currentView as 'aletheia' | 'techne' | 'kalon'].name} · ${demoRoles[currentView as 'aletheia' | 'techne' | 'kalon'].role} · 独立对话`
        : request?.activityId === scenario?.techne && request
          ? '◈ Logox · Techne 等待授权'
          : request?.activityId === scenario?.kalon && request
            ? '◈ Logox · Kalon 等待回答'
            : pending.length ? '◈ Logox · ' + pending.length + ' 个待回答'
              : activities.some(item => item.kind !== 'anamnesis' && ['queued', 'running'].includes(item.status)) ? '◈ Logox · 任务处理中'
                : scene.style && scene.runtime?.kalon === 'completed' ? '◈ Logox · 本轮完成 · Anamnesis 整理候选' : '◈ Logox · 舞台就绪'
      : `${own ? `${ownerHeader(currentView, roles)} · 独立对话` : '◈ Logox'} · ${pending.length ? pending.length + ' 个待回答' : '舞台就绪'}`;
  const statusLeftColor = notice
    ? palette.accent
    : own
      ? ownerColor(currentView, roles)
      : palette.muted;
  const backLabel = own ? 'Esc 返回 Logox  ' : '';
  const keysLabel = closing
    ? '正在关闭…'
    : own
      ? 'Enter 发送'
      : 'Enter 发送 · Shift+Enter 换行 · @角色 派发';
  const footerKeys = width < 32
    ? own ? 'Esc返回 · Enter发送' : 'Enter发送 · ^J换行'
    : width < 60
      ? own ? 'Esc 返回 Logox · Enter 发送' : 'Enter发送 · Shift+Enter换行'
      : backLabel + keysLabel;
  const footerHeight = screenRows < 2 ? 0 : 1;
  const hairlineHeight = screenRows >= 4 ? 2 : 0;
  const freeAnswer = (!inlineRequest || stage) && focus === 'question' && request && response &&
    getInteractionUI(request)?.describe(interactionState(request, response)).editing;
  const activeDraft = editingCustom ? customDraft : freeAnswer && response ? response.editor : draft;
  const editableComposer = focus === 'input' || Boolean(freeAnswer) || editingCustom;
  const promptGlyph = editingCustom ? '补充偏好 › ' : freeAnswer ? '答 › ' : '';
  const promptWidth = stringWidth(promptGlyph);
  const inputColumns = Math.max(1, width - promptWidth - (promptWidth > 0 ? 1 : 0));
  const inputLayout = layoutInput(activeDraft, inputColumns);
  const inputMaxHeight = Math.max(1, Math.min(5, screenRows - footerHeight - hairlineHeight - 1));
  const inputHeight = editableComposer ? Math.min(inputMaxHeight, inputLayout.lines.length) : 1;
  const inputStarts = useRef(new Map<string, number>());
  const inputKey = currentView + ':' + (editingCustom ? 'custom' : freeAnswer ? request?.requestId : 'main');
  const inputView = inputViewport(inputLayout, inputHeight, inputStarts.current.get(inputKey) ?? 0);
  inputStarts.current.set(inputKey, inputView.start);
  const placeholder = currentView === 'logox' ? '' : '给 ' + (roles[currentView]?.name ?? currentView) + ' 的补充…';
  const choiceSummary = demoScene && inlineRequest
    ? request?.kind === 'permission' ? '许可：' + (scene.permissionChoice === 'allow' ? '仅本次允许' : '拒绝（默认）') + ' · Enter 确认'
      : '选择：' + (scene.choice === 'minimal' ? '克制的文字作品集' : scene.choice === 'editorial' ? '温暖的编辑部' : '自由回答') + ' · Enter 确认'
    : request && response
    ? request.kind === 'permission'
      ? '许可：' + (response.selected === 0 ? '仅本次允许' : '拒绝（默认）') + ' · Enter 确认'
      : getInteractionUI(request)?.describe(interactionState(request, response)).hint ?? ''
    : '↑↓ 选择 · Enter 确认 · Esc 稍后';

  const query = completionQuery(draft, currentView);
  const suggestions = stage && !loginState && !surface && focus === 'input' && !editingCustom && !(completion.query === query && completion.dismissed)
    ? commandSuggestions(draft, getCommandContext?.() ?? emptyCommandContext) : [];
  const suggestionIndex = completion.query === query ? Math.min(completion.selected, Math.max(0, suggestions.length - 1)) : 0;
  const menuHeight = Math.max(0, Math.min(5, suggestions.length, screenRows - inputHeight - hairlineHeight - footerHeight - 1));
  const menuStart = Math.max(0, Math.min(suggestionIndex - Math.floor(menuHeight / 2), suggestions.length - menuHeight));
  const menuItems = suggestions.slice(menuStart, menuStart + menuHeight);
  const menuKeys = width < 45 ? 'Arrows select · Tab complete · Esc close' : 'Arrows select · Tab complete · Enter confirm · Esc close';
  const renderedFooterKeys = menuHeight ? menuKeys : footerKeys;
  const footerStatus = getStatus && !notice ? getStatus(currentView) : undefined;
  const statusReserve = footerStatus ? Math.min(Math.floor(width / 2), stringWidth(statusbarText(footerStatus, width, layout?.modules))) : 0;
  const hintWidth = Math.max(0, width - statusReserve - (statusReserve ? 2 : 0));
  const deliveryHint = !demoScene && !notice ? inputDeliveryHint(hintWidth, getQueuedCount?.(currentView) ?? 0,
    steerTarget ? (roles[steerTarget.ownerId]?.name ?? steerTarget.ownerId) + ' ' + steerTarget.activityId.slice(0, 8) : undefined,
    menuHeight ? menuKeys : undefined) : '';
  const footerStatusWidth = deliveryHint ? Math.max(0, width - stringWidth(deliveryHint) - 2) : width;
  const footerStatusParts = footerStatus ? statusbarParts(footerStatus, footerStatusWidth, layout?.modules) : [];
  const footerStatusText = getStatus && !notice ? footerStatusParts.map(part => part.text).join(' · ') : clipLine(statusLeft, footerStatusWidth);

  const activityRef = useRef<DOMElement>(null);
  const activityContentHeight = useContentHeight(activityRef);
  const detailRef = useRef<DOMElement>(null);
  const detailContentHeight = useContentHeight(detailRef);
  const loginHeight = loginState
    ? Math.min(
        screenRows,
        loginState.phase === 'provider'
          ? Math.min(8, loginState.providers.length) + 6
          : loginState.phase === 'method'
            ? Math.min(6, loginState.methods?.length ?? 2) + 6
            : loginState.phase === 'oauth'
              ? 8
              : 5,
      )
    : 0;
  const pickerHeight = surface?.kind === 'picker' ? Math.min(screenRows, 11) : 0;
  const fixedHeight = pickerHeight || (loginState ? loginHeight : inputHeight + hairlineHeight + footerHeight + menuHeight);
  const activityHeight = !loginState && !surface && !demoScene && !stage && activity ? Math.max(0, Math.min(activityContentHeight || (expanded ? 6 : 4), screenRows - fixedHeight)) : 0;
  const questionHeight = !loginState && !surface && !stage && (!demoScene || !inlineRequest) && request ? Math.max(0, Math.floor((screenRows - fixedHeight - activityHeight) * 0.6)) : 0;
  const timelineHeight = Math.max(0, screenRows - fixedHeight - activityHeight - questionHeight);
  const view = viewport(messageRows, timelineHeight, anchor);
  const selection = selectionInViewport(selectionRange(messageRows, contentSelection.current), view.start);
  const inputY = timelineHeight + activityHeight + questionHeight + menuHeight + (hairlineHeight ? 1 : 0);
  const detailMax = Math.max(0, detailContentHeight - questionHeight);
  const detailStart = Math.min(detailOffset, detailMax);
  setCursorPosition(!loginState && !surface && editableComposer && !closing ? {
    x: Math.min(width - 1, promptWidth + inputLayout.cursorColumn),
    y: inputY + inputLayout.cursorRow - inputView.start,
  } : undefined);
  useEffect(() => { if (!request) {setFocus('input'); setEditingCustom(false);} }, [request]);
  const openedRequests = useRef({sessionId, ids: new Set<string>()});
  useEffect(() => {
    if (!stage) return;
    if (openedRequests.current.sessionId !== sessionId) openedRequests.current = {sessionId, ids: new Set()};
    const fresh = snapshot.interactions.filter(item => item.sessionId === sessionId && item.status === 'pending' && !openedRequests.current.ids.has(item.requestId));
    if (!fresh.length) return;
    for (const item of fresh) openedRequests.current.ids.add(item.requestId);
    setScene(previous => {
      const folds = {...previous.folds};
      for (const item of fresh) {folds[item.activityId] = true; folds[item.requestId] = true;}
      return {...previous, folds};
    });
  }, [stage, sessionId, snapshot.interactions]);
  useEffect(() => {
    if (scene.runtime?.styleRequest?.status === 'pending') setScene(prev => ({...prev, folds: {...prev.folds, 'main-techne': false, 'main-kalon': true}}));
  }, [scene.runtime?.styleRequest?.requestId]);

  const changeResponse = (update: (current: ResponseDraft) => ResponseDraft) => {
    if (request) setResponses(previous => ({...previous, [request.requestId]: update(previous[request.requestId] ?? initialResponse(request))}));
  };
  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    void onClose().then(() => exit(), error => exit(error));
  };
  const interrupt = () => {
    if (closing) return;
    const copied = !surface && !loginState ? copySelection() : '';
    if (copied) {stdout?.write(osc52Clipboard(copied)); exitDeadline.current = 0; flash('已复制选区'); return;}
    const now = Date.now();
    if (exitDeadline.current > now) {close(); return;}
    exitDeadline.current = now + 1500; flash('再次按 Ctrl+C 退出', 1500);
  };
  const interruptRef = useRef(interrupt); interruptRef.current = interrupt;
  useEffect(() => registerInterrupt?.(() => interruptRef.current()), [registerInterrupt]);
  const stopActor = (activityId: string) => {
    if (stoppingIds.current.has(activityId)) return;
    const target = snapshot.activities.find(item => item.activityId === activityId && item.kind === 'actor' && ['queued', 'running', 'waiting_input', 'paused'].includes(item.status));
    if (!target) return;
    stoppingIds.current.add(activityId); setStopping(new Set(stoppingIds.current)); onCancel(activityId);
  };
  useEffect(() => {
    const next = new Set([...stopping].filter(id => snapshot.activities.some(item => item.activityId === id && ['queued', 'running', 'waiting_input', 'paused'].includes(item.status))));
    if (next.size !== stopping.size) {stoppingIds.current = next; setStopping(next);}
  }, [snapshot.activities, stopping]);
  const presentReading = () => {
    const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
    if (plane) plane.present({
      ...current,
      width,
      height: timelineHeight,
      selection: selectionInViewport(selectionRange(messageRows, contentSelection.current), current.start),
      motion: layout?.motion ?? true,
      hoveredFoldId: hoveredFoldIdRef.current,
    });
    else refreshReading(value => value + 1);
  };
  // Transfer the rectangle before Ink's resetAfterCommit paints the surrounding UI.
  useInsertionEffect(() => {
    if (!plane) return;
    if (surface?.kind === 'page') plane.hide();
    else plane.present({
      ...view,
      width,
      height: timelineHeight,
      selection,
      motion: layout?.motion ?? true,
      hoveredFoldId: hoveredFoldIdRef.current,
    });
  });
  const copySelection = () => {
    const range = selectionRange(messageRows, contentSelection.current);
    if (!range) return '';
    const {start, end} = normalizeSelection(range);
    const firstY = Math.max(0, start.y);
    const lastY = Math.min(messageRows.length - 1, end.y);
    if (firstY > lastY) return '';
    const decoratedRows = [...messageRows];
    for (let y = firstY; y <= lastY; y++) {
      decoratedRows[y] = decorateRow(messageRows[y]!, plane?.time ?? Date.now(), layout?.motion ?? true);
    }
    return extractSelection(decoratedRows, range);
  };
  const readingRows = () => {
    if (plane && plane.rows.length) return plane.rows;
    return view.rows;
  };
  const scroll = (amount: number) => {
    const maxStart = Math.max(0, messageRows.length - timelineHeight);
    const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
    const start = Math.max(0, Math.min(maxStart, current.start + amount));
    if (start === current.start && !(amount > 0 && start === maxStart && anchors.current[currentView] !== null)) return;
    let readableIndex = start;
    while (readableIndex < start + timelineHeight && messageRows[readableIndex]?.noSelect) readableIndex++;
    const readable = messageRows[readableIndex];
    setAnchor(start >= maxStart ? null : readable ? {messageId: readable.messageId, line: readable.line,
      screenOffset: readableIndex - start,
      ...(readable.sourceStart !== undefined ? {sourceOffset: readable.sourceStart} : {})} : {messageId: '__top__', line: start});
  };

  const confirmScenePermission = () => {
    if (!request || request.kind !== 'permission' || request.activityId !== scenario?.techne) return;
    const result = store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision: scene.permissionChoice === 'allow' ? 'allow_once' : 'deny'}));
    if (!result.ok) {setNotice(result.reason); return;}
    setScene(prev => ({...prev, folds: {...prev.folds, 'main-techne': false, 'history-techne-question': false}}));
    setFocus('input');
  };

  const confirmSceneStyle = () => {
    if (!request || request.kind !== 'question' || request.activityId !== scenario?.kalon) return;
    const custom = scene.custom.trim();
    if (scene.choice === 'custom' && !custom) {setScene(prev => ({...prev, customError: true})); return;}
    const base = scene.choice === 'minimal' ? '克制的文字作品集' : scene.choice === 'editorial' ? '温暖的编辑部' : custom;
    const answer: Answer = scene.choice === 'custom' || custom
      ? {type: 'text', text: (base + (scene.choice !== 'custom' && custom ? '，' + custom : '')).slice(0, 500)}
      : {type: 'option', optionId: scene.choice};
    const result = store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {style: answer}}));
    if (!result.ok) {setNotice(result.reason); return;}
    setScene(prev => ({...prev, customError: false, folds: {...prev.folds, 'main-kalon': false, 'history-kalon-question': false}}));
    setEditingCustom(false);
    setFocus('input');
  };

  const submitting = useRef(false);
  const sendSceneInput = (text = draft.text, delivery: SubmitDelivery = {mode: 'queue'}) => {
    if (!text.trim() || submitting.current) return;
    submitting.current = true;
    setNotice('');
    const source = delivery.mode === 'steer' ? activities.find(item => item.activityId === delivery.activityId)?.ownerId ?? currentView : currentView;
    const payload = delivery.mode === 'queue' && !stage && !demoScene && source !== 'logox' && !/^[@/]/.test(text) ? `@${source} ${text}` : text;
    void onSubmit(payload, source, delivery).then(() => {
      setDrafts(prev => ({...prev, [currentView]: prev[currentView]?.text === text ? emptyDraft : prev[currentView] ?? emptyDraft}));
      if (!text.trim().startsWith('/')) setAnchor(null);
    }, error => {flash(error instanceof Error ? error.message : String(error));}).finally(() => {submitting.current = false;});
  };

  const complete = (suggestion: CommandSuggestion, execute: boolean) => {
    const next = applyCommandSuggestion(draft, suggestion);
    setDraft(() => next);
    onDraft?.();
    setCompletion({query: completionQuery(next, currentView), selected: 0,
      dismissed: suggestion.kind === 'argument' || !next.text.endsWith(' ')});
    if (execute && suggestion.execute) sendSceneInput(next.text);
  };

  useEffect(() => {
    hoveredFoldIdRef.current = null;
    hoveredStopRef.current = '';
    setHoveredFoldId(null);
  }, [width, screenRows, currentView, anchor, scene.folds, expanded]);

  const lastClickRef = useRef<{time: number; key: string}>({time: 0, key: ''});
  const foldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseHandlerRef = useRef<(event: SgrMouseEvent) => void>(() => {});
  const mouseListeners = useRef(new Set<(event: SgrMouseEvent) => void>());
  const subscribeMouse = useMemo<MouseSubscriber>(() => handler => {mouseListeners.current.add(handler); return () => {mouseListeners.current.delete(handler);};}, []);
  const clickTimeline = (act: SceneAction, clickedRow: SceneRow, event: SgrMouseEvent) => {
    if (stage && act.foldId && act.kind !== 'stop_actor') {
      const index = foldIds.indexOf(act.foldId);
      if (index >= 0) setCardCursor(index);
      setSelectedActivityId(foldActivityId(act.foldId));
    }
    if (act.kind === 'stop_actor' && act.foldId) {stopActor(act.foldId); return;}
    const now = Date.now();
    if (stage && act.kind === 'select_answer' && act.requestId) {
      const clicked = pending.find(item => item.requestId === act.requestId);
      if (clicked) {setSelectedRequestId(clicked.requestId); setResponses(prev => {
        const current = prev[clicked.requestId] ?? initialResponse(clicked);
        return {...prev, [clicked.requestId]: clicked.kind === 'permission'
          ? {...current, selected: Number(act.value), error: ''}
          : reduceResponse(clicked, current, {kind: 'select', index: Number(act.value)})};
      }); setFocus('question');}
      return;
    }
    if (stage && act.kind === 'confirm_answer' && act.requestId) {
      if (request?.requestId === act.requestId) commitAnswer(); else {setSelectedRequestId(act.requestId); setFocus('question');}
      return;
    }
    if (act.kind === 'toggle_fold' && act.foldId) {
      const id = act.foldId;
      setScene(prev => ({...prev, folds: {...prev.folds, [id]: !(stage ? stageFoldOpen(snapshot, id, prev.folds) : isFoldOpen(prev, id, false))}}));
      return;
    }
    if ((act.kind === 'actor_summary' || act.kind === 'actor_body') && act.foldId && act.owner) {
      const id = act.foldId;
      const owner = act.owner;
      if (now - lastClickRef.current.time < 320 && lastClickRef.current.key === `actor:${owner}`) {
        if (foldTimerRef.current) { clearTimeout(foldTimerRef.current); foldTimerRef.current = null; }
        lastClickRef.current = {time: 0, key: ''};
        switchView(owner);
      } else {
        lastClickRef.current = {time: now, key: `actor:${owner}`};
        if (foldTimerRef.current) clearTimeout(foldTimerRef.current);
        foldTimerRef.current = setTimeout(() => {
          setScene(prev => {
            const defaultOpen = demoScene ? defaultSceneFoldOpen(scene, id) : stageFoldOpen(snapshot, id, {});
            return {...prev, folds: {...prev.folds, [id]: !isFoldOpen(prev, id, defaultOpen)}};
          });
        }, 180);
      }
      return;
    }
    if (act.kind === 'actor_body' && act.owner) {
      const owner = act.owner;
      if (now - lastClickRef.current.time < 320 && lastClickRef.current.key === `actor:${owner}`) {
        lastClickRef.current = {time: 0, key: ''};
        switchView(owner);
        return;
      }
      lastClickRef.current = {time: now, key: `actor:${owner}`};
    }
    if (act.kind === 'select_permission' && (act.value === 'allow' || act.value === 'deny')) {
      const val = act.value;
      setScene(prev => ({...prev, permissionChoice: val}));
      setFocus('question');
      return;
    }
    if (act.kind === 'later' && act.foldId) {
      const id = act.foldId;
      setScene(prev => ({...prev, folds: {...prev.folds, [id]: false}}));
      setEditingCustom(false); setFocus('input');
      return;
    }
    if (act.kind === 'confirm_permission') {
      if (event.x >= clickedRow.gutterCols + 12 && act.foldId) {
        const id = act.foldId;
        setScene(prev => ({...prev, folds: {...prev.folds, [id]: false}}));
        setFocus('input');
      } else {
        confirmScenePermission();
      }
      return;
    }
    if (act.kind === 'select_style' && (act.value === 'minimal' || act.value === 'editorial' || act.value === 'custom')) {
      const val = act.value;
      setScene(prev => ({...prev, choice: val, customError: false}));
      setEditingCustom(val === 'custom');
      setFocus('question');
      return;
    }
    if (act.kind === 'focus_custom') {
      setScene(prev => ({...prev, choice: 'custom', customError: false}));
      setEditingCustom(true);
      setFocus('question');
      return;
    }
    if (act.kind === 'confirm_style') {
      if (event.x >= clickedRow.gutterCols + 12 && act.foldId) {
        const id = act.foldId;
        setScene(prev => ({...prev, folds: {...prev.folds, [id]: false}}));
        setEditingCustom(false);
        setFocus('input');
      } else {
        confirmSceneStyle();
      }
      return;
    }
  };
  const updateDrag = (x: number, y: number) => {
    const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
    const selected = contentSelection.current;
    if (!selected || !gesture.current) return;
    const rowIndex = current.start + Math.max(0, Math.min(timelineHeight - 1, y));
    contentSelection.current = {...selected, focus: contentPoint(messageRows, rowIndex, x)};
    presentReading();
  };
  const dragAt = (x: number, y: number) => {
    if (!gesture.current) return;
    if (x !== gesture.current.x || y !== gesture.current.y) gesture.current.dragged = true;
    if (gesture.current.lastDragX === x && gesture.current.lastDragY === y) return;
    gesture.current.lastDragX = x;
    gesture.current.lastDragY = y;
    updateDrag(x, y);
    edgePointer.current = {x, y};
    if (gesture.current.dragged && (y <= 0 || y >= timelineHeight - 1) && !edgeTimer.current) {
      edgeTimer.current = setInterval(() => {
        const point = edgePointer.current;
        if (!point || !gesture.current?.dragged) {stopEdgeScroll(); return;}
        scroll(point.y <= 0 ? -1 : 1);
        updateDrag(point.x, point.y);
      }, 40);
    } else if (y > 0 && y < timelineHeight - 1) stopEdgeScroll();
  };
  mouseHandlerRef.current = (event: SgrMouseEvent) => {
    for (const listener of mouseListeners.current) listener(event);
    if (loginState || surface) return;
    if (event.action === 'wheel_up') { if (event.y < timelineHeight) scroll(-3); return; }
    if (event.action === 'wheel_down') { if (event.y < timelineHeight) scroll(3); return; }
    if (event.action === 'move') {
      if (lastHoverRef.current.x === event.x && lastHoverRef.current.y === event.y) return;
      lastHoverRef.current = {x: event.x, y: event.y};
      const rows = readingRows();
      const row = event.y < timelineHeight ? (rows[event.y] as SceneRow | undefined) : undefined;
      const control = row?.controls?.find(item => event.x >= item.startCol && event.x < item.endCol && !item.disabled);
      const nextStop = control?.action.foldId ?? '';
      if (hoveredStopRef.current !== nextStop) {
        hoveredStopRef.current = nextStop;
        setHoveredStop(nextStop);
      }
      const target = (demoScene || stage) && event.y < timelineHeight
        ? hoveredCardAt(row, event.x)
        : !demoScene && activity && !expanded && event.y >= timelineHeight && event.y < timelineHeight + activityHeight && event.x < width
          ? activity.activityId : null;
      if (hoveredFoldIdRef.current !== target) {
        hoveredFoldIdRef.current = target;
        presentReading();
        setHoveredFoldId(target);
      }
      return;
    }
    if (event.button !== 0) return;

    if (event.action === 'press') {
      const menuY = timelineHeight + activityHeight + questionHeight;
      if (menuHeight && event.y >= menuY && event.y < menuY + menuHeight) {
        setCompletion({query, selected: menuStart + event.y - menuY, dismissed: false});
        return;
      }
      // Footer "Esc 返回 Logox" click
      if (event.y >= screenRows - footerHeight && currentView !== 'logox') {
        switchView('logox');
        return;
      }
      // Composer input click focuses input
      if (event.y >= inputY && event.y < inputY + inputHeight) {
        if (editableComposer) {
          const cursor = cursorAt(inputLayout, inputView.start + event.y - inputY, Math.max(0, event.x - promptWidth));
          edit(current => ({text: current.text, cursor}));
        } else { setEditingCustom(false); setFocus('input'); }
        clearSelection();
        return;
      }
      if (event.y < timelineHeight) {
        stopEdgeScroll();
        const clickedRow = readingRows()[event.y] as SceneRow | undefined;
        const act = actionAt(clickedRow, event.x);
        const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
        const point = contentPoint(messageRows, current.start + event.y, event.x);
        contentSelection.current = {anchor: point, focus: point};
        gesture.current = {x: event.x, y: event.y, dragged: false, ...(act ? {action: act} : {}), ...(clickedRow ? {row: clickedRow} : {})};
        presentReading();
        return;
      }
      clearSelection();
      if (!demoScene && activity && event.y >= timelineHeight && event.y < timelineHeight + activityHeight) {
        const now = Date.now();
        if (now - lastClickRef.current.time < 350 && Object.hasOwn(roles, activity.ownerId) && activity.ownerId !== 'logox') {
          switchView(activity.ownerId as ActorId);
          lastClickRef.current = {time: 0, key: ''};
        } else {
          setExpanded(value => !value);
          lastClickRef.current = {time: now, key: activity.activityId};
        }
      }
      return;
    }
    if (event.action === 'drag') {dragAt(event.x, event.y); return;}
    if (event.action === 'release') {
      const pressed = gesture.current;
      if (!pressed) return;
      dragAt(event.x, event.y); stopEdgeScroll();
      gesture.current = null;
      if (!pressed.dragged) {
        contentSelection.current = null; presentReading();
        if (pressed.action && pressed.row) clickTimeline(pressed.action, pressed.row, event);
        return;
      }
      const copied = copySelection();
      if (copied) {stdout?.write(osc52Clipboard(copied)); exitDeadline.current = 0; flash('已复制选区（不含左侧轨道）');}
    }
  };

  useEffect(() => {
    if (!stdin) return;
    stdout?.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[2 q');
    const originalRead = stdin.read.bind(stdin);
    let carry = '';
    stdin.read = ((size?: number) => {
      const chunk = originalRead(size);
      if (chunk !== null && chunk !== undefined) {
        const text = carry + (typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        const events = parseSgrMouse(text);
        for (let i = 0; i < events.length; i++) {
          const ev = events[i]!;
          if (ev.action === 'drag' && i + 1 < events.length && events[i + 1]!.action === 'drag') continue;
          if (ev.action === 'move' && i + 1 < events.length && events[i + 1]!.action === 'move') continue;
          mouseHandlerRef.current(ev);
        }
        const tail = /\x1b\[<[\d;]*$/.exec(text);
        carry = tail ? tail[0] : '';
      }
      return chunk;
    }) as typeof stdin.read;
    return () => {
      if (foldTimerRef.current) clearTimeout(foldTimerRef.current);
      stdin.read = originalRead;
      stdout?.write('\x1b[0 q\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
    };
  }, [stdin, stdout]);

  const commitAnswer = () => {
    if (!request || !response) return;
    if (request.kind === 'permission') {
      const result = store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision: response.selected === 0 ? 'allow_once' : 'deny'}));
      if (result.ok) { setFocus('input'); setDetailOffset(0); }
      else changeResponse(current => ({...current, error: result.reason}));
      return;
    }
    const transition = getInteractionUI(request)?.reduce(interactionState(request, response), {kind: 'submit'});
    if (!transition) return;
    if (!transition.complete) {
      changeResponse(current => reduceResponse(request, current, {kind: 'submit'}));
      setDetailOffset(0);
      return;
    }
    const result = store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: transition.answers}));
    if (result.ok) { setFocus('input'); setDetailOffset(0); }
    else changeResponse(current => ({...current, error: result.reason}));
  };

  const edit = (fn: (current: Draft) => Draft) => {
    if (editingCustom) {
      setCustomDraft(prev => {
        const next = fn(prev);
        setScene(s => ({...s, choice: 'custom', custom: next.text.slice(0, 500), customError: false}));
        return next;
      });
      return;
    }
    if ((!inlineRequest || stage) && focus === 'question' && request?.kind === 'question' && response) {
      changeResponse(current => {
        const editor = fn(current.editor);
        return reduceResponse(request, {...current, editor, text: editor.text}, {kind: 'text', text: editor.text});
      });
    } else {
      setFocus('input');
      if (completion.query) setCompletion({query: '', selected: 0, dismissed: false});
      setDraft(fn);
      onDraft?.();
    }
  };
  usePaste(text => {exitDeadline.current = 0; setNotice(''); if (!loginState && !surface) edit(current => insert(current, text));});
  useInput((input, key) => {
    if (closing || key.eventType === 'release') return;
    if (key.ctrl && input === 'c') {interrupt(); return;}
    exitDeadline.current = 0; if (notice) setNotice('');
    if (key.ctrl && input === 'd') { close(); return; }
    if (loginState) return;
    if (surface) return;
    if (key.ctrl && input === 't') {
      if (focus !== 'input' || editingCustom || !draft.text.trim()) return;
      if (/^[@/]/.test(draft.text.trim())) {flash('Steering cannot execute commands or actor-routing syntax. Use Queue instead.'); return;}
      if (!steerTarget) {flash(selectedActivityId ? 'The selected task is no longer active. The draft was retained.' : 'Select an active task with Ctrl+N before steering.'); return;}
      sendSceneInput(draft.text, {mode: 'steer', activityId: steerTarget.activityId}); return;
    }
    if (menuHeight && !key.ctrl && !key.meta && !key.shift) {
      if (key.upArrow || key.downArrow) {
        setCompletion({query, selected: (suggestionIndex + (key.upArrow ? suggestions.length - 1 : 1)) % suggestions.length, dismissed: false});
        return;
      }
      if (key.escape) {setCompletion({query, selected: suggestionIndex, dismissed: true}); return;}
      if (key.tab || key.return) {
        const selected = suggestions[suggestionIndex];
        if (selected) complete(selected, key.return);
        return;
      }
    }
    if (key.tab) {
      if (stage) {
        const stops = [...new Set(messageRows.flatMap(row => (row as SceneRow).controls?.filter(item => !item.disabled).flatMap(item => item.action.foldId ? [item.action.foldId] : []) ?? []))];
        const targets = ['input', ...pending.map(item => 'question:' + item.requestId), ...stops.map(id => 'stop:' + id)];
        const current = focus === 'stop' ? 'stop:' + focusedStop : focus === 'question' ? 'question:' + request?.requestId : 'input';
        const selected = targets[(Math.max(0, targets.indexOf(current)) + targets.length + (key.shift ? -1 : 1)) % targets.length]!;
        if (selected === 'input') {setFocus('input'); return;}
        const kind = selected.startsWith('stop:') ? 'stop' : 'question', id = selected.slice(kind.length + 1);
        setFocus(kind);
        if (kind === 'stop') {
          setFocusedStop(id);
          const index = messageRows.findIndex(row => (row as SceneRow).controls?.some(item => item.action.foldId === id));
          if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        } else {
          const target = pending.find(item => item.requestId === id);
          setSelectedRequestId(id);
          if (target) setScene(prev => ({...prev, folds: {...prev.folds, [target.activityId]: true, [id]: true}}));
          const index = messageRows.findIndex(row => row.messageId === id);
          if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        }
        return;
      }
      if (stage && request) {
        if (focus === 'question') {setFocus('input'); return;}
        setFocus('question');
        setScene(prev => ({...prev, folds: {...prev.folds, [request.activityId]: true, [request.requestId]: true}}));
        const index = messageRows.findIndex(row => row.messageId === request.requestId);
        if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        return;
      }
      if (demoScene && request) {
        setEditingCustom(false);
        if (focus === 'question') {setFocus('input'); return;}
        setFocus('question');
        if (inlineRequest) {
          const id = currentView === 'logox' ? 'main-' + request.ownerId : 'history-' + request.ownerId + '-question';
          setScene(prev => ({...prev, folds: {...prev.folds, [id]: true}}));
          const index = messageRows.findIndex(row => row.messageId.startsWith(id));
          if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        }
        return;
      }
      if (request) { setFocus(value => value === 'input' ? 'question' : 'input'); return; }
    }
    if (key.ctrl && input === 'p' && pending.length) {
      const next = pending[(pending.findIndex(item => item.requestId === request?.requestId) + 1) % pending.length];
      if (next) setSelectedRequestId(next.requestId);
      setDetailOffset(0); return;
    }
    if (stage && key.ctrl && (input === 'n' || input === 'o')) {
      if (input === 'n') {
        const index = foldIds.length ? (cardCursor + 1) % foldIds.length : 0;
        setCardCursor(index); setSelectedActivityId(foldActivityId(foldIds[index]));
      } else {const id = foldIds[cardCursor % Math.max(1, foldIds.length)]; if (id) setScene(prev => ({...prev, folds: {...prev.folds, [id]: !stageFoldOpen(snapshot, id, prev.folds)}}));}
      return;
    }
    if (key.ctrl && input === 'n') {
      if (demoScene) {
        setCardCursor(c => (c + 1) % foldableDemoIds.length);
        return;
      }
      if (activities.length) {
        const next = activities[(activities.findIndex(item => item.activityId === activity?.activityId) + 1) % activities.length];
        if (next) setSelectedActivityId(next.activityId);
      }
      return;
    }
    if (key.ctrl && input === 'o') {
      if (demoScene) {
        const id = foldableDemoIds[cardCursor]!;
        setScene(prev => {
          const defaultOpen = defaultSceneFoldOpen(scene, id);
          return {...prev, folds: {...prev.folds, [id]: !isFoldOpen(prev, id, defaultOpen)}};
        });
        return;
      }
      setExpanded(value => !value);
      return;
    }
    if (key.ctrl && input === 'g') {
      if (stage) {const order = Object.keys(roles); switchView(order[(order.indexOf(currentView) + 1) % order.length] ?? 'logox'); return;}
      if (demoScene) {
        const order: ActorId[] = ['logox', 'aletheia', 'techne', 'kalon'];
        const next = order[(order.indexOf(scene.view) + 1) % order.length]!;
        switchView(next);
        return;
      }
      const target = activity && Object.hasOwn(roles, activity.ownerId) && activity.ownerId !== 'logox'
        ? activity.ownerId as ActorId
        : currentView === 'logox' ? 'kalon' : 'logox';
      switchView(target);
      return;
    }
    if (key.ctrl && input === 'x' && focus === 'question' && request) {
      store.interactions.cancel(request.requestId); setFocus('input'); return;
    }
    if (key.escape) {
      if (stage && focus === 'question' && request) {setScene(prev => ({...prev, folds: {...prev.folds, [request.activityId]: false, [request.requestId]: false}})); setFocus('input'); return;}
      if (editingCustom) { setEditingCustom(false); setFocus('input'); return; }
      if (demoScene && focus === 'question') {
        setScene(prev => ({
          ...prev,
          folds: {
            ...prev.folds,
            ...(request?.kind === 'permission' ? {'main-techne': false, 'history-techne-question': false} : {'main-kalon': false, 'history-kalon-question': false}),
          },
        }));
        setFocus('input');
        return;
      }
      if (focus === 'question') { setFocus('input'); return; }
      if (currentView !== 'logox') { switchView('logox'); return; }
      if (focus === 'stop') {setFocus('input'); return;}
      if (selection) { clearSelection(); return; }
      const running = activities.find(item => item.ownerId === 'logox' && ['running', 'waiting_input', 'queued'].includes(item.status));
      if (running) onCancel(running.activityId);
      return;
    }
    if (key.ctrl && (key.upArrow || key.downArrow) && request) {
      setDetailOffset(value => Math.max(0, Math.min(detailMax, value + (key.upArrow ? -2 : 2)))); return;
    }
    if (key.pageUp || key.pageDown) { scroll((key.pageUp ? -1 : 1) * Math.max(1, timelineHeight - 1)); return; }
    if (key.ctrl && input === 'e') { setAnchor(null); return; }
    if ((key.upArrow || key.downArrow) && editableComposer) {
      const next = moveVertical(activeDraft, key.upArrow ? -1 : 1, inputColumns);
      if (!freeAnswer || next.cursor !== activeDraft.cursor) { edit(() => next); return; }
    }
    if (demoScene && inlineRequest && focus === 'question' && (key.upArrow || key.downArrow)) {
      if (request?.kind === 'permission') {
        setScene(prev => ({...prev, permissionChoice: prev.permissionChoice === 'allow' ? 'deny' : 'allow'}));
        setFocus('question');
        return;
      }
      if (request?.kind === 'question') {
        const order: Array<'minimal' | 'editorial' | 'custom'> = ['minimal', 'editorial', 'custom'];
        const next = order[(order.indexOf(scene.choice) + (key.upArrow ? 2 : 1)) % 3]!;
        setScene(prev => ({...prev, choice: next, customError: false}));
        setEditingCustom(next === 'custom');
        setFocus('question');
        return;
      }
    }
    if ((!inlineRequest || stage) && focus === 'question' && request && response && (key.upArrow || key.downArrow)) {
      changeResponse(current => request.kind === 'permission'
        ? {...current, selected: (current.selected + 1) % 2}
        : reduceResponse(request, current, {kind: 'move', delta: key.upArrow ? -1 : 1}));
      return;
    }
    if (key.ctrl && input === 'j') { edit(current => insert(current, '\n')); return; }
    if (key.return) {
      if (focus === 'stop') {stopActor(focusedStop); setFocus('input'); return;}
      if (key.shift || key.meta) { edit(current => insert(current, '\n')); return; }
      if (demoScene && key.ctrl) {
        const match = /^main-(aletheia|techne|kalon)$/.exec(foldableDemoIds[cardCursor]!);
        if (match) switchView(match[1] as ActorId);
        return;
      }
      if (demoScene) {
        if (editingCustom || focus === 'question') {
          if (inlineRequest && request?.kind === 'permission') confirmScenePermission();
          else if (inlineRequest && request?.kind === 'question') confirmSceneStyle();
          else commitAnswer();
          return;
        }
        if (draft.text.trim()) {
          sendSceneInput();
          return;
        }
        if (inlineRequest && request?.kind === 'permission') {confirmScenePermission(); return;}
        if (inlineRequest && request?.kind === 'question') {confirmSceneStyle(); return;}
        return;
      }
      if (stage && key.ctrl) {
        const selected = activities.find(item => item.activityId === foldActivityId(foldIds[cardCursor % Math.max(1, foldIds.length)]));
        if (selected && Object.hasOwn(roles, selected.ownerId) && selected.ownerId !== 'logox') switchView(selected.ownerId as ActorId);
        return;
      }
      if (key.ctrl && activity && Object.hasOwn(roles, activity.ownerId) && activity.ownerId !== 'logox') {
        switchView(activity.ownerId as ActorId);
        return;
      }
      if (stage && focus === 'input') {sendSceneInput(); return;}
      if (focus === 'question') commitAnswer();
      else if (draft.text.trim()) sendSceneInput();
      return;
    }
    if (key.backspace) { edit(current => erase(current, true)); return; }
    if (key.delete) { edit(current => erase(current, false)); return; }
    if (key.leftArrow || key.rightArrow) { edit(current => move(current, key.leftArrow ? -1 : 1)); return; }
    if (key.home || key.end) { edit(current => key.ctrl ? move(current, key.home ? -Infinity : Infinity) : moveToLineEdge(current, Boolean(key.end), inputColumns)); return; }
    if (!key.ctrl && !key.meta && input) edit(current => insert(current, input));
  });

  if (surface?.kind === 'page' && surfaces) return <MouseContext.Provider value={subscribeMouse}><TabbedPage key={surface.id} title={surface.title} tabs={surface.tabs}
    initialTab={surface.initialTab} width={width} height={screenRows} onClose={() => surfaces.cancel()}
    saving={surface.saving ?? false} error={surface.error ?? ''} notice={notice} onSave={(tabId, items) => {void surfaces.saveToggles(surface.id, tabId, items);}}
    onAction={(tabId, action) => {void surfaces.triggerTabAction(surface.id, tabId, action);}}/></MouseContext.Provider>;
  const hairline = '─'.repeat(width);
  return <Box flexDirection="column" width={width} height={screenRows} overflow="hidden">
    <Box height={timelineHeight} flexShrink={0} flexDirection="column" overflow="hidden">
      {!plane && view.rows.map((rawRow, index) => {
        const row = rawRow as SceneRow;
        const rail = row.gutterCols > 0 ? <Text color={row.railColor}>▎ </Text> : null;
        return <Box key={index} height={1} flexShrink={0} overflow="hidden">
          {rail}
          <Text wrap="truncate">{presentedSegments(row, index, selection).map((seg, i) =>
            <Text key={i} color={seg.color ?? palette.fg} {...(seg.bg ?? row.bg ? {backgroundColor: seg.bg ?? row.bg} : {})} bold={Boolean(seg.bold)} italic={Boolean(seg.italic)}>{seg.text}</Text>)}</Text>
        </Box>;
      })}
    </Box>
    {surface?.kind === 'picker' && surfaces ? <Picker key={surface.id} title={surface.title} description={surface.description}
      items={surface.items} current={surface.current} status={surface.status} error={surface.error} width={width} height={pickerHeight} y={timelineHeight}
      {...(surface.deleteLabel !== undefined ? {deleteLabel: surface.deleteLabel} : {})} onDelete={id => {void surfaces.deleteItem(surface.id, id);}}
      effort={surface.effort} effortLevels={surface.effortLevels}
      notice={notice} onSelect={(id, effort) => {void surfaces.choose(surface.id, id, effort);}} onCancel={() => surfaces.cancel()}/>
      : loginState && authentication ? <LoginDialog flow={authentication} state={loginState} width={width} height={loginHeight} y={timelineHeight} onCursor={setCursorPosition} onClose={close} notice={notice}/> : <>
    {!demoScene && !stage && activity && activityHeight > 0 && <Box height={activityHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      <Box ref={activityRef} flexDirection="column" flexShrink={0}><ActivityCard activity={activity} expanded={expanded} hovered={hoveredFoldId === activity.activityId}/></Box>
    </Box>}
    {!stage && (!demoScene || !inlineRequest) && request && response && questionHeight > 0 && <Box height={questionHeight} flexShrink={0} overflow="hidden" contentOffsetY={detailStart} flexDirection="column">
      <Box ref={detailRef} flexDirection="column" flexShrink={0}>
        <InteractionCard request={request} draft={response} focused={focus === 'question'}/>
      </Box>
    </Box>}
    {menuHeight > 0 && <CommandMenu items={menuItems} selected={suggestionIndex - menuStart} width={width}/>}
    {hairlineHeight > 0 && <Box height={1} flexShrink={0}><Text color={palette.line} wrap="truncate">{hairline}</Text></Box>}
    <Box height={inputHeight} flexShrink={0} flexDirection="column" overflow="hidden">
      {editableComposer ? inputView.lines.map((line, index) => <Box key={index} height={1} flexShrink={0}>
        <Text wrap="truncate">
          {promptWidth > 0 && <Text color={palette.user}>{index === 0 ? promptGlyph : ' '.repeat(promptWidth)}</Text>}
          <Text color={activeDraft.text ? palette.fg : palette.muted}>{activeDraft.text ? line.text : (placeholder ? clipLine(placeholder, inputColumns) : '')}</Text>
        </Text>
      </Box>) : <Text color={palette.muted} wrap="truncate">{clipLine(choiceSummary, width)}</Text>}
    </Box>
    {hairlineHeight > 0 && <Box height={1} flexShrink={0}><Text color={palette.line} wrap="truncate">{hairline}</Text></Box>}
    {footerHeight > 0 && <Box height={footerHeight} flexShrink={0}>
      <Text color={statusLeftColor} wrap="truncate">{getStatus && !notice
        ? footerStatusParts.map((part, index) => <Text key={index}>{index > 0 ? ' · ' : ''}<Text color={part.color ?? statusLeftColor}>{part.text}</Text></Text>)
        : footerStatusText}</Text>
      {deliveryHint && <>
        <Text>{' '.repeat(Math.max(0, width - stringWidth(footerStatusText) - stringWidth(deliveryHint)))}</Text>
        <Text color={palette.muted}>{deliveryHint}</Text>
      </>}
      {demoScene && !getStatus && !notice && stringWidth(statusLeft) + stringWidth(renderedFooterKeys) + 2 <= width && <>
        <Text>{' '.repeat(width - stringWidth(statusLeft) - stringWidth(renderedFooterKeys))}</Text>
        <Text color={palette.muted}>{renderedFooterKeys}</Text>
      </>}
    </Box>}
    </>}
  </Box>;
}
