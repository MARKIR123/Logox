/**
 * The plan as a Markdown file people read and edit (`<project>/.logox/plans/<id>.md`): `renderPlan()` and `parsePlan()` round-trip, and
 * `mergePlans()` combines a runtime change with an edit made on disk without losing either. Visible text (titles, owners, acceptance lines, notes,
 * checkboxes) is the person's; ids, prerequisites, links and acceptance marks live in HTML comments that stay fixed and win over anything the visible
 * text suggests. Pure: reading and writing the file belongs to `src/store/plans.ts`.
 *
 *     # Add a theme preview page <!-- plan:p7 status:active session:<id> created:<iso> updated:<iso> -->
 *
 *     ## 1 Design <!-- n:1 owner:logox -->
 *     - [x] 1.1 Sample rows and palette — kalon <!-- n:1.1 owner:kalon links:act_123 accepted:logox@<iso> -->
 *       - acceptance: contrast of every text pair ≥ 4.5
 *       - evidence: src/tui/panels/theme-sample.ts changed
 *     - [ ] 1.2 Contrast algorithm — aletheia <!-- n:1.2 owner:aletheia after:1.1 -->
 */
import {DIRECTOR_ID} from './director-id.js';
import {PLAN_MAX_DEPTH, cleanTitle, compareIds, depthOf, isValidId, parentOf, settlePlan, sortNodes, type Plan, type PlanLink, type PlanNode, type PlanStatus} from './plan.js';
import {planFileNoTitle, planFileReidentified, planFileStray} from '../prompts/runtime/plan.js';

const iso = (time: number) => new Date(time).toISOString();
const attrs = (comment: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const token of comment.trim().split(/\s+/)) {
    const at = token.indexOf(':');
    if (at > 0) found.set(token.slice(0, at), token.slice(at + 1));
  }
  return found;
};
const safeDecode = (value: string) => {try {return decodeURIComponent(value);} catch {return value;}};
const linkToken = (link: PlanLink) => link.automaJob ?? link.activityId ?? '';

