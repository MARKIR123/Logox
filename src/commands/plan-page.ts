/**
 * The plan pages behind the flowchart sidebar (`/tasks` shows it; there is no `/plan` command): a node's detail (acceptance, evidence, prerequisites and
 * links; a link opens the `/tasks` detail of that work) and the plan switcher (`/tasks plans`, the sidebar header's click and `p`) with one row per plan of
 * the project, a row for the session's work graph, and a re-activate row for a plan of an earlier session (`PlanBoard.adopt()`). Choosing a row tells the
 * sidebar what to draw (`CommandSurfaces.requestSidebarSource()`). Pages are a stack of the existing surfaces like `/tasks`, so keyboard, click, hover and
 * wheel behave as on every list. Nothing here owns state: rows come from the board (`src/store/plans.ts`) each time a level opens. The flowchart sidebar
 * (`src/tui/panels/plan-sidebar.ts`) opens a node's detail through `CommandSurfaces.openPlanNode()`.
 */
import type {PickerItem, TabAction, TabRow} from '../runtime/command-surface.js';
import {formatDuration} from './tasks-page.js';
import type {TasksCommand} from './tasks-page.js';
import type {DerivedNode, DerivedPlan, NodeStatus} from '../runtime/plan.js';
import type {PlanBoard} from '../store/plans.js';
import {row, tabContent} from './tab-rows.js';
import type {CommandSurfaces, PageActions} from './surfaces.js';

export const PLAN_EMPTY_TEXT = 'There is no plan yet. The Director creates one with Plan when a request has more than one piece of work.';
export const PLAN_GLYPHS: Readonly<Record<NodeStatus, string>> = {pending: '○', ready: '◌', running: '●', waiting: '◐', done: '◉', accepted: '✓', failed: '✗', interrupted: '⊘', abandoned: '–'};
const AUTO = '@auto', WORK = '@work', ADOPT = '@adopt:';

export interface PlanPageDeps {
  surfaces: CommandSurfaces;
  board: Pick<PlanBoard, 'peek' | 'view' | 'projectPlans' | 'adopt' | 'active'>;
  tasks: Pick<TasksCommand, 'openDelegation'>;
  actors: {find(id: string): {name: string} | undefined};
  /** The title of linked work (`/tasks` row id), when the session knows it. */
  workTitle(id: string): string | undefined;
  /** Whether the session has delegated work to draw as the work graph. */
  hasWork(): boolean;
}

