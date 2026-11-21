/**
 * The task graph: one picture of the work of a session, merged from the plan (`src/runtime/plan.ts`, what the Director meant to do) and the delegation record
 * (`projectDelegations()`, what was started). A plan node is a task that may have no work yet; a delegation nobody linked to a node is added as a task of its
 * own, so the sidebar shows both and a session that never had a plan (an earlier project, a small request) shows exactly the work done. Nothing is stored and
 * the plan is never touched: the merged copy carries synthesized nodes only for drawing, the `Plan` tool, the plan files and the Director's change feed keep
 * seeing the plan alone. Statuses come from `derivePlan()` over every delegation as `PlanWork`, so a settled synthesized task reads `done` or `failed`, never
 * `accepted` (nobody gave evidence).
 *
 * Where an unlinked delegation goes (in creation order, so parents are placed before their children):
 *  - under the node its dispatcher is linked to, or under the synthesized task of its dispatcher (an Automa job or fork of a companion working on 1.2 becomes 1.2.k);
 *  - a delegation of a Director round (or of a companion's own request) goes under the phase of the linked work of that same root, else under a phase
 *    synthesized for the root (title from the root, link to the root's activity); roots that dispatched nothing produce no phase;
 *  - below the third level (`PLAN_MAX_DEPTH`) nothing is added: the work is linked to the level-3 task instead, which shows it as `◦ N workers` and lets its
 *    status follow it.
 * Prerequisites (`after`) of a synthesized task point to the node of that delegation. Ids continue after the plan's own (`1.3` when the plan's children of `1`
 * end at `1.2`), in creation order, so they only shift when the Director adds nodes to the plan.
 */
import type {Delegation} from './delegations.js';
import {AUTOMA_OWNER, PLAN_MAX_DEPTH, cleanTitle, depthOf, derivePlan, parentOf, type DerivedPlan, type Plan, type PlanLink, type PlanNode, type PlanWork} from './plan.js';

/** The id of the graph of a session without a plan. */
export const TASKS_PLAN_ID = 'tasks';
export const TASKS_TITLE = 'Tasks';

export interface TaskGraph {
  /** The merged plan with statuses derived from the delegations. */
  readonly plan: DerivedPlan;
  /** Synthesized node id -> the delegation id whose detail page it opens (`/tasks` detail). */
  readonly delegationOf: ReadonlyMap<string, string>;
  /** The ids of the synthesized nodes (everything else is a node of the plan). */
  readonly synthetic: ReadonlySet<string>;
  /** The session had a plan. */
  readonly planned: boolean;
}

interface Draft {id: string; title: string; owner: string; after: string[]; acceptance: readonly string[]; links: PlanLink[]; accepted?: PlanNode['accepted']; abandoned?: boolean; note?: string}

/** One line of a title that may hold a whole assignment. */
const headline = (text: string, fallback: string): string => cleanTitle(text.split(/\r?\n/).find(line => line.trim()) ?? '') || fallback;
const topOf = (id: string): string => id.split('.')[0]!;

