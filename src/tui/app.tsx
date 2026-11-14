import {DIRECTOR_ID, isDirector} from '../runtime/director-id.js';
import {useContext, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Box, Text, useApp, useCursor, usePaste, useStdin, useStdout, useWindowSize, type DOMElement} from 'ink';
import stringWidth from 'string-width';
import {TerminalPlaneContext} from './terminal/terminal.js';
import {RuntimeStore} from '../runtime/store.js';
import {emptyCommandContext, type CommandContext} from '../commands.js';
import {commandSuggestions, completionQuery} from './commands/completion.js';
import type {CommandSurfaces} from '../commands/surfaces.js';
import {Picker} from './panels/picker.js';
import {COMPOSER_EXPAND_LABEL, COMPOSER_EXPAND_PADDING} from './input/fullscreen-editor.js';
import type {LoginFlow} from '../providers/login.js';
import type {StageStatus} from '../runtime/stage-status.js';
import type {SubmitDelivery} from '../application.js';
import type {StatusbarId, StatusbarPreferences} from '../config/statusbar-preferences.js';
import {statusbarLayout, type WidgetRegion} from './status/statusbar.js';
import {calculatePillsWidth} from './status/actor-pills.js';
import {MouseHost, type MouseSubscriber, type SgrMouseEvent} from './terminal/mouse.js';
import {LoginDialog} from './login/login.js';
import {useContentHeight} from './terminal/metrics.js';
import {PENDING_VISIBLE_MAX, pendingRowLayout} from './input/input-delivery.js';
import {CommandMenu, commandMenuLayout} from './commands/command-menu.js';
import type {PortfolioActivities} from '../demo/portfolio.js';
import {buildStageRows, stageFoldOpen} from './timeline/stage.js';
import {projectPortfolioScene} from '../demo/scene-state.js';
import {buildDemoSceneRows, INITIAL_DEMO_DRAFT, initialDemoSceneState, type DemoSceneUi} from '../demo/scene.js';
import {cast, type ActorId} from '../actors/ensemble.js';
import {ActivityCard} from './timeline/activity-card.js';
import {InteractionCard} from './interactions/interaction-card.js';
import {ownerColor, type ActorStyle, type ActorStyles} from './appearance/actor-style.js';
import {uiSettingsRevision} from '../config/ui-settings.js';
import {palette} from './appearance/theme.js';
import {mixHex} from './appearance/colors.js';
import {clipLine, safeText} from './terminal/text.js';
import {draftSelection, emptyDraft, inputViewport, insert, layoutInput, selectedText, type Draft} from './input/editor.js';
import type {SceneRow, SceneAction} from './timeline/scene.js';
import {timelineRows, viewport, type Anchor, type Row} from './timeline/viewport.js';
import {osc52Clipboard} from './terminal/clipboard.js';
import {selectionRange, selectionInViewport, type ContentSelection} from './timeline/selection.js';
import {getInteractionUI} from '../tools/ui-registry.js';
import {themeRevision} from '../config/theme-palette.js';
import {userLabelRevision} from '../config/user-profile.js';
import {useSplash} from './timeline/use-splash.js';
import {initialResponse, interactionState, type ResponseDraft} from './interactions/response-draft.js';
import {TimelinePane} from './timeline/timeline-pane.js';
import {PendingRows} from './input/pending-rows.js';
import {ComposerLines} from './input/composer-lines.js';
import {FooterBar} from './status/footer-bar.js';
import {useComposerActions} from './input/composer-actions.js';
import {useInputHistory} from './input/use-input-history.js';
import {choiceSummaryText} from './interactions/choice-summary.js';
import {useReading} from './timeline/use-reading.js';
import {overlayPage} from './panels/overlay-page.js';
import {footerKeyLabel, footerNoteSegments, statusLeftText} from './status/footer-model.js';
import {screenHeights} from './input/screen-heights.js';
import {useTerminalInput} from './terminal/terminal-input.js';
import {useNotices} from './status/use-notices.js';
import {useActivePills} from './status/use-active-pills.js';
import {createAnswerActions} from './interactions/answer-actions.js';
import {createMouseHandler} from './input/mouse-router.js';
import {useKeyboard} from './input/keyboard.js';
import type {ShellContext} from './input/shell-context.js';
import {QuestionDock} from './interactions/question-dock.js';

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
  /** Steers a pending message into its target's running round (`Send now`). */
  onSendPending?(id: string): Promise<void> | void;
  /** Takes a pending message back and returns its text (`×`). */
  onDiscardPending?(id: string): string | undefined;
  onCancel(activityId: string): void;
  /** Stops one running tool call (`■ Stop` on a tool row) without ending the owner's step. */
  onCancelTool?(callId: string): void;
  onDraft?(): void;
  onClose(): Promise<void>;
}
const noLoginSubscription = () => () => {};
const noLoginSnapshot = () => null;