export function createPlanPages(deps: PlanPageDeps) {
  const {surfaces, board, tasks, workTitle} = deps;
  const name = (ownerId: string) => deps.actors.find(ownerId)?.name ?? ownerId;
  const open = async (...args: Parameters<CommandSurfaces['openPicker']>) => {
    if (surfaces.getSnapshot()) surfaces.close();
    await surfaces.openPicker(...args);
  };

  const openDetail = async (plan: DerivedPlan, node: DerivedNode, backTo: () => Promise<void>) => {
    const known = node.links.map(link => link.activityId ?? link.automaJob!).map(id => ({id, title: workTitle(id)}));
    const actions: TabAction[] = known.flatMap((link, index) => link.title !== undefined && index < 9 ? [{id: 'link:' + link.id, label: 'Open ' + link.title, key: String(index + 1)}] : []);
    const path = (id: string): string => {const target = plan.nodes.find(item => item.id === id); return target ? id + ' ' + target.title : id;};
    const body: TabRow[] = [
      row.heading('Node'),
      row.field('Id', node.id), row.field('Title', node.title), row.field('Owner', name(node.owner) + (node.forked ? ' ⑂' : '')),
      row.field('Status', PLAN_GLYPHS[node.status] + ' ' + node.status),
      ...(node.leaves ? [row.field('Progress', `${node.leaves.done} of ${node.leaves.total} tasks complete` + (node.leaves.failed ? `, ${node.leaves.failed} failed` : '') + (node.leaves.interrupted ? `, ${node.leaves.interrupted} interrupted` : ''))] : []),
      ...(node.parent ? [row.field('Parent', path(node.parent))] : []),
      ...(node.after.length ? [row.field('After', node.after.map(path).join('; '))] : []),
      ...(node.blockedBy.length ? [row.field('Waiting for', node.blockedBy.join(', '))] : []),
      row.blank(), row.heading('Acceptance'),
      ...(node.acceptance.length ? node.acceptance.map(item => row.bullet(item)) : [row.muted('No acceptance checks written.')]),
      row.blank(), row.heading('Evidence'),
      ...(node.accepted ? [row.field('Accepted by', name(node.accepted.by) + ' · ' + new Date(node.accepted.at).toLocaleString()),
        ...(node.accepted.evidence.length ? node.accepted.evidence.map(item => row.bullet(item)) : [row.muted('No evidence recorded.')])] : [row.muted('Not accepted yet.')]),
      ...(node.note ? [row.blank(), row.heading('Note'), ...node.note.split('\n').map(line => row.text(line))] : []),
      row.blank(), row.heading('Linked work'),
      ...(known.length ? known.map((link, index) => row.text((index < 9 && link.title !== undefined ? `${index + 1}  ` : '•  ') + (link.title ?? link.id) +
        (node.work.find(item => item.id === link.id) ? ' · ' + node.work.find(item => item.id === link.id)!.phase : ''))) : [row.muted('Nothing is linked yet: work started with node ' + node.id + ' appears here.')]),
    ];
    const pageActions: PageActions = {
      onSaveToggles: () => ({}),
      onBack: backTo,
      onTabAction: async (_tab, action) => {
        if (!action.startsWith('link:')) return {};
        const id = action.slice(5);
        // The work's own detail comes back here on Esc.
        await tasks.openDelegation(id, async () => {await openDetail(plan, node, backTo);});
        return {};
      },
    };
    if (surfaces.getSnapshot()) surfaces.close();
    surfaces.openPage('Plan node · ' + node.title, [{id: 'detail', title: node.id + ' · ' + name(node.owner), ...tabContent(body), ...(actions.length ? {actions} : {})}], 'detail', pageActions);
  };

  /** The detail page of one node of the session's plan (the sidebar's double-click and Enter), or of the earlier session's plan named by `planId` (read-only); Esc closes it. */
  const openNode = async (id: string, planId?: string): Promise<void> => {
    const plan = planId === undefined ? board.peek() : await board.view(planId);
    const node = plan?.nodes.find(item => item.id === id);
    if (!plan || !node) throw new Error('That node no longer exists.');
    await openDetail(plan, node, async () => {});
  };
  surfaces.planNodeOpener = openNode;

  /** What the sidebar draws, chosen from a list of the project's plans (and the session's work). */
  const openSwitcher = async (): Promise<void> => {
    const headers = await board.projectPlans();
    const items: PickerItem[] = [{id: AUTO, label: 'Follow the session', description: 'The plan, else the work done so far, else the latest earlier plan'}];
    if (deps.hasWork()) items.push({id: WORK, label: 'Work so far', description: 'The delegated work of this session as a graph (no plan)'});
    for (const header of headers) {
      items.push({id: header.id, label: header.id + ' · ' + header.title,
        description: [header.status, header.nodes + ' nodes', header.current ? 'this session' : 'earlier session, read-only', formatAge(header.updatedAt)].join(' · ')});
      if (!header.current && header.status !== 'abandoned') items.push({id: ADOPT + header.id, label: '  Re-activate ' + header.id + ' in this session',
        description: board.active() ? 'Another plan is active: abandon it first' : 'Work then links to it again'});
    }
    await open({title: 'Plans', description: 'Enter shows it in the sidebar · Esc closes', current: '', items, emptyText: PLAN_EMPTY_TEXT},
      async () => ({items}), async id => {
        if (id === AUTO) {surfaces.requestSidebarSource({kind: 'auto'}); surfaces.requestPlanSidebar('show'); return {};}
        if (id === WORK) {surfaces.requestSidebarSource({kind: 'work'}); surfaces.requestPlanSidebar('show'); return {};}
        if (id.startsWith(ADOPT)) {
          const adopted = await board.adopt(id.slice(ADOPT.length));
          if (!adopted.ok) return {message: adopted.error, kind: 'command_error' as const};
          surfaces.requestSidebarSource({kind: 'plan', id: id.slice(ADOPT.length)}); surfaces.requestPlanSidebar('show');
          return {message: 'Plan ' + id.slice(ADOPT.length) + ' is active in this session again.', presentation: 'status' as const};
        }
        surfaces.requestSidebarSource({kind: 'plan', id}); surfaces.requestPlanSidebar('show');
        return {};
      });
  };
  surfaces.plansOpener = openSwitcher;

  return {openNode, openSwitcher};
}
export type PlanPages = ReturnType<typeof createPlanPages>;

function formatAge(time: number): string {
  const ago = Date.now() - time;
  return ago < 60_000 ? 'just now' : formatDuration(ago) + ' ago';
}
