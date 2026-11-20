/**
 * Model-facing text of the plan graph: refusals (each names its exact fix), the companion's `Plan context:` block, the Director's plan-change
 * update and the notes the plan files raise. The model (`src/runtime/plan.ts`) and the board (`src/store/plans.ts`) only fill the blanks.
 */
export const PLAN_ACCEPT_NEEDS_EVIDENCE = 'Accepting needs evidence: link the work or pass evidence.';
export const PLAN_CONTEXT_HEADING = 'Plan context:';
export const PLAN_NO_PLAN = 'There is no active plan. Fix: create one with {"op":"create","title":"...","nodes":[{"title":"...","owner":"techne"}]}.';
export const PLAN_UNAVAILABLE = 'Plans are not available in this setup.';
export const PLAN_EMPTY_CALL = 'There is no plan yet. Create one with {"op":"create","title":"...","nodes":[{"title":"...","owner":"techne"}]} when the request has more than one piece of work.';
export const PLAN_ONLY_DIRECTOR_CREATES = 'Only the Director creates a plan. Fix: ask the Director (SendMessage) or split the node you own into sub-steps with add.';
export const PLAN_ONLY_DIRECTOR_WHOLE = 'Only the Director changes the whole plan. Fix: ask the Director (SendMessage).';

export const planAlreadyActive = (id: string, title: string) =>
  `A plan is already active (${id} "${title}"). Fix: change it with add, update or remove, or end it first with {"op":"abandon"}.`;
export const planClosed = (id: string, status: string) =>
  status === 'abandoned' ? `Plan ${id} was abandoned. Fix: create a new plan with {"op":"create",...}.` : `Plan ${id} is ${status}.`;
export const planUnknownNode = (id: string, known: readonly string[]) =>
  `Unknown node "${id}". Fix: use an id of the current plan (${known.slice(0, 12).join(', ')}${known.length > 12 ? ', ...' : ''}); call Plan with no arguments to see it.`;
export const planTooDeep = (id: string) =>
  `A node cannot sit deeper than 3 levels (1.2.3 is the deepest); "${id}" would be too deep. Fix: add it as a sibling under the level-2 node, or split the work differently.`;
export const planNotYours = (id: string, owner: string) =>
  `Node ${id} is not under a node you own (it belongs to ${owner}). Fix: work under a node you own, or ask the Director (SendMessage) to change it.`;
export const planOwnNode = (id: string) =>
  `Only your own note can change on node ${id}, which you own. Fix: use update with note, or add sub-steps under it.`;
export const planOwnerChoice = (actor: string, owner: string) =>
  `Sub-steps you add can belong to you or to automa, not to "${owner}". Fix: use owner "${actor}" or "automa".`;
export const planUnknownOwner = (owner: string, known: readonly string[]) =>
  `Unknown owner "${owner}". Fix: use an actor id (${known.join(', ')}) or "automa".`;
export const planCannotAcceptOwn = (id: string, parent: string | undefined, parentOwner: string | undefined) =>
  parent ? `You cannot accept your own node ${id}: ${parentOwner ?? 'its parent owner'} (owner of ${parent}) accepts it. Fix: report your result; they accept it on evidence.`
    : `Only the Director accepts top-level node ${id}. Fix: report your result; the Director accepts it on evidence.`;
export const planCannotAccept = (id: string, parent: string | undefined, parentOwner: string | undefined) =>
  parent ? `Only the owner of ${parent} (${parentOwner ?? 'its owner'}) or the Director can accept or reopen ${id}. Fix: report to them instead.` : planCannotAcceptOwn(id, undefined, undefined);
export const planAbandonedNode = (id: string) => `Node ${id} is abandoned. Fix: reopen it first with {"op":"reopen","id":"${id}"}.`;
export const planRemoveRunning = (id: string, active: readonly string[]) =>
  `Node ${id} has linked work in progress (${active.join(', ')}). Fix: stop that work first (CancelActor for an actor task), then remove the node; or abandon it once the work ended.`;
export const planUnknownAfter = (id: string, ref: string) =>
  `Node ${id} waits for unknown node "${ref}". Fix: after takes node ids of this plan (for example "1.1").`;
export const planAfterSelf = (id: string) => `Node ${id} cannot wait for itself. Fix: remove it from after.`;
export const planAfterCycle = (path: readonly string[]) =>
  `after would make nodes wait for each other (${path.join(' -> ')}). Fix: drop one of these dependencies.`;
export const planBadOp = (op: string, need: string) => `Plan op "${op}" needs ${need}. Fix: send it with that field.`;
export const planEmptyTitle = 'A node needs a title. Fix: give each node a short title.';
export const planOpFailed = (index: number, op: string, error: string) => `Op ${index + 1} (${op}) was refused: ${error} Nothing was applied.`;
export const planUnknownLinkNode = (id: string, known: readonly string[]) =>
  known.length ? `Unknown plan node "${id}". Fix: pass a node id of the active plan (${known.slice(0, 12).join(', ')}${known.length > 12 ? ', ...' : ''}) or omit node.`
    : `Unknown plan node "${id}": there is no active plan. Fix: create one with Plan first, or omit node.`;

/** The Director's update when somebody else changed the plan: only changed nodes. */
export const planChangesHeader = (id: string, title: string) => `Plan ${id} "${title}": changes made by others since you last looked (changed nodes only; call Plan with no arguments for the whole plan).`;
export const planChangesMore = (count: number) => `... and ${count} more changed nodes.`;

/** What the file reader says about a line it could not read. */
export const planFileStray = (file: string, line: number, text: string) => `Plan file ${file} line ${line} was not understood and is kept as a note: ${text.length > 80 ? text.slice(0, 79) + '…' : text}`;
export const planFileNoTitle = (file: string) => `Plan file ${file} has no "# title" line and was ignored.`;
export const planFileReidentified = (file: string, id: string, why: string) => `Plan file ${file}: node ${id} ${why}.`;
export const planFileGone = (id: string) => `Plan ${id} was deleted on disk and is no longer tracked.`;
