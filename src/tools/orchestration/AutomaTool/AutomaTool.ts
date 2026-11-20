import {createHash, randomUUID} from 'node:crypto';
import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, relative} from 'node:path';
import {diffLines} from 'diff';
import {z} from 'zod';
import type {AutomaSwarm, AutomaJobState} from '../../../runtime/contracts.js';
import {definitionChangeNote, definitionChanges, definitionFingerprint} from '../../../runtime/definition-fingerprint.js';
import {stopReasonFor, type StopReasonCode} from '../../../runtime/stop-reason.js';
import type {ModelMessage, ModelTurn, ToolCall, ToolDefinition, TurnUsage} from '../../../runtime/messages.js';
import {ensureActorScratchpadDir, getActorScratchpadDir} from '../../../kernel/scratchpad.js';
import {promptCacheKey} from '../../../kernel/request.js';
import {runWorker, type WorkerProvider} from '../../../kernel/worker-run.js';
import {imagesOmittedNote} from '../../../providers/vision-fallback.js';
import type {ToolResult} from '../../types.js';
import {readSchema} from '../../ReadTool/ReadTool.js';
import {READ_DESCRIPTION} from '../../ReadTool/prompt.js';
import {globSchema} from '../../GlobTool/GlobTool.js';
import {GLOB_DESCRIPTION} from '../../GlobTool/prompt.js';
import {grepSchema} from '../../GrepTool/GrepTool.js';
import {GREP_DESCRIPTION} from '../../GrepTool/prompt.js';
import {webFetchSchema} from '../../WebFetchTool/WebFetchTool.js';
import {WEB_FETCH_DESCRIPTION} from '../../WebFetchTool/prompt.js';
import {writeSchema} from '../../WriteTool/WriteTool.js';
import {WRITE_DESCRIPTION} from '../../WriteTool/prompt.js';
import {editSchema} from '../../EditTool/EditTool.js';
import {EDIT_DESCRIPTION} from '../../EditTool/prompt.js';
import {shellSchema} from '../../ShellTool/ShellTool.js';
import {SHELL_DESCRIPTION} from '../../ShellTool/prompt.js';
import {grantTools, titleFrom, type JobGrant, type PlannedJob} from './grant.js';
import {AUTOMA_RETAINED_INPUT_LIMIT, type IdleWorker, type WorkerShelf} from './workers.js';
import {Semaphore} from '../../../kernel/semaphore.js';
import {finishSchema, parseFinish, type FinishArgs} from './finish.js';
import type {AutomaRoute} from './preset.js';
import {AUTOMA_FINISH_ACCEPTED, AUTOMA_FINISH_ALONE, AUTOMA_NO_TOOL_REMINDER, AUTOMA_STALLED_SUMMARY, FINISH_DESCRIPTION, FINISH_TOOL_NAME, queuedJobsLine} from './prompt.js';

export const AUTOMA_SCOPES = ['exact', 'bounded', 'open'] as const;
export type AutomaScope = typeof AUTOMA_SCOPES[number];

const automaJobSchema = z.strictObject({
  brief: z.string().trim().min(1).describe('What the worker must do and report. Stands alone: it never sees your conversation. When continuing a finished worker, only the next step'),
  title: z.string().trim().min(1).max(80).optional().describe('Short label for the stage; omit to use the start of the brief'),
  scope: z.enum(AUTOMA_SCOPES).describe('How open the problem is, not how much work it is: exact, bounded or open'),
  acceptance: z.array(z.string().min(1).max(300)).min(1).max(8).optional().describe('The checks that define done; the worker meets them and the result shows them'),
  writes: z.array(z.string().min(1)).min(1).max(64).optional().describe('Workspace paths or globs the job may edit. Omit for read-only work: reading, searching, commands and scratch scripts need no grant'),
  keep: z.boolean().optional().describe('No longer needed and ignored: every finished worker can be continued'),
  continue: z.string().min(1).optional().describe('Rare: id a result returned for a finished worker of this task, to give it a next step. Omit for a new job'),
  vision: z.boolean().optional().describe('Rare: true when the job must look at images (screenshots, mockups, image files). Omit otherwise'),
  after: z.array(z.string().min(1).max(80)).min(1).max(8).optional().describe('Jobs this one follows, by id (T1), "#n" position or exact title, or a finished worker by its id. It starts when they are all done and receives their results'),
  node: z.string().min(1).max(40).optional().describe('Rare: the plan node (see Plan) this job carries out; the node\'s status then follows the job'),
});

export const AUTOMA_MODES = ['wait', 'background'] as const;

export const automaArgs = z.strictObject({
  context: z.string().min(1).max(8000).optional().describe('Shared background for every job: goal, conventions, interfaces, what is out of scope'),
  jobs: z.array(automaJobSchema).min(1).max(32).optional().describe('Jobs of this call: independent ones run in parallel; one per question or file set. Order some with `after`'),
  style: z.string().min(1).optional().describe('Rare: a worker style from your profile. Omit: the runtime picks yours'),
  parallel: z.number().int().min(1).max(32).optional().describe('Omit unless you need fewer at once'),
  release: z.array(z.string().min(1)).min(1).max(32).optional().describe('Rare: ids of finished workers to end now; they also end with your task'),
  mode: z.enum(AUTOMA_MODES).optional().describe('`wait` (default) returns when every job has ended; `background` returns at once and delivers each result as a message'),
  wait: z.array(z.string().min(1)).min(1).max(64).optional().describe('Alone: ids of your background jobs to wait for; their results come back as this call\'s result'),
});

export type AutomaArgs = z.infer<typeof automaArgs>;
export const automaSchema = automaArgs;

const PLACEHOLDER = /^(?:|n\/?a|na|none|null|nil|undefined|no|false|new|fresh|omit(?:ted)?|unused|default|auto|default_preset|-+|\/|\.|\.\w+|_+\w*_+|<.*>)$/i;
const JOB_KEYS = new Set(['brief', 'title', 'scope', 'acceptance', 'writes', 'keep', 'continue', 'vision', 'after', 'node']);
const TOP_KEYS = new Set(['context', 'jobs', 'style', 'parallel', 'release', 'mode', 'wait']);

