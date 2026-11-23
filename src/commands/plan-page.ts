/**
 * The plan pages behind the team stage (`/team`): the Programme page and a plan node's detail. The Programme (a click on the act header, or `p`) lists the acts of
 * the session (natural rounds of work, `src/runtime/team-acts.ts`) in order, each with its tasks (the plan's nodes made inside it and the delegations) (status glyph, title, owner, how long it took or that it runs, `after <title>` prerequisites, `⑂` for a
 * fork and `◦N` for its workers), marks the act the stage shows, and ends with the plans of earlier sessions that can be re-activated (`PlanBoard.adopt()`).
 * Choosing an act heading moves the stage to that act (`CommandSurfaces.requestStageAct()`), a task opens its detail (a plan node's page with acceptance,
 * evidence, prerequisites and links, or the delegation page of work nobody named in the plan; a link opens the delegation detail, Esc comes back), an earlier plan
 * becomes this session's again. Ids are never shown. Pages are a stack of the existing surfaces, so keyboard, click, hover and wheel behave as on every list.
 * Nothing here owns state: rows are projected from the store and the board (`src/store/plans.ts`) each time the page opens, with the same functions the stage
 * uses (`src/runtime/team-acts.ts`), so the page and the stage always agree.
 */
import type {PickerItem, TabAction, TabRow} from '../runtime/command-surface.js';
import {formatDuration} from './tasks-page.js';
import type {TasksCommand} from './tasks-page.js';
import {projectDelegations} from '../runtime/delegations.js';
import type {DerivedNode, DerivedPlan, NodeStatus} from '../runtime/plan.js';
import type {RuntimeStore} from '../runtime/store.js';
import {actIndexAt, actModel, directorCloses, programme, type ProgrammeAct, type ProgrammeTask} from '../runtime/team-acts.js';
import {teamEvents} from '../runtime/team-events.js';
import {taskGraph, type TaskGraph} from '../runtime/task-graph.js';
import type {PlanBoard} from '../store/plans.js';
import {row, tabContent} from './tab-rows.js';
import type {CommandSurfaces, PageActions} from './surfaces.js';

export const PROGRAMME_EMPTY_TEXT = 'Nothing has been planned or delegated in this session yet. The programme lists the acts once the Director plans a request or dispatches work.';
export const PLAN_GLYPHS: Readonly<Record<NodeStatus, string>> = {pending: '○', ready: '◌', running: '●', waiting: '◐', done: '◉', accepted: '✓', failed: '✗', interrupted: '⊘', abandoned: '–'};
const ACT = 'act:', TASK = 'task:', ADOPT = 'adopt:', EARLIER = '@earlier';

export interface PlanPageDeps {
  surfaces: CommandSurfaces;
  board: Pick<PlanBoard, 'peek' | 'projectPlans' | 'adopt' | 'active'>;
  tasks: Pick<TasksCommand, 'openDelegation'>;
  actors: {find(id: string): {name: string} | undefined};
  store: Pick<RuntimeStore, 'getSnapshot'>;
  session: string;
  /** The title of linked work (a delegation id), when the session knows it. */
  workTitle(id: string): string | undefined;
}

