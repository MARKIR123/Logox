import {glob, lstat, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import type {ActorContext} from '../actors/ensemble.js';
import type {ToolCall, ToolDefinition} from '../runtime/messages.js';
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
  write: '写入完整 UTF-8 文件。先经用户批准并保存修改前备份。',
  edit: '精确替换已有文件中的文字；匹配不唯一时必须明确 replace_all。',
  glob: '按 glob 模式查找项目文件，忽略依赖、版本库和敏感文件。',
  grep: '使用 ripgrep 搜索正则表达式，返回路径、行号和匹配文字。',
  shell: '在工作目录执行命令；Windows 使用 PowerShell。必须经用户批准。',
  ask_user: '向用户提出 1–3 个问题，等待全部回答。选项为可选，支持自由文本。',
};
export const toolDefinitions: readonly ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name as ToolName], parameters: z.toJSONSchema(schema),
}));
const excluded = ['**/.git/**', '**/.logox/**', '**/node_modules/**', '**/dist/**', '**/.env*', '**/.aws/**', '**/.ssh/**', '**/legacy/**', '**/LEGACY/**'];
function sensitive(path: string): boolean {
  return path.split(/[\\/]/).some(part => ['.git', '.logox', '.aws', '.ssh', 'legacy'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.env'));
}
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
export interface ToolResult {text: string; isError: boolean}
export class Tools {
  readonly snapshots: Snapshots;
  constructor(readonly cwd: string, private readonly report: (context: ActorContext, text: string) => void = () => {}) {
    this.snapshots = new Snapshots(join(cwd, '.logox', 'snapshots'));
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
        const outcome = await context.ask({kind: 'question', ...args});
        return {text: JSON.stringify(outcome), isError: outcome.status !== 'answered'};
      }
      const path = 'path' in parsed ? await resolvedPath(resolve(this.cwd, parsed.path)) : await realpath(this.cwd);
      const root = await realpath(this.cwd);
      if (path.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy')) throw new Error('项目约定禁止读取或修改 legacy 材料');
      const readonly = ['read', 'glob', 'grep'].includes(name);
      const preparedVersion = ['write', 'edit'].includes(name) ? await fileVersion(path) : undefined;
      const needsPermission = !readonly || !inside(root, path) || sensitive(path);
      this.report(context, name + ' · ' + ('path' in parsed ? parsed.path : name === 'shell' ? schemas.shell.parse(parsed).command : ''));
      if (needsPermission) {
        const allowed = await context.permission({kind: 'permission', title: '允许执行 ' + name + ' 吗？',
          tool: name, arguments: JSON.parse(JSON.stringify(parsed)) as Record<string, z.infer<ReturnType<typeof z.json>>>,
          reason: name === 'shell' ? '命令可能修改文件或访问网络。' : readonly ? '目标位于工作目录外或属于敏感路径。' : '这次操作会修改文件，执行前会保存备份。'});
        if (!allowed) return {text: '用户拒绝了这次操作。请保留建议，不要重复请求相同操作。', isError: true};
      }
      context.signal.throwIfAborted();
      if (await resolvedPath(path) !== path) throw new Error('目标路径在等待审批期间改变，请重新请求操作');
      if (preparedVersion !== undefined && preparedVersion !== await fileVersion(path)) throw new Error('文件在等待审批期间发生变化，未执行修改；请重新读取后再请求');
      if (['read', 'edit', 'write'].includes(name)) {
        const size = await stat(path).then(info => info.size).catch(error => {if (error.code === 'ENOENT') return 0; throw error;});
        if (size > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB，请使用搜索缩小范围');
      }
      if (name === 'read') {
        const args = schemas.read.parse(parsed);
        const bytes = await bytesOrMissing(path);
        if (!bytes) throw new Error('文件不存在：' + args.path);
        if (bytes.length > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB，请使用搜索缩小范围');
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
        for await (const candidate of glob(args.pattern, {cwd: path, exclude: candidate => sensitive(candidate) || candidate.split(/[\\/]/).some(part => ['node_modules', 'dist'].includes(part.toLowerCase()))})) {
          context.signal.throwIfAborted();
          const full = join(path, candidate);
          if (sensitive(full) || !(await lstat(full)).isFile() || !inside(path, await realpath(full))) continue;
          results.push(candidate);
          if (results.length >= 1000) break;
        }
        return {text: results.sort().slice(0, 200).join('\n') + (results.length > 200 ? '\n（只展示前 200 项）' : ''), isError: false};
      }
      if (name === 'grep') {
        const args = schemas.grep.parse(parsed);
        const matchSchema = z.object({type: z.literal('match'), data: z.object({path: z.object({text: z.string()}), line_number: z.number(), lines: z.object({text: z.string()})})});
        const rawMatches: z.infer<typeof matchSchema>[] = [];
        const result = await runProcess('rg', ['--json', '--no-config', '--hidden', '--no-ignore', '--max-count', String(args.limit),
          ...excluded.flatMap(pattern => ['--iglob', '!' + pattern]), '--regexp', args.pattern, '--', path],
        this.cwd, context.signal, 30_000, 64_000, line => {
          let raw: unknown;
          try {raw = JSON.parse(line);} catch {return true;}
          const match = matchSchema.safeParse(raw);
          if (match.success && !sensitive(match.data.data.path.text)) rawMatches.push(match.data);
          return rawMatches.length < args.limit;
        });
        if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'rg 搜索失败');
        const matches: string[] = [];
        for (const item of rawMatches) {
          const file = resolve(this.cwd, item.data.path.text);
          if (sensitive(file) || !inside(path, await realpath(file))) continue;
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
