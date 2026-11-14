import {dirname, join, relative, resolve} from 'node:path';
import type {Activity} from '../runtime/contracts.js';
import {inside, overreach, overreachNote, patternHolder, patternsOverlap} from './ownership.js';
import {realpath} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {z} from 'zod';
import {ToolModelStorage, type ToolModel, type ToolModelMap} from './tool-models.js';
import {PermissionEngine, shellWords, type PermissionTarget} from '../permissions/engine.js';
import {PermissionGuard, type GuardOptions} from '../permissions/guard.js';
import {shellImpact} from '../permissions/shell.js';
import {pathDanger, riskyPath} from '../permissions/paths.js';
import type {ActorContext} from '../actors/ensemble.js';
import type {ToolCall, ToolDefinition, TurnUsage} from '../runtime/messages.js';
import {Snapshots, bytesOrMissing} from './snapshots.js';

import type {ToolRegistry} from './registry.js';
import {pathArg, toolAliases, canonicalToolName, type ToolResult, type CanonicalToolName} from './types.js';
import {filePathOf} from './aliases.js';
import {readSchema, executeRead} from './ReadTool/ReadTool.js';
import {READ_DESCRIPTION} from './ReadTool/prompt.js';
import {writeSchema, executeWrite} from './WriteTool/WriteTool.js';
import {WRITE_DESCRIPTION} from './WriteTool/prompt.js';
import {editSchema, executeEdit} from './EditTool/EditTool.js';
import {EDIT_DESCRIPTION} from './EditTool/prompt.js';
import {globSchema, executeGlob} from './GlobTool/GlobTool.js';
import {GLOB_DESCRIPTION} from './GlobTool/prompt.js';
import {grepSchema, executeGrep} from './GrepTool/GrepTool.js';
import {GREP_DESCRIPTION} from './GrepTool/prompt.js';
import {shellSchema, executeShell} from './ShellTool/ShellTool.js';
import {SHELL_DESCRIPTION} from './ShellTool/prompt.js';
import {shellJobSchema, executeShellJob} from './ShellJobTool/ShellJobTool.js';
import {SHELL_JOB_DESCRIPTION} from './ShellJobTool/prompt.js';
import {askUserQuestionSchema, executeAskUserQuestion} from './AskUserQuestionTool/AskUserQuestionTool.js';
import {ASK_USER_QUESTION_DESCRIPTION} from './AskUserQuestionTool/prompt.js';
import {webFetchSchema, executeWebFetch} from './WebFetchTool/WebFetchTool.js';
import {WEB_FETCH_DESCRIPTION} from './WebFetchTool/prompt.js';
import {actorSchema, type ActorArgs, type TaskSpec} from './orchestration/ActorTool/ActorTool.js';
import {ACTOR_DESCRIPTION, ACTOR_TOOL_NAME} from './orchestration/ActorTool/prompt.js';
import {craftActorSchema, type CraftActorArgs} from './orchestration/CraftActorTool/CraftActorTool.js';
import {CRAFT_ACTOR_DESCRIPTION, CRAFT_ACTOR_TOOL_NAME} from './orchestration/CraftActorTool/prompt.js';
import {readActorSchema, type ReadActorArgs} from './orchestration/ReadActorTool/ReadActorTool.js';
import {READ_ACTOR_DESCRIPTION, READ_ACTOR_TOOL_NAME} from './orchestration/ReadActorTool/prompt.js';
import {listActorsSchema, executeListActors, type ListActorsArgs} from './coordination/ListActorsTool/ListActorsTool.js';
import {LIST_ACTORS_DESCRIPTION, LIST_ACTORS_TOOL_NAME} from './coordination/ListActorsTool/prompt.js';
import {cancelActorSchema, executeCancelActor, type CancelActorArgs} from './orchestration/CancelActorTool/CancelActorTool.js';
import {CANCEL_ACTOR_DESCRIPTION, CANCEL_ACTOR_TOOL_NAME} from './orchestration/CancelActorTool/prompt.js';
import {loadToolsSchema} from './protocol/LoadToolsTool/LoadToolsTool.js';
import {LOAD_TOOLS_DESCRIPTION} from './protocol/LoadToolsTool/prompt.js';
import {finishRoundSchema} from './protocol/_FinishRoundTool/_FinishRoundTool.js';
import {FINISH_ROUND_DESCRIPTION} from './protocol/_FinishRoundTool/prompt.js';
import {AUTOMA_SYSTEM_PROMPT, automaSchema, executeAutomaDispatch, normalizeAutomaInput, type AutomaArgs, type ResolvedAutomaModel, type RetainedInstance} from './orchestration/AutomaTool/AutomaTool.js';
import {grantTools, isExclusiveCommand, pathDenial, planDispatch} from './orchestration/AutomaTool/grant.js';
import {DEFAULT_AUTOMA_PROFILE, type AutomaProfile} from './orchestration/AutomaTool/preset.js';
import {getActorScratchpadDir, getScratchpadDir} from '../kernel/scratchpad.js';
import type {ModelTurn} from '../runtime/messages.js';
import {AUTOMA_DESCRIPTION, AUTOMA_TOOL_NAME} from './orchestration/AutomaTool/prompt.js';
import {gitStatusSchema, executeGitStatus, type GitStatusArgs} from './protocol/_GitStatusTool/_GitStatusTool.js';
import {GIT_STATUS_DESCRIPTION, GIT_STATUS_TOOL_NAME} from './protocol/_GitStatusTool/prompt.js';
import {TOOL_CANCELLED_TEXT} from '../prompts/runtime/interruption.js';

