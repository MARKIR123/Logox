/**
 * The sidebar's host: the team stage (`team-sidebar.ts`), one act at a time of the session's task graph (`src/runtime/task-graph.ts`: the plan with the work nobody
 * linked to it added, or the work alone when there is no plan; `src/runtime/team-acts.ts` maps the team events to its acts). It decides whether the sidebar is docked
 * beside the timeline (terminals of at least `DOCK_MIN_COLUMNS` columns) or open as an overlay (narrower ones), keeps its view state (replay point, playback,
 * filter, hover, pulse), the footer chip and the keyboard and mouse entry points. `App` calls it once; everything it draws goes through `paintTeam()` and reaches
 * the screen as the terminal plane's side column (docked) or `PlanOverlay` (overlay).
 *
 * The graph is rebuilt from `PlanBoard.peek()` and the delegation record on every store change and kept as the same object while nothing the sidebar shows has
 * changed, so the acts and the layout are built once per change of events, graph, width or filter, never per frame. Visibility rules: a plan that becomes active
 * shows the sidebar (docked terminals only, unless the person hid it), a plan that is done or abandoned hides it with a notice, and the person's last explicit
 * choice is remembered for the session. A session without a plan never opens it by itself: `/team`, Ctrl+B or a click on the footer chip show it.
 */
import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {Key} from 'ink';
import stringWidth from 'string-width';
import type {Delegation} from '../../runtime/delegations.js';
import {AUTOMA_OWNER, type DerivedPlan} from '../../runtime/plan.js';
import {taskGraph, type TaskGraph} from '../../runtime/task-graph.js';
import type {PlanBoard} from '../../store/plans.js';
import {actIndexAt, actModel, actProgress} from '../../runtime/team-acts.js';
import {teamMembers, type TeamEvent} from '../../runtime/team-events.js';
import type {CommandSurfaces, SidebarMode} from '../../commands/surfaces.js';
import {ownerColor, type ActorStyles} from '../appearance/actor-style.js';
import {palette} from '../appearance/theme.js';
import type {SgrMouseEvent} from '../terminal/mouse.js';
import type {PlaneSide, SideSegment} from '../terminal/terminal-plane.js';
import {DOCK_MIN_COLUMNS, SIDEBAR_MAX, SIDEBAR_MIN, dragWidth, sidebarWidth} from './sidebar-frame.js';
import {actorDetail} from '../../runtime/team-stage.js';
import {PLAY_STEP_MS, arrived, buildTeamLayout, currentAct, emptyTeamView, jumpToAct, paintTeam, selectedId, stepPlay, stepTeamKey, stepTeamMouse, teamGeometryFor, teamLabeler, teamWidth, type TeamEffect,
  type TeamLayout, type TeamStep, type TeamView} from './team-sidebar.js';
import {PULSE_MS} from './team-stage.js';

export interface TeamSidebarInput {
  board: Pick<PlanBoard, 'peek' | 'subscribe' | 'refresh'> & {readonly revision: number} | undefined;
  surfaces: CommandSurfaces | undefined;
  /** The store revision: the sidebar looks at the plan and the delegations again when it moves. */
  revision: number;
  sessionId: string;
  /** The delegation record of the session (`projectDelegations()` of the store snapshot the sidebar follows), in creation order. */
  delegations: () => readonly Delegation[];
  /** The team event stream of the session (`src/runtime/team-events.ts`, memoised by the caller): the same array while nothing in it changed. */
  team: () => readonly TeamEvent[];
  /** When the Director ended a round normally, ascending (`directorCloses()` of the same snapshot): what closes an act. */
  closes: () => readonly number[];
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
}

export const CHIP_HINT = 'Team stage · click or Ctrl+B shows it';
export const NO_TASKS = 'Nothing has been planned or delegated in this session yet. The team stage fills in when the Director plans a request or dispatches work.';
const shallow = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);
/** Everything the sidebar shows of a graph: equal signatures keep the same graph object. */
const signature = (graph: TaskGraph) => JSON.stringify([graph.planned, graph.plan.id, graph.plan.title, graph.plan.status, graph.plan.nodes, [...graph.delegationOf], [...graph.synthetic]]);