/** The task graph of `plan` (absent: none) and `delegations` (creation order), or undefined when there is neither a plan nor any delegated work. */
export function taskGraph(plan: Pick<Plan, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'sessionId' | 'nodes' | 'note'> | undefined, delegations: readonly Delegation[], sessionId: string): TaskGraph | undefined {
  const byId = new Map(delegations.map(item => [item.id, item] as const));
  const drafts = new Map<string, Draft>();
  for (const node of plan?.nodes ?? []) {
    drafts.set(node.id, {id: node.id, title: node.title, owner: node.owner, after: [...node.after], acceptance: node.acceptance, links: [...node.links],
      ...(node.accepted ? {accepted: node.accepted} : {}), ...(node.abandoned ? {abandoned: true} : {}), ...(node.note ? {note: node.note} : {})});
  }
  /** Delegation id -> the node that carries it (linked by the plan, synthesized for it, or the level-3 node it was folded into). */
  const nodeOf = new Map<string, string>();
  const planned = new Set<string>();
  for (const draft of drafts.values()) for (const link of draft.links) {const token = link.activityId ?? link.automaJob; if (token) {nodeOf.set(token, draft.id); planned.add(token);}}
  const synthetic = new Set<string>(), delegationOf = new Map<string, string>();

  const nextId = (parent: string | undefined): string => {
    let max = 0;
    for (const id of drafts.keys()) if (parentOf(id) === parent) max = Math.max(max, Number(id.slice(parent === undefined ? 0 : parent.length + 1)) || 0);
    return (parent === undefined ? '' : parent + '.') + (max + 1);
  };
  const ownerOf = (item: Delegation) => item.kind === 'automa' && !item.fork ? AUTOMA_OWNER : item.ownerId;
  const linkOf = (item: Delegation): PlanLink => item.kind === 'automa' ? {automaJob: item.id} : {activityId: item.id};
  /** Adds `item` as a new node under `parent` (absent: a phase), or links it to `parent` when that is the third level. */
  const place = (item: Delegation, parent: string | undefined, fallback: string): string => {
    if (parent !== undefined && depthOf(parent) >= PLAN_MAX_DEPTH) {
      drafts.get(parent)!.links.push(linkOf(item));
      nodeOf.set(item.id, parent);
      return parent;
    }
    const id = nextId(parent), note = item.result?.summary ? cleanTitle(item.result.summary).slice(0, 160) : undefined;
    drafts.set(id, {id, title: headline(item.assignment.title || item.title, fallback), owner: ownerOf(item), after: [], acceptance: [], links: [linkOf(item)], ...(note ? {note} : {})});
    nodeOf.set(item.id, id); synthetic.add(id); delegationOf.set(id, item.id);
    return id;
  };

  /** The phase an unlinked delegation of this root joins: the phase of the root's linked work (the latest), else a phase synthesized for the root. */
  const phases = new Map<string, string>();
  const phaseFor = (rootId: string): string | undefined => {
    const known = phases.get(rootId);
    if (known !== undefined) return known;
    let found: string | undefined;
    for (const item of delegations) if (item.rootId === rootId && planned.has(item.id)) found = topOf(nodeOf.get(item.id)!);
    const root = byId.get(rootId);
    if (found === undefined && root) found = place(root, undefined, 'Request');
    if (found !== undefined) phases.set(rootId, found);
    return found;
  };

  for (const item of delegations) {
    if (item.rootId === item.id || nodeOf.has(item.id)) continue;
    const parent = item.parentId === undefined ? undefined : nodeOf.get(item.parentId);
    const target = parent ?? phaseFor(item.rootId);
    // A delegation whose root has no record (an older session) stands as a phase of its own.
    place(item, target, item.jobId ?? item.ownerId);
  }
  if (!plan && !synthetic.size) return undefined;

  // Prerequisites between delegations are prerequisites between their nodes.
  for (const id of synthetic) {
    const item = byId.get(delegationOf.get(id)!)!;
    const after = [...new Set((item.after ?? []).flatMap(other => nodeOf.has(other) && nodeOf.get(other) !== id ? [nodeOf.get(other)!] : []))];
    if (after.length) drafts.get(id)!.after = after;
  }
  const nodes: PlanNode[] = [...drafts.values()].map(draft => ({id: draft.id, title: draft.title, owner: draft.owner, after: draft.after, acceptance: draft.acceptance, links: draft.links,
    ...(draft.accepted ? {accepted: draft.accepted} : {}), ...(draft.abandoned ? {abandoned: true} : {}), ...(draft.note ? {note: draft.note} : {})}));
  const work: PlanWork[] = delegations.map(item => ({id: item.id, status: item.status, startedAt: item.startedAt, ...(item.fork ? {fork: true} : {})}));
  const live = delegations.some(item => ['running', 'queued', 'waiting_input', 'paused', 'waiting'].includes(item.status));
  const base: Plan = plan
    ? {id: plan.id, title: plan.title, status: plan.status, createdAt: plan.createdAt, updatedAt: plan.updatedAt, sessionId: plan.sessionId, nodes, ...(plan.note ? {note: plan.note} : {})}
    : {id: TASKS_PLAN_ID, title: TASKS_TITLE, status: live ? 'active' : 'done', createdAt: 0, updatedAt: Math.max(0, ...delegations.map(item => item.finishedAt ?? item.startedAt ?? 0)), sessionId, nodes};
  return {plan: derivePlan(base, work), delegationOf, synthetic, planned: plan !== undefined};
}