export {
  pathArg,
  toolAliases,
  canonicalToolName,
  type ToolResult,
  type CanonicalToolName,
  automaSchema,
  executeAutomaDispatch,
  type AutomaArgs,
  AUTOMA_DESCRIPTION,
  AUTOMA_TOOL_NAME,
  gitStatusSchema,
  executeGitStatus,
  type GitStatusArgs,
  GIT_STATUS_DESCRIPTION,
  GIT_STATUS_TOOL_NAME,
  actorSchema,
  type ActorArgs,
  type TaskSpec,
  ACTOR_DESCRIPTION,
  ACTOR_TOOL_NAME,
  craftActorSchema,
  type CraftActorArgs,
  CRAFT_ACTOR_DESCRIPTION,
  CRAFT_ACTOR_TOOL_NAME,
  readActorSchema,
  type ReadActorArgs,
  READ_ACTOR_DESCRIPTION,
  READ_ACTOR_TOOL_NAME,
  listActorsSchema,
  executeListActors,
  type ListActorsArgs,
  LIST_ACTORS_DESCRIPTION,
  LIST_ACTORS_TOOL_NAME,
  cancelActorSchema,
  executeCancelActor,
  type CancelActorArgs,
  CANCEL_ACTOR_DESCRIPTION,
  CANCEL_ACTOR_TOOL_NAME,
  ToolModelStorage,
  type ToolModel,
  type ToolModelMap,
};

export const schemas = {
  LoadTools: loadToolsSchema,
  Read: readSchema,
  Write: writeSchema,
  Edit: editSchema,
  Glob: globSchema,
  Grep: grepSchema,
  Shell: shellSchema,
  ShellJob: shellJobSchema,
  AskUserQuestion: askUserQuestionSchema,
  WebFetch: webFetchSchema,
  Actor: actorSchema,
  CraftActor: craftActorSchema,
  ReadActor: readActorSchema,
  ListActors: listActorsSchema,
  CancelActor: cancelActorSchema,
  Automa: automaSchema,
  _FinishRound: finishRoundSchema,
  _GitStatus: gitStatusSchema,
} as const;

export type ToolName = keyof typeof schemas;

export const descriptions: Record<ToolName, string> = {
  LoadTools: LOAD_TOOLS_DESCRIPTION,
  Read: READ_DESCRIPTION,
  Write: WRITE_DESCRIPTION,
  Edit: EDIT_DESCRIPTION,
  Glob: GLOB_DESCRIPTION,
  Grep: GREP_DESCRIPTION,
  Shell: SHELL_DESCRIPTION,
  ShellJob: SHELL_JOB_DESCRIPTION,
  AskUserQuestion: ASK_USER_QUESTION_DESCRIPTION,
  WebFetch: WEB_FETCH_DESCRIPTION,
  Actor: ACTOR_DESCRIPTION,
  CraftActor: CRAFT_ACTOR_DESCRIPTION,
  ReadActor: READ_ACTOR_DESCRIPTION,
  ListActors: LIST_ACTORS_DESCRIPTION,
  CancelActor: CANCEL_ACTOR_DESCRIPTION,
  Automa: AUTOMA_DESCRIPTION,
  _FinishRound: FINISH_ROUND_DESCRIPTION,
  _GitStatus: GIT_STATUS_DESCRIPTION,
};

