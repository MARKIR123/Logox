import {randomUUID} from 'node:crypto';
import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {diffLines} from 'diff';
import {z} from 'zod';
import type {AutomaSwarm, AutomaJobState} from '../../../runtime/contracts.js';
import type {ModelMessage, ModelTurn, Provider, ToolCall, ToolDefinition} from '../../../runtime/messages.js';
import {maybePersistLargeOutput} from '../../../kernel/scratchpad.js';
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

const pathList = (description: string) => z.array(z.string().min(1)).min(1).max(64).optional().describe(description);

const automaJobSchema = z.strictObject({
  brief: z.string().trim().min(1).describe('What the worker must do. Stands alone: goal, scope, what not to touch, what to report. When resuming an instance, only the next step'),
  title: z.string().trim().min(1).max(80).optional().describe('Short label for the stage; omit to use the start of the brief'),
  read: pathList('Narrow the paths or globs the job may read. Omit for the whole workspace'),
  files: pathList('Paths or globs the job may write. Omit for a read-only job; never a placeholder'),
  commands: pathList('Command prefixes the job may run, such as "npm test". Omit unless the job must run commands'),
  output: z.enum(['text', 'json']).optional().describe('Set json only when the report must be a JSON value'),
  persistence: z.boolean().optional().describe('Rare: keep this worker for follow-up runs. Omit for single use'),
  instance: z.string().min(1).optional().describe('Rare: id of a kept instance (looks like w1a2b3c4) to continue. Omit for a new job'),
});

export const automaArgs = z.strictObject({
  jobs: z.array(automaJobSchema).min(1).max(8).optional().describe('Independent jobs to run in parallel; one per question or file set'),
  preset: z.string().min(1).optional().describe('Omit: the right preset is chosen from the files and commands you grant'),
  parallel: z.number().int().min(1).max(8).optional().describe('Omit unless you need fewer at once'),
  release: z.array(z.string().min(1)).min(1).max(8).optional().describe('Ids of kept instances to end, once finished'),
});

export type AutomaArgs = z.infer<typeof automaArgs>;
export const automaSchema = automaArgs;

const PLACEHOLDER = /^(?:|n\/?a|na|none|null|nil|undefined|no|false|new|fresh|omit(?:ted)?|unused|default|auto|default_preset|-+|\/|\.|\.\w+|_+\w*_+|<.*>)$/i;
const WORKSPACE_READ = /^(?:\.\/?|\*+|\*\*\/\*+|\.\/\*+)$/;
const INSTANCE_ID = /^w[0-9a-f]+$/;

function cleanList(value: unknown, extra?: RegExp, keep?: RegExp): unknown {
  if (!Array.isArray(value)) return value;
  const kept = value.filter(item => typeof item !== 'string' || keep?.test(item.trim()) || !(PLACEHOLDER.test(item.trim()) || extra?.test(item.trim())));
  return kept.length ? kept : undefined;
}

/**
 * Forgiving front door for what models naturally write: `tasks` or bare strings for `jobs`, `task` for `brief`, a missing title,
 * and the placeholders ("n/a", "none", "new", "default") they put in optional fields. Real values pass through untouched.
 */
export function normalizeAutomaInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = {...(input as Record<string, unknown>)};
  if (raw.jobs === undefined && raw.tasks !== undefined) raw.jobs = raw.tasks;
  delete raw.tasks;
  if (typeof raw.jobs === 'string') raw.jobs = [raw.jobs];
  if (Array.isArray(raw.jobs)) {
    raw.jobs = raw.jobs.map(item => {
      const job: Record<string, unknown> = typeof item === 'string' ? {brief: item} : item && typeof item === 'object' ? {...item as Record<string, unknown>} : {};
      for (const alias of ['task', 'prompt', 'instructions']) {
        if (job.brief === undefined && job[alias] !== undefined) job.brief = job[alias];
        delete job[alias];
      }
      if (typeof job.title === 'string' && !job.title.trim()) delete job.title;
      if (job.title === undefined && typeof job.brief === 'string' && job.brief.trim()) job.title = titleFrom(job.brief);
      job.read = cleanList(job.read, WORKSPACE_READ); job.files = cleanList(job.files, undefined, /^[./]$/); job.commands = cleanList(job.commands);
      if (typeof job.instance === 'string' && !INSTANCE_ID.test(job.instance.trim())) delete job.instance;
      if (job.output !== 'json') delete job.output;
      if (job.persistence === false && !job.instance) delete job.persistence;
      for (const key of Object.keys(job)) if (job[key] === undefined) delete job[key];
      return job;
    });
  }
  if (Array.isArray(raw.release)) {
    const ids = raw.release.filter(id => typeof id === 'string' && INSTANCE_ID.test(id.trim()));
    if (ids.length) raw.release = ids; else delete raw.release;
  }
  if (typeof raw.preset === 'string' && PLACEHOLDER.test(raw.preset.trim())) delete raw.preset;
  if (raw.parallel === 0 || raw.parallel === null) delete raw.parallel;
  return raw;
}

