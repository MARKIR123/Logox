/**
 * The plan sidebar's host: which plan is drawn, whether the sidebar is docked beside the timeline (terminals of at least `DOCK_MIN_COLUMNS` columns) or open
 * as an overlay (narrower ones), its view state (selection, folds, hover, scroll), the footer chip and the keyboard and mouse entry points. `App` calls it
 * once; everything it draws goes through `paintSidebar()` and reaches the screen as the terminal plane's side column (docked) or `PlanOverlay` (overlay).
 *
 * The plan is read with `PlanBoard.peek()` on every store change and kept as the same object while nothing the sidebar shows has changed, so the flow layout is
 * built once per change of plan, width or fold state, never per frame. Visibility rules: a plan that becomes active shows the sidebar (docked terminals only,
 * unless the person hid it), a plan that is done or abandoned hides it with a notice, and the person's last explicit choice is remembered for the session.
 */
import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {Key} from 'ink';
import stringWidth from 'string-width';
import {AUTOMA_OWNER, type DerivedPlan} from '../../runtime/plan.js';
import type {PlanBoard} from '../../store/plans.js';
import type {CommandSurfaces, PlanSidebarMode} from '../../commands/surfaces.js';
import {ownerColor, type ActorStyles} from '../appearance/actor-style.js';
import {palette} from '../appearance/theme.js';
import type {SgrMouseEvent} from '../terminal/mouse.js';
import type {PlaneSide, SideSegment} from '../terminal/terminal-plane.js';
import {buildFlow, type FlowLayout} from './plan-flow.js';
import {DOCK_MIN_COLUMNS, SIDEBAR_MAX, SIDEBAR_MIN, clampScroll, emptyView, flowOptionsFor, followTarget, FOLLOW_PAUSE_MS, paintSidebar, planProgress, revealNode,
  sidebarGeometry, sidebarWidth, stepKey, stepMouse, type SidebarEffect, type SidebarKey, type SidebarStep, type SidebarView} from './plan-sidebar.js';

export interface PlanSidebarInput {
  board: Pick<PlanBoard, 'peek' | 'subscribe' | 'refresh'> & {readonly revision: number} | undefined;
  surfaces: CommandSurfaces | undefined;
  /** The store revision: the sidebar looks at the plan again when it moves. */
  revision: number;
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

export const CHIP_HINT = 'Plan sidebar · click or Ctrl+B shows it';
const NO_PLAN = 'There is no plan yet. The Director creates one when a request has more than one piece of work.';
const shallow = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);
/** Everything the sidebar shows of a plan: equal signatures keep the same plan object. */
const signature = (plan: DerivedPlan) => JSON.stringify([plan.id, plan.title, plan.status, plan.nodes]);

export function usePlanSidebar(input: PlanSidebarInput) {
  const {board, surfaces, revision, columns, width, screenRows, roles, themeVersion, welcome, focus, setFocus, flash, locate} = input;
  const subscribe = useMemo(() => board ? (listener: () => void) => board.subscribe(listener) : noSubscription, [board]);
  const boardRevision = useSyncExternalStore(subscribe, () => board?.revision ?? 0);
  const wide = columns >= DOCK_MIN_COLUMNS;
  // The plan, as the same object while its picture is unchanged.
  const planCache = useRef<{key: string; plan: DerivedPlan} | undefined>(undefined);
  const plan = useMemo(() => {
    const next = board?.peek();
    if (!next) {planCache.current = undefined; return undefined;}
    const key = signature(next);
    if (planCache.current?.key === key) return planCache.current.plan;
    planCache.current = {key, plan: next};
    return next;
  }, [board, boardRevision, revision]);

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

  const docked = Boolean(plan) && shown && wide && !welcome && !overlay;
  const panelVisible = docked || (overlay && Boolean(plan));
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
    const flow = buildFlow(plan, {...flowOptionsFor(panelWidth), expanded, owners: ownerLabel});
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
    previous.current = plan ? {id: plan.id, status: plan.status} : undefined;
    if (plan?.status === 'active' && wide && autoFor.current !== plan.id) {
      autoFor.current = plan.id;
      if (choice.current !== 'hidden') setShown(true);
    }
    // A plan that was active and is done or gone: the sidebar goes away and says how to bring it back.
    if (before?.status === 'active' && (!plan || plan.id !== before.id || plan.status !== 'active') && (shown || overlay)) {
      const done = plan?.id === before.id && plan.status === 'done';
      setShown(false); setOverlay(false);
      if (focus === 'plan') setFocus('input');
      flash(`Plan ${before.id} ${done ? 'is done' : 'was closed'} · /plan sidebar or Ctrl+B shows it again`, 5000, 'info');
    }
  }, [plan?.id, plan?.status, wide]);
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
      case 'open': if (overlay) setOverlay(false); surfaces?.openPlanNode(effect.id); break;
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
    if (!plan) {flash(NO_PLAN, 3500, 'info'); return;}
    if (!wide) {if (overlay) closeOverlay(); else openOverlay(); return;}
    if (!docked) {show(); setFocus('plan'); return;}
    if (focus === 'plan') hide(); else setFocus('plan');
  };
  /** `/plan sidebar show|hide|toggle` and the footer chip: visibility only, the keyboard stays where it is. */
  const request = (mode: PlanSidebarMode) => {
    if (!plan) {flash(NO_PLAN, 3500, 'info'); return;}
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
      pageUp: key.pageUp, pageDown: key.pageDown, home: key.home, end: key.end};
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
      if (event.action === 'move' && viewRef.current.hovered !== undefined) apply({view: {...viewRef.current, hovered: undefined}, effects: [], consumed: false});
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
    const deps = [plan, current, view, panelWidth, height, focused, themeVersion];
    if (!paintCache.current || !shallow(paintCache.current.deps, deps)) {
      const clamped = clampScroll(view, current, sidebarGeometry(height));
      paintCache.current = {deps, lines: paintSidebar({plan, flow: current, view: clamped, width: panelWidth, height, focused,
        ownerColor: id => id === AUTOMA_OWNER ? palette.automa : ownerColor(id, rolesRef.current)})};
    }
    const lines = paintCache.current.lines;
    return docked ? {lines, side: {x: dockX, width: dockWidth, lines}} : {lines};
  };

  const progress = plan ? planProgress(plan) : undefined;
  const chipLabel = progress ? ` ▸ Plan ${progress.accepted}/${progress.total} ` : '';
  const chip = plan && !panelVisible && progress ? {label: chipLabel, width: stringWidth(chipLabel)} : undefined;
  return {plan, docked, overlay, wide, focused: docked && focus === 'plan', keyboardOwner, panelVisible, timelineWidth, dockX, overlayX, overlayWidth, dockWidth,
    chip, chipHover, setChipHover, shortcut, request, show, hide, openOverlay, handleKey, handleMouse, render};
}
export type PlanSidebar = ReturnType<typeof usePlanSidebar>;
const noSubscription = () => () => {};