export const toolDefinitions: readonly ToolDefinition[] = (
  ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Shell', 'ShellJob', 'AskUserQuestion', 'WebFetch', 'Automa', '_FinishRound'] as const
).map(name => ({
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(schemas[name]),
}));

export function validateToolCall(call: ToolCall): {valid: true; data: unknown} | {valid: false; error: string} {
  const canonical = canonicalToolName(call.name);
  if (!canonical || !Object.hasOwn(schemas, canonical)) {
    return {valid: false, error: `Unknown tool: ${call.name}. Available tools: ${Object.keys(schemas).join(', ')}`};
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch (e) {
    return {valid: false, error: `Invalid JSON in tool arguments: ${e instanceof Error ? e.message : String(e)}`};
  }
  if (!args || typeof args !== 'object') {
    return {valid: false, error: `Tool arguments must be a JSON object, received ${typeof args}`};
  }
  if ('archived_arguments' in args && typeof (args as any).archived_arguments === 'string') {
    const archivePath = (args as any).archived_arguments;
    if (existsSync(archivePath)) {
      try {
        const payload = JSON.parse(readFileSync(archivePath, 'utf8'));
        if (payload?.call?.arguments) {
          args = typeof payload.call.arguments === 'string' ? JSON.parse(payload.call.arguments) : payload.call.arguments;
        }
      } catch {}
    }
  }
  const toolName = canonical as ToolName;
  const result = schemas[toolName].safeParse(toolName === 'Automa' ? normalizeAutomaInput(args) : args);
  if (result.success) return {valid: true, data: result.data};

  const missingParams = result.error.issues
    .filter((issue: z.ZodIssue) => issue.code === 'invalid_type' && (issue.message.includes('required') || (issue as unknown as {received?: string}).received === 'undefined'))
    .map((issue: z.ZodIssue) => issue.path.join('.') || 'root');

  const unrecognizedKeys = result.error.issues
    .filter((issue: z.ZodIssue) => issue.code === 'unrecognized_keys')
    .flatMap((issue: z.ZodIssue) => (issue as unknown as {keys: string[]}).keys);

  const issuesList = result.error.issues.map((issue: z.ZodIssue) => {
    const field = issue.path.join('.') || 'parameter';
    return `${field}: ${issue.message}`;
  });

  const parts: string[] = [];
  if (missingParams.length > 0) {
    parts.push(`The required parameter(s) ${missingParams.map((p: string) => `\`${p}\``).join(', ')} is missing`);
  }
  if (unrecognizedKeys.length > 0) {
    parts.push(`Unexpected parameter(s) ${unrecognizedKeys.map((k: string) => `\`${k}\``).join(', ')} provided`);
  }
  parts.push(`Details: ${issuesList.join('; ')}`);

  return {
    valid: false,
    error: `Parameter validation failed for tool \`${call.name}\`: ${parts.join('. ')}.`,
  };
}

export function validToolCall(call: ToolCall): boolean {
  return validateToolCall(call).valid;
}

async function resolvedPath(path: string): Promise<string> {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (current === parent) throw error;
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}

const AUTOMA_DEFAULT_PARALLEL = 4;

/** What the application supplies so Automa can run; tests supply fakes. */
export interface AutomaEnvironment {
  /** Picks the model: `/model automa` first, then `preferred` (style, then role) when it resolves, then the session model. */
  resolveModel(preferred: string | undefined): ResolvedAutomaModel;
  profile?(ownerId: string): AutomaProfile | undefined;
  actorName?(ownerId: string): string | undefined;
  maxParallel?(): number;
  journalPath?(sessionId: string): string;
  charge?(context: ActorContext, usage: ModelTurn['usage'], model: string): void;
  priceUsage?(usage: NonNullable<ModelTurn['usage']>, model: string): TurnUsage | undefined;
}