export function App({store, authentication, surfaces, getCommandContext, getActors, getStatus, statusbar, registerInterrupt, sessionId, demoScene = false, stage = false, scenario, onSubmit, onSendPending, onDiscardPending, onCancel, onCancelTool, onClose, onDraft}: AppProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const deferredSnapshot = useDeferredValue(snapshot);
  const themeVersion = themeRevision() * 1000 + userLabelRevision() + uiSettingsRevision() * 1e9;
  const definitions = getActors?.();
  const roles = useMemo<ActorStyles>(() => {
    if (!definitions) return cast;
    const roles: Record<string, ActorStyle> = Object.fromEntries(definitions.map(role => [role.id, role]));
    for (const activity of snapshot.activities) if (activity.kind === 'actor' && !roles[activity.ownerId])
      roles[activity.ownerId] = {symbol: '◇', name: activity.ownerId, title: 'Past role', color: palette.accent};
    return roles;
  }, [definitions, snapshot.activities, themeVersion]);
  const loginState = useSyncExternalStore(authentication?.subscribe ?? noLoginSubscription, authentication?.getSnapshot ?? noLoginSnapshot);
  const loginFolded = loginState?.phase === 'wizard' && Boolean(loginState.collapsed);
  const rawSurface = useSyncExternalStore(surfaces?.subscribe ?? noLoginSubscription, surfaces?.getSnapshot ?? noLoginSnapshot);
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

  const [activeWindow, setActiveWindow] = useState(DIRECTOR_ID);
  const [expandHovered, setExpandHovered] = useState(false);
  const [pendingHover, setPendingHover] = useState<{id: string; control: 'send' | 'discard'} | null>(null);
  const [composerMode, setComposerMode] = useState<{sessionId: string; ownerId: string; scrollOffset: number | null} | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => ({
    logox: demoScene ? insert(emptyDraft, INITIAL_DEMO_DRAFT) : emptyDraft,
    aletheia: emptyDraft,
    techne: emptyDraft,
    kalon: emptyDraft,
  }));
  const topAnchor: Anchor | null = demoScene ? {messageId: '__top__', line: 0} : null;
  const plane = useContext(TerminalPlaneContext);
  const anchors = useRef<Record<string, Anchor | null>>({
    logox: topAnchor,
    aletheia: topAnchor,
    techne: topAnchor,
    kalon: topAnchor,
  });
  const [hoveredFoldId, setHoveredFoldId] = useState<string | null>(null);
  const hoveredFoldIdRef = useRef<string | null>(null);
  const [hoveredPill, setHoveredPill] = useState<string | null>(null);
  const hoveredPillRef = useRef<string | null>(null);
  const [hoveredWidget, setHoveredWidget] = useState<StatusbarId | null>(null);
  const hoveredWidgetRef = useRef<StatusbarId | null>(null);
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
  const currentView = demoScene ? scene.view : activeWindow;
  const {notice, noticeTone, setNotice, flash} = useNotices({store, sessionId, currentView, snapshot});
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [completion, setCompletion] = useState({query: '', selected: 0, dismissed: false});
  const exitDeadline = useRef(0);
  const statusSelectionRef = useRef<{startX: number; currentX: number; active: boolean; text: string} | null>(null);

  // A late read-only result belongs only to its originating window; hidden results cannot own input or the canvas.
  const surface = rawSurface?.kind === 'result' && (
    rawSurface.ownerId !== undefined && rawSurface.ownerId !== currentView ||
    rawSurface.sessionId !== undefined && rawSurface.sessionId !== sessionId
  ) ? null : rawSurface;
  const composerExpanded = Boolean(composerMode?.sessionId === sessionId && composerMode.ownerId === currentView &&
    !loginState && !surface && focus === 'input' && !editingCustom);
  const historyFor = useInputHistory(snapshot, sessionId);
  const draftRevisions = useRef(new Map<string, number>());
  const cancelledInputs = useRef(new Set<string>());
  const escArmedUntil = useRef(0);
  const inputDrag = useRef<{key: string; anchor: number} | null>(null);
  const draft = drafts[currentView] ?? emptyDraft;
  const anchor = anchors.current[currentView] ?? null;
  const setDraft = (fn: (current: Draft) => Draft) => {
    draftRevisions.current.set(currentView, (draftRevisions.current.get(currentView) ?? 0) + 1);
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
    (isDirector(currentView) || request.ownerId === currentView)
  );
  const request = pending.find(item => item.requestId === selectedRequestId) ?? pending[0];
  const inlineRequest = stage && request || demoScene && request && (request.activityId === scenario?.techne || request.activityId === scenario?.kalon);
  const response = request ? responses[request.requestId] ?? initialResponse(request) : undefined;
  const activities = snapshot.activities.filter(activity =>
    activity.sessionId === sessionId &&
    (isDirector(currentView) || activity.ownerId === currentView)
  );
  const activity = activities.find(item => item.activityId === selectedActivityId) ??
    activities.find(item => item.status === 'waiting_input') ??
    activities.findLast(item => ['running', 'queued', 'paused'].includes(item.status)) ??
    activities.at(-1);

  const visibleMessages = useMemo(() => deferredSnapshot.messages.filter(message =>
    message.sessionId === sessionId &&
    (isDirector(currentView) || message.ownerId === currentView)
  ), [deferredSnapshot.messages, sessionId, currentView]);

  const welcome = !demoScene && !activities.length && !pending.length && !visibleMessages.some(message =>
    message.role !== 'system' || !message.systemPresentation || message.systemPresentation === 'timeline'
  ) ? visibleMessages.findLast(message => message.role === 'system' && message.systemPresentation === 'welcome') : undefined;
  const welcomeLines = useMemo(() => welcome
    ? layoutInput({text: safeText((welcome.systemTitle ? welcome.systemTitle + '\n' : '') + welcome.text).replace(/\t/g, '  '), cursor: 0}, width).lines
    : [], [welcome, width]);

  const dockQuestion = !loginState && !surface && !demoScene && request?.kind === 'question' &&
    (!stage || stageFoldOpen(deferredSnapshot, request.requestId, sceneUi.folds));

  const messageRows: readonly Row[] = useMemo(() => {
    if (demoScene) return buildDemoSceneRows(scene, width, hoveredFoldId);
    if (stage) return buildStageRows(deferredSnapshot, sessionId, currentView, width, sceneUi.folds, hoveredFoldId, responses, roles,
      {stopping, focusedStop: focus === 'stop' ? focusedStop : '', hoveredStop,
        focusedQuestionId: dockQuestion ? request.requestId : ''});
    return timelineRows(visibleMessages, width);
  }, [themeVersion, demoScene, stage, responses, deferredSnapshot, sessionId, currentView, sceneUi.folds, scene, visibleMessages, width, hoveredFoldId, roles, stopping, focusedStop, focus, hoveredStop, request, dockQuestion]);

  const foldIds = [...new Set(messageRows.flatMap(row => (row as SceneRow).action?.foldId ? [(row as SceneRow).action!.foldId!] : []))];
  const foldActivityId = (id: string | undefined) => {
    if (!id) return '';
    id = id.replace(/-more$/, ''); // a body expander belongs to its card
    const direct = activities.find(item => item.activityId === id);
    if (direct) return direct.activityId;
    return snapshot.messages.findLast(message => message.id === id || message.step?.groupId === id)?.activityId ?? '';
  };
  const liveWindowTasks = activities.filter(item => item.ownerId === currentView && ['running', 'waiting_input'].includes(item.status));
  const selectedSteerTask = selectedActivityId ? activities.find(item => item.activityId === selectedActivityId)
    : liveWindowTasks.length === 1 ? liveWindowTasks[0] : undefined;
  const steerTarget = selectedSteerTask && ['running', 'waiting_input'].includes(selectedSteerTask.status) ? selectedSteerTask : undefined;
  const own = !isDirector(currentView);
  const cachedStageStatus = useMemo(() => {
    if (!getStatus) return undefined;
    return getStatus(currentView);
  }, [getStatus, currentView, snapshot.revision, themeVersion]);
  const statusLeft = statusLeftText({notice, cachedStageStatus, width, layout, demoScene, own, currentView, roles, request, scenario, pending, activities, scene});
  const statusLeftColor = notice
    ? palette.accent
    : own
      ? ownerColor(currentView, roles)
      : palette.muted;
  const footerKeys = footerKeyLabel({own, closing, width});
  /** Row 1 is the status line; row 2 (notices, hover detail, key hints) needs a real status source and some height. */
  const footerHeight = screenRows < 2 ? 0 : getStatus && screenRows >= 8 ? 2 : 1;
  const footerStatusY = screenRows - footerHeight;
  const hairlineHeight = screenRows >= 4 ? 2 : 0;
  const freeAnswer = (!inlineRequest || stage) && focus === 'question' && request && response &&
    getInteractionUI(request)?.describe(interactionState(request, response)).editing;
  const questionPanel = dockQuestion && response ? request : undefined;
  const activeDraft = editingCustom ? customDraft : draft;
  const editableComposer = focus === 'input' || editingCustom;
  const windowColor = ownerColor(currentView, roles);
  const promptGlyph = editingCustom ? 'Extra preference › ' : '❯ ';
  const composerRule = mixHex(windowColor, palette.bg, 0.45), composerPrompt = mixHex(windowColor, palette.bg, 0.9);
  const promptWidth = stringWidth(promptGlyph);
  const showExpandButton = !closing && !composerExpanded && editableComposer && !editingCustom && !loginState && !surface && width >= 6;
  const expandButtonWidth = showExpandButton ? stringWidth(COMPOSER_EXPAND_LABEL) + COMPOSER_EXPAND_PADDING * 2 : 0;
  const composerTextWidth = width - (showExpandButton ? expandButtonWidth + 1 : 0);
  const inputColumns = Math.max(1, composerTextWidth - promptWidth - (showExpandButton || promptWidth > 0 ? 1 : 0));
  const inputLayout = layoutInput(activeDraft, inputColumns);
  const inputMaxHeight = Math.max(1, Math.min(5, screenRows - footerHeight - hairlineHeight - 1));
  const inputHeight = editableComposer ? Math.min(inputMaxHeight, inputLayout.lines.length) : 1;
  const pendingAll = stage && !demoScene ? snapshot.pending.filter(item => item.sessionId === sessionId && (item.ownerId === currentView || item.windowId === currentView)) : [];
  const pendingHeight = pendingAll.length && !closing && !loginState && !surface
    ? Math.min(PENDING_VISIBLE_MAX, pendingAll.length, Math.max(0, screenRows - inputHeight - hairlineHeight - footerHeight - 2)) : 0;
  /** The newest rows sit nearest the composer. */
  const pendingShown = pendingAll.slice(pendingAll.length - pendingHeight);
  const inputStarts = useRef(new Map<string, number>());
  const inputKey = currentView + ':' + (editingCustom ? 'custom' : freeAnswer ? request?.requestId : 'main');
  const inputView = inputViewport(inputLayout, inputHeight, inputStarts.current.get(inputKey) ?? 0);
  inputStarts.current.set(inputKey, inputView.start);
  const inputSelection = draftSelection(activeDraft);
  const choiceSummary = choiceSummaryText({demoScene, inlineRequest, request, response, scene});

  const query = completionQuery(draft, currentView);
  const suggestions = stage && !composerExpanded && !loginState && !surface && focus === 'input' && !editingCustom && !(completion.query === query && completion.dismissed)
    ? commandSuggestions(draft, getCommandContext?.() ?? emptyCommandContext) : [];
  const suggestionIndex = completion.query === query ? Math.min(completion.selected, Math.max(0, suggestions.length - 1)) : 0;
  const {count: menuCount, height: menuHeight, showCounts: menuShowCounts} = commandMenuLayout(suggestions.length,
    Math.max(0, screenRows - inputHeight - pendingHeight - hairlineHeight - footerHeight - (screenRows >= 8 ? 1 : 0)));
  const moveSuggestion = (direction: number) => {
    if (!suggestions.length) return;
    setCompletion(previous => {
      const selected = previous.query === query ? Math.min(previous.selected, suggestions.length - 1) : 0;
      return {query, selected: (selected + direction + suggestions.length) % suggestions.length, dismissed: false};
    });
  };
  const menuKeys = width < 45 ? 'Arrows select · Tab complete · Esc close' : 'Arrows select · Tab complete · Enter confirm · Esc close';
  const renderedFooterKeys = menuHeight ? menuKeys : footerKeys;
  const {activePills} = useActivePills({snapshot, sessionId, roles, width, themeVersion});

  const pillsWidth = calculatePillsWidth(activePills);
  const footerStatus = cachedStageStatus;
  const footerStatusWidth = Math.max(0, width - pillsWidth - (pillsWidth > 0 ? 1 : 0));
  const noticeInline = Boolean(notice) && (!getStatus || footerHeight < 2);
  // The same layout draws row 1 and answers hover and click hit tests.
  const footerLayout = useMemo(() => footerStatus
    ? statusbarLayout(footerStatus, footerStatusWidth, layout?.modules, layout ?? undefined, {hovered: hoveredWidget})
    : {parts: [], regions: [] as WidgetRegion[], width: 0},
  [footerStatus, footerStatusWidth, layout, hoveredWidget]);
  const footerStatusParts = footerLayout.parts;
  const footerStatusText = footerStatus && !noticeInline ? footerStatusParts.map(part => part.text).join('') : clipLine(statusLeft, footerStatusWidth);
  const queuedHere = pendingAll.length;
  const footerNote = footerNoteSegments({hoveredPill, activePills, snapshot, getStatus, roles, notice, noticeInline, noticeTone, hoveredWidget, footerStatus, windowColor,
    width, footerHeight, own, queuedHere, menuHeight, closing});

  const activityRef = useRef<DOMElement>(null);
  const activityContentHeight = useContentHeight(activityRef);
  const detailRef = useRef<DOMElement>(null);
  const detailContentHeight = useContentHeight(detailRef);
  const {loginHeight, pickerHeight, activityHeight, questionHeight, timelineHeight} = screenHeights({loginState, loginFolded, surface, screenRows, inputHeight, pendingHeight,
    hairlineHeight, footerHeight, menuHeight, demoScene, stage, activity, activityContentHeight, expanded, questionPanel, request, inlineRequest});
  const splash = useSplash({welcome, width, timelineHeight, roles, themeVersion});
  const view = viewport(messageRows, timelineHeight, anchor);
  const selection = selectionInViewport(selectionRange(messageRows, contentSelection.current), view.start);
  const inputY = timelineHeight + (loginFolded ? loginHeight : 0) + activityHeight + questionHeight + menuHeight + pendingHeight + (hairlineHeight ? 1 : 0);
  const pendingY = inputY - (hairlineHeight ? 1 : 0) - pendingHeight;
  const pendingAt = (point: {x: number; y: number}) => {
    const index = point.y - pendingY;
    const item = pendingShown[index];
    if (!item || index < 0) return undefined;
    const row = pendingRowLayout(width, item.text, item.ownerId === currentView ? undefined : roles[item.ownerId]?.name ?? item.ownerId, !!item.restored);
    const control = row.send && point.x >= row.send.x0 && point.x < row.send.x1 ? 'send' as const : row.discard && point.x >= row.discard.x0 && point.x < row.discard.x1 ? 'discard' as const : undefined;
    return {item, control};
  };
  const atExpandButton = (point: {x: number; y: number}) => showExpandButton && point.y === inputY &&
    point.x >= width - expandButtonWidth && point.x < width;
  useEffect(() => {setExpandHovered(false);}, [showExpandButton, currentView, sessionId, inputY, width]);
  const detailMax = Math.max(0, detailContentHeight - questionHeight);
  const detailStart = Math.min(detailOffset, detailMax);
  if (!(questionPanel && focus === 'question') && !(loginState?.phase === 'wizard' && !loginFolded)) setCursorPosition((!loginState || loginFolded) && !surface && !composerExpanded && editableComposer && !closing ? {
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

  const {changeResponse, confirmScenePermission, confirmSceneStyle, actorNameOf, choosePermission, commitAnswer} = createAnswerActions({
    store, roles, scenario, scene, request, response, setResponses, setScene, setFocus, setEditingCustom, setDetailOffset, setNotice});
  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    void onClose().then(() => exit(), error => exit(error));
  };
  const interrupt = () => {
    if (closing || surface?.kind === 'result') return;
    const copied = !composerExpanded && !surface && (!loginState || loginFolded)
      ? (editableComposer ? selectedText(activeDraft) : '') || copySelection() : '';
    if (copied) {stdout?.write(osc52Clipboard(copied)); exitDeadline.current = 0; flash('Copied selection to clipboard', 3500, 'success'); return;}
    const now = Date.now();
    if (exitDeadline.current > now) {close(); return;}
    exitDeadline.current = now + 1500; flash('Press Ctrl+C again to exit', 1500, 'warning');
  };
  const interruptRef = useRef(interrupt); interruptRef.current = interrupt;
  useEffect(() => registerInterrupt?.(() => interruptRef.current()), [registerInterrupt]);
  const stopActor = (activityId: string) => {
    if (stoppingIds.current.has(activityId)) return;
    const target = snapshot.activities.find(item => item.activityId === activityId && item.kind === 'actor' && ['queued', 'running', 'waiting_input', 'paused'].includes(item.status));
    // A tool row's `■ Stop` carries the message id: it stops that one call only.
    const tool = target ? undefined : snapshot.messages.find(item => item.id === activityId && item.step?.state === 'running' && item.step.call);
    if (!target && !tool) return;
    stoppingIds.current.add(activityId); setStopping(new Set(stoppingIds.current));
    if (tool) onCancelTool?.(tool.step!.call!.id); else onCancel(activityId);
  };
  useEffect(() => {
    const next = new Set([...stopping].filter(id => snapshot.activities.some(item => item.activityId === id && ['queued', 'running', 'waiting_input', 'paused'].includes(item.status)) ||
      snapshot.messages.some(item => item.id === id && item.step?.state === 'running')));
    if (next.size !== stopping.size) {stoppingIds.current = next; setStopping(next);}
  }, [snapshot.activities, snapshot.messages, stopping]);
  const {presentReading, copySelection, readingRows, scroll} = useReading({plane, messageRows, timelineHeight, anchors, currentView, composerExpanded, surface,
    welcome, width, layout, contentSelection, hoveredFoldIdRef, view, selection, setAnchor});

  const {sendSceneInput, complete, edit, sendPending, takePendingBack, steerInput} = useComposerActions({draft, activities, currentView, stage, demoScene, onSubmit, onDraft,
    onSendPending, onDiscardPending, setComposerMode, setNotice, flash, draftRevisions, historyFor, setDrafts, setAnchor, setDraft, setCompletion, completion,
    editingCustom, setCustomDraft, setScene, focus, setFocus, request, response, changeResponse, inlineRequest, setPendingHover, pendingAll, steerTarget, selectedActivityId});

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
  useTerminalInput(stdin, stdout, mouseHandlerRef, foldTimerRef);

  usePaste(text => {exitDeadline.current = 0; if (composerExpanded) return; setNotice(''); if ((!loginState || loginFolded) && !surface) edit(current => insert(current, text));});
  const shell: ShellContext = {
    store, sessionId, stage, demoScene, scenario, snapshot, roles, plane, stdout, onSubmit, onCancel, onDraft, currentView, switchView, activities,
    activity, pending, request, response, questionPanel, inlineRequest, freeAnswer, scene, setScene, foldIds, foldActivityId, cardCursor,
    setCardCursor, setSelectedActivityId, setSelectedRequestId, setResponses, expanded, setExpanded, setDetailOffset, detailMax, focus, setFocus,
    focusedStop, setFocusedStop, editingCustom, setEditingCustom, loginState, loginFolded, surface, composerExpanded, setComposerMode, closing, close,
    interrupt, exitDeadline, notice, setNotice, flash, changeResponse, choosePermission, commitAnswer, actorNameOf, confirmScenePermission,
    confirmSceneStyle, draft, activeDraft, editableComposer, edit, setDraft, historyFor, inputLayout, inputView, inputColumns, inputKey, inputY,
    inputHeight, promptWidth, inputDrag, sendSceneInput, steerInput, sendPending, takePendingBack, pendingAt, setPendingHover, atExpandButton,
    setExpandHovered, menuHeight, suggestions, suggestionIndex, query, setCompletion, moveSuggestion, complete, stopActor, cancelledInputs,
    escArmedUntil, width, screenRows, timelineHeight, activityHeight, questionHeight, messageRows, view, selection, anchors, setAnchor, scroll,
    presentReading, readingRows, copySelection, clearSelection, stopEdgeScroll, contentSelection, gesture, edgeTimer, edgePointer, statusSelectionRef,
    lastClickRef, foldTimerRef, lastHoverRef, mouseListeners, hoveredFoldIdRef, setHoveredFoldId, hoveredStopRef, setHoveredStop, hoveredPillRef,
    setHoveredPill, hoveredWidgetRef, setHoveredWidget, footerHeight, footerStatusY, footerLayout, footerStatusText, noticeInline, activePills,
    surfaces, composerMode, setCursorPosition, subscribeMouse, windowColor,
  };
  mouseHandlerRef.current = createMouseHandler(shell);
  useKeyboard(shell);

  const overlay = overlayPage(shell);
  if (overlay) return overlay;
  const hairline = '─'.repeat(width);
  return <Box flexDirection="column" width={width} height={screenRows} overflow="hidden">
    <TimelinePane splash={splash} welcome={welcome} welcomeLines={welcomeLines} plane={plane} view={view} selection={selection} width={width} timelineHeight={timelineHeight}/>
    {loginState?.phase === 'wizard' && authentication && <MouseHost subscribe={subscribeMouse} color={windowColor}><LoginDialog flow={authentication} state={loginState} width={width} height={loginHeight} y={timelineHeight} onCursor={setCursorPosition} onClose={close} notice={notice}/></MouseHost>}
    {surface?.kind === 'picker' && surfaces ? <MouseHost subscribe={subscribeMouse} color={windowColor}><Picker key={surface.id} title={surface.title} description={surface.description}
      items={surface.items} current={surface.current} status={surface.status} error={surface.error} width={width} height={pickerHeight} y={timelineHeight}
      {...(surface.emptyText !== undefined ? {emptyText: surface.emptyText} : {})}
      {...(surface.deleteLabel !== undefined ? {deleteLabel: surface.deleteLabel} : {})} onDelete={id => {void surfaces.deleteItem(surface.id, id);}}
      effort={surface.effort} effortLevels={surface.effortLevels}
      notice={notice} onSelect={(id, effort) => {void surfaces.choose(surface.id, id, effort);}} onCancel={() => surfaces.cancel()}/></MouseHost>
      : loginState && authentication && !loginFolded ? loginState.phase === 'wizard' ? null : <MouseHost subscribe={subscribeMouse} color={windowColor}><LoginDialog flow={authentication} state={loginState} width={width} height={loginHeight} y={timelineHeight} onCursor={setCursorPosition} onClose={close} notice={notice}/></MouseHost> : <>
    {!demoScene && !stage && activity && activityHeight > 0 && <Box height={activityHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      <Box ref={activityRef} flexDirection="column" flexShrink={0}><ActivityCard activity={activity} expanded={expanded} hovered={hoveredFoldId === activity.activityId}/></Box>
    </Box>}
    {questionPanel && response && questionHeight > 0 && <QuestionDock panel={questionPanel} response={response} height={questionHeight} detailStart={detailStart}
      width={width} y={timelineHeight + activityHeight - detailStart} focused={focus === 'question'} windowColor={windowColor} subscribeMouse={subscribeMouse}
      setFocus={setFocus} changeResponse={changeResponse}/>}
    {!questionPanel && !stage && (!demoScene || !inlineRequest) && request && response && questionHeight > 0 && <Box height={questionHeight} flexShrink={0} overflow="hidden" contentOffsetY={detailStart} flexDirection="column">
      <Box ref={detailRef} flexDirection="column" flexShrink={0}>
        <InteractionCard request={request} draft={response} focused={focus === 'question'} height={questionHeight}/>
      </Box>
    </Box>}
    {menuHeight > 0 && <MouseHost subscribe={subscribeMouse} color={windowColor}>
      <CommandMenu items={suggestions} selected={suggestionIndex} width={width} query={draft.text} maxVisible={menuCount} showCounts={menuShowCounts}
        y={timelineHeight + activityHeight + questionHeight}
        onPick={selected => setCompletion({query, selected, dismissed: false})}
        onWheelStep={moveSuggestion}/>
    </MouseHost>}
    {pendingHeight > 0 && <PendingRows shown={pendingShown} height={pendingHeight} width={width} currentView={currentView} roles={roles} hover={pendingHover} windowColor={windowColor}/>}
    {hairlineHeight > 0 && <Box height={1} flexShrink={0}><Text color={composerRule} wrap="truncate">{hairline}</Text></Box>}
    <ComposerLines editable={editableComposer} height={inputHeight} width={width} textWidth={composerTextWidth} view={inputView} selection={inputSelection}
      promptWidth={promptWidth} promptGlyph={promptGlyph} promptColor={composerPrompt} editingCustom={editingCustom} showExpandButton={showExpandButton}
      expandHovered={expandHovered} choiceSummary={choiceSummary}/>
    {hairlineHeight > 0 && <Box height={1} flexShrink={0}><Text color={composerRule} wrap="truncate">{hairline}</Text></Box>}
    {footerHeight > 0 && <FooterBar height={footerHeight} width={width} hasStatus={Boolean(getStatus)} noticeInline={noticeInline} demoScene={demoScene} notice={notice}
      statusLeft={statusLeft} statusLeftColor={statusLeftColor} statusText={footerStatusText} layout={footerLayout} pills={activePills} pillsWidth={pillsWidth}
      hoveredPill={hoveredPill} keys={renderedFooterKeys} note={footerNote}/>}
    </>}
  </Box>;
}
