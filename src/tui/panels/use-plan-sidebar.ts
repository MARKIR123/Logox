/**
 * The task sidebar's host: which task graph is drawn (`src/runtime/task-graph.ts`: the session's plan with the unlinked work added, the work alone when there is
 * no plan, else the latest plan of an earlier session, read-only; or what `/tasks plans` pinned), whether the sidebar is docked beside the timeline (terminals of at least `DOCK_MIN_COLUMNS` columns) or open
 * as an overlay (narrower ones), its view state (selection, folds, hover, scroll), the footer chip and the keyboard and mouse entry points. `App` calls it
 * once; everything it draws goes through `paintSidebar()` and reaches the screen as the terminal plane's side column (docked) or `PlanOverlay` (overlay).
 *
 * The graph is rebuilt from `PlanBoard.peek()` and the delegation record on every store change and kept as the same object while nothing the sidebar shows has
 * changed, so the flow layout is built once per change of graph, width or fold state, never per frame. Visibility rules: a plan that becomes active shows the
 * sidebar (docked terminals only, unless the person hid it), a plan that is done or abandoned hides it with a notice, and the person's last explicit choice is
 * remembered for the session. A session without a plan never opens it by itself: the graph of its work is one `/tasks`, Ctrl+B or click on the footer chip away.
 */
import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {Key} from 'ink';
import stringWidth from 'string-width';
import type {Delegation} from '../../runtime/delegations.js';
import {AUTOMA_OWNER, type DerivedPlan} from '../../runtime/plan.js';
import {taskGraph} from '../../runtime/task-graph.js';
import type {PlanBoard} from '../../store/plans.js';
import type {CommandSurfaces, PlanSidebarMode, SidebarSource} from '../../commands/surfaces.js';
import {ownerColor, type ActorStyles} from '../appearance/actor-style.js';
import {palette} from '../appearance/theme.js';
import type {SgrMouseEvent} from '../terminal/mouse.js';
import type {PlaneSide, SideSegment} from '../terminal/terminal-plane.js';
import {buildFlow, type FlowLayout} from './plan-flow.js';
import {DOCK_MIN_COLUMNS, SIDEBAR_MAX, SIDEBAR_MIN, clampScroll, type GraphKind, emptyView, flowOptionsFor, followTarget, FOLLOW_PAUSE_MS, paintSidebar, planProgress, revealNode,
  sidebarGeometry, sidebarWidth, stepKey, stepMouse, type SidebarEffect, type SidebarKey, type SidebarStep, type SidebarView} from './plan-sidebar.js';

export interface PlanSidebarInput {
  board: Pick<PlanBoard, 'peek' | 'mine' | 'view' | 'earlier' | 'subscribe' | 'refresh'> & {readonly revision: number} | undefined;
  surfaces: CommandSurfaces | undefined;
  /** The store revision: the sidebar looks at the plan and the delegations again when it moves. */
  revision: number;
  sessionId: string;
  /** The delegation record of the session (`projectDelegations()` of the store snapshot the sidebar follows), in creation order. */
  delegations: () => readonly Delegation[];
  /** Terminal columns and rows, and the usable width `App` lays out with. */
  columns: number;
  width: number;
  screenRows: number;
  roles: ActorStyles;
  themeVersion: number;
  /** The welcome splash owns the timeline rectangle: nothing docks beside it. */
  welcome: boolean;
  focus: 'input' | 'question' | 'stop' | 'plan';
  setFocus(next: 'input' | 'plan'): void;
  flash(text: string, duration?: number, tone?: 'info' | 'success' | 'warning' | 'error'): void;
  /** Scrolls the timeline to an actor's latest card (the same jump as an actor pill click). */
  locate(ownerId: string): void;
}