interface OwnedInstance extends RetainedInstance {readonly sessionId: string; readonly ownerId: string; readonly activityId: string}

async function fileVersion(path: string): Promise<string> {
  const bytes = await bytesOrMissing(path);
  return bytes ? String(bytes.length) : 'missing';
}

/** Static denial text for the model; the user's note, when given, is appended verbatim as their stated reason. */
const DENIED = 'Operation denied. Please respect this decision and pursue alternative approaches without repeating the same action.';
const deniedText = (note?: string) => note ? DENIED + ' The user said why: "' + note + '"' : DENIED;
export class Tools {
  readonly snapshots: Snapshots;
  readonly modelStorage: ToolModelStorage;
  constructor(
    readonly cwd: string,
    private readonly report: (context: ActorContext, text: string) => void = () => {},
    readonly permissions = new PermissionEngine(cwd),
    readonly options: {home?: string} = {}
  ) {
    this.snapshots = new Snapshots(join(cwd, '.logox', 'snapshots'));
    const home = options.home ?? homedir();
    this.modelStorage = new ToolModelStorage(join(home, '.logox', 'tool-models.json'));
  }

  private registry: ToolRegistry | undefined;
  setRegistry(registry: ToolRegistry): void {this.registry = registry;}
  private activities: (() => readonly Activity[]) | undefined;
  private readonly overreachNotified = new Set<string>();
  /** Supplies the live activity list so Edit/Write can note edits on files another actor's active assignment owns. */
  setActivityProbe(probe: () => readonly Activity[]): void {this.activities = probe;}
  private async withOverreachNote(path: string, context: ActorContext, run: () => Promise<ToolResult>): Promise<ToolResult> {
    const root = await realpath(this.cwd);
    const owner = this.activities ? overreach(this.activities(), context.ownerId, path, root) : undefined;
    const result = await run();
    if (!owner || result.isError) return result;
    const key = [context.ownerId, path, owner.activityId].join('\0');
    if (this.overreachNotified.has(key)) return result;
    this.overreachNotified.add(key);
    const file = relative(root, path).replaceAll('\\', '/') || path;
    const actor = owner.ownerId.charAt(0).toUpperCase() + owner.ownerId.slice(1);
    return {...result, text: result.text + '\n' + overreachNote(file, owner, actor)};
  }
  private readonly guards = new Map<string, PermissionGuard>();
  private readonly disposedGuards = new WeakSet<PermissionGuard>();
  private automa: AutomaEnvironment | undefined;
  /** In memory only: a kept instance never outlives its task or this process. */
  private readonly instances = new Map<string, OwnedInstance>();
  private readonly dispatches = new Map<string, {readonly ownerId: string; readonly files: readonly string[]}>();
  /** Per principal: dispatches refused whole, by their normalised arguments, so an identical retry is answered without planning again. */
  private readonly refusals = new Map<string, Map<string, string>>();

  setAutomaEnvironment(environment: AutomaEnvironment): void {
    this.automa = environment;
  }

  /** A write pattern held by someone other than `ownerId`: a peer's active assignment, or a peer's running job. */
  private patternHolder(ownerId: string, pattern: string): string | undefined {
    const display = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
    const activity = this.activities ? patternHolder(this.activities(), ownerId, pattern, this.cwd) : undefined;
    if (activity) return `${display(activity.ownerId)}'s active assignment "${(activity.taskTitle ?? activity.title).replace(/\s+/g, ' ').trim()}"`;
    for (const dispatch of this.dispatches.values()) {
      if (dispatch.ownerId !== ownerId && dispatch.files.some(file => patternsOverlap(file, pattern, this.cwd))) return `a running Automa job of ${display(dispatch.ownerId)}`;
    }
    return undefined;
  }

