import {randomUUID} from 'node:crypto';
import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, relative} from 'node:path';
import {diffLines} from 'diff';
import {z} from 'zod';
import type {AutomaSwarm, AutomaJobState} from '../../../runtime/contracts.js';
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
import {finishSchema, parseFinish, type FinishArgs} from './finish.js';
import {AUTOMA_FINISH_ACCEPTED, AUTOMA_FINISH_ALONE, AUTOMA_NO_TOOL_REMINDER, AUTOMA_STALLED_SUMMARY, FINISH_DESCRIPTION, FINISH_TOOL_NAME} from './prompt.js';

export const AUTOMA_SCOPES = ['exact', 'bounded', 'open'] as const;
export type AutomaScope = typeof AUTOMA_SCOPES[number];

const automaJobSchema = z.strictObject({
  brief: z.string().trim().min(1).describe('What the worker must do and report. Stands alone: it never sees your conversation. When continuing a kept worker, only the next step'),
  title: z.string().trim().min(1).max(80).optional().describe('Short label for the stage; omit to use the start of the brief'),
  scope: z.enum(AUTOMA_SCOPES).describe('How open the problem is, not how much work it is: exact, bounded or open'),
  acceptance: z.array(z.string().min(1).max(300)).min(1).max(8).optional().describe('The checks that define done; the worker meets them and the result shows them'),
  writes: z.array(z.string().min(1)).min(1).max(64).optional().describe('Workspace paths or globs the job may edit. Omit for read-only work: reading, searching, commands and scratch scripts need no grant'),
  keep: z.boolean().optional().describe('Rare: true keeps this worker\'s context after the job; the result gives its id. Omit for single use'),
  continue: z.string().min(1).optional().describe('Rare: id a result returned for a kept worker, to give it a next step. Omit for a new job'),
  vision: z.boolean().optional().describe('Rare: true when the job must look at images (screenshots, mockups, image files). Omit otherwise'),
});

export const automaArgs = z.strictObject({
  context: z.string().min(1).max(8000).optional().describe('Shared background for every job: goal, conventions, interfaces, what is out of scope'),
  jobs: z.array(automaJobSchema).min(1).max(8).optional().describe('Independent jobs to run in parallel; one per question or file set'),
  style: z.string().min(1).optional().describe('Rare: a worker style from your profile. Omit: the runtime picks yours'),
  parallel: z.number().int().min(1).max(8).optional().describe('Omit unless you need fewer at once'),
  release: z.array(z.string().min(1)).min(1).max(8).optional().describe('Rare: ids of kept workers to end early; they also end with your task'),
});

export type AutomaArgs = z.infer<typeof automaArgs>;
export const automaSchema = automaArgs;

const PLACEHOLDER = /^(?:|n\/?a|na|none|null|nil|undefined|no|false|new|fresh|omit(?:ted)?|unused|default|auto|default_preset|-+|\/|\.|\.\w+|_+\w*_+|<.*>)$/i;
const JOB_KEYS = new Set(['brief', 'title', 'scope', 'acceptance', 'writes', 'keep', 'continue', 'vision']);
const TOP_KEYS = new Set(['context', 'jobs', 'style', 'parallel', 'release']);

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
  if (typeof raw.style !== 'string' || PLACEHOLDER.test(raw.style.trim())) delete raw.style; else raw.style = raw.style.trim();
  if (typeof raw.parallel !== 'number' || !Number.isInteger(raw.parallel) || raw.parallel < 1 || raw.parallel > 8) delete raw.parallel;
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
/** A kept instance whose context reached this many input tokens is closed: re-sending it costs more than a fresh brief. */
export const AUTOMA_RETAINED_INPUT_LIMIT = 64_000;
const CALLS_SHOWN_PER_JOB = 20;
const DIFF_COUNT_LIMIT = 512 * 1024;
const TRUST_LINE = "Trust: summary and evidence are the worker's own; Changed and Ran are measured by the runtime.";

export type AutomaProvider = WorkerProvider;
/** `model` is `<provider>/<model>`; `vision` is whether it can see images (absent counts as yes). */
export interface ResolvedAutomaModel {readonly provider: AutomaProvider; readonly model: string; readonly vision?: boolean}

export interface RetainedInstance {
  readonly id: string;
  readonly workerId: string;
  readonly grant: JobGrant;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly resolved: ResolvedAutomaModel;
}

export interface WrittenFile {readonly path: string; readonly before: Buffer | null; readonly after: Buffer}

export interface DispatchOptions {
  readonly jobs: readonly PlannedJob[];
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
  resolveModel(preferred: string | undefined, vision?: boolean): ResolvedAutomaModel;
  instance(id: string): RetainedInstance | undefined;
  retain(instance: RetainedInstance): void;
  forget(id: string): void;
  executeTool(worker: {workerId: string; grant: JobGrant}, call: ToolCall): Promise<ToolResult>;
  trackWrites(workerId: string, listener: (file: WrittenFile) => void): () => void;
  journalPath?: string | undefined;
  onProgress?(swarm: AutomaSwarm): void;
  charge?(usage: ModelTurn['usage'], model: string): void;
  /** Ledger form of a worker turn's usage (tokens, model, provider, priced cost); stored on the turn's `message` event. */
  priceUsage?(usage: NonNullable<ModelTurn['usage']>, model: string): TurnUsage | undefined;
}