export const CHIP_HINT = 'Task sidebar · click or Ctrl+B shows it';
export const NO_TASKS = 'Nothing has been planned or delegated in this session yet. The task graph appears when the Director plans a request or dispatches work.';
/** What the sidebar draws: the node ids and layout come from `plan`; `delegationOf` names the delegation behind a synthesized node. */
interface Graph {readonly kind: GraphKind; readonly plan: DerivedPlan; readonly delegationOf: ReadonlyMap<string, string>; readonly synthetic: ReadonlySet<string>}
const NONE: ReadonlyMap<string, string> = new Map(), NONE_SET: ReadonlySet<string> = new Set();
const shallow = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);
/** Everything the sidebar shows of a plan: equal signatures keep the same plan object. */
const signature = (graph: Graph) => JSON.stringify([graph.kind, graph.plan.id, graph.plan.title, graph.plan.status, graph.plan.nodes, [...graph.delegationOf], [...graph.synthetic]]);

export function usePlanSidebar(input: PlanSidebarInput) {
  const {board, surfaces, revision, sessionId, delegations, columns, width, screenRows, roles, themeVersion, welcome, focus, setFocus, flash, locate} = input;
  const subscribe = useMemo(() => board ? (listener: () => void) => board.subscribe(listener) : noSubscription, [board]);
  const boardRevision = useSyncExternalStore(subscribe, () => board?.revision ?? 0);
  const wide = columns >= DOCK_MIN_COLUMNS;
  // What the person chose in `/tasks plans`; undefined follows the session.
  const [pinned, setPinned] = useState<SidebarSource | undefined>(undefined);
  const [pinnedOther, setPinnedOther] = useState<DerivedPlan | undefined>(undefined);
  const [earlier, setEarlier] = useState<DerivedPlan | undefined>(undefined);
  /** The plan of this session the sidebar follows (what visibility rules look at); `peek()` never reads files. */
  const boardPlan = useMemo(() => board?.peek(), [board, boardRevision, revision]);
  // The session's graph, as the same object while its picture is unchanged.
  const graphCache = useRef<{key: string; graph: Graph} | undefined>(undefined);
  const baseGraph = useMemo((): Graph | undefined => {
    let next: Graph | undefined;
    const pinnedPlan = pinned?.kind === 'plan' ? board?.mine(pinned.id) : undefined;
    if (pinned?.kind === 'plan' && !pinnedPlan) next = pinnedOther?.id === pinned.id ? {kind: 'earlier', plan: pinnedOther, delegationOf: NONE, synthetic: NONE_SET} : undefined;
    else {
      const merged = taskGraph(pinned?.kind === 'work' ? undefined : pinnedPlan ?? boardPlan, delegations(), sessionId);
      if (merged) next = {kind: merged.planned ? 'plan' : 'work', plan: merged.plan, delegationOf: merged.delegationOf, synthetic: merged.synthetic};
    }
    if (!next) {graphCache.current = undefined; return undefined;}
    const key = signature(next);
    if (graphCache.current?.key === key) return graphCache.current.graph;
    graphCache.current = {key, graph: next};
    return next;
  }, [board, boardRevision, revision, boardPlan, pinned, pinnedOther, sessionId]);
  const earlierGraph = useMemo((): Graph | undefined => earlier ? {kind: 'earlier', plan: earlier, delegationOf: NONE, synthetic: NONE_SET} : undefined, [earlier]);
  const graph = baseGraph ?? earlierGraph;
  const plan = graph?.plan;
  const graphRef = useRef(graph); graphRef.current = graph;
  // A plan of another session (chosen in the switcher) or, with nothing of this session to draw, the latest earlier plan: read from the project's plan files.
  useEffect(() => {
    if (!board || pinned?.kind !== 'plan' || board.mine(pinned.id)) {setPinnedOther(undefined); return;}
    let live = true;
    void board.view(pinned.id).then(next => {if (live) setPinnedOther(next);}).catch(() => {});
    return () => {live = false;};
  }, [board, pinned, boardRevision]);
  const settled = baseGraph !== undefined || pinned !== undefined;
  useEffect(() => {
    if (!board || settled) {setEarlier(undefined); return;}
    let live = true;
    void board.earlier().then(next => {if (live) setEarlier(next);}).catch(() => {});
    return () => {live = false;};
  }, [board, boardRevision, settled]);
  useEffect(() => surfaces?.subscribeSidebarSource(source => setPinned(source.kind === 'auto' ? undefined : source)), [surfaces]);

  const choice = useRef<'shown' | 'hidden' | undefined>(undefined);
  const autoFor = useRef<string | undefined>(undefined);
  const [shown, setShown] = useState(() => {
    const initial = board?.peek();
    if (initial?.status === 'active' && wide) {autoFor.current = initial.id; return true;}
    return false;
  });
  const [overlay, setOverlay] = useState(false);
  const [view, setView] = useState<SidebarView>(emptyView);
  const [chipHover, setChipHover] = useState(false);
  const viewRef = useRef(view); viewRef.current = view;
  const rolesRef = useRef(roles); rolesRef.current = roles;

  const docked = Boolean(graph) && shown && wide && !welcome && !overlay;
  const panelVisible = docked || (overlay && Boolean(graph));
  const dockWidth = sidebarWidth(width);
  const overlayWidth = Math.max(Math.min(columns, SIDEBAR_MIN), Math.min(width, SIDEBAR_MAX));
  const panelWidth = overlay ? overlayWidth : dockWidth;
  const dockX = width - dockWidth, overlayX = Math.max(0, width - overlayWidth);
  const timelineWidth = docked ? dockX - 1 : width;

  // ------------------------------------------------------------------------------------------------------------------------------ layout
  const ownerLabel = (id: string) => {
    if (id === AUTOMA_OWNER) return {symbol: '◦', name: 'automa'};
    const role = rolesRef.current[id];
    return role ? {symbol: role.symbol, name: role.name.toLowerCase()} : {symbol: '◇', name: id};
  };
  const ownersKey = plan ? [...new Set(plan.nodes.map(node => node.owner))].map(id => id + ownerLabel(id).symbol + ownerLabel(id).name).join('|') : '';
  const flowCache = useRef<{plan: DerivedPlan; width: number; ownersKey: string; expanded: SidebarView['expanded']; flow: FlowLayout} | undefined>(undefined);
  /** The flow for the current plan, panel width and fold state; built once per change of those. */
  const flowFor = (expanded: SidebarView['expanded']): FlowLayout | undefined => {
    if (!plan || !panelVisible) return undefined;
    const cached = flowCache.current;
    if (cached && cached.plan === plan && cached.width === panelWidth && cached.ownersKey === ownersKey && cached.expanded === expanded) return cached.flow;
    const flow = buildFlow(plan, {...flowOptionsFor(panelWidth), expanded, owners: ownerLabel, synthetic: graph!.synthetic});
    flowCache.current = {plan, width: panelWidth, ownersKey, expanded, flow};
    return flow;
  };
  const flow = flowFor(view.expanded);
  const heightRef = useRef(0);

  // ------------------------------------------------------------------------------------------------------------------------------ visibility
  const hide = () => {
    choice.current = 'hidden'; setShown(false); setOverlay(false);
    if (focus === 'plan') setFocus('input');
  };
  const show = () => {
    choice.current = 'shown'; board?.refresh(); setShown(true);
  };
  const openOverlay = () => {board?.refresh(); setOverlay(true);};
  const closeOverlay = () => {setOverlay(false); if (focus === 'plan') setFocus('input');};

  const previous = useRef<{id: string; status: DerivedPlan['status']} | undefined>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = boardPlan ? {id: boardPlan.id, status: boardPlan.status} : undefined;
    if (boardPlan?.status === 'active' && wide && autoFor.current !== boardPlan.id) {
      autoFor.current = boardPlan.id;
      if (choice.current !== 'hidden') setShown(true);
    }
    // A plan that was active and is done or gone: the sidebar goes away and says how to bring it back.
    if (before?.status === 'active' && (!boardPlan || boardPlan.id !== before.id || boardPlan.status !== 'active') && (shown || overlay)) {
      const done = boardPlan?.id === before.id && boardPlan.status === 'done';
      setShown(false); setOverlay(false);
      if (focus === 'plan') setFocus('input');
      flash(`Plan ${before.id} ${done ? 'is done' : 'was closed'} · /tasks or Ctrl+B shows the task graph again`, 5000, 'info');
    }
  }, [boardPlan?.id, boardPlan?.status, wide]);
  // Another graph has other node ids: selection and folds do not carry over.
  const graphKey = graph ? graph.kind + ':' + graph.plan.id : '';
  const lastKey = useRef(graphKey);
  useEffect(() => {if (lastKey.current !== graphKey) {lastKey.current = graphKey; setView(emptyView);}}, [graphKey]);
  // The keyboard cannot stay in a sidebar that is not there.
  useEffect(() => {if (focus === 'plan' && !docked && !overlay) setFocus('input');}, [focus, docked, overlay]);

  // The running node scrolls into view unless the person scrolled lately.
  const followed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!plan || !flow) {followed.current = undefined; return;}
    const target = followTarget(plan, flow);
    if (target === followed.current) return;
    followed.current = target;
    if (target === undefined || Date.now() - viewRef.current.scrolledAt <= FOLLOW_PAUSE_MS) return;
    setView(current => revealNode(current, flow, sidebarGeometry(heightRef.current), target));
  }, [flow, plan]);

  // ------------------------------------------------------------------------------------------------------------------------------ interaction
  const apply = (step: SidebarStep) => {
    const before = viewRef.current;
    if (step.view !== before) {viewRef.current = step.view; setView(step.view);}
    for (const effect of step.effects) run(effect);
  };
  const run = (effect: SidebarEffect) => {
    switch (effect.kind) {
      case 'focus': if (!overlay) setFocus('plan'); break;
      case 'blur': if (overlay) closeOverlay(); else setFocus('input'); break;
      case 'close': hide(); break;
      case 'open': {
        if (overlay) setOverlay(false);
        const delegation = graphRef.current?.delegationOf.get(effect.id);
        if (delegation) surfaces?.openWorkNode(delegation);
        else surfaces?.openPlanNode(effect.id, graphRef.current?.plan.id);
        break;
      }
      case 'plans': if (overlay) setOverlay(false); surfaces?.openPlans(); break;
      case 'owner': {
        const owner = plan?.nodes.find(node => node.id === effect.id)?.owner;
        if (!owner) break;
        if (owner === AUTOMA_OWNER) {flash('Automa workers have no card of their own: open the node for their jobs.', 3500, 'info'); break;}
        if (overlay) setOverlay(false);
        locate(owner);
        break;
      }
    }
  };
  /** The shortcut: shown or hidden, with the keyboard in it when it opens (once: show and focus, Esc: back to the composer, again: hide). */
  const shortcut = () => {
    if (!plan) {flash(NO_TASKS, 3500, 'info'); return;}
    if (!wide) {if (overlay) closeOverlay(); else openOverlay(); return;}
    if (!docked) {show(); setFocus('plan'); return;}
    if (focus === 'plan') hide(); else setFocus('plan');
  };
  /** `/tasks [sidebar] show|hide|toggle` and the footer chip: visibility only, the keyboard stays where it is. */
  const request = (mode: PlanSidebarMode) => {
    if (!plan) {flash(NO_TASKS, 3500, 'info'); return;}
    const want = mode === 'toggle' ? !panelVisible : mode === 'show';
    if (!wide) {if (want) openOverlay(); else closeOverlay(); return;}
    if (want) show(); else hide();
  };
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => surfaces?.subscribePlanSidebar(mode => requestRef.current(mode)), [surfaces]);

  const keyboardOwner = overlay || docked && focus === 'plan';
  const handleKey = (typed: string, key: Key): boolean => {
    const current = flowFor(viewRef.current.expanded);
    if (!current || !plan) return false;
    if (key.tab) return false;
    if (key.ctrl || key.meta) return overlay;
    const mapped: SidebarKey = {up: key.upArrow, down: key.downArrow, left: key.leftArrow, right: key.rightArrow, enter: key.return, escape: key.escape,
      pageUp: key.pageUp, pageDown: key.pageDown, home: key.home, end: key.end, plans: typed === 'p'};
    const step = stepKey(current, viewRef.current, sidebarGeometry(heightRef.current), mapped, Date.now());
    if (step.consumed) {apply(step); return true;}
    if (overlay) return true;
    // A typing key returns the keyboard to the composer and is typed there.
    if (typed) setFocus('input');
    return false;
  };
  /** Routes one mouse event; true when the sidebar took it. `busy` is a timeline or composer gesture in progress. */
  const handleMouse = (event: SgrMouseEvent, busy: boolean): boolean => {
    const current = flowFor(viewRef.current.expanded);
    if (!panelVisible || !current || !plan) return false;
    const x0 = overlay ? overlayX : dockX;
    const inside = event.x >= x0 && event.x < x0 + panelWidth && event.y < heightRef.current;
    if (!inside) {
      if (overlay) {if (event.action === 'press' && event.button === 0) closeOverlay(); return true;}
      if (event.action === 'move' && (viewRef.current.hovered !== undefined || viewRef.current.hoveredHeader)) apply({view: {...viewRef.current, hovered: undefined, hoveredHeader: false}, effects: [], consumed: false});
      return false;
    }
    if (busy && !overlay && (event.action === 'drag' || event.action === 'release')) return false;
    if (event.action === 'drag' || event.action === 'release') return true;
    if (event.action === 'press' && event.button !== 0) return true;
    apply(stepMouse(current, viewRef.current, sidebarGeometry(heightRef.current), {x: event.x - x0, y: event.y, action: event.action}, Date.now()));
    return true;
  };

  // ------------------------------------------------------------------------------------------------------------------------------ painting
  const paintCache = useRef<{deps: readonly unknown[]; lines: SideSegment[][]} | undefined>(undefined);
  /** The lines of the panel for `height` rows (the timeline's when docked, the screen's as an overlay). */
  const render = (height: number): {readonly lines: readonly (readonly SideSegment[])[]; readonly side?: PlaneSide} | undefined => {
    heightRef.current = height;
    const current = flowFor(view.expanded);
    if (!plan || !current || !panelVisible) return undefined;
    const focused = overlay || focus === 'plan';
    const deps = [plan, current, view, panelWidth, height, focused, themeVersion, graph!.kind];
    if (!paintCache.current || !shallow(paintCache.current.deps, deps)) {
      const clamped = clampScroll(view, current, sidebarGeometry(height));
      paintCache.current = {deps, lines: paintSidebar({plan, flow: current, view: clamped, width: panelWidth, height, focused, kind: graph!.kind, synthetic: graph!.synthetic,
        ownerColor: id => id === AUTOMA_OWNER ? palette.automa : ownerColor(id, rolesRef.current)})};
    }
    const lines = paintCache.current.lines;
    return docked ? {lines, side: {x: dockX, width: dockWidth, lines}} : {lines};
  };

  const progress = plan ? planProgress(plan, graph!.synthetic) : undefined;
  const chipLabel = !progress ? '' : graph!.kind === 'earlier' ? ' ▸ Earlier tasks ' : ` ▸ Tasks ${progress.accepted}/${progress.total} `;
  const chip = plan && !panelVisible && progress ? {label: chipLabel, width: stringWidth(chipLabel)} : undefined;
  return {plan, docked, overlay, wide, focused: docked && focus === 'plan', keyboardOwner, panelVisible, timelineWidth, dockX, overlayX, overlayWidth, dockWidth,
    chip, chipHover, setChipHover, shortcut, request, show, hide, openOverlay, handleKey, handleMouse, render};
}
export type PlanSidebar = ReturnType<typeof usePlanSidebar>;
const noSubscription = () => () => {};