  /**
   * Grant check for a worker's call. Only workspace writes are scoped here (to the job's `writes`, plus the dispatcher's own scratchpad);
   * reads and commands are left to the permission engine, which judges them under the dispatcher's name exactly as it would the dispatcher's own.
   * Refusals here never reach the permission engine or an approval card.
   */
  private async workerDenial(name: ToolName, parsed: unknown, context: ActorContext): Promise<string | undefined> {
    const grant = context.via!.grant;
    if (!grantTools(grant).includes(name)) return `Tool \`${name}\` is not available to a worker. Available: ${grantTools(grant).join(', ')}.`;
    if (name !== 'Edit' && name !== 'Write') return undefined;
    const target = filePathOf(parsed);
    const lexical = target ? resolve(this.cwd, target) : this.cwd;
    const canonical = await resolvedPath(lexical), root = await realpath(this.cwd);
    const denial = pathDenial(name, grant, {lexical, canonical, root, scratch: getActorScratchpadDir(this.cwd, context.sessionId, context.ownerId)});
    if (denial) return denial;
    const owner = this.activities ? overreach(this.activities(), context.ownerId, canonical, root) : undefined;
    if (!owner) return undefined;
    const actor = owner.ownerId.charAt(0).toUpperCase() + owner.ownerId.slice(1);
    return `Not written: ${relative(root, canonical).replaceAll('\\', '/')} belongs to ${actor}'s active assignment. Report it under "Not verified".`;
  }

  /** The single Automa entry: every worker tool call re-enters `execute()` under the principal's identity. */
  private async runAutoma(args: AutomaArgs, context: ActorContext, inputNotes: readonly string[] = []): Promise<ToolResult> {
    const environment = this.automa;
    if (!environment) return {text: 'Automa requires a model provider, and none is configured.', isError: true};
    const refuse = (text: string): ToolResult => ({text, isError: true, disposition: 'denied'});
    const {sessionId, ownerId, activityId} = context;
    const key = JSON.stringify([sessionId, ownerId]);
    // An identical call that was already refused gets the same answer at once: nothing changed, so nothing can run differently.
    const fingerprint = JSON.stringify(args);
    const refusals = this.refusals.get(key) ?? this.refusals.set(key, new Map()).get(key)!;
    const earlier = refusals.get(fingerprint);
    if (earlier) return refuse('Identical call, refused again without running. ' + earlier);
    const refuseAndRemember = (text: string): ToolResult => {
      if (refusals.size >= 16) refusals.delete(refusals.keys().next().value!);
      refusals.set(fingerprint, text);
      return refuse(text);
    };
    if (!args.jobs?.length && !args.release?.length) return refuseAndRemember('Automa needs `jobs`. Fix: send {"jobs":[{"brief":"Find every caller of parseConfig and list path:line"}]}, or `release` with ids of kept workers.');
    if (this.dispatches.has(key)) return refuse('You already have an Automa dispatch in progress; wait for it to return.');
    const mine = (instance: OwnedInstance) => instance.sessionId === sessionId && instance.ownerId === ownerId;
    // An instance belongs to one task: anything left over from an earlier task of this actor ends here.
    for (const [id, instance] of this.instances) if (mine(instance) && instance.activityId !== activityId) this.instances.delete(id);
    const retained = [...this.instances.values()].filter(mine);
    const profile = environment.profile?.(ownerId) ?? DEFAULT_AUTOMA_PROFILE;
    const plan = planDispatch({jobs: args.jobs ?? [], style: args.style, release: args.release ?? [], profile, cwd: this.cwd, retained,
      scratch: getActorScratchpadDir(this.cwd, sessionId, ownerId), system: AUTOMA_SYSTEM_PROMPT,
      holder: pattern => this.patternHolder(ownerId, pattern)});
    if (!plan.ok) return refuseAndRemember(plan.error);
    const note = [...inputNotes, plan.note].filter(Boolean).join('\n');
    const released = plan.release;
    for (const id of released) this.instances.delete(id);
    if (!plan.jobs.length) return {text: [`Released ${released.join(', ') || 'nothing'}.`, note].filter(Boolean).join('\n'), isError: false};
    const name = (environment.actorName?.(ownerId) ?? ownerId.charAt(0).toUpperCase() + ownerId.slice(1));
    const {startTool: _principalStep, reportSwarm, ...principal} = context;
    const parallel = args.parallel ?? plan.parallel ?? environment.maxParallel?.() ?? AUTOMA_DEFAULT_PARALLEL;
    this.dispatches.set(key, {ownerId, files: plan.jobs.flatMap(job => job.denial ? [] : job.grant.writes)});
    try {
      const result = await executeAutomaDispatch({
        jobs: plan.jobs, parallel, swarmName: profile.name, signal: context.signal,
        cwd: this.cwd, root: await realpath(this.cwd), sessionId, principal: ownerId, activityId, released,
        resolveModel: environment.resolveModel,
        instance: id => {const found = this.instances.get(id); return found && mine(found) ? found : undefined;},
        retain: instance => {this.instances.set(instance.id, {...instance, sessionId, ownerId, activityId});},
        forget: id => {this.instances.delete(id);},
        executeTool: ({workerId, grant}, call) => this.execute(call, {...principal, via: {label: `${name}'s ${profile.name}`, workerId, grant}}),
        trackWrites: (workerId, listener) => this.snapshots.trackWrites(workerId, listener),
        journalPath: environment.journalPath?.(sessionId),
        ...(reportSwarm ? {onProgress: reportSwarm} : {}),
        ...(environment.priceUsage ? {priceUsage: environment.priceUsage} : {}),
        ...(environment.charge ? {charge: (usage: ModelTurn['usage'], model: string) => environment.charge!(context, usage, model)} : {}),
      });
      return note ? {...result, text: result.text + '\n\n' + note} : result;
    } finally {
      this.dispatches.delete(key);
    }
  }