function cleanList(value: unknown, keep?: RegExp): unknown {
  if (typeof value === 'string') value = [value];
  if (!Array.isArray(value)) return value;
  const kept = value.filter(item => typeof item === 'string' && item.trim() && (keep?.test(item.trim()) || !PLACEHOLDER.test(item.trim())));
  return kept.length ? kept : undefined;
}

/**
 * Forgiving front door for what models naturally write: `tasks` or bare strings for `jobs`, `task` for `brief`, `files` for `writes`,
 * a missing title, a missing or unknown `scope` (read as `bounded`, with a note) and the placeholders ("n/a", "none", "new", "default") they
 * put in optional fields. Retired fields (`read`, `commands`, `output`, `preset`) and unknown ones are dropped; each drop is reported
 * through `notes`. Real values pass through untouched.
 */
export function normalizeAutomaInput(input: unknown, notes: string[] = []): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = {...(input as Record<string, unknown>)};
  if (raw.jobs === undefined && raw.tasks !== undefined) raw.jobs = raw.tasks;
  delete raw.tasks;
  if (typeof raw.jobs === 'string') raw.jobs = [raw.jobs];
  const dropped = new Set<string>();
  const drop = (key: string, value: unknown) => {
    const empty = (item: unknown) => typeof item === 'string' && PLACEHOLDER.test(item.trim());
    if (value === undefined || key === 'output' || empty(value) || (Array.isArray(value) && value.every(empty))) return;
    dropped.add(key);
  };
  let scopeMissing = false;
  const scopeInvalid = new Set<string>();
  if (Array.isArray(raw.jobs)) {
    raw.jobs = raw.jobs.map(item => {
      const job: Record<string, unknown> = typeof item === 'string' ? {brief: item} : item && typeof item === 'object' ? {...item as Record<string, unknown>} : {};
      for (const alias of ['task', 'prompt', 'instructions']) {
        if (job.brief === undefined && job[alias] !== undefined) job.brief = job[alias];
        delete job[alias];
      }
      if (typeof job.title === 'string' && !job.title.trim()) delete job.title;
      if (job.title === undefined && typeof job.brief === 'string' && job.brief.trim()) job.title = titleFrom(job.brief);
      const scope = typeof job.scope === 'string' ? job.scope.trim().toLowerCase() : undefined;
      if (scope && (AUTOMA_SCOPES as readonly string[]).includes(scope)) job.scope = scope;
      else {
        if (scope && !PLACEHOLDER.test(scope)) scopeInvalid.add(scope); else scopeMissing = true;
        job.scope = 'bounded';
      }
      const acceptance = cleanList(job.acceptance);
      job.acceptance = Array.isArray(acceptance) ? acceptance.map(check => (check as string).trim()) : undefined;
      // Old names stay accepted: files -> writes, persistence -> keep, instance -> continue.
      if (job.writes === undefined && job.files !== undefined) job.writes = job.files;
      delete job.files;
      job.writes = cleanList(job.writes, /^[./]$/);
      if (job.keep === undefined && job.persistence !== undefined) job.keep = job.persistence;
      if (job.continue === undefined && job.instance !== undefined) job.continue = job.instance;
      delete job.persistence; delete job.instance;
      if (job.keep === 'true' || job.keep === 'false') job.keep = job.keep === 'true';
      if (typeof job.keep !== 'boolean') delete job.keep;
      if (typeof job.continue !== 'string' || PLACEHOLDER.test(job.continue.trim())) delete job.continue; else job.continue = job.continue.trim();
      if (job.keep === false && !job.continue) delete job.keep;
      if (job.vision === 'true' || job.vision === 'false') job.vision = job.vision === 'true';
      if (job.vision !== true) delete job.vision;
      // `after` may arrive as one string, or as `depends_on` / `needs`; numbers are positions ("#2").
      for (const alias of ['depends_on', 'dependsOn', 'needs']) {
        if (job.after === undefined && job[alias] !== undefined) job.after = job[alias];
        delete job[alias];
      }
      if (typeof job.after === 'number') job.after = '#' + job.after;
      if (Array.isArray(job.after)) job.after = job.after.map(item => typeof item === 'number' ? '#' + item : item);
      const after = cleanList(job.after, /^#\d+$/);
      job.after = Array.isArray(after) ? [...new Set(after.map(item => (item as string).trim()))] : undefined;
      if (typeof job.node === 'number') job.node = String(job.node);
      if (typeof job.node === 'string' && PLACEHOLDER.test(job.node.trim())) delete job.node;
      for (const key of Object.keys(job)) {
        if (!JOB_KEYS.has(key)) {drop(key, job[key]); delete job[key];}
        else if (job[key] === undefined) delete job[key];
      }
      return job;
    });
  }
  if (typeof raw.context !== 'string' || PLACEHOLDER.test(raw.context.trim())) delete raw.context; else raw.context = raw.context.trim();
  if (Array.isArray(raw.release)) {
    // Unknown ids are not filtered here: the planner ignores them with a note.
    const ids = raw.release.filter(id => typeof id === 'string' && !PLACEHOLDER.test(id.trim())).map(id => (id as string).trim());
    if (ids.length) raw.release = ids; else delete raw.release;
  } else if (typeof raw.release === 'string' && !PLACEHOLDER.test(raw.release.trim())) raw.release = [raw.release.trim()];
  else if (raw.release !== undefined) {
    delete raw.release;
  }
  if (typeof raw.mode === 'string' && (AUTOMA_MODES as readonly string[]).includes(raw.mode.trim().toLowerCase())) raw.mode = raw.mode.trim().toLowerCase(); else delete raw.mode;
  if (typeof raw.wait === 'string') raw.wait = [raw.wait];
  if (Array.isArray(raw.wait)) {
    const ids = raw.wait.filter(id => typeof id === 'string' && !PLACEHOLDER.test(id.trim())).map(id => (id as string).trim());
    if (ids.length) raw.wait = [...new Set(ids)]; else delete raw.wait;
  } else delete raw.wait;
  if (typeof raw.style !== 'string' || PLACEHOLDER.test(raw.style.trim())) delete raw.style; else raw.style = raw.style.trim();
  if (typeof raw.parallel !== 'number' || !Number.isInteger(raw.parallel) || raw.parallel < 1 || raw.parallel > 32) delete raw.parallel;
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) {drop(key, raw[key]); delete raw[key];}
  }
  if (scopeMissing) notes.push('scope was missing; treated as bounded.');
  if (scopeInvalid.size) notes.push(`scope ${[...scopeInvalid].map(value => `"${value}"`).join(', ')} is not exact, bounded or open; treated as bounded.`);
  if (dropped.has('preset')) {dropped.delete('preset'); notes.push('`preset` is retired and was ignored: the runtime picks the worker style; workers can run commands under your permission rules.');}
  if (dropped.has('commands')) {dropped.delete('commands'); notes.push('`commands` was ignored: workers run commands without a grant, judged by the same permission rules as yours.');}
  if (dropped.has('read')) {dropped.delete('read'); notes.push('`read` was ignored: workers read whatever you can read.');}
  if (dropped.size) notes.push('Ignored unknown fields: ' + [...dropped].join(', ') + '.');
  return raw;
}

