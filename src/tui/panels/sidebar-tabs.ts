/**
 * The sidebar's tab registry and its header bar, as pure functions. The sidebar is a small window host: a header bar (a tab strip with an underline rule, `+` to open
 * another tab and the toggle icon at its right end) over the page of the active tab. The pages themselves are `team-sidebar.ts` (Team) and `sidebar-pages.ts`
 * (Changes, Usage); `use-team-sidebar.ts` hosts them. Nothing here reads a clock, a store or the terminal.
 *
 * Adding a tab: add its id to `SidebarTabId` and an entry to `SIDEBAR_TABS` (title, one-line summary), then give the host a page for it.
 */
import stringWidth from 'string-width';
import {faintColor} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import type {SideSegment} from '../terminal/terminal-plane.js';
import {SIDEBAR_TAB_IDS, type SidebarTabId} from '../../commands/surfaces.js';
import {fit} from './panel-text.js';
import {dimmed, lerpColor} from './hover-fade.js';

export type {SidebarTabId};
export interface SidebarTabSpec {readonly id: SidebarTabId; readonly title: string; readonly summary: string}
/** Every tab the sidebar knows, in the order `+` opens them. */
export const SIDEBAR_TABS: readonly SidebarTabSpec[] = [
  {id: 'team', title: 'Team', summary: 'the team stage: acts, task graph and the posts of the team'},
  {id: 'changes', title: 'Changes', summary: 'files changed in this session with added and removed lines'},
  {id: 'usage', title: 'Usage', summary: 'tokens and cost per actor in this session'},
];
const known = new Set<string>(SIDEBAR_TAB_IDS);
export const isTabId = (value: string): value is SidebarTabId => known.has(value);
/** A tab named by a person (`Team`, `changes`), case-insensitive; undefined when unknown. */
export const parseTabId = (text: string): SidebarTabId | undefined => {const id = text.trim().toLowerCase(); return isTabId(id) ? id : undefined;};
export const tabTitle = (id: SidebarTabId): string => SIDEBAR_TABS.find(tab => tab.id === id)!.title;

/** Which tabs are open (in strip order) and which one is shown. `active` is always one of `open`, and `open` is never empty. */
export interface SidebarTabsState {readonly open: readonly SidebarTabId[]; readonly active: SidebarTabId}
export const DEFAULT_TABS: SidebarTabsState = {open: ['team'], active: 'team'};
/** A remembered state (possibly stale or hand-edited) made valid: unknown and repeated ids dropped, an empty set becomes Team, a missing active tab the first open one. */
export function normalizeTabs(open?: readonly string[], active?: string): SidebarTabsState {
  const ids = [...new Set((open ?? []).filter(isTabId))];
  if (!ids.length) return DEFAULT_TABS;
  return {open: ids, active: active !== undefined && isTabId(active) && ids.includes(active) ? active : ids[0]!};
}
export const sameTabs = (a: SidebarTabsState, b: SidebarTabsState): boolean => a.active === b.active && a.open.length === b.open.length && a.open.every((id, at) => id === b.open[at]);
/** `id` opened (appended when new) and shown. */
export const openTab = (state: SidebarTabsState, id: SidebarTabId): SidebarTabsState => state.open.includes(id) ? state.active === id ? state : {...state, active: id} : {open: [...state.open, id], active: id};
export const activateTab = (state: SidebarTabsState, id: SidebarTabId): SidebarTabsState => state.open.includes(id) && state.active !== id ? {...state, active: id} : state;
/** `id` closed; the last open tab stays, and closing the shown one shows its right neighbour (else the left one). */
export function closeTab(state: SidebarTabsState, id: SidebarTabId): SidebarTabsState {
  const at = state.open.indexOf(id);
  if (at < 0 || state.open.length < 2) return state;
  const open = state.open.filter(item => item !== id);
  return {open, active: state.active === id ? open[Math.min(at, open.length - 1)]! : state.active};
}
/** The next (`1`) or previous (`-1`) open tab, wrapping. */
export function cycleTab(state: SidebarTabsState, direction: 1 | -1): SidebarTabsState {
  const at = state.open.indexOf(state.active), next = state.open[(at + direction + state.open.length) % state.open.length]!;
  return next === state.active ? state : {...state, active: next};
}
/** The closed tab `+` opens next (registry order); undefined when everything is open. */
export const nextClosedTab = (state: SidebarTabsState): SidebarTabId | undefined => SIDEBAR_TABS.find(tab => !state.open.includes(tab.id))?.id;

// ---------------------------------------------------------------------------------------------------------------------------------- header bar
/** The header is the tab strip and the rule under it. */
export const HEADER_ROWS = 2;
/** The sidebar toggle: a square with the right panel filled, like an editor's secondary-sidebar button (one cell wide). */
export const TOGGLE_ICON = '◨';
/** Columns the timeline leaves free at the right while no sidebar is docked: row 0 holds the toggle icon there (a space and the icon). */
export const TOGGLE_GUTTER = 2;
export const CLOSE_MARK = '×', ADD_MARK = '+';
export type HeaderTarget =
  | {readonly kind: 'tab'; readonly id: SidebarTabId}
  | {readonly kind: 'close'; readonly id: SidebarTabId}
  | {readonly kind: 'add'}
  | {readonly kind: 'toggle'};
