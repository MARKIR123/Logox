/**
 * The plan board of one session: the plan files of the project (`<project>/.logox/plans/<id>.md`, for people to read and edit), the plans of this
 * session held in memory, and what each reader has been told. Everything that changes a plan goes through `apply()` (the `Plan` tool, `/plan`, the hub)
 * or `link()` (a dispatch carrying a node); both write the file atomically. The file is read again before each use, so a person's edit is honoured, and
 * when a runtime change meets a change made on disk the two are merged field by field (`mergePlans()`), never one over the other.
 *
 * Statuses are not stored: `plans()` derives them from the work records the application supplies (`derivePlan()`), memoised on the store revision.
 */
import {createHash} from 'node:crypto';
import {mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DIRECTOR_ID, isDirector} from '../runtime/director-id.js';
import {applyPlanOps, derivePlan, pathAndSubtree, planChanges, planDigest, renderOutline, type DerivedNode, type DerivedPlan, type Plan, type PlanLink, type PlanNode, type PlanOp, type PlanWork} from '../runtime/plan.js';
import {mergePlans, parsePlan, renderPlan} from '../runtime/plan-file.js';
import {PLAN_EMPTY_CALL, planChangesHeader, planFileGone, planUnknownLinkNode} from '../prompts/runtime/plan.js';
import {replaceFile} from './replace-file.js';

export interface PlanBoardOptions {
  readonly cwd: string;
  readonly sessionId: string;
  /** The work records nodes link to (`projectDelegations()` of the session). */
  readonly work: () => readonly PlanWork[];
  /** Changes whenever `work()` may answer differently (the store revision); it keys the memo of derived plans. */
  readonly workRevision?: () => number;
  /** Actor ids an owner may name. */
  readonly knownOwners?: () => readonly string[];
  /** The evidence the runtime can read from a node's finished linked work, for an `accept` without evidence. */
  readonly evidence?: (node: PlanNode) => Promise<readonly string[]>;
  /** Raised once per distinct problem with a plan file (an unreadable line, a deleted file, a failed write). */
  readonly notice?: (text: string) => void;
  readonly now?: () => number;
}
export type PlanApply =
  | {readonly ok: true; readonly lines: readonly string[]; readonly plan: DerivedPlan; readonly touched: readonly string[]}
  | {readonly ok: false; readonly error: string};
/** A plan of the project, in any session, as the plan switcher lists it. */
export interface PlanHeader {readonly id: string; readonly title: string; readonly status: Plan['status']; readonly sessionId: string; readonly updatedAt: number; readonly nodes: number; readonly current: boolean}

interface Entry {plan: Plan; /** The plan as last read from or written to the file. */ base: Plan; /** The file's text then; undefined while the file does not exist yet. */ text: string | undefined; readonly path: string}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class PlanBoard {
  readonly dir: string;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly told = new Set<string>();
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly peeked = new Map<string, Map<string, Map<string, string>>>();
  private readonly memo = new Map<string, {key: string; plan: DerivedPlan}>();
  private writes: Promise<void> = Promise.resolve();
  private chain: Promise<unknown> = Promise.resolve();
  private counter = 0;
  /** Bumped by every change of a plan's content (not by the progress of linked work, which `signature()` covers). */
  revision = 0;
  constructor(private readonly options: PlanBoardOptions) {
    this.dir = join(options.cwd, '.logox', 'plans');
  }
  private now(): number {return this.options.now?.() ?? Date.now();}
  private notify(text: string): void {
    if (this.told.has(text)) return;
    this.told.add(text);
    this.options.notice?.(text);
  }
  private changed(): void {
    this.revision++;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}

