/**
 * The plan graph: a task graph the Director keeps for a request, pure and UI-neutral. A plan is a tree of nodes (ids `1`, `1.2`, `1.2.3`; three
 * levels at most) with an owner, prerequisites (`after`), acceptance checks and links to the work that carries each node out (a companion's
 * activity, an Automa job). The runtime never stores a node's progress: `derivePlan()` reads it from the linked work (`src/runtime/delegations.ts`
 * records) every time, so `running`, `done` or `failed` cannot disagree with what happened. Only `accepted` and `abandoned` are written, by an owner
 * or the Director, and acceptance carries evidence.
 *
 * `applyPlanOp()` is the one place that decides who may change what and refuses with the exact fix. Persistence (`src/runtime/plan-file.ts`,
 * `src/store/plans.ts`), the `Plan` tool, the `/tasks` pages and the session hub all sit on these types.
 */
import {isDirector} from './director-id.js';
import * as text from '../prompts/runtime/plan.js';

export const PLAN_MAX_DEPTH = 3;
/** The owner of work that runs as Automa jobs. */
export const AUTOMA_OWNER = 'automa';
/** The actor name of the person's own edits (the GUI): the same rights as the Director. */
export const PLAN_USER = 'user';

export type PlanStatus = 'active' | 'done' | 'abandoned';
export type NodeStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'done' | 'failed' | 'accepted' | 'abandoned';
export interface PlanLink {readonly activityId?: string; readonly automaJob?: string}
export interface PlanAccepted {readonly by: string; readonly at: number; readonly evidence: readonly string[]}
export interface PlanNode {
  /** `1`, `1.2`, `1.2.3`: the parent is the id without its last segment. Ids are assigned by the runtime and never reused for another node while it exists. */
  readonly id: string;
  readonly title: string;
  /** An actor id, or `automa`. */
  readonly owner: string;
  /** Node ids that must be accepted or done before this one is ready. */
  readonly after: readonly string[];
  readonly acceptance: readonly string[];
  /** The work that carries the node out, in the order it was linked. */
  readonly links: readonly PlanLink[];
  readonly accepted?: PlanAccepted;
  readonly abandoned?: boolean;
  readonly note?: string;
}
export interface Plan {
  /** `p` and a short number. */
  readonly id: string;
  readonly title: string;
  readonly status: PlanStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionId: string;
  readonly nodes: readonly PlanNode[];
  readonly note?: string;
}

export interface NewNode {title: string; owner?: string | undefined; after?: readonly string[] | undefined; acceptance?: readonly string[] | undefined; nodes?: readonly NewNode[] | undefined}
export type PlanOp =
  | {readonly op: 'create'; readonly title: string; readonly nodes?: readonly NewNode[] | undefined}
  | {readonly op: 'add'; readonly parent?: string | undefined; readonly nodes: readonly NewNode[]}
  | {readonly op: 'update'; readonly id: string; readonly title?: string | undefined; readonly owner?: string | undefined; readonly after?: readonly string[] | undefined;
      readonly acceptance?: readonly string[] | undefined; readonly note?: string | undefined}
  | {readonly op: 'remove'; readonly id: string}
  | {readonly op: 'accept'; readonly id: string; readonly evidence?: readonly string[] | undefined}
  | {readonly op: 'reopen'; readonly id: string}
  | {readonly op: 'abandon'; readonly id?: string | undefined};