/** The part of a worker's system prompt that never changes; the project rules, the shared context and the style flavour follow it (`workerSystem()`). */
export const AUTOMA_SYSTEM_PROMPT = `You are an Automa worker in LOGOX: a stateless worker that one member of the ensemble dispatched for one job. You have no personality and nobody to talk to. The brief, the project rules and the shared context are everything you know; the result you hand back through Finish is the only thing your dispatcher reads.

Do exactly what the brief asks. You may read anything your dispatcher can read and run commands; you may write only the paths your grant lists, plus your scratchpad. Every call is judged by your dispatcher's permission rules: when one is refused, report it, do not look for a way around it.

How to work:
- Start doing, not planning. Read what the brief points at, then act.
- Verify by running things when you can. Report only what you saw or did; never claim a check you did not run.
- When the brief leaves something open, decide within its scope and say what you decided. When a missing fact blocks you, stop and ask through Finish with status "blocked".
- Something that matters but lies outside your brief: leave it and name it under notVerified.
- Run the acceptance checks the brief lists, if any, before you finish.

End by calling Finish exactly once. Every turn must call a tool until then.`;

/** The part of a worker's definition that comes from the project: the contract and the rules, as they are now. Stored with a worker, compared when it is continued. */
export function workerPromptHash(rules: string): string {
  return createHash('sha256').update(AUTOMA_SYSTEM_PROMPT + '\n' + rules.trim()).digest('hex').slice(0, 16);
}

/** One line per scope, shown under the brief. */
const SCOPE_GLOSS: Readonly<Record<AutomaScope, string>> = {
  exact: 'exact: follow the brief literally.',
  bounded: 'bounded: use judgment inside the stated goal.',
  open: 'open: find the cause or approach first; say how sure you are.',
};