/** The key a control's hover fade is stored under (`FadeSet`). */
export const targetKey = (target: HeaderTarget): string => target.kind === 'tab' || target.kind === 'close' ? target.kind + ':' + target.id : target.kind;
export const sameTarget = (a: HeaderTarget | undefined, b: HeaderTarget | undefined): boolean => a === b || a !== undefined && b !== undefined && a.kind === b.kind && (a.kind === 'add' || a.kind === 'toggle' || a.kind === b.kind && 'id' in b && a.id === b.id);
/** A clickable span of the strip in content cells (`x0` inclusive, `x1` exclusive). */
export interface HeaderRegion {readonly x0: number; readonly x1: number; readonly target: HeaderTarget}
export interface TabHeader {
  /** The strip and the rule under it, as segments `content` cells wide (no border). */
  readonly strip: readonly SideSegment[];
  readonly rule: readonly SideSegment[];
  readonly regions: readonly HeaderRegion[];
}
const pad = (count: number): SideSegment => ({text: ' '.repeat(Math.max(0, count)), color: palette.fg});
/** The width of the toggle's click target: the icon and a cell of air on both sides. */
export const TOGGLE_SPAN = 3;

/**
 * The header in `content` cells: ` Team   Changes ×   Usage ×  +            ◨ ` over a rule whose active stretch is drawn heavy in the accent colour. The active tab is
 * bold and strong, the others muted, the pointer's target accent; a tab that does not fit loses its `×` (inactive ones first) and then its words. The toggle is
 * the last cell; `hover` is what the pointer is over, `fade` the eased hover level 0..1 of a control by `targetKey` (default: 1 under the pointer, else 0) and `focused`
 * whether the sidebar has the keyboard.
 */
export function tabHeader(state: SidebarTabsState, content: number, hover?: HeaderTarget, focused = false, fade?: (key: string) => number, focusLevel?: number): TabHeader {
  // The rule is the header's focus chrome: full accent (active tab) and line strength while the sidebar is the focused region, dimmed otherwise (`focusLevel` 0..1).
  const ruleColor = (active: boolean): string => {
    const full = active ? palette.accent : palette.line;
    return focusLevel === undefined ? full : lerpColor(dimmed(full), full, focusLevel);
  };
  const level = (target: HeaderTarget): number => fade ? fade(targetKey(target)) : sameTarget(hover, target) ? 1 : 0;
  const room = Math.max(0, content - TOGGLE_SPAN - 1);
  const closable = state.open.length > 1;
  const adding = nextClosedTab(state) !== undefined;
  const addWidth = adding ? 3 : 0;
  // Each tab is ` Title ×` (the close mark only when closable); shrink until the strip fits.
  let showClose: (id: SidebarTabId) => boolean = () => closable, limit = Infinity;
  const widths = (): number[] => state.open.map(id => 2 + Math.min(limit, stringWidth(tabTitle(id))) + (showClose(id) ? 2 : 0));
  const total = () => widths().reduce((sum, width) => sum + width, 0) + addWidth;
  if (total() > room) showClose = id => closable && (id === state.active || sameTarget(hover, {kind: 'tab', id}) || sameTarget(hover, {kind: 'close', id}));
  while (total() > room && limit > 3) limit = limit === Infinity ? Math.max(...state.open.map(id => stringWidth(tabTitle(id)))) - 1 : limit - 1;
  const strip: SideSegment[] = [], rule: SideSegment[] = [], regions: HeaderRegion[] = [];
  let x = 0;
  for (const id of state.open) {
    const active = id === state.active;
    const overTab = sameTarget(hover, {kind: 'tab', id}), overClose = sameTarget(hover, {kind: 'close', id});
    const title = fit(tabTitle(id), limit === Infinity ? 99 : limit), close = showClose(id);
    const width = 2 + stringWidth(title) + (close ? 2 : 0);
    if (x + width > room && regions.length) break;
    const tabLevel = level({kind: 'tab', id}), closeLevel = level({kind: 'close', id});
    const color = active ? palette.strong : lerpColor(palette.muted, palette.fg, tabLevel);
    strip.push({text: ' ' + title, color, ...(active ? {bold: true} : tabLevel >= 0.5 ? {underline: true} : {})});
    if (close) strip.push({text: ' ' + CLOSE_MARK, color: lerpColor(active ? palette.muted : faintColor(), palette.error, closeLevel), ...(closeLevel >= 0.5 ? {bold: true} : {})});
    strip.push({text: ' ', color: palette.fg});
    regions.push({x0: x, x1: x + width - (close ? 3 : 0), target: {kind: 'tab', id}});
    if (close) regions.push({x0: x + width - 3, x1: x + width, target: {kind: 'close', id}});
    rule.push({text: (active ? '━' : '─').repeat(width), color: ruleColor(active)});
    x += width;
  }
  if (adding && x <= room) {
    const over = level({kind: 'add'});
    strip.push({text: ' ' + ADD_MARK + ' ', color: lerpColor(faintColor(), palette.accent, over), ...(over >= 0.5 ? {bold: true} : {})});
    rule.push({text: '─'.repeat(addWidth), color: ruleColor(false)});
    regions.push({x0: x, x1: x + addWidth, target: {kind: 'add'}});
    x += addWidth;
  }
  const toggleOver = level({kind: 'toggle'});
  const gap = Math.max(0, content - TOGGLE_SPAN - x);
  strip.push(pad(gap), {text: ' ' + TOGGLE_ICON + ' ', color: lerpColor(focused ? palette.accent : palette.muted, palette.accent, toggleOver), ...(toggleOver >= 0.5 ? {bold: true} : {})});
  rule.push({text: '─'.repeat(Math.max(0, content - x)), color: ruleColor(false)});
  regions.push({x0: content - TOGGLE_SPAN, x1: content, target: {kind: 'toggle'}});
  return {strip, rule, regions};
}
/** The strip target at content column `cx`, if any. */
export const headerTargetAt = (header: TabHeader, cx: number): HeaderTarget | undefined => header.regions.find(region => cx >= region.x0 && cx < region.x1)?.target;