/** What an op may need to know beyond the plan. */
export interface PlanEnv {
  readonly now: number;
  readonly sessionId: string;
  /** The id of a new plan. */
  readonly planId?: () => string;
  /** The actor ids an owner may name (`automa` is always valid); absent: any. */
  readonly knownOwners?: readonly string[] | undefined;
  /** The derived status of a node before the op (a node with work in progress cannot be removed). */
  readonly status?: (id: string) => NodeStatus | undefined;
  /** Evidence the runtime read from a node's linked work, for an `accept` without evidence. */
  readonly evidence?: (id: string) => readonly string[] | undefined;
  /** Ids of linked work in progress of a node, for the refusal text. */
  readonly active?: (id: string) => readonly string[];
}
export type PlanResult =
  | {readonly ok: true; readonly plan: Plan; /** What changed, one line each, for the tool result. */ readonly lines: readonly string[]; /** The nodes the op touched (added, changed or removed). */ readonly touched: readonly string[]}
  | {readonly ok: false; readonly error: string};

// ---------------------------------------------------------------------------------------------------------------------------------- ids and trees
export const parentOf = (id: string): string | undefined => {const at = id.lastIndexOf('.'); return at < 0 ? undefined : id.slice(0, at);};
export const depthOf = (id: string): number => id.split('.').length;
export const isUnder = (id: string, ancestor: string): boolean => id.startsWith(ancestor + '.');
export function compareIds(a: string, b: string): number {
  const left = a.split('.'), right = b.split('.');
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = Number(left[index]), y = Number(right[index]);
    if (x !== y) return Number.isNaN(x) || Number.isNaN(y) ? left[index]!.localeCompare(right[index]!) : x - y;
  }
  return left.length - right.length;
}
export const sortNodes = <T extends {readonly id: string}>(nodes: readonly T[]): T[] => [...nodes].sort((a, b) => compareIds(a.id, b.id));
export const isValidId = (id: string) => /^\d+(\.\d+){0,2}$/.test(id);
const oneLine = (value: string, limit: number) => value.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
/** Text that cannot break the plan file: one line, no comment markers. */
export const cleanTitle = (value: string) => oneLine(value, 160);
const cleanItem = (value: string) => oneLine(value, 400);
const cleanNote = (value: string) => value.replace(/<!--|-->/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n').slice(0, 1000);
const cleanList = (items: readonly string[] | undefined, limit = 12) => (items ?? []).map(cleanItem).filter(Boolean).slice(0, limit);

const full = (actor: string) => isDirector(actor) || actor === PLAN_USER;
const find = (nodes: readonly PlanNode[], id: string) => nodes.find(node => node.id === id);
/** Whether `actor` owns a strict ancestor of `id` (or the node itself with `self`). */
function ownsAbove(nodes: readonly PlanNode[], actor: string, id: string, self: boolean): boolean {
  for (let at: string | undefined = self ? id : parentOf(id); at !== undefined; at = parentOf(at)) if (find(nodes, at)?.owner === actor) return true;
  return false;
}
const idsOf = (nodes: readonly PlanNode[]) => sortNodes(nodes).map(node => node.id);
function nextChildId(nodes: readonly PlanNode[], parent: string | undefined): string {
  let max = 0;
  for (const node of nodes) if (parentOf(node.id) === parent) max = Math.max(max, Number(node.id.slice(parent === undefined ? 0 : parent.length + 1)) || 0);
  return (parent === undefined ? '' : parent + '.') + (max + 1);
}
const subtree = (nodes: readonly PlanNode[], id: string) => nodes.filter(node => node.id === id || isUnder(node.id, id));

/** A plan is done when it has live top-level nodes and every one of them is accepted (explicitly or because every live node below it is). */
function isAccepted(nodes: readonly PlanNode[], node: PlanNode): boolean {
  if (node.abandoned) return true;
  if (node.accepted) return true;
  const kids = nodes.filter(item => parentOf(item.id) === node.id);
  return kids.length > 0 && kids.every(kid => isAccepted(nodes, kid));
}
export function settlePlan(plan: Plan): Plan {
  if (plan.status === 'abandoned') return plan;
  const top = plan.nodes.filter(node => depthOf(node.id) === 1 && !node.abandoned);
  const done = top.length > 0 && top.every(node => isAccepted(plan.nodes, node));
  const status: PlanStatus = done ? 'done' : 'active';
  return status === plan.status ? plan : {...plan, status};
}

// ---------------------------------------------------------------------------------------------------------------------------------- applying ops
/** `after` entries must name nodes of the plan, never the node itself, and never form a cycle. */
function checkAfter(nodes: readonly PlanNode[]): string | undefined {
  const ids = new Set(nodes.map(node => node.id));
  for (const node of nodes) for (const ref of node.after) {
    if (ref === node.id) return text.planAfterSelf(node.id);
    if (!ids.has(ref)) return text.planUnknownAfter(node.id, ref);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): string | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return text.planAfterCycle([...path.slice(path.indexOf(id)), id]);
    state.set(id, 1);
    for (const ref of find(nodes, id)!.after) {const found = visit(ref, [...path, id]); if (found) return found;}
    state.set(id, 2);
    return undefined;
  };
  for (const node of nodes) {const found = visit(node.id, []); if (found) return found;}
  return undefined;
}