export function createPlanPages(deps: PlanPageDeps) {
  const {surfaces, board, tasks, workTitle, store, session} = deps;
  const name = (ownerId: string) => deps.actors.find(ownerId)?.name ?? ownerId;
  const open = async (...args: Parameters<CommandSurfaces['openPicker']>) => {
    if (surfaces.getSnapshot()) surfaces.close();
    await surfaces.openPicker(...args);
  };

  const openDetail = async (plan: DerivedPlan, node: DerivedNode, backTo: () => Promise<void>) => {
    const known = node.links.map(link => link.activityId ?? link.automaJob!).map(id => ({id, title: workTitle(id)}));
    const actions: TabAction[] = known.flatMap((link, index) => link.title !== undefined && index < 9 ? [{id: 'link:' + link.id, label: 'Open ' + link.title, key: String(index + 1)}] : []);
    // Ids are the model's; the person reads titles.
    const path = (id: string): string => plan.nodes.find(item => item.id === id)?.title ?? 'an earlier step';
    const body: TabRow[] = [
      row.heading('Node'),
      row.field('Title', node.title), row.field('Owner', name(node.owner) + (node.forked ? ' ⑂' : '')),
      row.field('Status', PLAN_GLYPHS[node.status] + ' ' + node.status),
      ...(node.leaves ? [row.field('Progress', `${node.leaves.done} of ${node.leaves.total} tasks complete` + (node.leaves.failed ? `, ${node.leaves.failed} failed` : '') + (node.leaves.interrupted ? `, ${node.leaves.interrupted} interrupted` : ''))] : []),
      ...(node.parent ? [row.field('Parent', path(node.parent))] : []),
      ...(node.after.length ? [row.field('After', node.after.map(path).join('; '))] : []),
      ...(node.blockedBy.length ? [row.field('Waiting for', node.blockedBy.map(path).join('; '))] : []),
      row.blank(), row.heading('Acceptance'),
      ...(node.acceptance.length ? node.acceptance.map(item => row.bullet(item)) : [row.muted('No acceptance checks written.')]),
      row.blank(), row.heading('Evidence'),
      ...(node.accepted ? [row.field('Accepted by', name(node.accepted.by) + ' · ' + new Date(node.accepted.at).toLocaleString()),
        ...(node.accepted.evidence.length ? node.accepted.evidence.map(item => row.bullet(item)) : [row.muted('No evidence recorded.')])] : [row.muted('Not accepted yet.')]),
      ...(node.note ? [row.blank(), row.heading('Note'), ...node.note.split('\n').map(line => row.text(line))] : []),
      row.blank(), row.heading('Linked work'),
      ...(known.length ? known.map((link, index) => row.text((index < 9 && link.title !== undefined ? `${index + 1}  ` : '•  ') + (link.title ?? link.id) +
        (node.work.find(item => item.id === link.id) ? ' · ' + node.work.find(item => item.id === link.id)!.phase : ''))) : [row.muted('Nothing is linked yet: work started for this step appears here.')]),
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
    surfaces.openPage('Plan node · ' + node.title, [{id: 'detail', title: name(node.owner), ...tabContent(body), ...(actions.length ? {actions} : {})}], 'detail', pageActions);
  };

  /** The task graph and the acts the stage draws right now (the same projection the terminal makes). */
  const current = (): {graph: TaskGraph | undefined; model: ReturnType<typeof actModel>} => {
    const snapshot = store.getSnapshot();
    const graph = taskGraph(board.peek(), projectDelegations({snapshot, sessionId: session}), session);
    return {graph, model: actModel(graph, teamEvents({snapshot, sessionId: session}), directorCloses(snapshot, session))};
  };

  const taskRow = (task: ProgrammeTask): PickerItem => {
    const parts = [name(task.owner), task.status === 'running' ? 'running' : task.took !== undefined ? formatDuration(task.took) : task.status,
      ...(task.after.length ? ['after ' + task.after.join(', ')] : []), ...(task.forked ? ['⑂'] : []), ...(task.workers ? ['◦' + task.workers] : [])];
    return {id: TASK + task.id, label: '    ' + '  '.repeat(task.depth) + PLAN_GLYPHS[task.status] + ' ' + task.title, description: parts.join(' · ')};
  };
  const actRow = (act: ProgrammeAct, total: number, here: number): PickerItem => {
    const p = act.progress;
    return {id: ACT + act.index, label: (act.index === here ? '▸ ' : '  ') + `Act ${act.index + 1} of ${total} · ${act.title}`,
      description: `${p.done}/${p.total}` + (p.failed ? ` · ${p.failed} failed` : '') + ' · ' + act.status};
  };

  /**
   * The Programme page: every act with its tasks, the act the stage shows marked (`here`, else the act of the newest event), and the plans of earlier sessions to
   * re-activate at the bottom.
   */
  const openProgramme = async (here?: number): Promise<void> => {
    const {graph, model} = current();
    const acts = programme(model), shown = here ?? actIndexAt(model, model.events.length - 1);
    const earlier = (await board.projectPlans().catch(() => [])).filter(header => !header.current && header.status !== 'abandoned');
    const items: PickerItem[] = acts.flatMap(act => [actRow(act, acts.length, shown), ...act.tasks.map(taskRow)]);
    if (earlier.length) {
      items.push({id: EARLIER, label: 'Earlier plans · re-activate', description: board.active() ? 'Another plan is active: abandon it first' : 'Work then links to the plan again', disabled: true});
      for (const header of earlier) items.push({id: ADOPT + header.id, label: '    ' + header.title, description: [header.nodes + ' nodes', header.status, formatAge(header.updatedAt)].join(' · ')});
    }
    const back = async () => {await openProgramme(here);};
    await open({title: 'Programme', description: 'Enter shows an act on the stage or opens a task · Esc closes', current: '', items, emptyText: PROGRAMME_EMPTY_TEXT},
      async () => ({items}), async id => {
        if (id.startsWith(ACT)) {
          const act = acts.find(item => item.index === Number(id.slice(ACT.length)));
          if (!act) return {message: 'That act no longer exists.', kind: 'command_error' as const};
          surfaces.requestSidebar('show'); surfaces.requestStageAct(act.index);
          return {};
        }
        if (id.startsWith(TASK)) {
          const nodeId = id.slice(TASK.length), task = acts.flatMap(act => act.tasks).find(item => item.id === nodeId);
          const node = graph?.plan.nodes.find(item => item.id === nodeId);
          if (task?.delegation && await tasks.openDelegation(task.delegation, back)) return {};
          if (graph && node) {await openDetail(graph.plan, node, back); return {};}
          return {message: 'That task no longer exists.', kind: 'command_error' as const};
        }
        if (id.startsWith(ADOPT)) {
          const planId = id.slice(ADOPT.length), adopted = await board.adopt(planId);
          if (!adopted.ok) return {message: adopted.error, kind: 'command_error' as const};
          surfaces.requestSidebar('show');
          return {message: 'Plan "' + (earlier.find(header => header.id === planId)?.title ?? 'earlier plan') + '" is active in this session again.', presentation: 'status' as const};
        }
        return {};
      });
  };
  surfaces.programmeOpener = openProgramme;

  return {openProgramme, openDetail};
}
export type PlanPages = ReturnType<typeof createPlanPages>;

function formatAge(time: number): string {
  const ago = Date.now() - time;
  return ago < 60_000 ? 'just now' : formatDuration(ago) + ' ago';
}