  configurePermissions(sessionId: string, options: GuardOptions): () => void {
    const previous = this.guards.get(sessionId);
    const guard = new PermissionGuard(this.permissions, options);
    this.guards.set(sessionId, guard);
    return () => {
      this.disposedGuards.add(guard);
      if (this.guards.get(sessionId) !== guard) return;
      if (previous && !this.disposedGuards.has(previous)) this.guards.set(sessionId, previous);
      else this.guards.delete(sessionId);
    };
  }

  permissionGuard(context: Pick<ActorContext, 'sessionId'>): PermissionGuard {
    let guard = this.guards.get(context.sessionId);
    if (!guard) {
      guard = new PermissionGuard(this.permissions);
      this.guards.set(context.sessionId, guard);
    }
    return guard;
  }

  async authorizeExtension(call: ToolCall, context: ActorContext, effect: PermissionTarget['effect'] = 'unknown'): Promise<boolean> {
    context.signal.throwIfAborted();
    const raw: unknown = JSON.parse(call.arguments);
    const paths: {original: string; canonical: string}[] = [];
    const visit = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (['path', 'file_path', 'target_file', 'file', 'dir', 'cwd', 'paths'].includes(key)) {
          for (const candidate of Array.isArray(item) ? item : [item]) {
            if (typeof candidate === 'string') {
              const path = await resolvedPath(resolve(this.cwd, candidate));
              if ([path, resolve(this.cwd, candidate)].some(c => c.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) {
                throw new Error('Project conventions forbid reading or modifying legacy materials');
              }
              paths.push({original: resolve(this.cwd, candidate), canonical: path});
            }
          }
        }
        await visit(item);
      }
    };
    await visit(raw);
    const root = await realpath(this.cwd);
    const danger = paths.flatMap(item => [item.original, item.canonical]).map(path => pathDanger(path, effect, [this.cwd, root])).find(Boolean);
    const target: PermissionTarget = {
      tool: call.name,
      paths: paths.flatMap(item => [
        item.original,
        item.canonical,
        relative(this.cwd, item.original).replaceAll('\\', '/'),
        relative(this.cwd, item.canonical).replaceAll('\\', '/'),
      ]),
      effect,
      risky: paths.some(item => !inside(root, item.canonical) || riskyPath(item.original, effect, [this.cwd, root]) || riskyPath(item.canonical, effect, [this.cwd, root])),
      ...(danger ? {danger} : {}),
      ...(raw && typeof raw === 'object' && 'command' in raw && typeof raw.command === 'string' ? {command: raw.command} : {}),
    };
    const guard = this.permissionGuard(context), args = z.record(z.string(), z.json()).parse(raw);
    let policy: string;
    let allowed: boolean;
    do {
      allowed = await guard.authorize(target, args, context);
      policy = guard.policy();
      context.signal.throwIfAborted();
      for (const path of paths) {
        if ((await resolvedPath(path.original)) !== path.canonical) {
          throw new Error('Extension target path changed during approval');
        }
      }
    } while (allowed && policy !== guard.policy());
    return allowed;
  }

  async execute(call: ToolCall, context: ActorContext): Promise<ToolResult> {
    try {
      context.signal.throwIfAborted();
      const canonical = canonicalToolName(call.name);
      if (!canonical || !Object.hasOwn(schemas, canonical)) throw new Error('Unknown tool: ' + call.name);
      if (this.registry && !this.registry.getToolsForActor(context.ownerId).some(tool => tool.name === canonical)) {
        return {text: 'Tool is unavailable for this actor: ' + canonical, isError: true, disposition: 'denied'};
      }
      const name = canonical as ToolName;
      const raw: unknown = JSON.parse(call.arguments);
      const automaNotes: string[] = [];
      const parsed = schemas[name].parse(name === 'Automa' ? normalizeAutomaInput(raw, automaNotes) : raw);

      if (context.via) {
        const denial = await this.workerDenial(name, parsed, context);
        if (denial) return {text: denial, isError: true, disposition: 'denied'};
      }

      if (name === 'AskUserQuestion') {
        const args = schemas.AskUserQuestion.parse(parsed);
        if (!await this.permissionGuard(context).authorize({tool: 'ask_user', paths: [], risky: false, effect: 'read'}, JSON.parse(JSON.stringify(args)), context)) {
          return {text: 'Question denied by permission rules.', isError: true, disposition: 'denied'};
        }
        return executeAskUserQuestion(args, context);
      }

      if (name === 'WebFetch') {
        const args = schemas.WebFetch.parse(parsed);
        if (!await this.permissionGuard(context).authorize({tool: 'web_fetch', paths: [], risky: false, effect: 'read'}, JSON.parse(JSON.stringify(args)), context)) {
          return {text: 'Operation denied. Please respect this decision and pursue alternative approaches without repeating the same action.', isError: true, disposition: 'denied'};
        }
        context.startTool?.();
        return executeWebFetch(args, context.signal, {cwd: this.cwd, sessionId: context.sessionId, callId: call.id});
      }

      if (name === 'Automa') {
        const args = schemas.Automa.parse(normalizeAutomaInput(parsed));
        if (!await this.permissionGuard(context).authorize({tool: 'automa', paths: [], risky: false, effect: 'read'}, JSON.parse(JSON.stringify(args)), context)) {
          return {text: 'Operation denied. Please respect this decision and pursue alternative approaches without repeating the same action.', isError: true, disposition: 'denied'};
        }
        context.startTool?.();
        return await this.runAutoma(args, context, automaNotes);
      }

      if (name === 'ShellJob') {
        const args = schemas.ShellJob.parse(parsed);
        context.startTool?.();
        return await executeShellJob(args);
      }

      if (name === 'Shell' && context.via && schemas.Shell.parse(parsed).run_in_background) {
        return {text: 'Background jobs are not available to Automa workers; run the command in the foreground.', isError: true, disposition: 'denied'};
      }

      if (name === '_GitStatus') {
        const args = schemas._GitStatus.parse(parsed);
        context.startTool?.();
        return await executeGitStatus(args, this.cwd);
      }

      const targetPath = filePathOf(parsed);
      const originalPath = targetPath ? resolve(this.cwd, targetPath) : this.cwd;
      const path = await resolvedPath(originalPath);
      const root = await realpath(this.cwd);
      if ([path, ...(targetPath ? [resolve(this.cwd, targetPath)] : [])].some(c => c.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) {
        throw new Error('Project conventions forbid reading or modifying legacy materials');
      }
      const preparedVersion = name === 'Write' ? await fileVersion(path) : undefined;
      const shellPaths: {original: string; canonical: string}[] = [];
      if (name === 'Shell') {
        for (const word of shellWords(schemas.Shell.parse(parsed).command).words.slice(1)) {
          if (word.startsWith('-') || word.startsWith('$')) continue;
          const original = resolve(this.cwd, word), canonical = await resolvedPath(original);
          if ([original, canonical].some(c => c.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) {
            throw new Error('Project conventions forbid reading or modifying legacy materials');
          }
          shellPaths.push({original, canonical});
        }
      }
      const effect: PermissionTarget['effect'] = ['Read', 'Glob', 'Grep', 'WebFetch'].includes(name) || (name === 'Shell' && shellImpact(schemas.Shell.parse(parsed).command).kind === 'safe')
        ? 'read'
        : ['Write', 'Edit'].includes(name) ? 'write' : 'unknown';
      const targets = [originalPath, path, ...shellPaths.flatMap(item => [item.original, item.canonical])];
      const danger = targets.map(p => pathDanger(p, effect, [this.cwd, root])).find(Boolean);
      const targetTool = name.toLowerCase();
      const target: PermissionTarget = {
        tool: targetTool,
        effect,
        paths: [
          relative(root, path).replaceAll('\\', '/'),
          path,
          relative(root, originalPath).replaceAll('\\', '/'),
          originalPath,
          ...shellPaths.flatMap(item => [
            item.original,
            item.canonical,
            relative(root, item.original).replaceAll('\\', '/'),
            relative(root, item.canonical).replaceAll('\\', '/'),
          ]),
        ],
        risky: !inside(root, path) || targets.some(p => riskyPath(p, effect, [this.cwd, root])) || shellPaths.some(item => !inside(root, item.canonical)),
        ...(danger ? {danger} : {}),
        ...(name === 'Shell' ? {command: schemas.Shell.parse(parsed).command} : {}),
      };
      const guard = this.permissionGuard(context), permissionArgs = JSON.parse(JSON.stringify(parsed)) as Record<string, z.infer<ReturnType<typeof z.json>>>;
      if (!context.via) this.report(context, name + ' · ' + (targetPath ?? (name === 'Shell' ? schemas.Shell.parse(parsed).command : 'url' in parsed ? (parsed as {url: string}).url : '')));
      let policy: string;
      do {
        const verdict = await guard.authorizeDetailed(target, permissionArgs, context);
        if (!verdict.allowed) return {text: deniedText(verdict.note), isError: true, disposition: 'denied'};
        policy = guard.policy();
        context.signal.throwIfAborted();
        for (const item of shellPaths) {
          if ((await resolvedPath(item.original)) !== item.canonical) throw new Error('Shell path changed during approval');
        }
        if ((await resolvedPath(originalPath)) !== path) throw new Error('Target path changed while awaiting approval; please re-request');
        if (preparedVersion !== undefined && preparedVersion !== (await fileVersion(path))) {
          throw new Error('File modified while awaiting approval; changes aborted. Please re-read file and try again.');
        }
      } while (policy !== guard.policy());

      context.startTool?.();

      if (name === 'Read') {
        return await executeRead(schemas.Read.parse(parsed), path, this.snapshots, context.via?.workerId ?? context.ownerId);
      }
      if (name === 'Write') {
        return await this.withOverreachNote(path, context, () => executeWrite(schemas.Write.parse(parsed), path, this.snapshots, context.activityId, context.signal, context.via?.workerId ?? context.ownerId, getActorScratchpadDir(this.cwd, context.sessionId, context.ownerId)));
      }
      if (name === 'Edit') {
        return await this.withOverreachNote(path, context, () => executeEdit(schemas.Edit.parse(parsed), path, this.snapshots, context.activityId, context.signal, context.via?.workerId ?? context.ownerId));
      }
      if (name === 'Glob') {
        return await executeGlob(schemas.Glob.parse(parsed), path, originalPath, context.signal);
      }
      if (name === 'Grep') {
        return await executeGrep(schemas.Grep.parse(parsed), path, originalPath, this.cwd, context.signal);
      }
      if (name === 'Shell') {
        const args = schemas.Shell.parse(parsed);
        const run = () => executeShell(args, this.cwd, context.signal, {activityId: context.activityId, toolId: call.id});
        return await (context.via && isExclusiveCommand(context.via.grant, args.command) ? this.snapshots.withLock('automa-exclusive-command', run) : run());
      }
      throw new Error('Unhandled tool: ' + name);
    } catch (error) {
      return {
        text: context.signal.aborted
          ? TOOL_CANCELLED_TEXT
          : error instanceof z.ZodError
          ? 'Invalid tool arguments: ' + error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('; ')
          : error instanceof Error
          ? error.message
          : String(error),
        isError: true,
        disposition: 'error',
      };
    }
  }
}
