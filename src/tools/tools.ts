import {glob, lstat, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {PermissionEngine, shellWords, type PermissionTarget} from '../permissions/engine.js';
import {PermissionGuard, type GuardOptions} from '../permissions/guard.js';
import {shellImpact} from '../permissions/shell.js';
import {pathDanger, riskyPath, runtimePath, searchablePath, searchExclusions} from '../permissions/paths.js';
import type {ActorContext} from '../actors/ensemble.js';
import type {ImageBlock, ToolCall, ToolDefinition} from '../runtime/messages.js';
import {questionSchema} from '../runtime/contracts.js';
import {Snapshots, bytesOrMissing} from './snapshots.js';
import {runProcess} from './process.js';

const pathArg = z.string().min(1);
const schemas = {
  read: z.strictObject({path: pathArg, offset: z.number().int().positive().default(1), limit: z.number().int().min(1).max(2000).default(2000)}),
  write: z.strictObject({path: pathArg, content: z.string()}),
  edit: z.strictObject({path: pathArg, old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().default(false)}),
  glob: z.strictObject({pattern: z.string().min(1), path: pathArg.default('.')}),
  grep: z.strictObject({pattern: z.string().min(1), path: pathArg.default('.'), limit: z.number().int().min(1).max(500).default(100)}),
  shell: z.strictObject({command: z.string().min(1), timeout: z.number().int().min(1).max(600).default(60)}),
  ask_user: z.strictObject({title: z.string().min(1), questions: z.array(questionSchema).min(1).max(3)}),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  read: '读取文本文件，返回行号；offset 从 1 开始。',
  write: '写入完整 UTF-8 文件。按当前权限模式裁决并保存修改前备份。',
  edit: '精确替换已有文件中的文字；匹配不唯一时必须明确 replace_all。',
  glob: '按 glob 模式查找项目文件，忽略依赖、版本库和敏感文件。',
  grep: '使用 ripgrep 搜索正则表达式，返回路径、行号和匹配文字。',
  shell: '在工作目录执行命令；Windows 使用 PowerShell。按当前权限模式裁决。',
  ask_user: '向用户提出 1–3 个问题，等待全部回答。选项为可选，支持自由文本。',
};
export const toolDefinitions: readonly ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name as ToolName], parameters: z.toJSONSchema(schema),
}));
function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
}
async function resolvedPath(path: string): Promise<string> {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try {return resolve(await realpath(current), ...missing.reverse());}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (current === parent) throw error;
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}
async function fileVersion(path: string): Promise<string> {
  try {const info = await stat(path); return JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.ino]);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error;}
}
function decode(bytes: Buffer): {text: string; bom: boolean} {
  if (bytes.includes(0)) throw new Error('暂不支持二进制或 UTF-16 文件');
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  try {return {text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bom ? bytes.subarray(3) : bytes), bom};}
  catch {throw new Error('文件不是有效 UTF-8，未执行修改');}
}
export interface ToolResult {text: string; isError: boolean; disposition?: 'denied' | 'error' | undefined; images?: ImageBlock[] | undefined}
export function validToolCall(call: ToolCall): boolean {
  if (!Object.hasOwn(schemas, call.name)) return false;
  try {return schemas[call.name as ToolName].safeParse(JSON.parse(call.arguments)).success;} catch {return false;}
}
export class Tools {
  readonly snapshots: Snapshots;
  constructor(readonly cwd: string, private readonly report: (context: ActorContext, text: string) => void = () => {},
    readonly permissions = new PermissionEngine(cwd)) {
    this.snapshots = new Snapshots(join(cwd, '.logox', 'snapshots'));
  }
  private readonly guards = new Map<string, PermissionGuard>();
  private readonly disposedGuards = new WeakSet<PermissionGuard>();
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
    if (!guard) {guard = new PermissionGuard(this.permissions); this.guards.set(context.sessionId, guard);}
    return guard;
  }
  /** 扩展完整 schema 由调用方先校验，再进入唯一裁决入口。 */
  async authorizeExtension(call: ToolCall, context: ActorContext, effect: PermissionTarget['effect'] = 'unknown'): Promise<boolean> {
    context.signal.throwIfAborted();
    const raw: unknown = JSON.parse(call.arguments);
    const paths: {original: string; canonical: string}[] = [];
    const visit = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (['path', 'file_path', 'target_file', 'file', 'dir', 'cwd', 'paths'].includes(key)) {
          for (const candidate of Array.isArray(item) ? item : [item]) if (typeof candidate === 'string') {
            const path = await resolvedPath(resolve(this.cwd, candidate));
            if ([path, resolve(this.cwd, candidate)].some(candidate => candidate.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) throw new Error('项目约定禁止读取或修改 legacy 材料');
            paths.push({original: resolve(this.cwd, candidate), canonical: path});
          }
        }
        await visit(item);
      }
    };
    await visit(raw);
    const root = await realpath(this.cwd);
    const danger = paths.flatMap(item => [item.original, item.canonical]).map(path => pathDanger(path, effect)).find(Boolean);
    const target: PermissionTarget = {tool: call.name, paths: paths.flatMap(item => [item.original, item.canonical, relative(this.cwd, item.original).replaceAll('\\', '/'), relative(this.cwd, item.canonical).replaceAll('\\', '/')]),
      effect, risky: paths.some(item => !inside(root, item.canonical) || riskyPath(item.original, effect) || riskyPath(item.canonical, effect)),
      ...(danger ? {danger} : {}),
      ...(raw && typeof raw === 'object' && 'command' in raw && typeof raw.command === 'string' ? {command: raw.command} : {})};
    const guard = this.permissionGuard(context), args = z.record(z.string(), z.json()).parse(raw);
    let policy: string;
    let allowed: boolean;
    do {
      allowed = await guard.authorize(target, args, context); policy = guard.policy();
      context.signal.throwIfAborted();
      for (const path of paths) if (await resolvedPath(path.original) !== path.canonical) throw new Error('扩展目标在审批期间改变');
    } while (allowed && policy !== guard.policy());
    return allowed;
  }
  async execute(call: ToolCall, context: ActorContext): Promise<ToolResult> {
    try {
      context.signal.throwIfAborted();
      if (!Object.hasOwn(schemas, call.name)) throw new Error('未知工具：' + call.name);
      const name = call.name as ToolName;
      const raw: unknown = JSON.parse(call.arguments);
      const parsed = schemas[name].parse(raw);
      if (name === 'ask_user') {
        const args = schemas.ask_user.parse(parsed);
        if (!await this.permissionGuard(context).authorize({tool: name, paths: [], risky: false, effect: 'read'}, JSON.parse(JSON.stringify(args)), context)) return {text: '提问被权限规则拒绝。', isError: true, disposition: 'denied'};
        context.startTool?.();
        const outcome = await context.ask({kind: 'question', ...args});
        return {text: JSON.stringify(outcome), isError: outcome.status !== 'answered'};
      }
      const originalPath = 'path' in parsed ? resolve(this.cwd, parsed.path) : this.cwd;
      const path = await resolvedPath(originalPath);
      const root = await realpath(this.cwd);
      if ([path, ...('path' in parsed ? [resolve(this.cwd, parsed.path)] : [])].some(candidate => candidate.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) throw new Error('项目约定禁止读取或修改 legacy 材料');
      const preparedVersion = ['write', 'edit'].includes(name) ? await fileVersion(path) : undefined;
      const shellPaths: {original: string; canonical: string}[] = [];
      if (name === 'shell') for (const word of shellWords(schemas.shell.parse(parsed).command).words.slice(1)) {
        if (word.startsWith('-') || word.startsWith('$')) continue;
        const original = resolve(this.cwd, word), canonical = await resolvedPath(original);
        if ([original, canonical].some(candidate => candidate.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy'))) throw new Error('项目约定禁止读取或修改 legacy 材料');
        shellPaths.push({original, canonical});
      }
      const effect: PermissionTarget['effect'] = ['read', 'glob', 'grep'].includes(name) || name === 'shell' && shellImpact(schemas.shell.parse(parsed).command).kind === 'safe' ? 'read'
        : ['write', 'edit'].includes(name) ? 'write' : 'unknown';
      const targets = [originalPath, path, ...shellPaths.flatMap(item => [item.original, item.canonical])];
      const danger = targets.map(path => pathDanger(path, effect)).find(Boolean);
      const target: PermissionTarget = {tool: name, effect, paths: [relative(root, path).replaceAll('\\', '/'), path, relative(root, originalPath).replaceAll('\\', '/'), originalPath,
        ...shellPaths.flatMap(item => [item.original, item.canonical, relative(root, item.original).replaceAll('\\', '/'), relative(root, item.canonical).replaceAll('\\', '/')])],
        risky: !inside(root, path) || targets.some(path => riskyPath(path, effect)) || shellPaths.some(item => !inside(root, item.canonical)),
        ...(danger ? {danger} : {}),
        ...(name === 'shell' ? {command: schemas.shell.parse(parsed).command} : {})};
      const guard = this.permissionGuard(context), permissionArgs = JSON.parse(JSON.stringify(parsed)) as Record<string, z.infer<ReturnType<typeof z.json>>>;
      this.report(context, name + ' · ' + ('path' in parsed ? parsed.path : name === 'shell' ? schemas.shell.parse(parsed).command : ''));
      let policy: string;
      do {
        if (!await guard.authorize(target, permissionArgs, context)) return {text: '操作被拒绝。请尊重裁决并寻找其他方案，不要重复请求相同操作。', isError: true, disposition: 'denied'};
        policy = guard.policy();
        context.signal.throwIfAborted();
        for (const item of shellPaths) if (await resolvedPath(item.original) !== item.canonical) throw new Error('Shell 路径在审批期间改变');
        if (await resolvedPath(originalPath) !== path) throw new Error('目标路径在等待审批期间改变，请重新请求操作');
        if (preparedVersion !== undefined && preparedVersion !== await fileVersion(path)) throw new Error('文件在等待审批期间发生变化，未执行修改；请重新读取后再请求');
      } while (policy !== guard.policy());
      context.startTool?.();
      if (['read', 'edit', 'write'].includes(name)) {
        const size = await stat(path).then(info => info.size).catch(error => {if (error.code === 'ENOENT') return 0; throw error;});
        if (size > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB，请使用搜索缩小范围');
      }
      if (name === 'read') {
        const args = schemas.read.parse(parsed);
        const bytes = await bytesOrMissing(path);
        if (!bytes) throw new Error('文件不存在：' + args.path);
        if (bytes.length > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB，请使用搜索缩小范围');
        const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
        const imageMimes: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp',
        };
        const mime = imageMimes[ext];
        if (mime) {
          if (bytes.length > 10 * 1024 * 1024) throw new Error('图片文件超过 10 MiB 大小限制');
          return {
            text: `[图片文件: ${args.path}, 大小: ${bytes.length} 字节, 格式: ${mime}]`,
            isError: false,
            images: [{data: bytes.toString('base64'), mimeType: mime}],
          };
        }
        const lines = decode(bytes).text.split(/\r?\n/);
        return {text: lines.slice(args.offset - 1, args.offset - 1 + args.limit)
          .map((line, index) => (args.offset + index) + ': ' + line.slice(0, 2000)).join('\n') +
          (lines.length > args.offset - 1 + args.limit ? '\n（后续内容已省略）' : ''), isError: false};
      }
      if (name === 'write' || name === 'edit') {
        const before = await bytesOrMissing(path);
        if (before && before.length > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB');
        let after: Buffer;
        if (name === 'write') after = Buffer.from(schemas.write.parse(parsed).content);
        else {
          const args = schemas.edit.parse(parsed);
          if (!before) throw new Error('文件不存在');
          const decoded = decode(before);
          const newline = decoded.text.includes('\r\n') ? '\r\n' : '\n';
          const old = args.old_text.replace(/\r?\n/g, newline);
          const replacement = args.new_text.replace(/\r?\n/g, newline);
          const count = decoded.text.split(old).length - 1;
          if (!count) throw new Error('未找到匹配文字，请重新读取文件');
          if (count > 1 && !args.replace_all) throw new Error('匹配不唯一，请提供更多上下文');
          after = Buffer.from((decoded.bom ? '\uFEFF' : '') + (args.replace_all ? decoded.text.split(old).join(replacement) : decoded.text.replace(old, () => replacement)));
        }
        if (after.length > 32 * 1024 * 1024) throw new Error('写入内容超过 32 MiB');
        await this.snapshots.apply(path, before, after, context.activityId, context.signal);
        return {text: '已修改 ' + path + '；可使用 /undo 撤销这一轮文件修改。', isError: false};
      }
      if (name === 'glob') {
        const args = schemas.glob.parse(parsed);
        if (isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes('..')) throw new Error('pattern 必须是目标目录内的相对模式');
        const results: string[] = [];
        const includeRuntime = runtimePath(originalPath) || runtimePath(path) || runtimePath(args.pattern);
        for await (const candidate of glob(args.pattern, {cwd: path, exclude: candidate => !searchablePath(candidate, includeRuntime) || candidate.split(/[\\/]/).some(part => ['node_modules', 'dist'].includes(part.toLowerCase()))})) {
          context.signal.throwIfAborted();
          const full = join(path, candidate);
          if (!searchablePath(full, includeRuntime) || !(await lstat(full)).isFile() || !inside(path, await realpath(full))) continue;
          results.push(candidate);
          if (results.length >= 1000) break;
        }
        return {text: results.sort().slice(0, 200).join('\n') + (results.length > 200 ? '\n（只展示前 200 项）' : ''), isError: false};
      }
      if (name === 'grep') {
        const args = schemas.grep.parse(parsed);
        const includeRuntime = runtimePath(originalPath) || runtimePath(path);
        const matchSchema = z.object({type: z.literal('match'), data: z.object({path: z.object({text: z.string()}), line_number: z.number(), lines: z.object({text: z.string()})})});
        const rawMatches: z.infer<typeof matchSchema>[] = [];
        const result = await runProcess('rg', ['--json', '--no-config', '--hidden', '--no-ignore', '--max-count', String(args.limit),
          ...searchExclusions(includeRuntime).flatMap(pattern => ['--iglob', '!' + pattern]), '--regexp', args.pattern, '--', path],
        this.cwd, context.signal, 30_000, 64_000, line => {
          let raw: unknown;
          try {raw = JSON.parse(line);} catch {return true;}
          const match = matchSchema.safeParse(raw);
          if (match.success && searchablePath(match.data.data.path.text, includeRuntime)) rawMatches.push(match.data);
          return rawMatches.length < args.limit;
        });
        if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'rg 搜索失败');
        const matches: string[] = [];
        for (const item of rawMatches) {
          const file = resolve(this.cwd, item.data.path.text);
          const canonical = await realpath(file);
          if (!searchablePath(file, includeRuntime) || !searchablePath(canonical, includeRuntime) || !inside(path, canonical)) continue;
          matches.push(relative(this.cwd, file) + ':' + item.data.line_number + ': ' + item.data.lines.text.trimEnd().slice(0, 2000));
          if (matches.length >= args.limit) break;
        }
        return {text: (matches.join('\n') || '没有匹配结果。') + (rawMatches.length >= args.limit ? '\n（达到展示上限，搜索已停止）' : ''), isError: false};
      }
      const args = schemas.shell.parse(parsed);
      const result = await runProcess(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
        process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command] : ['-c', args.command],
        this.cwd, context.signal, args.timeout * 1000);
      return {text: '退出码：' + result.code + '\n' + result.stdout + (result.stderr ? '\n标准错误：\n' + result.stderr : ''), isError: result.code !== 0};
    } catch (error) {
      return {text: context.signal.aborted ? '工具已取消。' : error instanceof z.ZodError ? '工具参数无效：' + error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('; ')
        : error instanceof Error ? error.message : String(error), isError: true};
    }
  }
}