export const AUTOMA_SYSTEM_PROMPT = `You are Automa, a stateless worker in LOGOX. You have no personality and nobody to talk to: the brief is everything you know, and your final message is the only thing your dispatcher reads.
Do exactly what the brief asks, inside the grant it lists. Your tools are checked on every call. If a call is refused, do not look for another way around it; report it.
Report what you actually found or did. Do not claim work you did not verify, and do not fix anything the brief did not ask for: if you find something that matters outside your scope, leave it and name it in notes.
No greetings, no explanations of your method, no closing remarks. End with exactly this report:
summary: what you found or did, or NO_MATCHES if nothing matched
evidence: path:line coordinates or short verbatim excerpts that back the summary
notes: anything found but left unhandled, including dependencies outside your scope; omit if none`;

const toolDefinitions: Readonly<Record<string, ToolDefinition>> = {
  Read: {name: 'Read', description: READ_DESCRIPTION, parameters: z.toJSONSchema(readSchema)},
  Glob: {name: 'Glob', description: GLOB_DESCRIPTION, parameters: z.toJSONSchema(globSchema)},
  Grep: {name: 'Grep', description: GREP_DESCRIPTION, parameters: z.toJSONSchema(grepSchema)},
  WebFetch: {name: 'WebFetch', description: WEB_FETCH_DESCRIPTION, parameters: z.toJSONSchema(webFetchSchema)},
  Edit: {name: 'Edit', description: EDIT_DESCRIPTION, parameters: z.toJSONSchema(editSchema)},
  Write: {name: 'Write', description: WRITE_DESCRIPTION, parameters: z.toJSONSchema(writeSchema)},
  Shell: {name: 'Shell', description: SHELL_DESCRIPTION, parameters: z.toJSONSchema(shellSchema)},
};

export function automaToolDefinitions(grant: JobGrant): readonly ToolDefinition[] {
  return grantTools(grant).map(name => toolDefinitions[name]!);
}

const AUTOMA_PROVIDER_RETRIES = 5;
/** A kept instance whose context reached this many input tokens is closed: re-sending it costs more than a fresh brief. */
export const AUTOMA_RETAINED_INPUT_LIMIT = 64_000;
const CALLS_SHOWN_PER_JOB = 20;
const DIFF_COUNT_LIMIT = 512 * 1024;

export type AutomaProvider = Pick<Provider, 'respond'>;
export interface ResolvedAutomaModel {readonly provider: AutomaProvider; readonly model: string}

export interface RetainedInstance {
  readonly id: string;
  readonly workerId: string;
  readonly grant: JobGrant;
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
  resolveModel(preferred: string | undefined): ResolvedAutomaModel;
  instance(id: string): RetainedInstance | undefined;
  retain(instance: RetainedInstance): void;
  forget(id: string): void;
  executeTool(worker: {workerId: string; grant: JobGrant}, call: ToolCall): Promise<ToolResult>;
  trackWrites(workerId: string, listener: (file: WrittenFile) => void): () => void;
  journalPath?: string | undefined;
  onProgress?(swarm: AutomaSwarm): void;
  charge?(usage: ModelTurn['usage'], model: string): void;
}

interface Report {summary: string; evidence: string; notes: string}

/** Splits the worker's closing report; anything unlabelled stays in the summary so nothing a worker said is lost. */
export function parseReport(text: string): Report {
  let current: keyof Report = 'summary', labelled = false;
  const unlabelled: string[] = [], collected: Record<keyof Report, string[]> = {summary: [], evidence: [], notes: []};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?\*{0,2}(summary|evidence|notes)\*{0,2}\s*:\*{0,2}\s*(.*)$/i.exec(line);
    if (match) {
      labelled = true;
      current = match[1]!.toLowerCase() as keyof Report;
      if (match[2]) collected[current].push(match[2]);
    } else if (labelled) collected[current].push(line);
    else unlabelled.push(line);
  }
  const body = (key: keyof Report) => collected[key].join('\n').trim();
  return {summary: [unlabelled.join('\n').trim(), body('summary')].filter(Boolean).join('\n'), evidence: body('evidence'), notes: body('notes')};
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
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

