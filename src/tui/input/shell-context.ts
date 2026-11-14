// The bundle of `App` state, refs and closures that the keyboard, mouse and click routers read. `App` builds one object per
// render (just before the routers run) from values it already owns; nothing here is state of its own, so a router reads exactly
// what the original inline handler closed over. Refs are the same objects `App` holds, never copies.
import type {Dispatch, MutableRefObject, SetStateAction} from 'react';
import type {RuntimeStore} from '../../runtime/store.js';
import type {Activity, Interaction, RuntimeSnapshot} from '../../runtime/contracts.js';
import type {PortfolioActivities} from '../../demo/portfolio.js';
import type {DemoSceneState, DemoSceneUi} from '../../demo/scene.js';
import type {SubmitDelivery} from '../../application.js';
import type {ActorStyles} from '../appearance/actor-style.js';
import type {CommandSuggestion} from '../commands/completion.js';
import type {ApprovalDecision} from '../interactions/approval-view.js';
import type {ResponseDraft} from '../interactions/response-draft.js';
import type {ActivePillItem} from '../status/actor-pills.js';
import type {NoticeTone} from '../status/notification-line.js';
import type {statusbarLayout} from '../status/statusbar.js';
import type {SceneAction, SceneRow} from '../timeline/scene.js';
import type {ContentSelection, selectionInViewport} from '../timeline/selection.js';
import type {Anchor, Row, viewport} from '../timeline/viewport.js';
import type {TerminalPlane} from '../terminal/terminal-plane.js';
import type {layoutInput, inputViewport, Draft} from './editor.js';
import type {StatusbarId} from '../../config/statusbar-preferences.js';
import type {useCursor, useStdout} from 'ink';
import type {CommandSurface} from '../../runtime/command-surface.js';
import type {CommandSurfaces} from '../../commands/surfaces.js';
import type {MouseSubscriber} from '../terminal/mouse.js';

export type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;
export type FocusTarget = 'input' | 'question' | 'stop';
export interface Gesture {x: number; y: number; dragged: boolean; action?: SceneAction; row?: SceneRow; lastDragX?: number; lastDragY?: number}

