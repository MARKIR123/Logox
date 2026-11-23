import {z} from 'zod';
import type {ToolResult} from '../../types.js';
import {PLAN_UNAVAILABLE, planBadOp} from '../../../prompts/runtime/plan.js';
import type {NewNode, PlanOp} from '../../../runtime/plan.js';
import type {PlanApply} from '../../../store/plans.js';
import {dropEmpty, isDict, onlyFields, type Dict} from '../../filler.js';

const leaf = z.strictObject({
  title: z.string().trim().min(1).max(160).describe('Short title'),
  owner: z.string().trim().min(1).optional().describe('Actor id, or "automa"; defaults to you'),
  after: z.array(z.string().trim().min(1)).max(8).optional().describe('Node ids that must be accepted first'),
  acceptance: z.array(z.string().trim().min(1).max(400)).max(12).optional().describe('Checks that define done'),
});
const child = leaf.extend({nodes: z.array(leaf).max(12).optional().describe('Sub-nodes (third level)')});
const node = leaf.extend({nodes: z.array(child).max(12).optional().describe('Sub-nodes (second level)')});

const fields = {
  title: z.string().trim().min(1).max(160).optional().describe('create: the plan title; update: the new node title'),
  nodes: z.array(node).max(20).optional().describe('create: top-level nodes; add: nodes to add under parent'),
  parent: z.string().trim().min(1).optional().describe('add: node id to add under; omit for top level (Director)'),
  id: z.string().trim().min(1).optional().describe('update, remove, accept, reopen, abandon: the node id'),
  owner: z.string().trim().min(1).optional().describe('update: the new owner'),
  after: z.array(z.string().trim().min(1)).max(8).optional().describe('update: replaces the prerequisites'),
  acceptance: z.array(z.string().trim().min(1).max(400)).max(12).optional().describe('update: replaces the acceptance checks'),
  note: z.string().max(1000).optional().describe('update: a note on the node; empty clears it'),
  evidence: z.array(z.string().trim().min(1).max(400)).max(20).optional().describe('accept: what shows it is done; omit to use the record of the linked work'),
};
const OPS = ['create', 'add', 'update', 'remove', 'accept', 'reopen', 'abandon'] as const;
export const planOpSchema = z.strictObject({op: z.enum(OPS).describe('create, add, update, remove, accept, reopen or abandon (the whole plan without id)'), ...fields});
export const planSchema = z.strictObject({
  op: z.enum(OPS).optional().describe('One op; omit op and ops to read the current plan'),
  ...fields,
  ops: z.array(planOpSchema).max(20).optional().describe('Several ops applied in order, all or none'),
});
export type PlanArgs = z.infer<typeof planSchema>;

/** The one table of which fields each op uses; every other field of a call is ignored, whatever its value. Mirrors `toPlanOp()`. */
export const PLAN_OP_FIELDS = {
  create: ['title', 'nodes'],
  add: ['parent', 'nodes'],
  update: ['id', 'title', 'owner', 'after', 'acceptance', 'note'],
  remove: ['id'],
  accept: ['id', 'evidence'],
  reopen: ['id'],
  abandon: ['id'],
} as const satisfies Record<typeof OPS[number], readonly string[]>;
const NODE_FIELDS = ['title', 'owner', 'after', 'acceptance', 'nodes'] as const;
/** Update fields where an empty value is a real request (clear the note, drop the prerequisites or checks) when nothing else is being changed. */
const CLEARABLE = ['note', 'after', 'acceptance'] as const;

const normalNodes = (value: unknown): unknown => Array.isArray(value)
  ? value.map(item => {
    if (!isDict(item)) return item;
    const next = dropEmpty(onlyFields(item, NODE_FIELDS));
    if (next.nodes !== undefined) next.nodes = normalNodes(next.nodes);
    return next;
  })
  : value;

/** One op without its filler: only the fields its op uses, and only those with a value. An unknown op is left for the schema to refuse. */
function normalOp(item: unknown): unknown {
  if (!isDict(item)) return item;
  const op = typeof item.op === 'string' ? item.op.trim() : item.op;
  if (typeof op !== 'string' || !Object.hasOwn(PLAN_OP_FIELDS, op)) return dropEmpty(item);
  const fields = PLAN_OP_FIELDS[op as keyof typeof PLAN_OP_FIELDS];
  const next = dropEmpty(onlyFields(item, fields));
  if (op === 'update' && !['title', 'owner', 'after', 'acceptance', 'note'].some(key => next[key] !== undefined)) {
    for (const key of CLEARABLE) if (item[key] === '' || (Array.isArray(item[key]) && !(item[key] as unknown[]).length)) next[key] = item[key];
  }
  if (next.nodes !== undefined) next.nodes = normalNodes(next.nodes);
  return {op, ...next};
}