function briefText(planned: PlannedJob): string {
  const {job, grant} = planned;
  return [job.brief, '', 'Grant:',
    '- read: ' + (grant.read ? [...grant.read, ...grant.files].join(', ') : 'the whole workspace'),
    '- write: ' + (grant.files.join(', ') || 'nothing; this job is read-only'),
    '- commands: ' + (grant.commands.join(', ') || 'none'),
    ...(job.output === 'json' ? ['', 'Make the summary a single valid JSON value.'] : [])].join('\n');
}

async function respondWithRetry(resolved: ResolvedAutomaModel, request: Parameters<AutomaProvider['respond']>[0], signal: AbortSignal): Promise<ModelTurn> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {return await resolved.provider.respond(request, () => {}, signal);}
    catch (error) {
      if (signal.aborted || attempt >= AUTOMA_PROVIDER_RETRIES || (error as {retryable?: unknown}).retryable !== true) throw error;
      await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal});
    }
  }
}

/** One line naming a call by its decision-relevant argument, for the stage and the receipt's denied list. */
function callTitle(call: ToolCall): string {
  let detail = '';
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const value = args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.url;
    if (typeof value === 'string') detail = value;
  } catch {}
  return (call.name + ' ' + detail).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
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

  const finish = async (index: number, state: AutomaJobState['state'], started: number, sections: readonly (readonly [string, string])[]) => {
    const elapsed = Date.now() - started;
    const body = sections.filter(([, text]) => text).map(([label, text]) => label + ': ' + text);
    const receipt = [`[job ${index + 1}/${jobs.length} · ${state} · ${seconds(elapsed)}] ${jobs[index]!.job.title}`, ...body].join('\n');
    receipts[index] = receipt; statuses[index] = state;
    const {startedAt: _startedAt, tool: _tool, ...settled} = states[index]!;
    states[index] = {...settled, state, elapsedMs: elapsed, receipt: receipt.slice(0, 4000)};
    publish();
    await journal(index, 'end', {state, elapsedMs: elapsed, receipt});
  };

  const runJob = async (index: number): Promise<void> => {
    const planned = jobs[index]!, started = Date.now();
    if (planned.denial) {await finish(index, 'denied', started, [['summary', planned.denial]]); return;}
    if (signal.aborted) {await finish(index, 'cancelled', started, []); return;}
    const kept = planned.job.instance ? options.instance(planned.job.instance) : undefined;
    const workerId = kept?.workerId ?? 'automa:' + options.activityId + ':' + randomUUID().slice(0, 8);
    const grant = planned.grant;
    const written = new Map<string, {before: Buffer | null; after: Buffer}>();
    const stopTracking = options.trackWrites(workerId, file => {
      written.set(file.path, {before: written.has(file.path) ? written.get(file.path)!.before : file.before, after: file.after});
    });
    const ran: string[] = [], refused: string[] = [];
    let succeeded = 0, lastInput = 0;
    const messages: ModelMessage[] = kept ? [...kept.messages, {role: 'user', text: planned.job.brief}] : [{role: 'user', text: briefText(planned)}];
    states[index] = {...states[index]!, state: 'running', startedAt: started};
    publish();
    await journal(index, 'start', {title: planned.job.title, brief: planned.job.brief, grant, workerId, ...(kept ? {instance: kept.id} : {})});
    try {
      const resolved = kept?.resolved ?? options.resolveModel(planned.model);
      const tools = automaToolDefinitions(grant);
      let finalText = '', truncated = false;
      for (;;) {
        signal.throwIfAborted();
        const turn = await respondWithRetry(resolved, {system: AUTOMA_SYSTEM_PROMPT, messages, tools, thinking: false}, signal);
        options.charge?.(turn.usage, resolved.model);
        signal.throwIfAborted();
        lastInput = turn.usage?.input ?? lastInput;
        messages.push(turn.message);
        await journal(index, 'message', {message: turn.message});
        const calls = turn.message.toolCalls ?? [];
        if (!calls.length) {finalText = turn.message.text.trim(); truncated = turn.stop === 'length'; break;}
        for (const call of calls) {
          signal.throwIfAborted();
          if (turn.stop === 'length') {
            messages.push({role: 'tool', name: call.name, callId: call.id, text: 'Not executed: the response was cut off and the arguments may be incomplete. Reissue the call.', isError: true});
            continue;
          }
          const title = callTitle(call);
          states[index] = {...states[index]!, tool: title, calls: [...states[index]!.calls, {name: call.name, title, state: 'running' as const}].slice(-CALLS_SHOWN_PER_JOB)};
          publish();
          // Model-chosen call ids repeat across jobs, and they name offloaded output files.
          const scoped = {...call, id: safeId(workerId + '-' + call.id)};
          const result = await options.executeTool({workerId, grant}, scoped);
          const outcome = result.isError ? 'failed' as const : 'completed' as const;
          const {tool: _shown, ...rest} = states[index]!;
          states[index] = {...rest, calls: rest.calls.map((item, at) => at === rest.calls.length - 1 ? {...item, state: outcome} : item)};
          publish();
          if (result.isError && result.disposition === 'denied') refused.push(title);
          else if (!result.isError) succeeded++;
          if (/^(?:shell|bash)$/i.test(call.name) && result.disposition !== 'denied') ran.push((JSON.parse(call.arguments) as {command?: string}).command + (result.isError ? ' (failed)' : ' (passed)'));
          const text = await maybePersistLargeOutput(result.text, options.cwd, scoped.id, options.sessionId);
          messages.push({role: 'tool', name: call.name, callId: call.id, text, isError: Boolean(result.isError)});
          await journal(index, 'tool', {call, isError: Boolean(result.isError), disposition: result.disposition, text});
        }
      }
      stopTracking();
      if (!finalText) {
        if (kept) options.forget(kept.id);
        await finish(index, 'failed', started, [['summary', 'The worker returned no report.'], ['changed', changeLine(written, options.root)], ['denied', refused.join(', ')]]);
        return;
      }
      const report = parseReport(finalText), notes: string[] = [];
      if (truncated) notes.push('The report was cut off at the output limit.');
      if (planned.job.output === 'json') {
        try {JSON.parse(report.summary);} catch {notes.push('The summary is not valid JSON as requested.');}
      }
      const allDenied = refused.length > 0 && succeeded === 0 && written.size === 0;
      const wantsKeep = kept ? planned.job.persistence !== false : planned.job.persistence === true;
      let instanceLine = '';
      if (wantsKeep && !allDenied && lastInput < AUTOMA_RETAINED_INPUT_LIMIT) {
        const id = kept?.id ?? 'w' + randomUUID().slice(0, 8);
        options.retain({id, workerId, grant, messages, resolved});
        instanceLine = `${id} (kept; continue with \`instance\`, and \`release\` it once the work is finished)`;
      } else {
        if (kept) options.forget(kept.id);
        if (wantsKeep && !allDenied) notes.push(`Instance closed: its context reached ${lastInput} input tokens. Dispatch a fresh job with a complete brief.`);
      }
      await finish(index, allDenied ? 'denied' : 'done', started, [
        ['summary', report.summary], ['changed', changeLine(written, options.root)], ['ran', ran.join(', ')], ['denied', refused.join(', ')],
        ['evidence', report.evidence], ['notes', [report.notes, ...notes].filter(Boolean).join('\n')], ['instance', instanceLine]]);
    } catch (error) {
      stopTracking();
      if (kept) options.forget(kept.id);
      await finish(index, signal.aborted ? 'cancelled' : 'failed', started, [
        ...(signal.aborted ? [] : [['summary', error instanceof Error ? error.message : String(error)] as const]),
        ['changed', changeLine(written, options.root)], ['ran', ran.join(', ')], ['denied', refused.join(', ')]]);
    }
  };

  publish();
  let next = 0;
  await Promise.all(Array.from({length: Math.min(options.parallel, jobs.length)}, async () => {
    while (next < jobs.length) await runJob(next++);
  }));

  const count = (state: AutomaJobState['state']) => statuses.filter(item => item === state).length;
  const done = count('done');
  const header = `Automa dispatch · ${options.swarmName} · ${done}/${jobs.length} done` + (options.released?.length ? ` · released ${options.released.join(', ')}` : '');
  return {text: [header, ...receipts].join('\n\n'), isError: done === 0, ...(count('denied') === jobs.length ? {disposition: 'denied' as const} : {})};
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
