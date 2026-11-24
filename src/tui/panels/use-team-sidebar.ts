/**
 * The sidebar's host: a small window host with a header bar of tabs (`sidebar-tabs.ts`: Team, Changes, Usage; `+` opens another, `×` closes one, the toggle icon at the
 * right closes the sidebar) over the page of the active tab. Team is the team stage (`team-sidebar.ts`); Changes and Usage are the list pages of `sidebar-pages.ts`.
 * The open tabs and the active one are remembered in `ui-preferences.json`. The same toggle icon is mirrored at the right end of the footer's status row
 * (`status/footer-bar.tsx`, always visible), so a closed sidebar opens by mouse. The Team page shows one act at a time of the session's task graph (`src/runtime/task-graph.ts`: the plan with the work nobody
 * linked to it added, or the work alone when there is no plan; `src/runtime/team-acts.ts` maps the team events to its acts). It decides whether the sidebar is docked
 * beside the timeline (terminals of at least `DOCK_MIN_COLUMNS` columns) or open as an overlay (narrower ones), keeps its view state (replay point, playback,
 * filter, hover, pulse), the toggle gutter and the keyboard and mouse entry points. `App` calls it once; everything it draws goes through `paintTeam()` and reaches
 * the screen as the terminal plane's side column (docked) or `PlanOverlay` (overlay).
 *
 * The graph is rebuilt from `PlanBoard.peek()` and the delegation record on every store change and kept as the same object while nothing the sidebar shows has
 * changed, so the acts and the layout are built once per change of events, graph, width or filter, never per frame. Visibility rules: a plan that becomes active
 * shows the sidebar (docked terminals only, unless the person hid it), a plan that is done or abandoned hides it with a notice, and the person's last explicit
 * choice is remembered for the session. A session without a plan never opens it by itself: `/team`, `/sidebar`, Ctrl+B, the toggle icon or a click on the footer chip show it.
 */
import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {subscribeTerminalFocus, terminalFocus} from '../terminal/focus.js';
import type {Key} from 'ink';
import type {Delegation} from '../../runtime/delegations.js';
import {AUTOMA_OWNER, type DerivedPlan} from '../../runtime/plan.js';
import {taskGraph, type TaskGraph} from '../../runtime/task-graph.js';
import type {PlanBoard} from '../../store/plans.js';
import {actModel} from '../../runtime/team-acts.js';
import {teamMembers, type TeamEvent} from '../../runtime/team-events.js';
import type {CommandSurfaces, SidebarMode} from '../../commands/surfaces.js';
import {basename} from 'node:path';
import {ownerColor, type ActorStyles} from '../appearance/actor-style.js';
import {palette} from '../appearance/theme.js';
import type {SgrMouseEvent} from '../terminal/mouse.js';
import type {PlaneSide, SideSegment} from '../terminal/terminal-plane.js';
import {CONTENT_X, DOCK_MIN_COLUMNS, DOUBLE_CLICK_MS, SIDEBAR_MAX, SIDEBAR_MIN, dragWidth, sideLine, sidebarWidth} from './sidebar-frame.js';
import {HEADER_ROWS, TOGGLE_GUTTER, TOGGLE_ICON, parseTabId, targetKey, closeTab, cycleTab, headerTargetAt, nextClosedTab, normalizeTabs, openTab, activateTab, sameTabs, sameTarget, tabHeader, tabTitle, type HeaderTarget, type SidebarTabId,
  type SidebarTabsState} from './sidebar-tabs.js';