/**
 * Plan input as the model meant it: empty values (`[]`, `""`, `null`) are absent, `ops: []` is absent, and each op keeps only its own fields
 * (`PLAN_OP_FIELDS`), so filler such as `"x"` in an unused field never refuses a call. Idempotent.
 */
export function normalizePlanInput(input: unknown): unknown {
  if (!isDict(input)) return input;
  const top = dropEmpty(input);
  const ops = Array.isArray(top.ops) ? top.ops.map(normalOp) : top.ops;
  if (top.op === undefined) return ops === undefined ? top : {...top, ops};
  const single = normalOp(input) as Dict; // from the raw input: a bare update may mean "clear" with an empty value
  return ops === undefined ? single : {...single, ops};
}

const nodes = (items: readonly z.infer<typeof node>[]): NewNode[] => items.map(item => ({title: item.title, owner: item.owner, after: item.after, acceptance: item.acceptance,
  ...(item.nodes ? {nodes: nodes(item.nodes as z.infer<typeof node>[])} : {})}));

/** One op as written in the tool call; a string is the refusal with its fix. */
export function toPlanOp(input: z.infer<typeof planOpSchema>): PlanOp | string {
  switch (input.op) {
    case 'create': return input.title ? {op: 'create', title: input.title, ...(input.nodes ? {nodes: nodes(input.nodes)} : {})} : planBadOp('create', 'title');
    case 'add': return input.nodes?.length ? {op: 'add', parent: input.parent, nodes: nodes(input.nodes)} : planBadOp('add', 'nodes');
    case 'update': return input.id ? {op: 'update', id: input.id, title: input.title, owner: input.owner, after: input.after, acceptance: input.acceptance, note: input.note} : planBadOp('update', 'id');
    case 'remove': return input.id ? {op: 'remove', id: input.id} : planBadOp('remove', 'id');
    case 'accept': return input.id ? {op: 'accept', id: input.id, evidence: input.evidence} : planBadOp('accept', 'id');
    case 'reopen': return input.id ? {op: 'reopen', id: input.id} : planBadOp('reopen', 'id');
    case 'abandon': return {op: 'abandon', id: input.id};
  }
}

/** What the tool needs of the board: the outline of the plan, and applying ops as an actor. */
export interface PlanToolHost {
  describe(): string;
  apply(ops: readonly PlanOp[], actor: string): Promise<PlanApply>;
}

export async function executePlan(args: PlanArgs, context: {caller: string; board: PlanToolHost | undefined}): Promise<ToolResult> {
  const {board} = context;
  if (!board) return {text: PLAN_UNAVAILABLE, isError: true};
  const {ops, ...single} = normalizePlanInput(args) as PlanArgs;
  if (ops && single.op) return {text: `Send either op or ops, not both: op is "${single.op}" and ops holds ${ops.length} op${ops.length === 1 ? '' : 's'}. Fix: delete op and put every op, including this one, in ops.`, isError: true};
  if (!single.op && !ops) {
    const given = Object.keys(single);
    if (given.length) return {text: `${planBadOp('(none)', 'op')} Fields received without op: ${given.map(key => `${key}=${JSON.stringify(single[key as keyof typeof single])}`).join(', ').slice(0, 300)}.`, isError: true};
    return {text: board.describe(), isError: false};
  }
  const list = ops ?? [{...single, op: single.op!}];
  const planned: PlanOp[] = [];
  for (const [index, item] of list.entries()) {
    const parsed = toPlanOp(item);
    if (typeof parsed === 'string') return {text: (list.length > 1 ? `Op ${index + 1} (${item.op}): ` : '') + parsed, isError: true};
    planned.push(parsed);
  }
  const result = await board.apply(planned, context.caller);
  if (!result.ok) return {text: result.error, isError: true};
  return {text: [...result.lines, `Plan ${result.plan.id} is ${result.plan.status}: ${result.plan.progress.accepted}/${result.plan.progress.total} top-level nodes accepted.`].join('\n'), isError: false};
}

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'Plan', category: 'coordination', loading: 'eager', roles: 'all', terminalVisibility: 'card', description: 'Maintain the plan for the current request'};