export interface ShellContext {
  // Session, mode and external callbacks.
  store: RuntimeStore;
  sessionId: string;
  stage: boolean;
  demoScene: boolean;
  scenario: PortfolioActivities | undefined;
  snapshot: RuntimeSnapshot;
  roles: ActorStyles;
  plane: TerminalPlane | null;
  stdout: ReturnType<typeof useStdout>['stdout'];
  onSubmit(text: string, source?: string, delivery?: SubmitDelivery): Promise<void>;
  onCancel(activityId: string): void;
  onDraft: (() => void) | undefined;
  // Window, activity and interaction selection.
  currentView: string;
  switchView(target: string): void;
  activities: Activity[];
  activity: Activity | undefined;
  pending: Interaction[];
  request: Interaction | undefined;
  response: ResponseDraft | undefined;
  questionPanel: Extract<Interaction, {kind: 'question'}> | undefined;
  inlineRequest: unknown;
  freeAnswer: unknown;
  scene: DemoSceneState;
  setScene: Setter<DemoSceneUi>;
  foldIds: string[];
  foldActivityId(id: string | undefined): string;
  cardCursor: number;
  setCardCursor: Setter<number>;
  setSelectedActivityId: Setter<string>;
  setSelectedRequestId: Setter<string>;
  setResponses: Setter<Record<string, ResponseDraft>>;
  expanded: boolean;
  setExpanded: Setter<boolean>;
  setDetailOffset: Setter<number>;
  detailMax: number;
  focus: FocusTarget;
  setFocus: Setter<FocusTarget>;
  focusedStop: string;
  setFocusedStop: Setter<string>;
  editingCustom: boolean;
  setEditingCustom: Setter<boolean>;
  // Overlays that take the keyboard.
  loginState: unknown;
  loginFolded: boolean;
  surface: CommandSurface | null;
  surfaces: CommandSurfaces | undefined;
  composerMode: {sessionId: string; ownerId: string; scrollOffset: number | null} | null;
  setCursorPosition: ReturnType<typeof useCursor>['setCursorPosition'];
  subscribeMouse: MouseSubscriber;
  windowColor: string;
  composerExpanded: boolean;
  setComposerMode: Setter<{sessionId: string; ownerId: string; scrollOffset: number | null} | null>;
  closing: boolean;
  close(): void;
  interrupt(): void;
  exitDeadline: Ref<number>;
  // Notices.
  notice: string;
  setNotice(text: string, tone?: NoticeTone): void;
  flash(text: string, duration?: number, tone?: NoticeTone): void;
  // Answers.
  changeResponse(update: (current: ResponseDraft) => ResponseDraft): void;
  choosePermission(item: Interaction, decision: ApprovalDecision, note?: string): void;
  commitAnswer(): void;
  actorNameOf(item: Interaction): string;
  confirmScenePermission(): void;
  confirmSceneStyle(): void;
  // Composer and command menu.
  draft: Draft;
  activeDraft: Draft;
  editableComposer: boolean;
  edit(fn: (current: Draft) => Draft): void;
  setDraft(fn: (current: Draft) => Draft): void;
  historyFor(ownerId: string): {browse(draft: Draft, direction: number): Draft};
  inputLayout: ReturnType<typeof layoutInput>;
  inputView: ReturnType<typeof inputViewport>;
  inputColumns: number;
  inputKey: string;
  inputY: number;
  inputHeight: number;
  promptWidth: number;
  inputDrag: Ref<{key: string; anchor: number} | null>;
  sendSceneInput(text?: string, delivery?: SubmitDelivery): void;
  steerInput(): void;
  sendPending(id: string): void;
  takePendingBack(id: string): void;
  pendingAt(point: {x: number; y: number}): {item: {id: string}; control: 'send' | 'discard' | undefined} | undefined;
  setPendingHover: Setter<{id: string; control: 'send' | 'discard'} | null>;
  atExpandButton(point: {x: number; y: number}): boolean;
  setExpandHovered: Setter<boolean>;
  menuHeight: number;
  suggestions: readonly CommandSuggestion[];
  suggestionIndex: number;
  query: string;
  setCompletion: Setter<{query: string; selected: number; dismissed: boolean}>;
  moveSuggestion(direction: number): void;
  complete(suggestion: CommandSuggestion, execute: boolean): void;
  // Stopping and cancelling.
  stopActor(activityId: string): void;
  cancelledInputs: Ref<Set<string>>;
  escArmedUntil: Ref<number>;
  // Timeline geometry, scrolling and selection.
  width: number;
  screenRows: number;
  timelineHeight: number;
  activityHeight: number;
  questionHeight: number;
  messageRows: readonly Row[];
  view: ReturnType<typeof viewport>;
  selection: ReturnType<typeof selectionInViewport>;
  anchors: Ref<Record<string, Anchor | null>>;
  setAnchor(next: Anchor | null): void;
  scroll(amount: number): void;
  presentReading(): void;
  readingRows(): readonly Row[];
  copySelection(): string;
  clearSelection(): void;
  stopEdgeScroll(): void;
  contentSelection: Ref<ContentSelection | null>;
  gesture: Ref<Gesture | null>;
  edgeTimer: Ref<ReturnType<typeof setInterval> | undefined>;
  edgePointer: Ref<{x: number; y: number} | null>;
  statusSelectionRef: Ref<{startX: number; currentX: number; active: boolean; text: string} | null>;
  lastClickRef: Ref<{time: number; key: string}>;
  foldTimerRef: Ref<ReturnType<typeof setTimeout> | null>;
  lastHoverRef: Ref<{x: number; y: number}>;
  mouseListeners: Ref<Set<(event: import('../terminal/mouse.js').SgrMouseEvent) => void>>;
  // Hover state and the footer layout shared by drawing and hit tests.
  hoveredFoldIdRef: Ref<string | null>;
  setHoveredFoldId: Setter<string | null>;
  hoveredStopRef: Ref<string>;
  setHoveredStop: Setter<string>;
  hoveredPillRef: Ref<string | null>;
  setHoveredPill: Setter<string | null>;
  hoveredWidgetRef: Ref<StatusbarId | null>;
  setHoveredWidget: Setter<StatusbarId | null>;
  footerHeight: number;
  footerStatusY: number;
  footerLayout: ReturnType<typeof statusbarLayout>;
  footerStatusText: string;
  noticeInline: boolean;
  activePills: readonly ActivePillItem[];
}