import {FADE_TICK_MS, FadeSet, lerpColor} from './hover-fade.js';
import {changeDetail, type FileChange} from './changes-model.js';
import {changesModel, clampView, emptyListView, paintList, stepListKey, stepListMouse, usageModel, type ListModel, type ListStep, type ListView, type UsageEntry} from './sidebar-pages.js';
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
  /** The files this session's edits changed (`fileChanges()` of the store snapshot, memoised by the caller); read only while the Changes tab is shown. */
  changes: () => readonly FileChange[];
  /** Tokens and cost per actor; read only while the Usage tab is shown. */
  usage: () => readonly UsageEntry[];
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
  /** Motion is on (`/settings`): hover fades ease, else they jump. */
  motion?: boolean;
  /** The welcome splash owns the timeline rectangle: nothing docks beside it. */
  welcome: boolean;
  focus: 'input' | 'question' | 'stop' | 'plan';
  setFocus(next: 'input' | 'plan'): void;
  flash(text: string, duration?: number, tone?: 'info' | 'success' | 'warning' | 'error'): void;
}

export const CHIP_HINT = 'Team stage · click or Ctrl+B shows it';
const shallow = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);
/** Everything the sidebar shows of a graph: equal signatures keep the same graph object. */
const signature = (graph: TaskGraph) => JSON.stringify([graph.planned, graph.plan.id, graph.plan.title, graph.plan.status, graph.plan.nodes, [...graph.delegationOf], [...graph.synthetic]]);