type JobStatus = Extract<AutomaJobState['state'], 'done' | 'blocked' | 'failed' | 'cancelled' | 'denied'>;

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
function jobMessage(planned: PlannedJob, scratch: string, resumed: boolean): string {
  const {job, grant} = planned;
  return [job.brief, '', 'Scope: ' + SCOPE_GLOSS[job.scope ?? 'bounded'],
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
  kept?: string | undefined;
}

/** The runtime's result block for one job; everything the worker wrote is escaped, everything measured is added by the runtime. */
export function resultBlock(head: {id: string; title: string; status: JobStatus; elapsedMs: number; model: string}, parts: ResultParts): string {
  const list = (label: string, items: readonly string[] | undefined) => items?.length ? [label + ':', ...items.map(item => '- ' + escapeBlock(item))] : [];
  return [`<automa-result id="${attribute(head.id)}" title="${attribute(head.title)}" status="${head.status}" took="${took(head.elapsedMs)}" model="${attribute(head.model)}">`,
    'Summary: ' + escapeBlock(parts.summary),
    ...list('Evidence', parts.evidence), ...list('Not verified', parts.notVerified),
    ...(parts.question ? ['Question: ' + escapeBlock(parts.question)] : []),
    ...(parts.acceptance?.length ? ['Acceptance: ' + parts.acceptance.map(escapeBlock).join('; ')] : []),
    ...(parts.changed ? ['Changed (measured): ' + parts.changed] : []),
    ...(parts.ran ? ['Ran: ' + parts.ran] : []),
    ...(parts.denied ? ['Denied: ' + parts.denied] : []),
    ...(parts.kept ? [`Kept: ${parts.kept} for continue`] : []),
    '</automa-result>'].join('\n');
}

/** Runs one dispatch: jobs fail independently, and the call returns once every job has ended. */
export async function executeAutomaDispatch(options: DispatchOptions): Promise<ToolResult> {
  const {jobs, signal} = options;
  const states: AutomaJobState[] = jobs.map(planned => ({title: planned.job.title, state: 'queued', elapsedMs: 0, calls: []}));
  const publish = () => options.onProgress?.({name: options.swarmName, jobs: states.map(state => ({...state, calls: [...state.calls]}))});
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

  const finish = async (index: number, status: JobStatus, started: number, model: string, parts: ResultParts, id = 'j' + (index + 1)) => {
    const planned = jobs[index]!, elapsed = Date.now() - started;
    const receipt = resultBlock({id, title: planned.job.title, status, elapsedMs: elapsed, model}, {...parts, acceptance: planned.job.acceptance});
    receipts[index] = receipt; statuses[index] = status;
    const {startedAt: _startedAt, tool: _tool, ...settled} = states[index]!;
    states[index] = {...settled, state: status, elapsedMs: elapsed, receipt: receipt.slice(0, 4000)};
    publish();
    await journal(index, 'end', {state: status, status, elapsedMs: elapsed, receipt, model, scope: planned.job.scope ?? 'bounded', vision: Boolean(planned.job.vision)});
  };

  const runJob = async (index: number): Promise<void> => {
    const planned = jobs[index]!, started = Date.now();
    if (planned.denial) {await finish(index, 'denied', started, '', {summary: planned.denial}); return;}
    if (signal.aborted) {await finish(index, 'cancelled', started, '', {summary: 'Cancelled before it started.'}); return;}
    const kept = planned.job.continue ? options.instance(planned.job.continue) : undefined;
    const workerId = kept?.workerId ?? 'automa:' + options.activityId + ':' + randomUUID().slice(0, 8);
    const grant = planned.grant;
    const written = new Map<string, {before: Buffer | null; after: Buffer}>();
    const stopTracking = options.trackWrites(workerId, file => {
      written.set(file.path, {before: written.has(file.path) ? written.get(file.path)!.before : file.before, after: file.after});
    });
    const ran: string[] = [], refused: string[] = [];
    let succeeded = 0, lastInput = 0, modelName = '';
    const text = jobMessage(planned, getActorScratchpadDir(options.cwd, options.sessionId, options.principal), Boolean(kept));
    const messages: ModelMessage[] = kept ? [...kept.messages, {role: 'user', text}] : [{role: 'user', text}];
    states[index] = {...states[index]!, state: 'running', startedAt: started};
    publish();
    await journal(index, 'start', {title: planned.job.title, brief: planned.job.brief, grant, workerId, ...(kept ? {instance: kept.id} : {})});
    const measured = () => ({changed: changeLine(written, options.root), ran: ranLine(ran), denied: refused.join(', ')});
    try {
      const resolved = kept?.resolved ?? options.resolveModel(planned.model, planned.job.vision);
      modelName = resolved.model;
      // A vision job never runs on a model that cannot see images: this job is refused, the others of the dispatch still run.
      if (planned.job.vision && resolved.vision === false) {
        stopTracking();
        if (kept) options.forget(kept.id);
        await finish(index, 'denied', started, modelName, {summary: `Job "${planned.job.title.trim() || '#' + (index + 1)}" needs a model that can see images. Choose a vision fallback under /model automa.`});
        return;
      }
      const end = await runWorker<FinishArgs>({
        provider: resolved.provider, model: resolved.model, vision: resolved.vision, system: planned.system, tools: automaToolDefinitions(grant), messages, signal,
        cwd: options.cwd, sessionId: options.sessionId, workerId, cacheKey: promptCacheKey(options.sessionId, 'automa:' + options.activityId), retries: options.retries ?? DEFAULT_PROVIDER_RETRIES,
        terminal: {name: FINISH_TOOL_NAME, reminder: AUTOMA_NO_TOOL_REMINDER, alone: AUTOMA_FINISH_ALONE, accepted: AUTOMA_FINISH_ACCEPTED, settle: call => parseFinish(call.arguments)},
        executeCall: async call => {
          const title = callTitle(call);
          states[index] = {...states[index]!, tool: title, calls: [...states[index]!.calls, {name: call.name, title, state: 'running' as const}].slice(-CALLS_SHOWN_PER_JOB)};
          publish();
          const result = await options.executeTool({workerId, grant}, call);
          const outcome = result.isError ? 'failed' as const : 'completed' as const;
          const {tool: _shown, ...rest} = states[index]!;
          states[index] = {...rest, calls: rest.calls.map((item, at) => at === rest.calls.length - 1 ? {...item, state: outcome} : item)};
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
        onUsage: turn => options.charge?.(turn.usage, resolved.model),
        onTurn: async turn => {
          lastInput = turn.usage?.input ?? lastInput;
          const priced = turn.usage ? options.priceUsage?.(turn.usage, resolved.model) : undefined;
          await journal(index, 'message', {message: turn.message, ...(priced ? {usage: priced} : {})});
        },
        onResult: (call, result, output) => journal(index, 'tool', {call, isError: Boolean(result.isError), disposition: result.disposition, text: output}),
      });
      stopTracking();
      const notes: string[] = end.imagesOmitted ? [imagesOmittedNote(modelName)] : [];
      if (end.kind === 'stalled') {
        if (kept) options.forget(kept.id);
        await finish(index, 'failed', started, modelName, {summary: AUTOMA_STALLED_SUMMARY, notVerified: [...(end.lastText ? [end.lastText.slice(0, 600)] : []), ...notes], ...measured()});
        return;
      }
      const result = end.value;
      const allDenied = result.status === 'done' && refused.length > 0 && succeeded === 0 && written.size === 0;
      const wantsKeep = kept ? planned.job.keep !== false : planned.job.keep === true;
      const keepable = (result.status === 'done' || result.status === 'blocked') && !allDenied;
      let id: string | undefined;
      if (wantsKeep && keepable && lastInput < AUTOMA_RETAINED_INPUT_LIMIT) {
        id = kept?.id ?? 'w' + randomUUID().slice(0, 8);
        options.retain({id, workerId, grant, system: planned.system, messages, resolved});
      } else {
        if (kept) options.forget(kept.id);
        if (wantsKeep && keepable) notes.push(`Instance closed: its context reached ${lastInput} input tokens. Dispatch a fresh job with a complete brief.`);
      }
      await finish(index, allDenied ? 'denied' : result.status, started, modelName, {summary: result.summary, evidence: result.evidence, notVerified: [...(result.notVerified ?? []), ...notes],
        question: result.question, ...measured(), kept: id}, id);
    } catch (error) {
      stopTracking();
      if (kept) options.forget(kept.id);
      await finish(index, signal.aborted ? 'cancelled' : 'failed', started, modelName, {summary: signal.aborted ? 'Cancelled.' : error instanceof Error ? error.message : String(error), ...measured()});
    }
  };

  await ensureActorScratchpadDir(options.cwd, options.sessionId, options.principal).catch(() => {});
  publish();
  let next = 0;
  await Promise.all(Array.from({length: Math.min(options.parallel, jobs.length)}, async () => {
    while (next < jobs.length) await runJob(next++);
  }));

  const count = (state: AutomaJobState['state']) => statuses.filter(item => item === state).length;
  const done = count('done');
  const header = `Automa dispatch · ${options.swarmName} · ${done}/${jobs.length} done` + (options.released?.length ? ` · released ${options.released.join(', ')}` : '');
  return {text: [header, ...receipts, TRUST_LINE].join('\n\n'), isError: done === 0 && count('blocked') === 0, ...(count('denied') === jobs.length ? {disposition: 'denied' as const} : {})};
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