/** Adds `items` under `parent` (undefined: top level); returns the new nodes or a refusal. */
function grow(nodes: readonly PlanNode[], parent: string | undefined, items: readonly NewNode[], actor: string, env: PlanEnv): {nodes: PlanNode[]; added: PlanNode[]} | string {
  let all = [...nodes];
  const added: PlanNode[] = [];
  const known = env.knownOwners ? [...new Set([...env.knownOwners, AUTOMA_OWNER])] : undefined;
  const place = (at: string | undefined, list: readonly NewNode[]): string | undefined => {
    for (const item of list) {
      const title = cleanTitle(item.title);
      if (!title) return text.planEmptyTitle;
      const id = nextChildId(all, at);
      if (depthOf(id) > PLAN_MAX_DEPTH) return text.planTooDeep(id);
      const owner = (item.owner ?? '').trim() || actor;
      if (!full(actor) && owner !== actor && owner !== AUTOMA_OWNER) return text.planOwnerChoice(actor, owner);
      if (known && !known.includes(owner)) return text.planUnknownOwner(owner, known);
      const node: PlanNode = {id, title, owner, after: [...new Set((item.after ?? []).map(ref => ref.trim()).filter(Boolean))], acceptance: cleanList(item.acceptance), links: []};
      all = [...all, node]; added.push(node);
      if (item.nodes?.length) {const failed = place(id, item.nodes); if (failed) return failed;}
    }
    return undefined;
  };
  const failed = place(parent, items);
  if (failed) return failed;
  const bad = checkAfter(all);
  return bad ?? {nodes: all, added};
}

const label = (node: PlanNode) => `${node.id} ${node.title} (${node.owner})`;