export function useTeamSidebar(input: TeamSidebarInput) {
  const {motion = true, board, surfaces, revision, sessionId, delegations, team, columns, width, roles, themeVersion, welcome, focus, setFocus, flash} = input;
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
  const [teamView, setTeamView] = useState<TeamView>(emptyTeamView);
  const teamViewRef = useRef(teamView); teamViewRef.current = teamView;
  useEffect(() => {setTeamView(emptyTeamView); teamViewRef.current = emptyTeamView;}, [sessionId]);

  const choice = useRef<'shown' | 'hidden' | undefined>(undefined);
  const autoFor = useRef<string | undefined>(undefined);
  const [shown, setShown] = useState(() => {
    const initial = board?.peek();
    if (initial?.status === 'active' && wide) {autoFor.current = initial.id; return true;}
    return false;
  });
  const [overlay, setOverlay] = useState(false);
  const rolesRef = useRef(roles); rolesRef.current = roles;

  const docked = shown && wide && !welcome && !overlay;
  const panelVisible = docked || overlay;
  // The tabs: which are open and which is shown, remembered in the preferences; the pages of Changes and Usage keep their own scroll and selection.
  const [tabs, setTabsState] = useState<SidebarTabsState>(() => {const saved = surfaces?.sidebarTabsStore?.get(); return normalizeTabs(saved?.open, saved?.active);});
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const setTabs = (next: SidebarTabsState) => {
    if (sameTabs(next, tabsRef.current)) return;
    tabsRef.current = next; setTabsState(next);
    surfaces?.sidebarTabsStore?.set({open: next.open, active: next.active});
  };
  const [headerHover, setHeaderHover] = useState<HeaderTarget | undefined>(undefined);
  const [edgeHover, setEdgeHover] = useState(false);
  // The pointer is over the toggle icon in the top-right gutter (sidebar closed).
  const [toggleHover, setToggleHover] = useState(false);
  const [views, setViews] = useState<Readonly<Record<'changes' | 'usage', ListView>>>({changes: emptyListView, usage: emptyListView});
  const viewsRef = useRef(views); viewsRef.current = views;
  const activeTab = tabs.active;
  // The width the person dragged the border to (undefined: the default). It is kept as chosen and re-clamped into the current range, so a narrow terminal never loses it.
  const [preferred, setPreferred] = useState<number | undefined>(() => surfaces?.sidebarWidthStore?.get());
  const preferredRef = useRef(preferred); preferredRef.current = preferred;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);
  const dockWidth = sidebarWidth(width, preferred);
  const overlayWidth = Math.max(Math.min(columns, SIDEBAR_MIN), Math.min(width, SIDEBAR_MAX));
  const panelWidth = overlay ? overlayWidth : dockWidth;
  const dockX = width - dockWidth, overlayX = Math.max(0, width - overlayWidth);
  // Without a docked sidebar the timeline leaves a gutter of `TOGGLE_GUTTER` columns at the right, where the toggle icon sits on row 0 in its own cells (also under an overlay or
  // the welcome splash, so the width never jumps); docked, the sidebar's own header bar carries the icon.
  const timelineWidth = docked ? dockX - 1 : width - TOGGLE_GUTTER;

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
    if (!playing || !panelVisible || tabs.active !== 'team') return;
    const timer = setTimeout(() => {
      const layout = teamLayoutFor();
      if (!layout) return;
      applyTeam({view: stepPlay(layout, teamViewRef.current, teamGeometryFor(layout, heightRef.current), Date.now()), effects: [], consumed: true});
    }, PLAY_STEP_MS / speed);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [playing, speed, teamView.selected, teamView.live, panelVisible, tabs.active]);
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
  // Hover fades of the header controls and the stage cards (150 ms eased; instant without motion); only the sidebar re-renders while one runs.
  const fades = useRef(new FadeSet()).current;
  // The sidebar's focus chrome (header rule and border) is the focused region's: it eases up while the sidebar has the keyboard and the terminal window is focused.
  const windowFocused = useSyncExternalStore(subscribeTerminalFocus, () => terminalFocus() !== false);
  const regionFocused = (overlay || focus === 'plan') && windowFocused;
  const fadeBusy = fades.step([...regionFocused ? ['focus'] : [], ...headerHover ? [targetKey(headerHover)] : [], ...toggleHover && !panelVisible ? ['toggle'] : [], ...teamView.hoveredStage ? [teamView.hoveredStage] : []], Date.now(), motion);
  const [, setFadeTick] = useState(0);
  useEffect(() => {
    if (!fadeBusy) return;
    const timer = setTimeout(() => setFadeTick(count => count + 1), FADE_TICK_MS);
    return () => clearTimeout(timer);
  });
  const teamActive = tabs.active === 'team';
  /** The shortcut: shown or hidden, with the keyboard in it when it opens (once: show and focus, Esc: back to the composer, again: hide). */
  const shortcut = () => {
    if (!wide) {if (overlay) closeOverlay(); else openOverlay(); return;}
    if (!docked) {show(); setFocus('plan'); return;}
    if (focus === 'plan') hide(); else setFocus('plan');
  };
  /** The icon in the header bar: the sidebar goes away, or an overlay closes. */
  const toggleOff = () => {if (overlay) closeOverlay(); else hide();};
  /**
   * `/team` (Team tab), `/sidebar [tab]` and the toggle icon: visibility and the tab, the keyboard stays where it is. With a tab, toggling an open sidebar that already shows
   * that tab hides it; any other toggle shows the sidebar with that tab open and active. Without a tab only the visibility changes.
   */
  const request = (mode: SidebarMode, tab?: SidebarTabId) => {
    const onTab = tab === undefined || tabsRef.current.active === tab;
    const want = mode === 'toggle' ? !(panelVisible && onTab) : mode === 'show';
    if (want && tab !== undefined) setTabs(openTab(tabsRef.current, tab));
    if (!wide) {if (want) openOverlay(); else closeOverlay(); return;}
    if (want) show(); else hide();
  };
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => surfaces?.subscribeSidebar((mode, tab) => requestRef.current(mode, tab === undefined ? undefined : parseTabId(tab))), [surfaces]);

  // The list page of the active tab (Changes or Usage): rebuilt when its data, the width or the actors change (items lose two cells to the selection marker).
  const content = panelWidth - CONTENT_X;
  const nameOf = (id: string) => rolesRef.current[id]?.name ?? id;
  const changesData = useMemo(() => panelVisible && tabs.active === 'changes' ? input.changes() : [], [panelVisible, tabs.active, revision, sessionId]);
  const usageData = useMemo(() => panelVisible && tabs.active === 'usage' ? input.usage() : [], [panelVisible, tabs.active, revision, sessionId, roles]);
  const page = useMemo((): ListModel | undefined => {
    if (!panelVisible) return undefined;
    if (tabs.active === 'changes') return changesModel(changesData, content - 2, {name: nameOf});
    if (tabs.active === 'usage') return usageModel(usageData, content - 2);
    return undefined;
  }, [panelVisible, tabs.active, changesData, usageData, content, roles]);
  const pageRef = useRef(page); pageRef.current = page;
  const fullHeightRef = useRef(0);
  const bodyHeight = () => Math.max(0, fullHeightRef.current - HEADER_ROWS);
  const pageView = (): ListView => tabsRef.current.active === 'team' ? emptyListView : viewsRef.current[tabsRef.current.active];
  const setPageView = (view: ListView) => {
    const id = tabsRef.current.active;
    if (id === 'team' || viewsRef.current[id] === view) return;
    const next = {...viewsRef.current, [id]: view}; viewsRef.current = next; setViews(next);
  };
  /** What activating a list item does: a file opens its diff as a page, an actor opens its window. */
  const openItem = (id: string) => {
    if (overlay) setOverlay(false);
    if (tabsRef.current.active === 'changes') {
      const change = changesData.find(item => item.path === id);
      if (!change) return;
      try {surfaces?.openResult(basename(change.path) || change.path, changeDetail(change, nameOf), undefined, undefined, true);}
      catch {flash('Close the open page first', 2000, 'info');}
    } else surfaces?.requestWindow(id);
  };
  const applyList = (step: ListStep) => {
    if (step.view !== pageView()) setPageView(step.view);
    for (const effect of step.effects) {
      if (effect.kind === 'focus') {if (!overlay) setFocus('plan');}
      else if (effect.kind === 'blur') {if (overlay) closeOverlay(); else setFocus('input');}
      else openItem(effect.id);
    }
  };

  const keyboardOwner = overlay || docked && focus === 'plan';
  const handleKey = (typed: string, key: Key): boolean => {
    if (!panelVisible) return false;
    if (key.tab) return false;
    if (key.ctrl || key.meta) return overlay;
    // Digits pick the Nth open tab, `w` closes the shown one (a tab always remains).
    if (/^[1-9]$/.test(typed) && Number(typed) <= tabsRef.current.open.length && !(teamActive && teamViewRef.current.picker !== undefined)) {
      setTabs(activateTab(tabsRef.current, tabsRef.current.open[Number(typed) - 1]!)); return true;
    }
    if (typed === 'w' && tabsRef.current.open.length > 1) {setTabs(closeTab(tabsRef.current, tabsRef.current.active)); return true;}
    if (!teamActive) {
      const model = pageRef.current;
      if (model) {
        const step = stepListKey(model, clampView(model, pageView(), bodyHeight()), bodyHeight(), {up: key.upArrow, down: key.downArrow, enter: key.return, escape: key.escape,
          pageUp: key.pageUp, pageDown: key.pageDown, home: key.home, end: key.end});
        if (step.consumed) {applyList(step); return true;}
      }
      if (overlay) return true;
      if (typed) setFocus('input');
      return false;
    }
    const layout = teamLayoutFor();
    if (!layout) return false;
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
  const lastEdgeClick = useRef(0);
  const clearTeamHover = () => {
    const now = teamViewRef.current;
    if (now.hovered !== undefined || now.hoveredName !== undefined || now.hoveredControl !== undefined || now.hoveredStage !== undefined)
      applyTeam({view: {...now, hovered: undefined, hoveredName: undefined, hoveredControl: undefined, hoveredStage: undefined}, effects: [], consumed: false});
  };
  const clearPageHover = () => {
    const id = tabsRef.current.active;
    if (id !== 'team' && viewsRef.current[id].hovered !== undefined) setPageView({...viewsRef.current[id], hovered: undefined});
  };
  const clearHovers = () => {if (headerHover) setHeaderHover(undefined); if (edgeHover) setEdgeHover(false); clearTeamHover(); clearPageHover();};
  /** Routes one mouse event; true when the sidebar took it. `busy` is a timeline or composer gesture in progress. */
  const handleMouse = (event: SgrMouseEvent, busy: boolean): boolean => {
    if (!panelVisible) {
      const over = !welcome && event.y === 0 && event.x >= width - TOGGLE_GUTTER && event.x < width;
      if (event.action === 'move' && over !== toggleHover) setToggleHover(over);
      if (over && event.action === 'press' && event.button === 0 && !busy) {setToggleHover(false); request('show'); return true;}
      return over && event.action !== 'wheel_up' && event.action !== 'wheel_down';
    }
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
    const layout = teamActive ? teamLayoutFor() : undefined;
    if (layout && teamViewRef.current.scrubbing && (event.action === 'drag' || event.action === 'release')) {
      applyTeam(stepTeamMouse(layout, teamViewRef.current, teamGeometryFor(layout, heightRef.current), {x: event.x - x0, y: event.y - HEADER_ROWS, action: event.action}, Date.now(), panelWidth, label));
      return true;
    }
    const inside = event.x >= x0 && event.x < x0 + panelWidth && event.y < fullHeightRef.current;
    if (!inside) {
      if (overlay) {if (event.action === 'press' && event.button === 0) closeOverlay(); return true;}
      if (event.action === 'move') clearHovers();
      return false;
    }
    if (busy && !overlay && (event.action === 'drag' || event.action === 'release')) return false;
    if (event.action === 'drag' || event.action === 'release') return true;
    if (event.action === 'press' && event.button !== 0) return true;
    const lx = event.x - x0, ly = event.y, now = Date.now();
    // Column 0 is the border: the resize handle (the overlay has none).
    if (lx === 0 && !overlay) {
      if (event.action === 'move') {if (!edgeHover) {setEdgeHover(true); setHeaderHover(undefined); clearTeamHover(); clearPageHover();} return true;}
      if (event.action === 'press') {
        setFocus('plan');
        const double = now - lastEdgeClick.current <= DOUBLE_CLICK_MS;
        lastEdgeClick.current = double ? 0 : now;
        runTeam({kind: double ? 'reset-width' : 'drag'});
      }
      return true;
    }
    if (edgeHover) setEdgeHover(false);
    // The header bar: tabs, close marks, `+` and the toggle; the wheel cycles the tabs.
    if (ly < HEADER_ROWS) {
      const target = headerTargetAt(tabHeader(tabsRef.current, content, undefined), lx - CONTENT_X);
      if (event.action === 'move') {
        clearTeamHover(); clearPageHover();
        if (!sameTarget(target, headerHover)) setHeaderHover(target);
        return true;
      }
      if (event.action === 'wheel_up' || event.action === 'wheel_down') {setTabs(cycleTab(tabsRef.current, event.action === 'wheel_down' ? 1 : -1)); return true;}
      if (!overlay) setFocus('plan');
      if (!target) return true;
      if (target.kind === 'toggle') toggleOff();
      else if (target.kind === 'tab') setTabs(activateTab(tabsRef.current, target.id));
      else if (target.kind === 'close') setTabs(closeTab(tabsRef.current, target.id));
      else {const next = nextClosedTab(tabsRef.current); if (next) setTabs(openTab(tabsRef.current, next));}
      return true;
    }
    if (headerHover) setHeaderHover(undefined);
    const y = ly - HEADER_ROWS;
    if (!teamActive) {
      const model = pageRef.current;
      if (model) applyList(stepListMouse(model, clampView(model, pageView(), bodyHeight()), bodyHeight(), {x: lx, y, action: event.action}));
      return true;
    }
    if (!layout) return true;
    clearPageHover();
    applyTeam(stepTeamMouse(layout, teamViewRef.current, teamGeometryFor(layout, heightRef.current), {x: lx, y, action: event.action}, now, panelWidth, label));
    return true;
  };

  // ------------------------------------------------------------------------------------------------------------------------------ painting
  const paintCache = useRef<{deps: readonly unknown[]; lines: SideSegment[][]} | undefined>(undefined);
  /** The lines of the panel for `height` rows (the timeline's when docked, the screen's as an overlay): the header bar, then the page of the active tab. */
  const render = (height: number): {readonly lines: readonly (readonly SideSegment[])[]; readonly side?: PlaneSide} | undefined => {
    fullHeightRef.current = height;
    const bodyRows = Math.max(0, height - HEADER_ROWS);
    heightRef.current = bodyRows;
    if (!panelVisible) {
      // Closed: only the gutter column, blank except the toggle icon on its first row; `lines` is what an overlay would show (nothing).
      if (welcome || overlay) return undefined;
      const level = fades.level('toggle'), blank: SideSegment[] = [{text: ' '.repeat(TOGGLE_GUTTER), color: palette.fg}];
      const icon: SideSegment[] = [{text: ' ', color: palette.fg}, {text: TOGGLE_ICON, color: lerpColor(palette.muted, palette.accent, level), ...(level >= 0.5 ? {bold: true} : {})}];
      const lines = Array.from({length: height}, (_, row) => row === 0 ? icon : blank);
      return {lines, side: {x: width - TOGGLE_GUTTER, width: TOGGLE_GUTTER, lines}};
    }
    const layout = teamActive ? teamLayoutFor() : undefined;
    const focused = overlay || focus === 'plan';
    const view = page ? clampView(page, pageView(), bodyRows) : emptyListView;
    const deps = [tabs, headerHover, edgeHover, teamActive ? layout : page, teamActive ? teamView : view, panelWidth, height, focused, themeVersion, dragging, fades.signature()];
    const paint = (pulseMs?: number): SideSegment[][] => {
      const focusLevel = fades.level('focus');
      const frame = {width: panelWidth, hoveredEdge: edgeHover ? 'handle' as const : undefined, accent: dragging, level: focusLevel};
      const header = tabHeader(tabs, content, headerHover, focused, fades.level, focusLevel);
      const head = [sideLine(frame, header.strip), sideLine(frame, header.rule)];
      if (height <= HEADER_ROWS) return head.slice(0, height);
      if (teamActive) {
        if (!layout) return head;
        return [...head, ...paintTeam({layout, view: teamView, width: panelWidth, height: bodyRows, focused, dragging, hoveredEdge: edgeHover, focusLevel, label, stage: true, fade: fades.level,
          ownerColor: id => id === AUTOMA_OWNER ? palette.automa : ownerColor(id, rolesRef.current), ...(pulseMs !== undefined ? {pulseMs} : {})})];
      }
      return [...head, ...(page ? paintList(page, view, content, bodyRows, focused) : []).map(line => sideLine(frame, line))];
    };
    if (!paintCache.current || !shallow(paintCache.current.deps, deps)) paintCache.current = {deps, lines: paint()};
    const lines = paintCache.current.lines;
    if (!docked) return {lines};
    // The pulse of a post that just began: the terminal plane asks for the lines again every animation frame until it has travelled (docked only; the overlay shows the stage at rest).
    const pulse = teamActive && layout ? teamView.pulse : undefined;
    const animate = pulse && layout && Date.now() - pulse.at < PULSE_MS && selectedId(layout, teamView) === pulse.id
      ? (now: number, motion: boolean) => {const ms = now - pulse.at; return motion && ms >= 0 && ms < PULSE_MS ? {lines: paint(ms), busy: true} : {lines: paintCache.current?.lines ?? lines, busy: false};}
      : undefined;
    return {lines, side: {x: dockX, width: dockWidth, lines, ...(animate ? {animate} : {})}};
  };


  return {docked, overlay, wide, focused: docked && focus === 'plan', keyboardOwner, panelVisible, timelineWidth, dockX, overlayX, overlayWidth, dockWidth,
    shortcut, request, show, hide, openOverlay, handleKey, handleMouse, render, tabs, toggleHover, setToggleHover, motion};
}
export type TeamSidebar = ReturnType<typeof useTeamSidebar>;
const noSubscription = () => () => {};
