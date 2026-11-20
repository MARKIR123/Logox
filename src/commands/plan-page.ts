/**
 * `/plan`: the plan of the current request as an indented tree, one row per node (status glyph, id, title, owner, progress of a parent), a node's detail
 * on Enter (acceptance, evidence, prerequisites and links; a link opens the `/tasks` detail of that work), and a switcher row when the project holds
 * more than one plan. A stack of the existing surfaces like `/tasks`, so keyboard, click, hover and wheel behave as on every list. Nothing here owns
 * state: rows come from the board (`src/store/plans.ts`) each time a level opens. This list is the stopgap until the flowchart sidebar.
 */
import type {PickerItem, TabAction, TabRow} from '../runtime/command-surface.js';
import {formatDuration} from './tasks-page.js';
import type {TasksCommand} from './tasks-page.js';
import type {DerivedNode, DerivedPlan, NodeStatus} from '../runtime/plan.js';
import type {PlanBoard} from '../store/plans.js';
import {row, tabContent} from './tab-rows.js';
import type {CommandSurfaces, PageActions} from './surfaces.js';

export const PLAN_EMPTY_TEXT = 'There is no plan yet. The Director creates one with Plan when a request has more than one piece of work.';
export const PLAN_USAGE = 'Usage: /plan';
export const PLAN_GLYPHS: Readonly<Record<NodeStatus, string>> = {pending: '○', ready: '◌', running: '●', waiting: '◐', done: '◉', accepted: '✓', failed: '✗', abandoned: '–'};
const SWITCH = '@plans', ADOPT = '@adopt';

export interface PlanPageDeps {
  surfaces: CommandSurfaces;
  board: Pick<PlanBoard, 'plans' | 'view' | 'projectPlans' | 'adopt' | 'active'>;
  tasks: Pick<TasksCommand, 'openDelegation'>;
  actors: {find(id: string): {name: string} | undefined};
  /** The title of linked work (`/tasks` row id), when the session knows it. */
  workTitle(id: string): string | undefined;
}

/** `○ 1.2 Contrast algorithm`, indented by depth. */
export function nodeLabel(node: DerivedNode): string {
  return '  '.repeat(node.depth - 1) + PLAN_GLYPHS[node.status] + ' ' + node.id + ' ' + node.title;
}
/** `aletheia · 1/3 · ready`: owner, progress of a parent (accepted of live children), status, and what a pending node waits for. */
export function nodeDescription(node: DerivedNode): string {
  return [node.owner, node.progress ? `${node.progress.accepted}/${node.progress.total}` : undefined, node.status, node.blockedBy.length ? 'after ' + node.blockedBy.join(', ') : undefined].filter(Boolean).join(' · ');
}

export function createPlanCommand(deps: PlanPageDeps) {
  const {surfaces, board, tasks, workTitle} = deps;
  const name = (ownerId: string) => deps.actors.find(ownerId)?.name ?? ownerId;
  const open = async (...args: Parameters<CommandSurfaces['openPicker']>) => {
    if (surfaces.getSnapshot()) surfaces.close();
    await surfaces.openPicker(...args);
  };
  /** The plan being looked at: a plan id chosen in the switcher, else the active plan, else the latest of the session. */
  let viewing: string | undefined;
  const current = async (): Promise<{plan: DerivedPlan | undefined; mine: boolean}> => {
    const mine = board.plans();
    const chosen = viewing ? mine.find(plan => plan.id === viewing) : undefined;
    if (chosen) return {plan: chosen, mine: true};
    if (viewing) {const other = await board.view(viewing); if (other) return {plan: other, mine: false};}
    return {plan: mine.findLast(plan => plan.status === 'active') ?? mine.at(-1), mine: true};
  };

  const openDetail = async (plan: DerivedPlan, node: DerivedNode, backTo: () => Promise<void>) => {
    const known = node.links.map(link => link.activityId ?? link.automaJob!).map(id => ({id, title: workTitle(id)}));
    const actions: TabAction[] = known.flatMap((link, index) => link.title !== undefined && index < 9 ? [{id: 'link:' + link.id, label: 'Open ' + link.title, key: String(index + 1)}] : []);
    const path = (id: string): string => {const target = plan.nodes.find(item => item.id === id); return target ? id + ' ' + target.title : id;};
    const body: TabRow[] = [
      row.heading('Node'),
      row.field('Id', node.id), row.field('Title', node.title), row.field('Owner', name(node.owner)),
      row.field('Status', PLAN_GLYPHS[node.status] + ' ' + node.status),
      ...(node.progress ? [row.field('Progress', `${node.progress.accepted} of ${node.progress.total} sub-nodes accepted`)] : []),
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

  const openSwitcher = async (): Promise<void> => {
    const headers = await board.projectPlans();
    const items: PickerItem[] = headers.map(header => ({id: header.id, label: header.id + ' · ' + header.title,
      description: [header.status, header.nodes + ' nodes', header.current ? 'this session' : 'earlier session', formatAge(header.updatedAt)].join(' · ')}));
    await open({title: 'Plans', description: 'Enter shows a plan · Esc goes back', current: viewing ?? '', items, emptyText: PLAN_EMPTY_TEXT},
      async () => ({items}), async id => {viewing = id; await openList(); return {};}, undefined, async () => {await openList();});
  };

  const openList = async (focus?: string): Promise<void> => {
    const {plan, mine} = await current();
    const several = (await board.projectPlans()).length > 1;
    const items: PickerItem[] = [];
    if (plan && several) items.push({id: SWITCH, label: 'Plans · ' + plan.id + ' ' + plan.title, description: 'Enter switches plan'});
    if (plan && !mine) items.push({id: ADOPT, label: 'Re-activate this plan in this session', description: board.active() ? 'Another plan is active: abandon it first' : 'Work then links to it again'});
    if (plan) for (const node of plan.nodes) items.push({id: node.id, label: nodeLabel(node), description: nodeDescription(node)});
    const description = plan ? `${plan.id} · ${plan.status} · ${plan.progress.accepted}/${plan.progress.total} accepted` + (mine ? '' : ' · earlier session, read-only') + ' · Enter opens a node · Esc closes' : '';
    await open({title: plan ? 'Plan · ' + plan.title : 'Plan', description, current: '', ...(focus ? {focus} : {}), items, emptyText: PLAN_EMPTY_TEXT},
      async () => ({items}), async id => {
        if (id === SWITCH) {await openSwitcher(); return {};}
        if (id === ADOPT) {
          const adopted = await board.adopt(plan!.id);
          if (!adopted.ok) return {message: adopted.error, kind: 'command_error' as const};
          viewing = plan!.id;
          await openList();
          return {};
        }
        const node = plan?.nodes.find(item => item.id === id);
        if (!plan || !node) throw new Error('That node no longer exists.');
        await openDetail(plan, node, async () => {await openList(id);});
        return {};
      });
  };

  return {
    /** `/plan` opens the page; arguments are not accepted. */
    async command(argument: string): Promise<void> {
      if (argument.trim()) throw new Error(PLAN_USAGE);
      viewing = undefined;
      await openList();
    },
    openList,
  };
}
export type PlanCommand = ReturnType<typeof createPlanCommand>;

function formatAge(time: number): string {
  const ago = Date.now() - time;
  return ago < 60_000 ? 'just now' : formatDuration(ago) + ' ago';
}