/** Applies one op for `actor` to `plan` (absent: no plan yet). Returns the new plan, or the refusal with its fix; the input is never changed. */
export function applyPlanOp(plan: Plan | undefined, op: PlanOp, actor: string, env: PlanEnv): PlanResult {
  const refuse = (error: string): PlanResult => ({ok: false, error});
  const done = (next: Plan, lines: readonly string[], touched: readonly string[]): PlanResult =>
    ({ok: true, plan: settlePlan({...next, updatedAt: env.now}), lines, touched});

  if (op.op === 'create') {
    if (!full(actor)) return refuse(text.PLAN_ONLY_DIRECTOR_CREATES);
    if (plan && plan.status === 'active') return refuse(text.planAlreadyActive(plan.id, plan.title));
    const title = cleanTitle(op.title);
    if (!title) return refuse(text.planBadOp('create', 'a title'));
    const grown = grow([], undefined, op.nodes ?? [], actor, env);
    if (typeof grown === 'string') return refuse(grown);
    const created: Plan = {id: env.planId?.() ?? 'p1', title, status: 'active', createdAt: env.now, updatedAt: env.now, sessionId: env.sessionId, nodes: sortNodes(grown.nodes)};
    return done(created, [`Created plan ${created.id} "${title}"` + (grown.added.length ? ' with ' + grown.added.map(label).join('; ') : '') + '.'], grown.added.map(node => node.id));
  }
  if (!plan) return refuse(text.PLAN_NO_PLAN);
  if (plan.status === 'abandoned') return refuse(text.planClosed(plan.id, plan.status));
  const nodes = plan.nodes;
  const need = (id: string | undefined, name: string): PlanNode | string => {
    if (!id) return text.planBadOp(name, 'an id');
    return find(nodes, id) ?? text.planUnknownNode(id, idsOf(nodes));
  };
  /** Rights over a node below one the actor owns (the node itself is not enough). */
  const underOwn = (node: PlanNode): string | undefined => full(actor) || ownsAbove(nodes, actor, node.id, false) ? undefined
    : text.planNotYours(node.id, node.owner);

  switch (op.op) {
    case 'add': {
      let parent: PlanNode | undefined;
      if (op.parent !== undefined) {
        const found = need(op.parent, 'add');
        if (typeof found === 'string') return refuse(found);
        parent = found;
        if (!full(actor) && !ownsAbove(nodes, actor, parent.id, true)) return refuse(text.planNotYours(parent.id, parent.owner));
        if (parent.abandoned) return refuse(text.planAbandonedNode(parent.id));
      } else if (!full(actor)) return refuse(text.PLAN_ONLY_DIRECTOR_WHOLE);
      if (!op.nodes.length) return refuse(text.planBadOp('add', 'nodes'));
      const grown = grow(nodes, parent?.id, op.nodes, actor, env);
      if (typeof grown === 'string') return refuse(grown);
      return done({...plan, nodes: sortNodes(grown.nodes)}, ['Added ' + grown.added.map(label).join('; ') + '.'], grown.added.map(node => node.id));
    }
    case 'update': {
      const node = need(op.id, 'update');
      if (typeof node === 'string') return refuse(node);
      let next: PlanNode = node;
      if (!full(actor)) {
        if (node.owner === actor && !ownsAbove(nodes, actor, node.id, false)) {
          if (op.title !== undefined || op.owner !== undefined || op.after !== undefined || op.acceptance !== undefined) return refuse(text.planOwnNode(node.id));
        } else {const denied = underOwn(node); if (denied) return refuse(denied);}
      }
      if (op.title !== undefined) {const title = cleanTitle(op.title); if (!title) return refuse(text.planEmptyTitle); next = {...next, title};}
      if (op.owner !== undefined) {
        const owner = op.owner.trim(), known = env.knownOwners ? [...new Set([...env.knownOwners, AUTOMA_OWNER])] : undefined;
        if (!full(actor) && owner !== actor && owner !== AUTOMA_OWNER) return refuse(text.planOwnerChoice(actor, owner));
        if (known && !known.includes(owner)) return refuse(text.planUnknownOwner(owner, known));
        next = {...next, owner};
      }
      if (op.after !== undefined) next = {...next, after: [...new Set(op.after.map(ref => ref.trim()).filter(Boolean))]};
      if (op.acceptance !== undefined) next = {...next, acceptance: cleanList(op.acceptance)};
      if (op.note !== undefined) {const note = cleanNote(op.note); const {note: _dropped, ...rest} = next; next = note ? {...rest, note} : rest;}
      const all = nodes.map(item => item.id === node.id ? next : item);
      const bad = checkAfter(all);
      if (bad) return refuse(bad);
      return done({...plan, nodes: all}, [`Updated ${label(next)}.`], [node.id]);
    }
    case 'remove': {
      const node = need(op.id, 'remove');
      if (typeof node === 'string') return refuse(node);
      const denied = underOwn(node);
      if (denied) return refuse(denied);
      const gone = subtree(nodes, node.id), busy = gone.filter(item => env.status?.(item.id) === 'running' || env.status?.(item.id) === 'waiting');
      if (busy.length) return refuse(text.planRemoveRunning(node.id, busy.flatMap(item => env.active?.(item.id) ?? [item.id])));
      const ids = new Set(gone.map(item => item.id));
      const kept = nodes.filter(item => !ids.has(item.id)).map(item => item.after.some(ref => ids.has(ref)) ? {...item, after: item.after.filter(ref => !ids.has(ref))} : item);
      return done({...plan, nodes: kept}, [`Removed ${label(node)}` + (gone.length > 1 ? ` and ${gone.length - 1} below it` : '') + '.'], [...ids]);
    }
    case 'accept': {
      const node = need(op.id, 'accept');
      if (typeof node === 'string') return refuse(node);
      const parent = parentOf(node.id), parentNode = parent ? find(nodes, parent) : undefined;
      if (!full(actor) && parentNode?.owner !== actor) return refuse(node.owner === actor ? text.planCannotAcceptOwn(node.id, parent, parentNode?.owner) : text.planCannotAccept(node.id, parent, parentNode?.owner));
      if (node.abandoned) return refuse(text.planAbandonedNode(node.id));
      const given = cleanList(op.evidence, 20);
      const evidence = given.length ? given : [...env.evidence?.(node.id) ?? []].map(cleanItem).filter(Boolean).slice(0, 20);
      if (!evidence.length) return refuse(text.PLAN_ACCEPT_NEEDS_EVIDENCE);
      const next: PlanNode = {...node, accepted: {by: actor, at: env.now, evidence}};
      return done({...plan, nodes: nodes.map(item => item.id === node.id ? next : item)}, [`Accepted ${label(node)}.`], [node.id]);
    }
    case 'reopen': {
      const node = need(op.id, 'reopen');
      if (typeof node === 'string') return refuse(node);
      const parent = parentOf(node.id), parentNode = parent ? find(nodes, parent) : undefined;
      if (!full(actor) && parentNode?.owner !== actor) return refuse(text.planCannotAccept(node.id, parent, parentNode?.owner));
      const {accepted: _accepted, abandoned: _abandoned, ...open} = node;
      // A node accepted through its children needs one of them reopened; the explicit marks are all there is to clear here.
      return done({...plan, nodes: nodes.map(item => item.id === node.id ? open : item)}, [`Reopened ${label(node)}.`], [node.id]);
    }
    case 'abandon': {
      if (op.id === undefined) {
        if (!full(actor)) return refuse(text.PLAN_ONLY_DIRECTOR_WHOLE);
        return {ok: true, plan: {...plan, status: 'abandoned', updatedAt: env.now}, lines: [`Abandoned plan ${plan.id} "${plan.title}".`], touched: nodes.map(node => node.id)};
      }
      const node = need(op.id, 'abandon');
      if (typeof node === 'string') return refuse(node);
      const denied = underOwn(node);
      if (denied) return refuse(denied);
      const ids = new Set(subtree(nodes, node.id).map(item => item.id));
      return done({...plan, nodes: nodes.map(item => ids.has(item.id) ? {...item, abandoned: true} : item)}, [`Abandoned ${label(node)}.`], [...ids]);
    }
  }
}