/** The system prompt every job of a dispatch shares: the contract, the project rules exactly as actors receive them, then the shared context. The style flavour is appended by `planDispatch()`. */
export function workerSystem(rules: string, context: string | undefined): string {
  return [AUTOMA_SYSTEM_PROMPT, rules.trim(), context?.trim() ? '# Shared context\n\n' + context.trim().replace(/^# /gm, '## ') : ''].filter(Boolean).join('\n\n');
}

const toolDefinitions: Readonly<Record<string, ToolDefinition>> = {
  Read: {name: 'Read', description: READ_DESCRIPTION, parameters: z.toJSONSchema(readSchema)},
  Glob: {name: 'Glob', description: GLOB_DESCRIPTION, parameters: z.toJSONSchema(globSchema)},
  Grep: {name: 'Grep', description: GREP_DESCRIPTION, parameters: z.toJSONSchema(grepSchema)},
  WebFetch: {name: 'WebFetch', description: WEB_FETCH_DESCRIPTION, parameters: z.toJSONSchema(webFetchSchema)},
  Edit: {name: 'Edit', description: EDIT_DESCRIPTION, parameters: z.toJSONSchema(editSchema)},
  Write: {name: 'Write', description: WRITE_DESCRIPTION, parameters: z.toJSONSchema(writeSchema)},
  Shell: {name: 'Shell', description: SHELL_DESCRIPTION, parameters: z.toJSONSchema(shellSchema)},
};
const finishDefinition: ToolDefinition = {name: FINISH_TOOL_NAME, description: FINISH_DESCRIPTION, parameters: z.toJSONSchema(finishSchema)};

/** The tools of a worker: the granted business tools, then `Finish` (the only tool it alone has). */
export function automaToolDefinitions(grant: JobGrant): readonly ToolDefinition[] {
  return [...grantTools(grant).map(name => toolDefinitions[name]!), finishDefinition];
}

const DEFAULT_PROVIDER_RETRIES = 3;
export {AUTOMA_RETAINED_INPUT_LIMIT};
const LARGE_CONTEXT_NOTE = "this worker's context is large; a fresh job with a short brief is cheaper.";
const CALLS_SHOWN_PER_JOB = 20;
const DIFF_COUNT_LIMIT = 512 * 1024;
export const TRUST_LINE = "Trust: summary and evidence are the worker's own; Changed and Ran are measured by the runtime.";
/** The heading of the section that carries the results of the jobs a job follows. */
const PRIOR_RESULTS_HEADING = 'Results of the jobs this one follows:';

export type AutomaProvider = WorkerProvider;
/** `model` is `<provider>/<model>`; `vision` is whether it can see images (absent counts as yes). */
export interface ResolvedAutomaModel {readonly provider: AutomaProvider; readonly model: string; readonly vision?: boolean; readonly route?: AutomaRoute}

export interface WrittenFile {readonly path: string; readonly before: Buffer | null; readonly after: Buffer}

export interface DispatchOptions {
  /** Every job carries its readable id (`T1`): new for a fresh job, the continued worker's own for a continued one. */
  readonly jobs: readonly (PlannedJob & {readonly id: string})[];
  readonly parallel: number;
  readonly swarmName: string;
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly root: string;
  readonly sessionId: string;
  readonly principal: string;
  readonly activityId: string;
  readonly released?: readonly string[];
  /** Provider retries per request (the kernel's `max_retries`). */
  readonly retries?: number;
  resolveModel(preferred: string | undefined, vision?: boolean, writes?: boolean): ResolvedAutomaModel;
  /** Where finished workers wait for a continue. */
  readonly workers: WorkerShelf;
  /** Session-wide running limit (`[automa] max_running`): a job holds one slot while it runs; the others show as queued. */
  readonly slots?: Pick<Semaphore, 'acquire'> & Partial<Pick<Semaphore, 'saturated' | 'capacity'>>;
  /** Hash of the worker contract and project rules as they are now (the style flavour and the shared context are not part of it); stored on new workers and compared when a worker is continued. */
  readonly promptHash?: string | undefined;
  /** Why the dispatcher is being stopped, once it is (the runtime's cause word); a job that ends cancelled reports it as its stop reason. */
  stopCause?(): string | undefined;
  /** Read-only calls of one worker turn that run side by side (`permissions.readonly_concurrency`). */
  readonly readonlyConcurrency?: number;
  /** True for a call that only observes (`catalog.ts:isReadOnlyTool`); supplied by `Tools`, which may import the catalog. */
  readOnly?(call: ToolCall): boolean;
  executeTool(worker: {workerId: string; grant: JobGrant}, call: ToolCall): Promise<ToolResult>;
  trackWrites(workerId: string, listener: (file: WrittenFile) => void): () => void;
  journalPath?: string | undefined;
  onProgress?(swarm: AutomaSwarm): void;
  /** Called as each job ends, with what the worker handed back (the brief check reads its verdict here instead of parsing the result text). */
  onEnd?(end: {readonly index: number; readonly status: JobStatus; readonly summary: string; readonly question?: string | undefined}): void;
  /** The dispatch runs in the background: its swarm is published as such and each job starts without `delivered`. */
  readonly background?: boolean | undefined;
  /** Called when jobs end, with their result blocks: one job, or a job that did not end `done` together with the jobs it kept from starting. */
  onResults?(results: readonly JobOutcome[]): void;
  charge?(usage: ModelTurn['usage'], model: string): void;
  /** Ledger form of a worker turn's usage (tokens, model, provider, priced cost); stored on the turn's `message` event. */
  priceUsage?(usage: NonNullable<ModelTurn['usage']>, model: string): TurnUsage | undefined;
}

type JobStatus = Extract<AutomaJobState['state'], 'done' | 'blocked' | 'failed' | 'cancelled' | 'denied' | 'skipped'>;

/** How one job ended, with the runtime's result block. */
export interface JobOutcome {readonly id: string; readonly title: string; readonly status: JobStatus; readonly block: string}

/** What a call that started a dispatch has right away. */
export interface DispatchRun {
  /** Where each job stands as the call returns: `running`, `queued` (a free place or running slot is awaited) or `waiting` (it follows unfinished jobs); `after` lists what it follows. */
  readonly initial: readonly {readonly id: string; readonly title: string; readonly state: 'running' | 'queued' | 'waiting'; readonly after: readonly string[]}[];
  /** Settles when every job has ended. */
  readonly done: Promise<ToolResult>;
  /** The results of these jobs reached the dispatcher: the card shows them as delivered. */
  markDelivered(ids: readonly string[]): void;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}
/** `m:ss` */
function took(ms: number): string {
  const total = Math.round(ms / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function changeLine(files: ReadonlyMap<string, {before: Buffer | null; after: Buffer}>, root: string): string {
  const parts: string[] = [];
  for (const [path, {before, after}] of files) {
    if (before && before.equals(after)) continue;
    const name = relative(root, path).replaceAll('\\', '/') || path;
    if ((before?.length ?? 0) > DIFF_COUNT_LIMIT || after.length > DIFF_COUNT_LIMIT) {parts.push(name + ' (rewritten)'); continue;}
    let added = 0, removed = 0;
    for (const change of diffLines(before?.toString('utf8') ?? '', after.toString('utf8'))) {
      if (change.added) added += change.count ?? 0;
      if (change.removed) removed += change.count ?? 0;
    }
    parts.push(`${name} (+${added} −${removed})`);
  }
  return parts.join(', ');
}

/** The job's user message: the brief, its scope, the acceptance checks and (for a fresh worker) the grant. The system prompt stays the same for every job of a dispatch. */
function jobMessage(planned: PlannedJob, scratch: string, resumed: boolean, prior: readonly string[] = []): string {
  const {job, grant} = planned;
  // The results of the jobs this one follows (summary, evidence, not verified, changed, ran): their reports, never their transcripts.
  const followed = prior.length ? ['', PRIOR_RESULTS_HEADING, ...prior.map(block => block.split('\n').filter(line => !line.startsWith('Trust:')).join('\n'))] : [];
  return [job.brief, ...followed, '', 'Scope: ' + SCOPE_GLOSS[job.scope ?? 'bounded'],
    ...(job.acceptance?.length ? ['', 'Acceptance:', ...job.acceptance.map(check => '- ' + check)] : []),
    ...(resumed ? [] : ['', 'Grant:',
      '- read: anything your dispatcher can read',
      '- write: ' + (grant.writes.join(', ') || 'no workspace files; this job is read-only'),
      `- scratchpad: ${scratch} (write scratch scripts and notes here; nothing else outside the write list)`,
      "- commands: allowed, judged by your dispatcher's permission rules"])].join('\n');
}

/** One line naming a call by its decision-relevant argument, for the stage and the result's denied list. */
function callTitle(call: ToolCall): string {
  let detail = '';
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const value = args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.url;
    if (typeof value === 'string') detail = value;
  } catch {}
  return (call.name + ' ' + detail).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** A shell command and how it ended, read from the result's own `Exit code:` line. */
function ranEntry(command: string, result: ToolResult): string {
  const code = /^Exit code: (-?\d+)/.exec(result.text)?.[1];
  return `${command} (${code !== undefined ? 'exit ' + code : result.isError ? 'failed' : 'exit 0'})`;
}

/** The commands a worker ran, compact: the first few, then a count. */
function ranLine(ran: readonly string[]): string {
  return ran.length > 6 ? ran.slice(0, 6).join(', ') + `, +${ran.length - 6} more` : ran.join(', ');
}

/** Worker text never closes (or fakes) the block around it. */
const escapeBlock = (text: string) => text.replace(/<(\/?)(automa-result)/gi, '<\\$1$2');
const attribute = (text: string) => escapeBlock(text).replace(/\s+/g, ' ').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

interface ResultParts {
  summary: string;
  evidence?: readonly string[] | undefined;
  notVerified?: readonly string[] | undefined;
  question?: string | undefined;
  acceptance?: readonly string[] | undefined;
  changed?: string | undefined;
  ran?: string | undefined;
  denied?: string | undefined;
  /** One runtime line after the measured ones; for what the dispatcher should know about the worker itself. */
  note?: string | undefined;
}

/** The runtime's result block for one job; everything the worker wrote is escaped, everything measured is added by the runtime. */
export function resultBlock(head: {id: string; title: string; status: JobStatus; elapsedMs: number; model: string; stop?: StopReasonCode | undefined}, parts: ResultParts): string {
  const list = (label: string, items: readonly string[] | undefined) => items?.length ? [label + ':', ...items.map(item => '- ' + escapeBlock(item))] : [];
  // `status` is what the worker reported; `stop` says how the run ended and is shown only when it was not an ordinary completion.
  const stop = head.stop && head.stop !== 'completed' ? ` stop="${head.stop}"` : '';
  return [`<automa-result id="${attribute(head.id)}" title="${attribute(head.title)}" status="${head.status}"${stop} took="${took(head.elapsedMs)}" model="${attribute(head.model)}">`,
    'Summary: ' + escapeBlock(parts.summary),
    ...list('Evidence', parts.evidence), ...list('Not verified', parts.notVerified),
    ...(parts.question ? ['Question: ' + escapeBlock(parts.question)] : []),
    ...(parts.acceptance?.length ? ['Acceptance: ' + parts.acceptance.map(escapeBlock).join('; ')] : []),
    ...(parts.changed ? ['Changed (measured): ' + parts.changed] : []),
    ...(parts.ran ? ['Ran: ' + parts.ran] : []),
    ...(parts.denied ? ['Denied: ' + parts.denied] : []),
    ...(parts.note ? ['Note: ' + escapeBlock(parts.note)] : []),
    '</automa-result>'].join('\n');
}

/** Runs one dispatch: jobs fail independently, and the call returns once every job has ended. */
export function executeAutomaDispatch(options: DispatchOptions): Promise<ToolResult> {
  return startAutomaDispatch(options).done;
}

/**
 * Starts one dispatch and returns at once with where each job stands and a promise for the whole. A job starts when every job it follows (`after`) has
 * ended `done`; one that did not end `done` keeps its dependents from starting (they end `skipped`, stop reason `dependency_unmet`). Jobs that wait hold neither
 * a per-dispatch place nor a session running slot.
 */
export function startAutomaDispatch(options: DispatchOptions): DispatchRun {
  const {jobs, signal} = options;
  const needs = jobs.map(planned => planned.needs ?? []), workerNeeds = jobs.map(planned => planned.needsWorkers ?? []);
  const dependents: number[][] = jobs.map(() => []);
  needs.forEach((list, index) => list.forEach(prerequisite => dependents[prerequisite]!.push(index)));
  const followed = jobs.map((_, index) => [...needs[index]!.map(prerequisite => jobs[prerequisite]!.id), ...workerNeeds[index]!]);
  const ordered = followed.some(list => list.length > 0);
  const states: AutomaJobState[] = jobs.map((planned, index) => ({id: planned.id, title: planned.job.title, state: followed[index]!.length ? 'waiting' : 'queued', elapsedMs: 0, calls: [],
    ...(planned.job.node ? {node: planned.job.node} : {}),
    ...(followed[index]!.length ? {after: followed[index]!} : {}), ...(options.background ? {delivered: false} : {})}));
  const publish = () => options.onProgress?.({name: options.swarmName, jobs: states.map(state => ({...state, calls: [...state.calls]})), ...(options.background ? {background: true} : {})});
  const finished: boolean[] = jobs.map(() => false);
  /** Results of finished workers this job follows, read before anything starts. */
  const external: {id: string; status: string; block: string | undefined}[][] = jobs.map(() => []);
  let ended = 0;
  let openAll!: () => void;
  const allEnded = new Promise<void>(resolve => {openAll = resolve;});
  let journalReady: Promise<unknown> | undefined;
  const journal = (jobIndex: number, event: string, data: Record<string, unknown> = {}) => {
    if (!options.journalPath) return Promise.resolve();
    const path = options.journalPath;
    journalReady ??= mkdir(dirname(path), {recursive: true});
    return journalReady.then(() => appendFile(path, JSON.stringify({time: Date.now(), parentActivityId: options.activityId, principal: options.principal,
      jobIndex, event, ...data}) + '\n')).catch(() => {});
  };

  const receipts: string[] = new Array(jobs.length).fill('');
  const statuses: AutomaJobState['state'][] = jobs.map(() => 'queued');

  /** How a job ended, in the one outcome vocabulary: a worker that finished (whatever it reported) completed; the rest are mapped by `stopReasonFor`. */
  const stopOf = (status: JobStatus, how: {error?: unknown; stalled?: boolean}): StopReasonCode =>
    status === 'cancelled' ? stopReasonFor({status: 'cancelled', cause: options.stopCause?.()})
    : status === 'failed' ? stopReasonFor({status: 'failed', ...(how.stalled ? {stalled: true} : {}), error: how.error ?? new Error('failed')})
    : status === 'skipped' ? stopReasonFor({status: 'skipped'})
    : 'completed';
  /** Records how a job ended (block, state, journal); `shelve` is the finished worker kept for a continue, stored with this result so a job that follows it can start from it. */
  const finishCore = async (index: number, status: JobStatus, started: number, model: string, parts: ResultParts, route?: AutomaRoute, how: {error?: unknown; stalled?: boolean} = {}, shelve?: Omit<IdleWorker, 'last'>) => {
    const planned = jobs[index]!, id = planned.id, elapsed = Date.now() - started, stop = stopOf(status, how);
    finished[index] = true;
    const receipt = resultBlock({id, title: planned.job.title, status, elapsedMs: elapsed, model, stop}, {...parts, acceptance: planned.job.acceptance});
    receipts[index] = receipt; statuses[index] = status;
    // Shelved before anything hears of the result, so a dispatcher that answers it at once can continue the worker.
    // (A worker that could not be parked simply cannot be continued.)
    if (shelve) await options.workers.retain({...shelve, last: {status, block: receipt}}).catch(() => {});
    options.onEnd?.({index, status, summary: parts.summary, question: parts.question});
    const {startedAt: _startedAt, tool: _tool, ...settled} = states[index]!;
    const shown = route ?? (planned.grant.writes.length ? 'code' as const : 'read' as const);
    states[index] = {...settled, state: status, elapsedMs: elapsed, receipt: receipt.slice(0, 4000), route: shown, ...(model ? {model} : {}), stopReason: stop, summary: parts.summary.slice(0, 600),
      ...(parts.evidence?.length ? {evidence: parts.evidence.slice(0, 8)} : {}), ...(parts.notVerified?.length ? {notVerified: parts.notVerified.slice(0, 8)} : {}), ...(parts.question ? {question: parts.question} : {})};
    publish();
    await journal(index, 'end', {id, state: status, status, stop, elapsedMs: elapsed, receipt, model, route: shown, scope: planned.job.scope ?? 'bounded', vision: Boolean(planned.job.vision),
      ...(options.background ? {background: true} : {})});
  };
  const outcomeOf = (index: number): JobOutcome => ({id: jobs[index]!.id, title: jobs[index]!.job.title, status: statuses[index] as JobStatus, block: receipts[index]!});

  /** The jobs that follow this one, directly or not, that have not ended, nearest first. */
  const downstream = (index: number): number[] => {
    const order: number[] = [], seen = new Set<number>([index]);
    for (let at = 0, queue = [index]; at < queue.length; at++) {
      for (const next of dependents[queue[at]!]!) if (!seen.has(next)) {seen.add(next); queue.push(next); if (!finished[next]) order.push(next);}
    }
    return order;
  };
  let launch!: (index: number) => void;
  /** A job has ended: a failure ends the jobs that follow it without starting them, one that is done may release the jobs that wait for it. */
  const settle = async (index: number): Promise<void> => {
    const outcomes: JobOutcome[] = [outcomeOf(index)];
    const status = statuses[index];
    if (status !== 'done') {
      for (const next of downstream(index)) {
        if (finished[next]) continue;
        const cause = needs[next]!.find(prerequisite => finished[prerequisite] && statuses[prerequisite] !== 'done')!;
        await finishCore(next, 'skipped', Date.now(), '', {summary: `Not started: ${jobs[cause]!.id} ended ${statuses[cause]}.`});
        outcomes.push(outcomeOf(next));
      }
    }
    try {options.onResults?.(outcomes);} catch {}
    ended += outcomes.length;
    if (status === 'done') for (const next of dependents[index]!) {
      if (finished[next] || !needs[next]!.every(prerequisite => finished[prerequisite] && statuses[prerequisite] === 'done')) continue;
      launch(next);
    }
    if (ended >= jobs.length) openAll();
  };
  const finish = async (...args: Parameters<typeof finishCore>) => {
    await finishCore(...args);
    await settle(args[0]);
  };

  // A dispatch of many jobs with one shared system prompt starts job 0 alone: once its first response is back, the provider's prefix cache can
  // serve the shared prefix to the others. They start when it has answered, failed or ended.
  // Never with an order between the jobs: job 0 may be the one that waits.
  const staggered = !ordered && jobs.length > 3 && new Set(jobs.map(planned => planned.system)).size === 1;
  let openStart!: () => void;
  const firstAnswered = new Promise<void>(resolve => {openStart = resolve;});

  let queuedForSlot = 0;
  const runJob = async (index: number): Promise<void> => {
    const planned = jobs[index]!, id = planned.id;
    if (planned.denial) {await finish(index, 'denied', Date.now(), '', {summary: planned.denial}); return;}
    if (signal.aborted) {await finish(index, 'cancelled', Date.now(), '', {summary: 'Cancelled before it started.'}); return;}
    if (staggered && index !== 0) await firstAnswered;
    // Queued until a running slot is free (`[automa] max_running`, across every dispatcher of the session).
    let releaseSlot: (() => void) | undefined;
    // A job that has to wait for a free slot is counted once; the dispatch's result says so in one line.
    if (options.slots?.saturated) queuedForSlot++;
    try {releaseSlot = await options.slots?.acquire(signal);}
    catch {await finish(index, 'cancelled', Date.now(), '', {summary: 'Cancelled before it started.'}); return;}
    const started = Date.now();
    const idle = planned.job.continue ? await options.workers.find(options.sessionId, options.principal, options.activityId, planned.job.continue) : undefined;
    if (planned.job.continue && !idle) {
      releaseSlot?.();
      await finish(index, 'failed', started, '', {summary: `Worker ${planned.job.continue} is closed or unknown; dispatch a new job.`});
      return;
    }
    if (idle) options.workers.hold(idle);
    const workerId = idle?.workerId ?? 'automa:' + options.activityId + ':' + randomUUID().slice(0, 8);
    const grant = planned.grant;
    const written = new Map<string, {before: Buffer | null; after: Buffer}>();
    const stopTracking = options.trackWrites(workerId, file => {
      written.set(file.path, {before: written.has(file.path) ? written.get(file.path)!.before : file.before, after: file.after});
    });
    const ran: string[] = [], refused: string[] = [];
    let succeeded = 0, lastInput = 0, modelName = '', route: AutomaRoute | undefined;
    states[index] = {...states[index]!, state: 'running', startedAt: started};
    publish();
    await journal(index, 'start', {id, title: planned.job.title, brief: planned.job.brief, grant, workerId, ...(idle ? {continued: id} : {})});
    const measured = () => ({changed: changeLine(written, options.root), ran: ranLine(ran), denied: refused.join(', ')});
    let change: string | undefined, fingerprint: string | undefined;
    try {
      const resolved = options.resolveModel(idle ? idle.preferred : planned.model, idle ? idle.vision : planned.job.vision, grant.writes.length > 0);
      // A worker continued after its definition changed still continues; it and its dispatcher are told once (the fingerprint is renewed below).
      fingerprint = definitionFingerprint({...(options.promptHash !== undefined ? {prompt: [options.promptHash]} : {}), grant: [JSON.stringify([grant.writes, grant.exclusive, grant.tools ?? null])], model: resolved.model});
      change = idle && fingerprint ? definitionChangeNote(id, definitionChanges(idle.fingerprint, fingerprint)) : undefined;
      const prior = [...needs[index]!.map(prerequisite => receipts[prerequisite]!), ...external[index]!.flatMap(item => item.block ? [item.block] : [])];
      const text = jobMessage(planned, getActorScratchpadDir(options.cwd, options.sessionId, options.principal), Boolean(idle), prior);
      const messages: ModelMessage[] = idle ? [...await options.workers.messages(idle), {role: 'user', text: change ? change + '\n\n' + text : text}] : [{role: 'user', text}];
      modelName = resolved.model;
      route = resolved.route;
      // A vision job never runs on a model that cannot see images: this job is refused, the others of the dispatch still run.
      if (planned.job.vision && resolved.vision === false) {
        stopTracking();
        if (idle) options.workers.unhold(idle);
        await finish(index, 'denied', started, modelName, {summary: `Job "${planned.job.title.trim() || '#' + (index + 1)}" needs a model that can see images. Choose a vision fallback under /model automa.`}, route);
        return;
      }
      const end = await runWorker<FinishArgs>({
        provider: resolved.provider, model: resolved.model, vision: resolved.vision, system: planned.system, tools: automaToolDefinitions(grant), messages, signal,
        cwd: options.cwd, sessionId: options.sessionId, workerId, cacheKey: promptCacheKey(options.sessionId, 'automa:' + options.activityId), retries: options.retries ?? DEFAULT_PROVIDER_RETRIES,
        terminal: {name: FINISH_TOOL_NAME, reminder: AUTOMA_NO_TOOL_REMINDER, alone: AUTOMA_FINISH_ALONE, accepted: AUTOMA_FINISH_ACCEPTED, settle: call => parseFinish(call.arguments)},
        ...(options.readOnly ? {readOnly: options.readOnly} : {}), concurrency: options.readonlyConcurrency,
        executeCall: async call => {
          const title = callTitle(call);
          // Calls of one turn may run side by side: each updates only its own row.
          const row = {name: call.name, title, state: 'running' as const};
          states[index] = {...states[index]!, tool: title, calls: [...states[index]!.calls, row].slice(-CALLS_SHOWN_PER_JOB)};
          publish();
          const result = await options.executeTool({workerId, grant}, call);
          const outcome = result.isError ? 'failed' as const : 'completed' as const;
          const {tool: _shown, ...rest} = states[index]!;
          const calls = rest.calls.map(item => item === row ? {...item, state: outcome} : item);
          const stillRunning = calls.findLast(item => item.state === 'running');
          states[index] = {...rest, calls, ...(stillRunning ? {tool: stillRunning.title} : {})};
          publish();
          if (result.isError && result.disposition === 'denied') refused.push(title);
          else if (!result.isError) succeeded++;
          if (/^(?:shell|bash)$/i.test(call.name) && result.disposition !== 'denied') {
            let command = '';
            try {command = (JSON.parse(call.arguments) as {command?: string}).command ?? '';} catch {}
            ran.push(ranEntry(command, result));
          }
          return result;
        },
        onUsage: turn => {
          if (index === 0) openStart();
          options.charge?.(turn.usage, resolved.model);
        },
        onTurn: async turn => {
          lastInput = turn.usage?.input ?? lastInput;
          const priced = turn.usage ? options.priceUsage?.(turn.usage, resolved.model) : undefined;
          await journal(index, 'message', {message: turn.message, ...(priced ? {usage: priced} : {})});
        },
        onResult: (call, result, output) => journal(index, 'tool', {call, isError: Boolean(result.isError), disposition: result.disposition, text: output}),
      });
      stopTracking();
      const notes: string[] = end.imagesOmitted ? [imagesOmittedNote(modelName)] : [];
      // Whatever the outcome, a worker that ended through the loop (Finish, or the stall rule) stays on the shelf with its history.
      const shelve: Omit<IdleWorker, 'last'> = {id, sessionId: options.sessionId, ownerId: options.principal, activityId: options.activityId, workerId, grant, system: planned.system,
        preferred: idle ? idle.preferred : planned.model, vision: idle ? idle.vision : Boolean(planned.job.vision), resolved, messages, lastInput, idleSince: Date.now(), busy: false,
        ...(fingerprint ? {fingerprint} : {})};
      const large = idle && lastInput >= AUTOMA_RETAINED_INPUT_LIMIT ? LARGE_CONTEXT_NOTE : undefined;
      // The block prefixes `Note: ` itself.
      const note = [change?.replace(/^Note: /, ''), large].filter(Boolean).join('\n') || undefined;
      if (end.kind === 'stalled') {
        await finish(index, 'failed', started, modelName, {summary: AUTOMA_STALLED_SUMMARY, notVerified: [...(end.lastText ? [end.lastText.slice(0, 600)] : []), ...notes], ...measured(), note}, route, {stalled: true}, shelve);
        return;
      }
      const result = end.value;
      const allDenied = result.status === 'done' && refused.length > 0 && succeeded === 0 && written.size === 0;
      await finish(index, allDenied ? 'denied' : result.status, started, modelName, {summary: result.summary, evidence: result.evidence, notVerified: [...(result.notVerified ?? []), ...notes],
        question: result.question, ...measured(), note}, route, {}, shelve);
    } catch (error) {
      stopTracking();
      // A continued worker that did not get to the end of its job stays as it was before this brief; the shelf's history was never extended.
      if (idle) options.workers.unhold(idle);
      await finish(index, signal.aborted ? 'cancelled' : 'failed', started, modelName, {summary: signal.aborted ? 'Cancelled.' : error instanceof Error ? error.message : String(error), ...measured(), ...(change ? {note: change.replace(/^Note: /, '')} : {})}, route, {error});
    } finally {
      releaseSlot?.();
    }
  };
  // The jobs of one dispatch that run at once (`parallel`); a job that waits for the jobs it follows has not asked for a place yet.
  const places = new Semaphore(() => options.parallel);
  const runJobs = async (index: number): Promise<void> => {
    let release: (() => void) | undefined;
    try {
      try {release = await places.acquire(signal);}
      catch {await finish(index, 'cancelled', Date.now(), '', {summary: 'Cancelled before it started.'}); return;}
      await runJob(index);
    } finally {
      release?.();
      if (index === 0) openStart();
    }
  };
  launch = index => {
    if (finished[index]) return;
    if (states[index]!.state === 'waiting') {states[index] = {...states[index]!, state: 'queued'}; publish();}
    void runJobs(index).catch(async error => {
      if (!finished[index]) await finish(index, 'failed', Date.now(), '', {summary: error instanceof Error ? error.message : String(error)}, undefined, {error}).catch(() => {});
    });
  };

  // Where each job stands as the call returns: the first `parallel` jobs that follow nothing run (unless the session's running slots are all taken), the rest queue.
  let startable = 0;
  const initial = jobs.map((planned, index) => ({id: planned.id, title: planned.job.title, after: followed[index]!,
    state: needs[index]!.length ? 'waiting' as const : startable++ < options.parallel && !options.slots?.saturated ? 'running' as const : 'queued' as const}));

  const run = async (): Promise<ToolResult> => {
    await ensureActorScratchpadDir(options.cwd, options.sessionId, options.principal).catch(() => {});
    publish();
    // A worker a job follows has already ended: it starts from that result, or, when the worker did not end `done`, does not start.
    for (let index = 0; index < jobs.length; index++) {
      for (const id of workerNeeds[index]!) {
        const worker = await options.workers.find(options.sessionId, options.principal, options.activityId, id);
        external[index]!.push({id, status: worker?.last?.status ?? (worker ? 'done' : 'closed'), block: worker?.last?.block});
      }
      const unmet = external[index]!.find(item => item.status !== 'done');
      if (unmet && !finished[index]) await finish(index, 'skipped', Date.now(), '', {summary: `Not started: ${unmet.id} ended ${unmet.status}.`});
    }
    for (let index = 0; index < jobs.length; index++) if (!needs[index]!.length) launch(index);
    if (!jobs.length) openAll();
    await allEnded;

    const count = (state: AutomaJobState['state']) => statuses.filter(item => item === state).length;
    const done = count('done'), skipped = count('skipped');
    const header = `Automa dispatch · ${options.swarmName} · ${done}/${jobs.length} done` + (skipped ? ` · ${skipped} skipped` : '') + (options.released?.length ? ` · released ${options.released.join(', ')}` : '');
    // Said once per dispatch, never per job: how many of its jobs had to wait for a running slot, and the limit behind it.
    const limits = queuedForSlot > 0 && options.slots?.capacity ? [queuedJobsLine(queuedForSlot, jobs.length, options.slots.capacity)] : [];
    return {text: [header, ...limits, ...receipts, TRUST_LINE].join('\n\n'), isError: done === 0 && count('blocked') === 0, ...(count('denied') === jobs.length ? {disposition: 'denied' as const} : {})};
  };
  return {initial, done: run(), markDelivered: ids => {
    let changed = false;
    for (const [index, state] of states.entries()) if (ids.includes(jobs[index]!.id) && state.delivered === false) {states[index] = {...state, delivered: true}; changed = true;}
    if (changed) publish();
  }};
}

/** Marks jobs a previous process left unfinished; they are never replayed, so the dispatcher decides what to send again. */
export async function markInterruptedJobs(journalPath: string): Promise<number> {
  let raw: string;
  try {raw = await readFile(journalPath, 'utf8');} catch {return 0;}
  const open = new Map<string, Record<string, unknown>>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const job = JSON.stringify([entry.parentActivityId, entry.jobIndex]);
      if (entry.event === 'start') open.set(job, entry);
      else if (entry.event === 'end' || entry.event === 'interrupted') open.delete(job);
    } catch {}
  }
  for (const entry of open.values()) {
    await appendFile(journalPath, JSON.stringify({time: Date.now(), parentActivityId: entry.parentActivityId, principal: entry.principal, jobIndex: entry.jobIndex, event: 'interrupted', state: 'interrupted'}) + '\n').catch(() => {});
  }
  return open.size;
}

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'Automa', category: 'orchestration', roles: 'all', loading: 'eager', terminalVisibility: 'card', description: 'Dispatch stateless parallel workers for mechanical work'};
