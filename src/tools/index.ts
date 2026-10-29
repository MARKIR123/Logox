import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {z} from 'zod';
import {ToolModelStorage, type ToolModel, type ToolModelMap} from './tool-models.js';
import {PermissionEngine, shellWords, type PermissionTarget} from '../permissions/engine.js';
import {PermissionGuard, type GuardOptions} from '../permissions/guard.js';
import {shellImpact} from '../permissions/shell.js';
import {pathDanger, riskyPath} from '../permissions/paths.js';
import type {ActorContext} from '../actors/ensemble.js';
import type {ToolCall, ToolDefinition} from '../runtime/messages.js';
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
import {borrowSkillSchema, type BorrowSkillArgs} from './coordination/BorrowSkillTool/BorrowSkillTool.js';
import {BORROW_SKILL_DESCRIPTION, BORROW_SKILL_TOOL_NAME} from './coordination/BorrowSkillTool/prompt.js';
import {listActorsSchema, executeListActors, type ListActorsArgs} from './coordination/ListActorsTool/ListActorsTool.js';
import {LIST_ACTORS_DESCRIPTION, LIST_ACTORS_TOOL_NAME} from './coordination/ListActorsTool/prompt.js';
import {cancelActorSchema, executeCancelActor, type CancelActorArgs} from './orchestration/CancelActorTool/CancelActorTool.js';
import {CANCEL_ACTOR_DESCRIPTION, CANCEL_ACTOR_TOOL_NAME} from './orchestration/CancelActorTool/prompt.js';
import {updateTaskProgressSchema, type UpdateTaskProgressArgs} from './orchestration/UpdateTaskProgressTool/UpdateTaskProgressTool.js';
import {UPDATE_TASK_PROGRESS_DESCRIPTION, UPDATE_TASK_PROGRESS_TOOL_NAME} from './orchestration/UpdateTaskProgressTool/prompt.js';
import {loadToolsSchema} from './protocol/LoadToolsTool/LoadToolsTool.js';
import {LOAD_TOOLS_DESCRIPTION} from './protocol/LoadToolsTool/prompt.js';
import {finishRoundSchema} from './protocol/_FinishRoundTool/_FinishRoundTool.js';
import {FINISH_ROUND_DESCRIPTION} from './protocol/_FinishRoundTool/prompt.js';
import {automaSchema, executeAutoma, type AutomaArgs} from './orchestration/AutomaTool/AutomaTool.js';
import {AUTOMA_DESCRIPTION, AUTOMA_TOOL_NAME} from './orchestration/AutomaTool/prompt.js';
import {gitStatusSchema, executeGitStatus, type GitStatusArgs} from './protocol/_GitStatusTool/_GitStatusTool.js';
import {GIT_STATUS_DESCRIPTION, GIT_STATUS_TOOL_NAME} from './protocol/_GitStatusTool/prompt.js';

export {
  pathArg,
  toolAliases,
  canonicalToolName,
  type ToolResult,
  type CanonicalToolName,
  automaSchema,
  executeAutoma,
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
  borrowSkillSchema,
  type BorrowSkillArgs,
  BORROW_SKILL_DESCRIPTION,
  BORROW_SKILL_TOOL_NAME,
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
  updateTaskProgressSchema,
  type UpdateTaskProgressArgs,
  UPDATE_TASK_PROGRESS_DESCRIPTION,
  UPDATE_TASK_PROGRESS_TOOL_NAME,
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
  AskUserQuestion: askUserQuestionSchema,
  WebFetch: webFetchSchema,
  Actor: actorSchema,
  CraftActor: craftActorSchema,
  ReadActor: readActorSchema,
  BorrowSkill: borrowSkillSchema,
  ListActors: listActorsSchema,
  CancelActor: cancelActorSchema,
  UpdateTaskProgress: updateTaskProgressSchema,
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
  AskUserQuestion: ASK_USER_QUESTION_DESCRIPTION,
  WebFetch: WEB_FETCH_DESCRIPTION,
  Actor: ACTOR_DESCRIPTION,
  CraftActor: CRAFT_ACTOR_DESCRIPTION,
  ReadActor: READ_ACTOR_DESCRIPTION,
  BorrowSkill: BORROW_SKILL_DESCRIPTION,
  ListActors: LIST_ACTORS_DESCRIPTION,
  CancelActor: CANCEL_ACTOR_DESCRIPTION,
  UpdateTaskProgress: UPDATE_TASK_PROGRESS_DESCRIPTION,
  Automa: AUTOMA_DESCRIPTION,
  _FinishRound: FINISH_ROUND_DESCRIPTION,
  _GitStatus: GIT_STATUS_DESCRIPTION,
};