export function useTeamSidebar(input: TeamSidebarInput) {
  const {board, surfaces, revision, sessionId, delegations, team, columns, width, roles, themeVersion, welcome, focus, setFocus, flash} = input;
  const subscribe = useMemo(() => board ? (listener: () => void) => board.subscribe(listener) : noSubscription, [board]);
  const boardRevision = useSyncExternalStore(subscribe, () => board?.revision ?? 0);
  const wide = columns >= DOCK_MIN_COLUMNS;
  /** The plan of this session the sidebar follows (what visibility rules look at); `peek()` never reads files. */
  const boardPlan = useMemo(() => board?.peek(), [board, boardRevision, revision]);
  // The session's task graph, as the same object while its picture is unchanged.
  const graphCache = useRef<{key: string; graph: TaskGraph} | undefined>(undefined);
  const graph = useMemo((): TaskGraph | undefined => {
    const next = taskGraph(boardPlan, delegations(), sessionId);
    if (!next) {graphCache.current = undefined; return undefined;}
    const key = signature(next);
    if (graphCache.current?.key === key) return graphCache.current.graph;
    graphCache.current = {key, graph: next};
    return next;
  }, [board, boardRevision, revision, boardPlan, sessionId]);

  // The team event stream, the acts it falls into and the view state of the stage.
  const events = useMemo(() => team(), [revision, sessionId]);
  const eventsRef = useRef(events); eventsRef.current = events;
  // The times the Director ended a round normally (what closes an act), the same array while they do not change.
  const closesRef = useRef<readonly number[]>([]);
  const closes = useMemo(() => {
    const next = input.closes(), before = closesRef.current;
    if (before.length === next.length && before.every((time, at) => time === next[at])) return before;
    closesRef.current = next;
    return next;
  }, [revision, sessionId]);
  const acts = useMemo(() => actModel(graph, events, closes), [graph, events, closes]);
  const actsRef = useRef(acts); actsRef.current = acts;
  // `/team` asked for it: the stage shows (empty, with a hint) even before anything happened.
  const [teamAsked, setTeamAsked] = useState(false);
  const [teamView, setTeamView] = useState<TeamView>(emptyTeamView);
  const teamViewRef = useRef(teamView); teamViewRef.current = teamView;
  const hasContent = Boolean(graph) || events.length > 0 || teamAsked;
  useEffect(() => {setTeamView(emptyTeamView); teamViewRef.current = emptyTeamView;}, [sessionId]);

  const choice = useRef<'shown' | 'hidden' | undefined>(undefined);
  const autoFor = useRef<string | undefined>(undefined);
  const [shown, setShown] = useState(() => {
    const initial = board?.peek();
    if (initial?.status === 'active' && wide) {autoFor.current = initial.id; return true;}
    return false;
  });
  const [overlay, setOverlay] = useState(false);
  const [chipHover, setChipHover] = useState(false);
  const rolesRef = useRef(roles); rolesRef.current = roles;

  const docked = hasContent && shown && wide && !welcome && !overlay;
  const panelVisible = docked || (overlay && hasContent);
  // The width the person dragged the border to (undefined: the default). It is kept as chosen and re-clamped into the current range, so a narrow terminal never loses it.
  const [preferred, setPreferred] = useState<number | undefined>(() => surfaces?.sidebarWidthStore?.get());
  const preferredRef = useRef(preferred); preferredRef.current = preferred;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);
  const dockWidth = sidebarWidth(width, preferred);
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
  const heightRef = useRef(0);
  // The layout: built once per change of the events, the acts, the width, the member filter and who is who.
  const label = useMemo(() => teamLabeler(ownerLabel), [roles]);
  const teamOwnersKey = useMemo(() => [...teamMembers(events), 'automa'].map(id => id + label(id).symbol + label(id).name).join('|'), [events, label]);
  const teamCache = useRef<{events: readonly TeamEvent[]; acts: typeof acts; width: number; filter: string | undefined; ownersKey: string; layout: TeamLayout} | undefined>(undefined);
  const layoutNow = (filter = teamViewRef.current.filter): TeamLayout => {
    const wanted = teamWidth(panelWidth), cached = teamCache.current;
    if (cached && cached.events === events && cached.acts === acts && cached.width === wanted && cached.filter === filter && cached.ownersKey === teamOwnersKey) return cached.layout;
    const layout = buildTeamLayout(events, {width: wanted, filter, label, acts});
    teamCache.current = {events, acts, width: wanted, filter, ownersKey: teamOwnersKey, layout};
    return layout;
  };
  const teamLayoutFor = (): TeamLayout | undefined => panelVisible ? layoutNow() : undefined;
  useEffect(() => {if (!docked) {dragRef.current = false; setDragging(false);}}, [docked]);
  // Playback: one post per `PLAY_STEP_MS / speed`, started by the stage's Play control or Space; the end switches to Live. One timer, re-armed after each step.
  const playing = teamView.playing === true, speed = teamView.speed ?? 1;
  useEffect(() => {
    if (!playing || !panelVisible) return;
    const timer = setTimeout(() => {
      const layout = teamLayoutFor();
      if (!layout) return;
      applyTeam({view: stepPlay(layout, teamViewRef.current, teamGeometryFor(layout, heightRef.current), Date.now()), effects: [], consumed: true});
    }, PLAY_STEP_MS / speed);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [playing, speed, teamView.selected, teamView.live, panelVisible]);
  // A post that arrives while Live pulses on the stage (a view that left Live is not disturbed).
  const newest = events.at(-1)?.id, seenNewest = useRef(newest);
  useEffect(() => {
    if (seenNewest.current === newest) return;
    seenNewest.current = newest;
    const layout = teamLayoutFor();
    if (!layout || newest === undefined || selectedId(layout, teamViewRef.current) !== newest) return;
    const next = arrived(teamViewRef.current, newest, Date.now());
    if (next !== teamViewRef.current) {teamViewRef.current = next; setTeamView(next);}
  }, [newest]);

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

  const previous = useRef<{id: string; title: string; status: DerivedPlan['status']} | undefined>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = boardPlan ? {id: boardPlan.id, title: boardPlan.title, status: boardPlan.status} : undefined;
    if (boardPlan?.status === 'active' && wide && autoFor.current !== boardPlan.id) {
      autoFor.current = boardPlan.id;
      if (choice.current !== 'hidden') setShown(true);
    }
    // A plan that was active and is done or gone: the sidebar goes away and says how to bring it back.
    if (before?.status === 'active' && (!boardPlan || boardPlan.id !== before.id || boardPlan.status !== 'active') && (shown || overlay)) {
      const done = boardPlan?.id === before.id && boardPlan.status === 'done';
      setShown(false); setOverlay(false);
      if (focus === 'plan') setFocus('input');
      flash(`Plan "${before.title}" ${done ? 'is done' : 'was closed'} · /team or Ctrl+B shows the team stage again`, 5000, 'info');
    }
  }, [boardPlan?.id, boardPlan?.status, wide]);
  // The keyboard cannot stay in a sidebar that is not there.
  useEffect(() => {if (focus === 'plan' && !docked && !overlay) setFocus('input');}, [focus, docked, overlay]);

  // ------------------------------------------------------------------------------------------------------------------------------ interaction
  const applyTeam = (step: TeamStep) => {
    if (step.view !== teamViewRef.current) {teamViewRef.current = step.view; setTeamView(step.view);}
    for (const effect of step.effects) runTeam(effect);
  };
  const runTeam = (effect: TeamEffect) => {
    switch (effect.kind) {
      case 'focus': if (!overlay) setFocus('plan'); break;
      case 'blur': if (overlay) closeOverlay(); else setFocus('input'); break;
      case 'close': if (overlay) closeOverlay(); else hide(); break;
      case 'drag': if (!overlay) {dragRef.current = true; setDragging(true);} break;
      case 'reset-width': setPreferred(undefined); preferredRef.current = undefined; surfaces?.sidebarWidthStore?.set(undefined); break;
      case 'programme': {
        if (overlay) setOverlay(false);
        surfaces?.openProgramme(currentAct(layoutNow(), teamViewRef.current));
        break;
      }
      case 'actor': {
        // The detail page of the card's actor at the replay point the stage shows.
        const layout = teamLayoutFor(), shown = layout ? selectedId(layout, teamViewRef.current) : undefined;
        const index = shown === undefined ? eventsRef.current.length - 1 : eventsRef.current.findIndex(item => item.id === shown);
        if (overlay) setOverlay(false);
        surfaces?.openTeamActor(actorDetail(eventsRef.current, index, effect.id));
        break;
      }
      case 'open': {
        const event = eventsRef.current.find(item => item.id === effect.id);
        if (!event) break;
        if (overlay) setOverlay(false);
        surfaces?.openTeamPost(event);
        break;
      }
    }
  };
  /** The Programme page chose an act: the stage moves to its first event (the member filter is dropped when it hides every event of the act). */
  const jump = (act: number) => {
    let view = teamViewRef.current, layout = layoutNow(view.filter);
    let next = jumpToAct(layout, view, teamGeometryFor(layout, heightRef.current), act);
    if (!next && view.filter !== undefined) {
      view = {...view, filter: undefined, picker: undefined}; layout = layoutNow(undefined);
      next = jumpToAct(layout, view, teamGeometryFor(layout, heightRef.current), act);
    }
    if (next) {teamViewRef.current = next; setTeamView(next);}
  };
  const jumpRef = useRef(jump); jumpRef.current = jump;
  useEffect(() => surfaces?.subscribeStageAct(act => jumpRef.current(act)), [surfaces]);
  /** The shortcut: shown or hidden, with the keyboard in it when it opens (once: show and focus, Esc: back to the composer, again: hide). */
  const shortcut = () => {
    if (!hasContent) {flash(NO_TASKS, 3500, 'info'); return;}
    if (!wide) {if (overlay) closeOverlay(); else openOverlay(); return;}
    if (!docked) {show(); setFocus('plan'); return;}
    if (focus === 'plan') hide(); else setFocus('plan');
  };
  /** `/team [sidebar] show|hide|toggle` and the footer chip: visibility only, the keyboard stays where it is. `/team` shows the stage even when nothing has happened yet. */
  const request = (mode: SidebarMode) => {
    setTeamAsked(true);
    const want = mode === 'toggle' ? !panelVisible : mode === 'show';
    if (!wide) {if (want) openOverlay(); else closeOverlay(); return;}
    if (want) show(); else hide();
  };
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => surfaces?.subscribeSidebar(mode => requestRef.current(mode)), [surfaces]);

  const keyboardOwner = overlay || docked && focus === 'plan';
  const handleKey = (typed: string, key: Key): boolean => {
    const layout = teamLayoutFor();
    if (!layout) return false;
    if (key.tab) return false;
    if (key.ctrl || key.meta) return overlay;
    const mapped = {up: key.upArrow, down: key.downArrow, left: key.leftArrow, right: key.rightArrow, enter: key.return, escape: key.escape,
      pageUp: key.pageUp, pageDown: key.pageDown, home: key.home, end: key.end, programme: typed === 'p', actPrev: typed === '[', actNext: typed === ']', filter: typed === 'f',
      space: typed === ' ', faster: typed === '+' || typed === '=', slower: typed === '-' || typed === '_'};
    const step = stepTeamKey(layout, teamViewRef.current, teamGeometryFor(layout, heightRef.current), mapped, Date.now());
    if (step.consumed) {applyTeam(step); return true;}
    if (overlay) return true;
    // A typing key returns the keyboard to the composer and is typed there.
    if (typed) setFocus('input');
    return false;
  };
  /** Routes one mouse event; true when the sidebar took it. `busy` is a timeline or composer gesture in progress. */
  const handleMouse = (event: SgrMouseEvent, busy: boolean): boolean => {
    const layout = teamLayoutFor();
    if (!panelVisible || !layout) return false;
    const x0 = overlay ? overlayX : dockX;
    if (dragRef.current) {
      // The border is held: the sidebar follows the pointer wherever it goes (and the timeline starts no selection); anything but a drag ends it.
      if (event.action === 'drag') {
        const next = dragWidth(width, event.x);
        if (next !== preferredRef.current) {preferredRef.current = next; setPreferred(next);}
      } else {
        dragRef.current = false; setDragging(false);
        if (preferredRef.current !== undefined) surfaces?.sidebarWidthStore?.set(preferredRef.current);
      }
      return true;
    }
    // The timeline scrubber is held: it follows the pointer wherever it goes until the release.
    if (teamViewRef.current.scrubbing && (event.action === 'drag' || event.action === 'release')) {
      applyTeam(stepTeamMouse(layout, teamViewRef.current, teamGeometryFor(layout, heightRef.current), {x: event.x - x0, y: event.y, action: event.action}, Date.now(), panelWidth, label));
      return true;
    }
    const inside = event.x >= x0 && event.x < x0 + panelWidth && event.y < heightRef.current;
    if (!inside) {
      if (overlay) {if (event.action === 'press' && event.button === 0) closeOverlay(); return true;}
      const now = teamViewRef.current;
      if (event.action === 'move' && (now.hovered !== undefined || now.hoveredName !== undefined || now.hoveredControl !== undefined || now.hoveredEdge || now.hoveredStage !== undefined)) {
        applyTeam({view: {...now, hovered: undefined, hoveredName: undefined, hoveredControl: undefined, hoveredEdge: undefined, hoveredStage: undefined}, effects: [], consumed: false});
      }
      return false;
    }
    if (busy && !overlay && (event.action === 'drag' || event.action === 'release')) return false;
    if (event.action === 'drag' || event.action === 'release') return true;
    if (event.action === 'press' && event.button !== 0) return true;
    const pointer = {x: event.x - x0, y: event.y, action: event.action, draggable: !overlay};
    applyTeam(stepTeamMouse(layout, teamViewRef.current, teamGeometryFor(layout, heightRef.current), pointer, Date.now(), panelWidth, label));
    return true;
  };

  // ------------------------------------------------------------------------------------------------------------------------------ painting
  const paintCache = useRef<{deps: readonly unknown[]; lines: SideSegment[][]} | undefined>(undefined);
  /** The lines of the panel for `height` rows (the timeline's when docked, the screen's as an overlay). */
  const render = (height: number): {readonly lines: readonly (readonly SideSegment[])[]; readonly side?: PlaneSide} | undefined => {
    heightRef.current = height;
    const layout = teamLayoutFor();
    if (!layout || !panelVisible) return undefined;
    const focused = overlay || focus === 'plan';
    const deps = ['team', layout, teamView, panelWidth, height, focused, themeVersion, dragging];
    const paint = (pulseMs?: number) => paintTeam({layout, view: teamView, width: panelWidth, height, focused, dragging, label, stage: true,
      ownerColor: id => id === AUTOMA_OWNER ? palette.automa : ownerColor(id, rolesRef.current), ...(pulseMs !== undefined ? {pulseMs} : {})});
    if (!paintCache.current || !shallow(paintCache.current.deps, deps)) paintCache.current = {deps, lines: paint()};
    const lines = paintCache.current.lines;
    if (!docked) return {lines};
    // The pulse of a post that just began: the terminal plane asks for the lines again every animation frame until it has travelled (docked only; the overlay shows the stage at rest).
    const pulse = teamView.pulse;
    const animate = pulse && Date.now() - pulse.at < PULSE_MS && selectedId(layout, teamView) === pulse.id
      ? (now: number, motion: boolean) => {const ms = now - pulse.at; return motion && ms >= 0 && ms < PULSE_MS ? {lines: paint(ms), busy: true} : {lines: paintCache.current?.lines ?? lines, busy: false};}
      : undefined;
    return {lines, side: {x: dockX, width: dockWidth, lines, ...(animate ? {animate} : {})}};
  };

  // The chip: the act the newest event is in and what it has settled, e.g. ` ▸ Act 2/3 · 3/5 `.
  const chipLabel = useMemo(() => {
    if (!acts.acts.length) return '';
    const last = events.length - 1, k = actIndexAt(acts, last), progress = actProgress(acts, acts.acts[k]!, last);
    // The chip and the header agree: the act of the newest post, or the last act at rest.
    return ` ▸ Act ${k + 1}/${acts.acts.length} · ${progress.done}/${progress.total} `;
  }, [acts, events]);
  const chip = chipLabel && !panelVisible ? {label: chipLabel, width: stringWidth(chipLabel)} : undefined;
  return {docked, overlay, wide, focused: docked && focus === 'plan', keyboardOwner, panelVisible, timelineWidth, dockX, overlayX, overlayWidth, dockWidth,
    chip, chipHover, setChipHover, shortcut, request, show, hide, openOverlay, handleKey, handleMouse, render};
}
export type TeamSidebar = ReturnType<typeof useTeamSidebar>;
const noSubscription = () => () => {};