/** Several ops applied in order and atomically: the first refusal ends the call with nothing applied. */
export function applyPlanOps(plan: Plan | undefined, ops: readonly PlanOp[], actor: string, env: PlanEnv): PlanResult {
  let current = plan;
  const lines: string[] = [], touched = new Set<string>();
  for (const [index, op] of ops.entries()) {
    const result = applyPlanOp(current, op, actor, env);
    if (!result.ok) return {ok: false, error: ops.length > 1 ? text.planOpFailed(index, op.op, result.error) : result.error};
    current = result.plan;
    lines.push(...result.lines);
    for (const id of result.touched) touched.add(id);
  }
  return current ? {ok: true, plan: current, lines, touched: [...touched]} : {ok: false, error: text.PLAN_NO_PLAN};
}

// ---------------------------------------------------------------------------------------------------------------------------------- linked work
/** One unit of work a node can be linked to: a delegation record (`delegations.ts:Delegation` has this shape). */
export interface PlanWork {readonly id: string; readonly status: string; /** When the work started, if known (a delegation record's `startedAt`). */ readonly startedAt?: number | undefined;
  /** The work is a fork (a copy of its dispatcher). */ readonly fork?: boolean | undefined}
export type WorkPhase = 'running' | 'waiting' | 'completed' | 'failed';
/** What a record's status says: a running task or job runs; one waiting for approval, an answer, a place in the queue or its prerequisites waits; the rest ended. */
export function workPhase(status: string): WorkPhase {
  if (status === 'running') return 'running';
  if (['queued', 'waiting_input', 'paused', 'waiting', 'blocked'].includes(status)) return 'waiting';
  if (status === 'completed' || status === 'done') return 'completed';
  return 'failed';
}