export const toolDefinitions: readonly ToolDefinition[] = (
  ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Shell', 'AskUserQuestion', 'WebFetch', 'Automa', '_FinishRound'] as const
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
  const toolName = canonical as ToolName;
  const result = schemas[toolName].safeParse(args);
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

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
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

async function fileVersion(path: string): Promise<string> {
  const bytes = await bytesOrMissing(path);
  return bytes ? String(bytes.length) : 'missing';
}

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
    this.modelStorage = new ToolModelStorage(
      join(home, '.logox', 'tool-models.json'),
      join(home, '.logox-ts', 'tool-models.json')
    );
  }

  private registry: ToolRegistry | undefined;
  setRegistry(registry: ToolRegistry): void {this.registry = registry;}
  private readonly guards = new Map<string, PermissionGuard>();
  private readonly disposedGuards = new WeakSet<PermissionGuard>();
  private automaRunner?: ((args: AutomaArgs, context: ActorContext) => Promise<ToolResult>) | undefined;

  setAutomaRunner(runner: (args: AutomaArgs, context: ActorContext) => Promise<ToolResult>): void {
    this.automaRunner = runner;
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
    const danger = paths.flatMap(item => [item.original, item.canonical]).map(path => pathDanger(path, effect)).find(Boolean);
    const target: PermissionTarget = {
      tool: call.name,
      paths: paths.flatMap(item => [
        item.original,
        item.canonical,
        relative(this.cwd, item.original).replaceAll('\\', '/'),
        relative(this.cwd, item.canonical).replaceAll('\\', '/'),
      ]),
      effect,
      risky: paths.some(item => !inside(root, item.canonical) || riskyPath(item.original, effect) || riskyPath(item.canonical, effect)),
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
      const parsed = schemas[name].parse(raw);

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
        const args = schemas.Automa.parse(parsed);
        if (!await this.permissionGuard(context).authorize({tool: 'automa', paths: args.paths ?? [], risky: false, effect: 'read'}, JSON.parse(JSON.stringify(args)), context)) {
          return {text: 'Operation denied. Please respect this decision and pursue alternative approaches without repeating the same action.', isError: true, disposition: 'denied'};
        }
        context.startTool?.();
        if (this.automaRunner) {
          return await this.automaRunner(args, context);
        }
        const journalPath = join(this.cwd, '.logox', 'state', 'subagents', 'automa.jsonl');
        return await executeAutoma(args, context.signal, {
          cwd: this.cwd,
          sessionId: context.sessionId,
          journalPath,
        });
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
      const danger = targets.map(p => pathDanger(p, effect)).find(Boolean);
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
        risky: !inside(root, path) || targets.some(p => riskyPath(p, effect)) || shellPaths.some(item => !inside(root, item.canonical)),
        ...(danger ? {danger} : {}),
        ...(name === 'Shell' ? {command: schemas.Shell.parse(parsed).command} : {}),
      };
      const guard = this.permissionGuard(context), permissionArgs = JSON.parse(JSON.stringify(parsed)) as Record<string, z.infer<ReturnType<typeof z.json>>>;
      this.report(context, name + ' · ' + (targetPath ?? (name === 'Shell' ? schemas.Shell.parse(parsed).command : 'url' in parsed ? (parsed as {url: string}).url : '')));
      let policy: string;
      do {
        if (!await guard.authorize(target, permissionArgs, context)) {
          return {text: 'Operation denied. Please respect this decision and pursue alternative approaches without repeating the same action.', isError: true, disposition: 'denied'};
        }
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
        return await executeRead(schemas.Read.parse(parsed), path, this.snapshots, context.ownerId);
      }
      if (name === 'Write') {
        return await executeWrite(schemas.Write.parse(parsed), path, this.snapshots, context.activityId, context.signal, context.ownerId);
      }
      if (name === 'Edit') {
        return await executeEdit(schemas.Edit.parse(parsed), path, this.snapshots, context.activityId, context.signal, context.ownerId);
      }
      if (name === 'Glob') {
        return await executeGlob(schemas.Glob.parse(parsed), path, originalPath, context.signal);
      }
      if (name === 'Grep') {
        return await executeGrep(schemas.Grep.parse(parsed), path, originalPath, this.cwd, context.signal);
      }
      if (name === 'Shell') {
        return await executeShell(schemas.Shell.parse(parsed), this.cwd, context.signal, {activityId: context.activityId, toolId: call.id});
      }
      throw new Error('Unhandled tool: ' + name);
    } catch (error) {
      return {
        text: context.signal.aborted
          ? 'Tool cancelled.'
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