  // ------------------------------------------------------------------------------------------------------------------------------ files
  private diskText(path: string): string | undefined {
    try {return readFileSync(path, 'utf8');} catch {return undefined;}
  }
  /** Reads the plans of this session from the project folder; call once when the session starts or resumes. */
  async load(): Promise<void> {
    let names: string[] = [];
    try {names = (await readdir(this.dir)).filter(name => name.endsWith('.md'));} catch {return;}
    for (const name of names.sort()) {
      const path = join(this.dir, name);
      let text: string;
      try {text = await readFile(path, 'utf8');} catch {continue;}
      const parsed = parsePlan(text, name, this.now());
      for (const issue of parsed.issues) this.notify(issue);
      if (!parsed.plan || parsed.plan.sessionId !== this.options.sessionId || this.entries.has(parsed.plan.id)) continue;
      const entry: Entry = {plan: parsed.plan, base: parsed.plan, text, path};
      this.entries.set(parsed.plan.id, entry);
      // The Director starts from what the plan already says: only later changes are news.
      this.baseline(DIRECTOR_ID, this.derive(parsed.plan));
      if (parsed.normalized) void this.write(entry);
    }
    this.changed();
  }
  /**
   * Reconciles one entry with its file: an edit on disk is read, a runtime change not yet written is kept, both are merged. True when the file differs
   * from the merged plan and should be written.
   */
  private reconcile(entry: Entry): boolean {
    const disk = this.diskText(entry.path);
    if (disk === entry.text) return false;
    if (disk === undefined) return false;
    const parsed = parsePlan(disk, entry.path, this.now());
    for (const issue of parsed.issues) this.notify(issue);
    entry.text = disk;
    if (!parsed.plan) return false;
    const disc = parsed.plan;
    const merged = mergePlans(entry.base, entry.plan, {...disc, id: entry.plan.id, sessionId: entry.plan.sessionId});
    const differs = !same(merged, entry.plan);
    entry.plan = merged;
    entry.base = disc;
    if (differs) this.changed();
    return !same(merged, disc) || parsed.normalized;
  }
  /** Reads the files again before a use: edits made by people since the last use are honoured. */
  refresh(): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.text !== undefined && this.diskText(entry.path) === undefined) {
        this.entries.delete(id);
        this.notify(planFileGone(id));
        this.changed();
        continue;
      }
      if (this.reconcile(entry)) void this.write(entry);
    }
  }
  private write(entry: Entry): Promise<void> {
    const run = this.writes.then(async () => {
      await mkdir(this.dir, {recursive: true});
      for (let attempt = 0; attempt < 4; attempt++) {
        this.reconcile(entry);
        const body = renderPlan(entry.plan);
        if (body === entry.text) return;
        const temporary = `${entry.path}.${process.pid}.${++this.counter}.tmp`;
        await writeFile(temporary, body, 'utf8');
        // Somebody wrote the file while the temporary one was prepared: read that edit, merge, and render again.
        if (this.diskText(entry.path) !== entry.text) {await rm(temporary, {force: true}); continue;}
        await replaceFile(temporary, entry.path);
        entry.text = body;
        entry.base = parsePlan(body, entry.path, this.now()).plan ?? entry.plan;
        return;
      }
    });
    this.writes = run.catch(error => {this.notify('Could not write plan file ' + entry.path + ': ' + (error instanceof Error ? error.message : String(error)));});
    return this.writes;
  }
  /** Resolves when every write started so far has reached the disk. */
  flush(): Promise<void> {return this.writes;}

  // ------------------------------------------------------------------------------------------------------------------------------ reading
  private derive(plan: Plan): DerivedPlan {
    const key = this.revision + ':' + (this.options.workRevision?.() ?? 'x') + ':' + plan.updatedAt;
    const hit = this.memo.get(plan.id);
    if (hit?.key === key) return hit.plan;
    const derived = derivePlan(plan, this.options.work());
    this.memo.set(plan.id, {key, plan: derived});
    return derived;
  }
  /** The plans of this session, oldest first, with statuses derived from the linked work. */
  plans(): DerivedPlan[] {
    this.refresh();
    return [...this.entries.values()].map(entry => entry.plan).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(plan => this.derive(plan));
  }
  private activeEntry(): Entry | undefined {
    return [...this.entries.values()].filter(entry => entry.plan.status === 'active').sort((a, b) => b.plan.updatedAt - a.plan.updatedAt || b.plan.id.localeCompare(a.plan.id))[0];
  }
  private latestEntry(): Entry | undefined {
    return [...this.entries.values()].filter(entry => entry.plan.status !== 'abandoned').sort((a, b) => b.plan.updatedAt - a.plan.updatedAt || b.plan.id.localeCompare(a.plan.id))[0];
  }
  /** The current plan of the request: the session's most recently updated active plan. */
  active(): DerivedPlan | undefined {
    this.refresh();
    const entry = this.activeEntry();
    return entry ? this.derive(entry.plan) : undefined;
  }
  /**
   * The plan the sidebar draws: the active plan, else the session's latest one that was not abandoned (a finished plan stays readable). Unlike `active()` it never
   * reads the plan files, so a view may call it on every store change; derived statuses are memoised on the store revision. Edits made on disk reach it with the
   * next `refresh()` (any `Plan` call, `/plan`, or the sidebar being opened).
   */
  peek(): DerivedPlan | undefined {
    const entry = this.activeEntry() ?? this.latestEntry();
    return entry ? this.derive(entry.plan) : undefined;
  }
  /** What `Plan` with no arguments answers: the active plan (or else the latest of the session) as an outline. */
  describe(): string {
    const all = this.plans();
    const plan = all.findLast(item => item.status === 'active') ?? all.at(-1);
    return plan ? renderOutline(plan) : PLAN_EMPTY_CALL;
  }
  /** A signature of everything a viewer of the plans shows (statuses included); it changes when and only when the picture does. */
  signature(): string {
    return JSON.stringify(this.plans().map(plan => [plan.id, plan.title, plan.status, plan.nodes.map(node => [node.id, node.title, node.owner, node.status, node.accepted ? 1 : 0, node.links.length, node.after.join(',')])]));
  }
  /** Every plan file of the project, any session: the plan switcher's list. Read-only apart from `adopt()`. */
  async projectPlans(): Promise<PlanHeader[]> {
    let names: string[] = [];
    try {names = (await readdir(this.dir)).filter(name => name.endsWith('.md'));} catch {return [];}
    const headers: PlanHeader[] = [];
    for (const name of names) {
      let text: string;
      try {text = await readFile(join(this.dir, name), 'utf8');} catch {continue;}
      const parsed = parsePlan(text, name, this.now()).plan;
      if (!parsed) continue;
      const live = this.entries.get(parsed.id)?.plan ?? parsed;
      headers.push({id: live.id, title: live.title, status: live.status, sessionId: live.sessionId, updatedAt: live.updatedAt, nodes: live.nodes.length, current: live.sessionId === this.options.sessionId});
    }
    return headers.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  }
  /** One plan of the project for reading: this session's with live statuses, another session's as the file holds it (explicit marks only). */
  async view(id: string): Promise<DerivedPlan | undefined> {
    this.refresh();
    const mine = this.entries.get(id);
    if (mine) return this.derive(mine.plan);
    const text = await readFile(join(this.dir, id + '.md'), 'utf8').catch(() => undefined);
    const parsed = text === undefined ? undefined : parsePlan(text, id + '.md', this.now()).plan;
    return parsed ? derivePlan(parsed, []) : undefined;
  }

  // ------------------------------------------------------------------------------------------------------------------------------ changing
  private nextPlanId(): string {
    let max = 0;
    const take = (name: string) => {const match = /^p(\d+)(?:\.md)?$/.exec(name); if (match) max = Math.max(max, Number(match[1]));};
    for (const id of this.entries.keys()) take(id);
    try {for (const name of readdirSync(this.dir)) take(name);} catch {}
    return 'p' + (max + 1);
  }
  /**
   * Applies ops for `actor`, atomically, and writes the file. `accept` without evidence is given the evidence the runtime reads from the node's linked work.
   * The Director (and the person) own what they changed: it is not reported back to them later.
   */
  apply(ops: readonly PlanOp[], actor: string): Promise<PlanApply> {
    const run = this.chain.then(async (): Promise<PlanApply> => {
      this.refresh();
      const entry = this.activeEntry() ?? this.latestEntry();
      const derived = entry ? this.derive(entry.plan) : undefined;
      const evidence = new Map<string, readonly string[]>();
      if (entry) for (const op of ops) if (op.op === 'accept' && !op.evidence?.length) {
        const node = entry.plan.nodes.find(item => item.id === op.id);
        if (node && this.options.evidence) evidence.set(node.id, await this.options.evidence(node).catch(() => []));
      }
      const byId = new Map((derived?.nodes ?? []).map(node => [node.id, node] as const));
      const result = applyPlanOps(entry?.plan, ops, actor, {now: this.now(), sessionId: this.options.sessionId, planId: () => this.nextPlanId(),
        ...(this.options.knownOwners ? {knownOwners: this.options.knownOwners()} : {}),
        status: id => byId.get(id)?.status, evidence: id => evidence.get(id), active: id => byId.get(id)?.work.filter(item => item.phase === 'running' || item.phase === 'waiting').map(item => item.id) ?? []});
      if (!result.ok) return result;
      const target: Entry = this.entries.get(result.plan.id) ?? {plan: result.plan, base: result.plan, text: undefined, path: join(this.dir, result.plan.id + '.md')};
      target.plan = result.plan;
      this.entries.set(result.plan.id, target);
      this.changed();
      await this.write(target);
      const next = this.derive(target.plan);
      this.acknowledge(actor, next, result.touched);
      return {ok: true, lines: result.lines, plan: next, touched: result.touched};
    });
    this.chain = run.catch(() => {});
    return run;
  }
  /** The refusal (with its fix) for a dispatch that names a node the active plan does not have, else undefined. */
  check(nodeId: string): string | undefined {
    this.refresh();
    const entry = this.activeEntry();
    if (entry?.plan.nodes.some(node => node.id === nodeId)) return undefined;
    return planUnknownLinkNode(nodeId, entry ? entry.plan.nodes.map(node => node.id) : []);
  }
  /** Records the work a dispatch started for a node; the node's status follows it from then on. */
  link(nodeId: string, link: PlanLink): void {
    const entry = this.activeEntry();
    const node = entry?.plan.nodes.find(item => item.id === nodeId);
    if (!entry || !node) return;
    const token = link.automaJob ?? link.activityId;
    if (node.links.some(existing => (existing.automaJob ?? existing.activityId) === token)) return;
    entry.plan = {...entry.plan, updatedAt: this.now(), nodes: entry.plan.nodes.map(item => item.id === nodeId ? {...item, links: [...item.links, link]} : item)};
    this.changed();
    void this.write(entry);
  }
  /** Re-activates a plan of an earlier session in this one (it becomes this session's plan); refused while another plan is active. */
  async adopt(id: string): Promise<{ok: true} | {ok: false; error: string}> {
    this.refresh();
    if (this.entries.has(id)) return {ok: true};
    const active = this.activeEntry();
    if (active) return {ok: false, error: `Plan ${active.plan.id} is active in this session. Abandon it first.`};
    const path = join(this.dir, id + '.md');
    const text = await readFile(path, 'utf8').catch(() => undefined);
    const parsed = text === undefined ? undefined : parsePlan(text, id + '.md', this.now()).plan;
    if (!parsed) return {ok: false, error: `No readable plan ${id} in ${this.dir}.`};
    const plan: Plan = {...parsed, sessionId: this.options.sessionId, status: parsed.status === 'abandoned' ? 'abandoned' : 'active', updatedAt: this.now()};
    if (plan.status === 'abandoned') return {ok: false, error: `Plan ${id} was abandoned and cannot be re-activated.`};
    const entry: Entry = {plan, base: parsed, text, path};
    this.entries.set(id, entry);
    this.changed();
    await this.write(entry);
    return {ok: true};
  }

  // ------------------------------------------------------------------------------------------------------------------------------ what readers know
  private baseline(actor: string, plan: DerivedPlan): Map<string, string> {
    const key = actor + '\0' + plan.id;
    const known = this.seen.get(key);
    if (known) return known;
    const digest = planDigest(plan);
    this.seen.set(key, digest);
    return digest;
  }
  /** The actor wrote these nodes itself: what it changed is not news to it. */
  private acknowledge(actor: string, plan: DerivedPlan, touched: readonly string[]): void {
    const known = this.baseline(actor, plan), now = planDigest(plan);
    for (const id of touched) {const signature = now.get(id); if (signature === undefined) known.delete(id); else known.set(id, signature);}
  }
  /**
   * What others changed in the plans of this session since the Director last looked: one block of changed nodes, or nothing. The text is a
   * proposal; `commit()` with its token records that it reached the model, so building the same request twice tells nothing twice.
   */
  peekChanges(actor: string): {readonly text: string; readonly token: string} | undefined {
    if (!isDirector(actor)) return undefined;
    const blocks: string[] = [], pending = new Map<string, Map<string, string>>();
    for (const plan of this.plans()) {
      if (plan.status === 'abandoned') continue;
      const known = this.baseline(actor, plan);
      const lines = planChanges(plan, known);
      if (!lines.length) continue;
      blocks.push([planChangesHeader(plan.id, plan.title), ...lines].join('\n'));
      pending.set(plan.id, planDigest(plan));
    }
    if (!blocks.length) return undefined;
    const text = blocks.join('\n\n'), token = createHash('sha1').update(text).digest('hex').slice(0, 12);
    this.peeked.set(actor + '\0' + token, pending);
    if (this.peeked.size > 16) this.peeked.delete(this.peeked.keys().next().value!);
    return {text, token};
  }
  /** The model has the update `peekChanges()` returned under `token`. */
  commit(actor: string, token: string): void {
    const pending = this.peeked.get(actor + '\0' + token);
    if (!pending) return;
    this.peeked.delete(actor + '\0' + token);
    for (const [planId, digest] of pending) this.seen.set(actor + '\0' + planId, digest);
  }
  /** One node of the active plan, as derived now. */
  node(id: string): DerivedNode | undefined {return this.active()?.nodes.find(node => node.id === id);}
  /** The `Plan context:` block of a dispatch on `nodeId`: its path from the root and its own subtree, nothing else. */
  contextFor(nodeId: string): string | undefined {
    const plan = this.active();
    return plan?.nodes.some(node => node.id === nodeId) ? pathAndSubtree(plan, nodeId) : undefined;
  }
}