export interface NodeProgress {readonly accepted: number; readonly done: number; readonly total: number}
export interface DerivedNode extends PlanNode {
  readonly status: NodeStatus;
  readonly depth: number;
  readonly parent?: string;
  readonly children: readonly string[];
  /** Parents only: how many live children are accepted or done. */
  readonly progress?: NodeProgress;
  /** The prerequisites still open. */
  readonly blockedBy: readonly string[];
  /** The linked work the runtime knows, with its phase. */
  readonly work: readonly {readonly id: string; readonly phase: WorkPhase; readonly fork?: true}[];
  /** A linked job is a fork: the owner is shown as the actor plus `⑂`. */
  readonly forked?: true;
  /** When the earliest work still running for this node (or, for a parent, below it) started; absent when nothing runs or no start is known. The sidebar's elapsed clock. */
  readonly runningSince?: number;
}
export interface DerivedPlan extends Omit<Plan, 'nodes'> {
  readonly nodes: readonly DerivedNode[];
  readonly progress: NodeProgress;
}

/** The linked work of a node that the runtime knows, in link order. */
export function linkedWork(node: PlanNode, work: readonly PlanWork[]): {id: string; phase: WorkPhase; fork?: true}[] {
  const byId = new Map(work.map(item => [item.id, item] as const));
  return node.links.flatMap(link => {
    const found = byId.get(link.activityId ?? link.automaJob ?? '');
    return found ? [{id: found.id, phase: workPhase(found.status), ...(found.fork ? {fork: true as const} : {})}] : [];
  });
}

/** The status of work-bearing nodes: live work wins; otherwise a failure with nothing completed after it is a failure, else done. */
function fromWork(items: readonly {phase: WorkPhase}[]): NodeStatus | undefined {
  if (!items.length) return undefined;
  if (items.some(item => item.phase === 'running')) return 'running';
  if (items.some(item => item.phase === 'waiting')) return 'waiting';
  const lastDone = items.findLastIndex(item => item.phase === 'completed');
  return items.some((item, index) => item.phase === 'failed' && index > lastDone) ? 'failed' : 'done';
}

