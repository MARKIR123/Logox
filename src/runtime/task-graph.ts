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
 * Attempts fold (`foldAttempts()`): a companion delegation that ended without a result (a quota, a timeout, an interrupt: `delegations.ts:endedWithoutResult`)
 * and was followed under the same root by a later delegation of the same actor, or was resumed (`resumeTaskId`), is an earlier attempt of that later one: it has no
 * node, its work is linked to the later node (so the detail page lists the attempts) and its prerequisites and dependents follow that node; a chain of
 * attempts folds into its last. An Automa worker that is continued keeps its job id, so `projectDelegations()` already holds it as one delegation. An unfinished
 * delegation nobody took up again stays, read as `interrupted`.
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
  /** Node id -> the delegations folded into it as earlier attempts, oldest first (their work is linked to the node; the node's own delegation is the last attempt). */
  readonly attempts: ReadonlyMap<string, readonly string[]>;
  /** The session had a plan. */
  readonly planned: boolean;
}

interface Draft {id: string; title: string; owner: string; after: string[]; acceptance: readonly string[]; links: PlanLink[]; accepted?: PlanNode['accepted']; abandoned?: boolean; note?: string}

/** One line of a title that may hold a whole assignment. */
const headline = (text: string, fallback: string): string => cleanTitle(text.split(/\r?\n/).find(line => line.trim()) ?? '') || fallback;
const topOf = (id: string): string => id.split('.')[0]!;

const LIVE_STATUS: ReadonlySet<string> = new Set(['running', 'queued', 'waiting_input', 'paused', 'waiting']);
/**
 * Earlier attempt id -> the delegation it folds into (the last of its chain). An actor delegation is an earlier attempt of a later one that resumes it
 * (`resumeTaskId`), or, when it ended without a result, of the next delegation of the same actor under the same root that is not itself a resumption of something
 * else. Nodes of the plan (`planned`) and Director rounds never fold.
 */
export function foldAttempts(delegations: readonly Delegation[], planned: ReadonlySet<string> = new Set()): Map<string, string> {
  const next = new Map<string, string>();
  delegations.forEach((earlier, index) => {
    if (earlier.kind !== 'actor' || planned.has(earlier.id) || LIVE_STATUS.has(earlier.status)) return;
    const rest = delegations.slice(index + 1).filter(item => item.kind === 'actor');
    const resumer = rest.find(item => item.resumes === earlier.id);
    const successor = resumer ?? (earlier.unfinished ? rest.find(item => item.ownerId === earlier.ownerId && item.rootId === earlier.rootId && !item.resumes) : undefined);
    if (successor) next.set(earlier.id, successor.id);
  });
  const last = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    while (next.has(at) && !seen.has(at)) {seen.add(at); at = next.get(at)!;}
    return at;
  };
  return new Map([...next.keys()].map(id => [id, last(id)] as const).filter(([id, target]) => id !== target));
}

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
  const folded = foldAttempts(delegations, planned);
  const target = (id: string): string => folded.get(id) ?? id;

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

  const placing = new Set<string>();
  const placeItem = (item: Delegation): void => {
    if (item.rootId === item.id || nodeOf.has(item.id) || folded.has(item.id) || placing.has(item.id)) return;
    placing.add(item.id);
    // The dispatcher may be an earlier attempt: the work belongs under the node its last attempt has, which is placed first.
    const dispatcher = item.parentId === undefined ? undefined : byId.get(target(item.parentId));
    if (dispatcher) placeItem(dispatcher);
    const parent = item.parentId === undefined ? undefined : nodeOf.get(target(item.parentId));
    // A delegation whose root has no record (an older session) stands as a phase of its own.
    place(item, parent ?? phaseFor(item.rootId), item.jobId ?? item.ownerId);
  };
  for (const item of delegations) placeItem(item);
  // An earlier attempt shares the node of its last attempt; its work is linked there, before the last attempt's own so the latest outcome decides the status.
  const attempts = new Map<string, string[]>();
  for (const item of delegations) {
    const node = folded.has(item.id) ? nodeOf.get(target(item.id)) : undefined;
    if (node === undefined) continue;
    nodeOf.set(item.id, node);
    attempts.set(node, [...attempts.get(node) ?? [], item.id]);
  }
  for (const [node, ids] of attempts) drafts.get(node)!.links.unshift(...ids.map(id => linkOf(byId.get(id)!)));
  if (!plan && !synthetic.size) return undefined;

  // Prerequisites between delegations are prerequisites between their nodes (an earlier attempt's prerequisites are its node's).
  for (const id of synthetic) {
    const own = delegations.filter(item => nodeOf.get(item.id) === id);
    const after = [...new Set(own.flatMap(item => item.after ?? []).flatMap(other => nodeOf.has(other) && nodeOf.get(other) !== id ? [nodeOf.get(other)!] : []))];
    if (after.length) drafts.get(id)!.after = after;
  }
  const nodes: PlanNode[] = [...drafts.values()].map(draft => ({id: draft.id, title: draft.title, owner: draft.owner, after: draft.after, acceptance: draft.acceptance, links: draft.links,
    ...(draft.accepted ? {accepted: draft.accepted} : {}), ...(draft.abandoned ? {abandoned: true} : {}), ...(draft.note ? {note: draft.note} : {})}));
  const work: PlanWork[] = delegations.map(item => ({id: item.id, status: item.status, startedAt: item.startedAt, ...(item.durationMs !== undefined ? {durationMs: item.durationMs} : {}), ...(item.fork ? {fork: true} : {}), ...(item.unfinished ? {unfinished: true} : {})}));
  const live = delegations.some(item => ['running', 'queued', 'waiting_input', 'paused', 'waiting'].includes(item.status));
  const base: Plan = plan
    ? {id: plan.id, title: plan.title, status: plan.status, createdAt: plan.createdAt, updatedAt: plan.updatedAt, sessionId: plan.sessionId, nodes, ...(plan.note ? {note: plan.note} : {})}
    : {id: TASKS_PLAN_ID, title: TASKS_TITLE, status: live ? 'active' : 'done', createdAt: 0, updatedAt: Math.max(0, ...delegations.map(item => item.finishedAt ?? item.startedAt ?? 0)), sessionId, nodes};
  return {plan: derivePlan(base, work), delegationOf, synthetic, attempts, planned: plan !== undefined};
}