// ---------------------------------------------------------------------------------------------------------------------------------- render
export function renderPlan(plan: Plan): string {
  const out: string[] = [`# ${plan.title} <!-- plan:${plan.id} status:${plan.status} session:${encodeURIComponent(plan.sessionId)} created:${iso(plan.createdAt)} updated:${iso(plan.updatedAt)} -->`];
  for (const line of (plan.note ?? '').split('\n').filter(Boolean)) out.push('- note: ' + line);
  for (const node of sortNodes(plan.nodes)) {
    const depth = depthOf(node.id);
    const comment = ['n:' + node.id, 'owner:' + node.owner, ...node.after.length ? ['after:' + node.after.join(',')] : [], ...node.links.length ? ['links:' + node.links.map(linkToken).join(',')] : [],
      ...node.accepted ? [`accepted:${node.accepted.by}@${iso(node.accepted.at)}`] : [], ...node.abandoned ? ['abandoned:1'] : []].join(' ');
    let pad = '';
    if (depth === 1) {out.push('', `## ${node.id} ${node.title} <!-- ${comment} -->`);}
    else {
      pad = '  '.repeat(depth - 2);
      out.push(`${pad}- [${node.abandoned ? '-' : node.accepted ? 'x' : ' '}] ${node.id} ${node.title} — ${node.owner} <!-- ${comment} -->`);
    }
    const detail = depth === 1 ? '' : pad + '  ';
    for (const item of node.acceptance) out.push(`${detail}- acceptance: ${item}`);
    for (const item of node.accepted?.evidence ?? []) out.push(`${detail}- evidence: ${item}`);
    for (const line of (node.note ?? '').split('\n').filter(Boolean)) out.push(`${detail}- note: ${line}`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------------------------- parse
interface RawNode {
  depth: number; id: string | undefined; title: string; owner: string | undefined; attrs: Map<string, string>; checked: boolean; abandoned: boolean;
  acceptance: string[]; evidence: string[]; notes: string[];
}
export interface ParsedPlan {
  /** Absent when the file has no title line. */
  readonly plan: Plan | undefined;
  /** What could not be read as intended; each is reported once as a notice. */
  readonly issues: readonly string[];
  /** The file holds something the writer would change (new ids, lines kept as notes): it should be written back. */
  readonly normalized: boolean;
}

const COMMENT = /^(.*?)\s*<!--\s*([\s\S]*?)\s*-->\s*$/;
const split = (line: string): {text: string; comment: Map<string, string>} => {
  const match = COMMENT.exec(line);
  return match ? {text: match[1]!.trim(), comment: attrs(match[2]!)} : {text: line.trim(), comment: new Map()};
};
const OWNER_SUFFIX = /^(.*\S)\s+—\s+([A-Za-z][\w.-]*)$/;

export function parsePlan(source: string, file: string, now = Date.now()): ParsedPlan {
  const issues: string[] = [];
  let normalized = false;
  const lines = source.replace(/^﻿/, '').split(/\r?\n/);
  const first = lines.findIndex(line => line.trim());
  const head = first < 0 ? undefined : /^#\s+(?!#)(.*)$/.exec(lines[first]!);
  if (!head) return {plan: undefined, issues: [planFileNoTitle(file)], normalized: false};
  const {text: title, comment: top} = split(head[1]!);
  const planNotes: string[] = [];
  const raws: RawNode[] = [];
  const stray = (index: number, line: string) => {
    issues.push(planFileStray(file, index + 1, line.trim())); normalized = true;
    (raws.at(-1)?.notes ?? planNotes).push(line.trim());
  };
  for (let index = first + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const heading = /^##\s+(.*)$/.exec(line);
    const item = /^(\s*)- \[([ xX-])\]\s+(.*)$/.exec(line);
    const detail = /^\s*- (acceptance|evidence|note):\s?(.*)$/.exec(line);
    if (heading || item) {
      const body = split(heading ? heading[1]! : item![3]!);
      const idMatch = /^(\d+(?:\.\d+)*)\s+(.*)$/.exec(body.text);
      let text = (idMatch ? idMatch[2]! : body.text), owner: string | undefined;
      const suffix = OWNER_SUFFIX.exec(text);
      if (suffix) {text = suffix[1]!; owner = suffix[2]!;}
      const comment = body.comment;
      const claimed = comment.get('n') ?? idMatch?.[1];
      const mark = item?.[2] ?? ' ';
      const indent = item ? item[1]!.length : 0;
      // A top-level heading has no box: its acceptance is the mark in its comment.
      raws.push({depth: heading ? 1 : indent >= 2 ? 3 : 2, id: claimed, title: cleanTitle(text) || '(untitled)', owner: owner ?? comment.get('owner'), attrs: comment,
        checked: heading ? comment.has('accepted') : mark === 'x' || mark === 'X',
        abandoned: mark === '-' || comment.has('abandoned'), acceptance: [], evidence: [], notes: []});
    } else if (detail) {
      const target = raws.at(-1);
      const value = detail[2]!.trim();
      if (!value) continue;
      if (detail[1] === 'acceptance') (target?.acceptance ?? planNotes).push(value);
      else if (detail[1] === 'evidence') (target?.evidence ?? planNotes).push(value);
      else (target?.notes ?? planNotes).push(value);
      if (!target && detail[1] !== 'note') {issues.push(planFileStray(file, index + 1, line.trim())); normalized = true;}
    } else stray(index, line);
  }

  // Ids: a claimed id stays when it is well formed, unique and shallow enough; the rest are assigned from the structure (the nearest shallower node above).
  const reserved = new Set<string>(), claimedOnce = new Set<string>();
  for (const raw of raws) {
    if (raw.id && isValidId(raw.id) && depthOf(raw.id) <= PLAN_MAX_DEPTH && !claimedOnce.has(raw.id)) {claimedOnce.add(raw.id); reserved.add(raw.id);}
    else if (raw.id) raw.id = undefined;
  }
  const assigned = new Set<string>(), nodes: PlanNode[] = [], stack: (PlanNode | undefined)[] = [];
  const nextId = (parent: string | undefined): string => {
    let max = 0;
    for (const id of [...reserved, ...assigned]) if (parentOf(id) === parent) max = Math.max(max, Number(id.slice(parent === undefined ? 0 : parent.length + 1)) || 0);
    return (parent === undefined ? '' : parent + '.') + (max + 1);
  };
  for (const raw of raws) {
    let depth = Math.min(raw.depth, PLAN_MAX_DEPTH), parent: PlanNode | undefined;
    if (depth > 1) {
      let at = depth - 1;
      while (at > 1 && !stack[at]) at--;
      parent = stack[at];
      depth = parent ? at + 1 : 1;
    }
    let id = raw.id;
    // A claimed id whose parent id is missing from the file cannot hang anywhere: it is assigned again.
    if (id && depthOf(id) > 1 && !reserved.has(parentOf(id)!)) {issues.push(planFileReidentified(file, id, 'lost its parent and was given a new id')); id = undefined;}
    if (!id) {id = nextId(parent?.id); normalized = true;}
    assigned.add(id);
    const links: PlanLink[] = (raw.attrs.get('links') ?? '').split(',').filter(Boolean).map(token => token.includes('/') ? {automaJob: token} : {activityId: token});
    const after = (raw.attrs.get('after') ?? '').split(',').filter(Boolean);
    const acceptedAttr = raw.attrs.get('accepted'), at = acceptedAttr ? acceptedAttr.lastIndexOf('@') : -1;
    let accepted: PlanNode['accepted'];
    if (raw.checked && !raw.abandoned) {
      const stamp = at > 0 ? Date.parse(acceptedAttr!.slice(at + 1)) : NaN;
      accepted = acceptedAttr ? {by: at > 0 ? acceptedAttr.slice(0, at) : acceptedAttr, at: Number.isNaN(stamp) ? now : stamp, evidence: raw.evidence}
        // A person ticked the box: that is an acceptance by the person.
        : {by: 'user', at: now, evidence: raw.evidence.length ? raw.evidence : ['Marked done in the plan file.']};
    }
    const note = raw.notes.join('\n');
    const node: PlanNode = {id, title: raw.title, owner: raw.owner ?? parent?.owner ?? DIRECTOR_ID, after, acceptance: raw.acceptance, links,
      ...(accepted ? {accepted} : {}), ...(raw.abandoned ? {abandoned: true} : {}), ...(note ? {note} : {})};
    nodes.push(node);
    stack[depth] = node;
    for (let deeper = depth + 1; deeper <= PLAN_MAX_DEPTH; deeper++) stack[deeper] = undefined;
  }

  // Prerequisites: unknown ids are dropped, and nodes caught in a cycle lose theirs, so a hand-edited file can never loop the runtime.
  const ids = new Set(nodes.map(node => node.id));
  let fixed = nodes.map(node => {
    const kept = node.after.filter(ref => ids.has(ref) && ref !== node.id);
    if (kept.length !== node.after.length) normalized = true;
    return kept.length === node.after.length ? node : {...node, after: kept};
  });
  const pending = new Map(fixed.map(node => [node.id, new Set(node.after)] as const));
  for (let progress = true; progress && pending.size;) {
    progress = false;
    for (const [id, needs] of pending) if ([...needs].every(ref => !pending.has(ref))) {pending.delete(id); progress = true;}
  }
  if (pending.size) {
    normalized = true;
    fixed = fixed.map(node => pending.has(node.id) && node.after.length ? {...node, after: []} : node);
    issues.push(planFileReidentified(file, [...pending.keys()].sort(compareIds).join(', '), 'waited on each other in a cycle; the prerequisites were dropped'));
  }

  const status = (['active', 'done', 'abandoned'] as const).find(item => item === top.get('status')) ?? 'active';
  const created = Date.parse(top.get('created') ?? ''), updated = Date.parse(top.get('updated') ?? '');
  const id = top.get('plan') ?? file.replace(/^.*[\\/]/, '').replace(/\.md$/, '');
  if (!top.get('plan')) normalized = true;
  const plan: Plan = {id, title: cleanTitle(title) || '(untitled plan)', status: status as PlanStatus, createdAt: Number.isNaN(created) ? now : created,
    updatedAt: Number.isNaN(updated) ? Number.isNaN(created) ? now : created : updated, sessionId: safeDecode(top.get('session') ?? ''), nodes: sortNodes(fixed),
    ...(planNotes.length ? {note: planNotes.join('\n')} : {})};
  return {plan, issues, normalized};
}

// ---------------------------------------------------------------------------------------------------------------------------------- merge
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Visible text: the person's edit wins when the file differs from what was last synced, else the runtime's value. Runtime fields: the other way round. */
const visible = <T>(base: T | undefined, memory: T, file: T): T => !same(file, base) ? file : memory;
const runtime = <T>(base: T | undefined, memory: T, file: T): T => !same(memory, base) ? memory : file;

/**
 * Three-way merge of a plan: `base` is what was last read from or written to the file, `memory` is what the runtime holds now, `file` is what is on disk now.
 * A node the person added stays, a node the person deleted goes, a node the runtime added stays; per field, titles, owners, acceptance lines and notes come
 * from the file when the person changed them and ids, prerequisites, links and acceptance marks from memory when the runtime changed them.
 */
export function mergePlans(base: Plan | undefined, memory: Plan, file: Plan): Plan {
  const byId = (plan: Plan | undefined) => new Map((plan?.nodes ?? []).map(node => [node.id, node] as const));
  const b = byId(base), m = byId(memory), f = byId(file);
  const out: PlanNode[] = [];
  for (const id of new Set([...f.keys(), ...m.keys()])) {
    const baseNode = b.get(id), mem = m.get(id), disk = f.get(id);
    if (!disk) {
      // Only the runtime has it: a runtime addition stays; a node the person deleted (it was in the last sync) goes.
      if (mem && !baseNode) out.push(mem);
      continue;
    }
    if (!mem) {
      // Only the file has it: a node the person added stays; one the runtime removed stays only if the person edited it since.
      if (!baseNode || !same(baseNode, disk)) out.push(disk);
      continue;
    }
    const node: PlanNode = {id, title: visible(baseNode?.title, mem.title, disk.title), owner: visible(baseNode?.owner, mem.owner, disk.owner),
      acceptance: visible(baseNode?.acceptance, mem.acceptance, disk.acceptance), after: runtime(baseNode?.after, mem.after, disk.after),
      links: runtime(baseNode?.links, mem.links, disk.links),
      ...pick('accepted', runtime(baseNode?.accepted, mem.accepted, disk.accepted)), ...pick('abandoned', runtime(baseNode?.abandoned, mem.abandoned, disk.abandoned)),
      ...pick('note', visible(baseNode?.note, mem.note, disk.note))};
    out.push(node);
  }
  const alive = new Set(out.map(node => node.id));
  const nodes = sortNodes(out).map(node => node.after.some(ref => !alive.has(ref)) ? {...node, after: node.after.filter(ref => alive.has(ref))} : node);
  const merged: Plan = {...memory, title: visible(base?.title, memory.title, file.title), status: runtime(base?.status, memory.status, file.status),
    updatedAt: Math.max(memory.updatedAt, file.updatedAt), nodes, ...pick('note', visible(base?.note, memory.note, file.note))};
  return settlePlan(merged);
}
function pick<K extends string, V>(key: K, value: V | undefined): {[P in K]?: V} {
  return value === undefined || value === false ? {} : {[key]: value} as {[P in K]?: V};
}