/** Statuses and roll-ups of a plan from the work its nodes are linked to. Pure: the same plan and records give the same answer. */
export function derivePlan(plan: Plan, work: readonly PlanWork[]): DerivedPlan {
  const nodes = sortNodes(plan.nodes);
  const kids = new Map<string | undefined, PlanNode[]>();
  for (const node of nodes) {
    const parent = parentOf(node.id);
    kids.set(parent, [...kids.get(parent) ?? [], node]);
  }
  const statuses = new Map<string, NodeStatus>(), visiting = new Set<string>();
  const byId = new Map(nodes.map(node => [node.id, node] as const));
  const satisfied = (id: string): boolean => {
    const status = statusOf(id);
    return status === 'accepted' || status === 'done' || status === 'abandoned' || status === undefined;
  };
  function statusOf(id: string): NodeStatus | undefined {
    const known = statuses.get(id);
    if (known) return known;
    const node = byId.get(id);
    if (!node) return undefined;
    // A cycle through `after` cannot be created by an op, but a hand-edited file may hold one: the node counts as open instead of looping.
    if (visiting.has(id)) return 'pending';
    visiting.add(id);
    let status: NodeStatus;
    const children = (kids.get(id) ?? []).filter(child => !child.abandoned);
    const own = fromWork(linkedWork(node, work));
    const open = node.after.filter(ref => !satisfied(ref));
    const idle: NodeStatus = open.length ? 'pending' : 'ready';
    if (node.abandoned) status = 'abandoned';
    else if (node.accepted) status = 'accepted';
    else {
      const parts = [...(own ? [own] : []), ...children.map(child => statusOf(child.id)!)];
      if (!parts.length) status = idle;
      else if (parts.every(part => part === 'accepted')) status = 'accepted';
      else if (parts.every(part => part === 'accepted' || part === 'done')) status = 'done';
      else if (parts.includes('running')) status = 'running';
      else if (parts.includes('waiting')) status = 'waiting';
      else if (parts.includes('failed')) status = 'failed';
      else status = idle;
    }
    visiting.delete(id);
    statuses.set(id, status);
    return status;
  }
  for (const node of nodes) statusOf(node.id);
  // The start of the earliest running work of each node's own links; a parent takes the earliest of its subtree.
  const startedAt = new Map(work.flatMap(item => item.startedAt === undefined ? [] : [[item.id, item.startedAt] as const]));
  const since = new Map<string, number>();
  for (const node of nodes) {
    if (node.abandoned) continue;
    for (const item of linkedWork(node, work)) {
      const started = startedAt.get(item.id);
      if (item.phase !== 'running' || started === undefined) continue;
      for (let at: string | undefined = node.id; at !== undefined; at = parentOf(at)) since.set(at, Math.min(since.get(at) ?? Infinity, started));
    }
  }
  const derived: DerivedNode[] = nodes.map(node => {
    const parent = parentOf(node.id);
    const children = kids.get(node.id) ?? [];
    const live = children.filter(child => !child.abandoned);
    const counts = (list: readonly PlanNode[]): NodeProgress => ({accepted: list.filter(child => statuses.get(child.id) === 'accepted').length,
      done: list.filter(child => statuses.get(child.id) === 'accepted' || statuses.get(child.id) === 'done').length, total: list.length});
    return {...node, status: statusOf(node.id)!, depth: depthOf(node.id), ...(parent !== undefined ? {parent} : {}), children: children.map(child => child.id),
      ...(live.length ? {progress: counts(live)} : {}),
      blockedBy: node.after.filter(ref => !satisfied(ref)), work: linkedWork(node, work), ...(linkedWork(node, work).some(item => item.fork) ? {forked: true as const} : {}), ...(since.has(node.id) ? {runningSince: since.get(node.id)!} : {})};
  });
  const top = nodes.filter(node => depthOf(node.id) === 1 && !node.abandoned);
  const topCounts = {accepted: top.filter(node => statuses.get(node.id) === 'accepted').length,
    done: top.filter(node => statuses.get(node.id) === 'accepted' || statuses.get(node.id) === 'done').length, total: top.length};
  return {...plan, nodes: derived, progress: topCounts};
}

// ---------------------------------------------------------------------------------------------------------------------------------- text for models
const statusWord = (node: DerivedNode) => node.status === 'abandoned' ? 'abandoned' : node.status;
/** One line of a node: `1.2 Title [status] owner`, with prerequisites and a parent's progress. */
export function nodeLine(node: DerivedNode): string {
  return `${node.id} ${node.title} [${statusWord(node)}] ${node.owner}` + (node.blockedBy.length ? ' after ' + node.blockedBy.join(',') : '') +
    (node.progress ? ` ${node.progress.accepted}/${node.progress.total}` : '');
}
/** The whole plan as an indented outline: what `Plan` with no arguments returns. */
export function renderOutline(plan: DerivedPlan): string {
  const lines = [`Plan ${plan.id} "${plan.title}" [${plan.status}] ${plan.progress.accepted}/${plan.progress.total} accepted`];
  for (const node of plan.nodes) {
    lines.push('  '.repeat(node.depth) + nodeLine(node));
    for (const item of node.acceptance) lines.push('  '.repeat(node.depth + 1) + '- acceptance: ' + item);
    if (node.accepted) lines.push('  '.repeat(node.depth + 1) + `- accepted by ${node.accepted.by}: ${node.accepted.evidence.join('; ')}`);
    if (node.note) lines.push('  '.repeat(node.depth + 1) + '- note: ' + node.note.replace(/\n/g, ' / '));
  }
  return lines.join('\n');
}
/** The node's path from the root and its own subtree: what a companion is told when it is dispatched on a node. Nothing else of the plan. */
export function pathAndSubtree(plan: DerivedPlan, id: string): string {
  const byId = new Map(plan.nodes.map(node => [node.id, node] as const));
  const lines: string[] = [];
  const path: DerivedNode[] = [];
  for (let at: string | undefined = id; at !== undefined; at = parentOf(at)) {const node = byId.get(at); if (node) path.unshift(node);}
  path.forEach((node, index) => lines.push('  '.repeat(index) + nodeLine(node) + (node.id === id ? '  <- your task' : '')));
  for (const node of plan.nodes) if (isUnder(node.id, id)) lines.push('  '.repeat(depthOf(node.id) - 1) + nodeLine(node));
  return text.PLAN_CONTEXT_HEADING + '\n' + lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------- change feed
/** How a node looks to someone who was told about it: what a change of it means to the Director (progress states in between are not news). */
export function nodeSignature(node: DerivedNode): string {
  const news = node.status === 'done' || node.status === 'failed' || node.status === 'accepted' || node.status === 'abandoned' ? node.status : 'open';
  return JSON.stringify([node.title, node.owner, node.parent ?? '', news, node.acceptance.length]);
}
export function planDigest(plan: DerivedPlan): Map<string, string> {return new Map(plan.nodes.map(node => [node.id, nodeSignature(node)] as const));}

const CHANGE_LINES = 20;
/**
 * What changed in `plan` since `seen` (the signatures the reader was last told or wrote itself): one line per changed node, none for a node whose
 * progress merely moved between pending, ready, running and waiting. An empty list means nothing worth saying.
 */
export function planChanges(plan: DerivedPlan, seen: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];
  const now = planDigest(plan);
  for (const node of plan.nodes) {
    const before = seen.get(node.id);
    if (before === now.get(node.id)) continue;
    if (before === undefined) lines.push(`+ ${nodeLine(node)}` + (node.parent ? ` (under ${node.parent})` : ''));
    else {
      const [title, owner, , news] = JSON.parse(before) as [string, string, string, string];
      const status = node.status === 'done' || node.status === 'failed' || node.status === 'accepted' || node.status === 'abandoned' ? node.status : 'open';
      const parts = [status !== news ? (status === 'open' ? 'open again' : status) : '', title !== node.title ? `now "${node.title}"` : '', owner !== node.owner ? `now ${node.owner}'s` : ''].filter(Boolean);
      lines.push(`~ ${node.id} ${node.title}: ${parts.join(', ') || 'changed'}`);
    }
  }
  for (const id of seen.keys()) if (!now.has(id)) lines.push(`- ${id} removed`);
  return lines.length > CHANGE_LINES ? [...lines.slice(0, CHANGE_LINES), text.planChangesMore(lines.length - CHANGE_LINES)] : lines;
}
