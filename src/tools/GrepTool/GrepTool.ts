import {realpath, stat, readdir, readFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {pathArg, type ToolResult} from '../types.js';
import {runtimePath, searchablePath, searchExclusions} from '../../permissions/paths.js';
import {runProcess} from '../process.js';
import {normalizeAliases} from '../aliases.js';
import {resolveRgPath} from './rg-path.js';

const grepArgs = z.strictObject({
  pattern: z.string().min(1).describe('The regular expression pattern to search for in file contents'),
  path: pathArg.optional().describe('File or directory to search in. Defaults to the current working directory.'),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "**/*.tsx")'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional()
    .describe('Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".'),
  '-B': z.number().int().nonnegative().optional().describe('Number of lines to show before each match (content mode only)'),
  '-A': z.number().int().nonnegative().optional().describe('Number of lines to show after each match (content mode only)'),
  '-C': z.number().int().nonnegative().optional().describe('Number of lines to show before and after each match (content mode only)'),
  '-n': z.boolean().optional().describe('Show line numbers in content mode (default true)'),
  '-i': z.boolean().optional().describe('Case insensitive search'),
  type: z.string().optional().describe('File type to search (e.g. "js", "py")'),
  head_limit: z.number().int().min(1).max(5000).optional().describe('Limit output to the first N lines or entries. Defaults to 250.'),
  multiline: z.boolean().optional().describe('Enable multiline mode, where "." matches newlines'),
});

/** Deprecated aliases: `limit` maps to `head_limit`; `offset` is ignored during the migration window. */
export const grepSchema = z.preprocess(value => {
  const normalized = normalizeAliases(value, {limit: 'head_limit'});
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
  const result = {...(normalized as Record<string, unknown>)};
  delete result.offset;
  return result;
}, grepArgs);

export type GrepArgs = z.infer<typeof grepArgs>;

const DEFAULT_HEAD_LIMIT = 250;

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
}

function globRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index++;
      } else source += '[^/\\\\]*';
    } else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

function displayPath(base: string, file: string): string {
  return relative(base, file).replaceAll('\\', '/');
}

function fallbackExcluded(name: string, includeRuntime: boolean): boolean {
  if (name === 'node_modules' || name === '.git') return true;
  return !includeRuntime && (name === '.logox' || name === '.Logox');
}

async function executeJsGrep(
  args: GrepArgs,
  canonicalPath: string,
  cwd: string,
  includeRuntime: boolean,
  signal: AbortSignal
): Promise<ToolResult> {
  const mode = args.output_mode ?? 'files_with_matches';
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const base = await realpath(cwd).catch(() => cwd);
  const flags = 'u' + (args['-i'] ? 'i' : '') + (args.multiline ? 's' : '');
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, flags);
  } catch {
    regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
  const glob = args.glob ? globRegExp(args.glob) : undefined;
  const matches: string[] = [];

  const searchFile = async (file: string): Promise<void> => {
    if (signal.aborted || matches.length >= headLimit) return;
    if (glob && !glob.test(displayPath(base, file)) && !glob.test(relative(canonicalPath, file).replaceAll('\\', '/'))) return;
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      return;
    }
    const lines = content.split(/\r?\n/);
    if (mode === 'files_with_matches') {
      if (regex.test(args.multiline ? content : lines.join('\n'))) matches.push(displayPath(base, file));
      return;
    }
    if (mode === 'count') {
      const count = args.multiline ? (content.match(new RegExp(args.pattern, flags + 'g'))?.length ?? 0)
        : lines.reduce((total, line) => total + (new RegExp(regex.source, flags).test(line) ? 1 : 0), 0);
      if (count) matches.push(displayPath(base, file) + ':' + count);
      return;
    }
    for (let index = 0; index < lines.length; index++) {
      if (matches.length >= headLimit) break;
      if (!new RegExp(regex.source, flags).test(lines[index]!)) continue;
      const lineNumber = index + 1;
      const text = lines[index]!.trimEnd().slice(0, 2000);
      matches.push(args['-n'] === false ? displayPath(base, file) + ': ' + text : displayPath(base, file) + ':' + lineNumber + ': ' + text);
    }
  };

  const walk = async (directory: string): Promise<void> => {
    if (signal.aborted || matches.length >= headLimit) return;
    const entries = await readdir(directory, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (signal.aborted || matches.length >= headLimit) break;
      const full = resolve(directory, entry.name);
      if (!searchablePath(full, includeRuntime) || fallbackExcluded(entry.name, includeRuntime)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) await searchFile(full);
    }
  };

  const pathStat = await stat(canonicalPath).catch(() => null);
  if (!pathStat) return {text: 'Path not found: ' + canonicalPath, isError: true};
  if (pathStat.isFile()) await searchFile(canonicalPath);
  else await walk(canonicalPath);

  return {
    text: (matches.join('\n') || 'No matches found.') + (matches.length >= headLimit ? '\n(Display limit reached, search stopped)' : ''),
    isError: false,
  };
}

function commonArgs(args: GrepArgs, includeRuntime: boolean): string[] {
  return [
    '--no-config',
    '--hidden',
    '--no-ignore',
    ...(args.glob ? ['--glob', args.glob] : []),
    ...(args.type ? ['--type', args.type] : []),
    ...(args['-i'] ? ['--ignore-case'] : []),
    ...(args.multiline ? ['--multiline'] : []),
    ...(args['-B'] !== undefined ? ['-B', String(args['-B'])] : []),
    ...(args['-A'] !== undefined ? ['-A', String(args['-A'])] : []),
    ...(args['-C'] !== undefined ? ['-C', String(args['-C'])] : []),
    ...searchExclusions(includeRuntime).flatMap(pattern => ['--iglob', '!' + pattern]),
  ];
}

export async function executeGrep(
  args: GrepArgs,
  canonicalPath: string,
  originalPath: string,
  cwd: string,
  signal: AbortSignal = new AbortController().signal
): Promise<ToolResult> {
  const includeRuntime = runtimePath(originalPath) || runtimePath(canonicalPath);
  const mode = args.output_mode ?? 'files_with_matches';
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const rg = resolveRgPath();
  const base = await realpath(cwd).catch(() => cwd);

  try {
    if (mode === 'content') {
      const matchSchema = z.object({
        type: z.literal('match'),
        data: z.object({
          path: z.object({text: z.string()}),
          line_number: z.number(),
          lines: z.object({text: z.string()}),
        }),
      });
      const contextSchema = z.object({
        type: z.literal('context'),
        data: z.object({
          path: z.object({text: z.string()}),
          line_number: z.number(),
          lines: z.object({text: z.string()}),
        }),
      });
      const output: string[] = [];
      let reached = false;
      const result = await runProcess(
        rg,
        [...commonArgs(args, includeRuntime), '--json', '--regexp', args.pattern, '--', canonicalPath],
        cwd,
        signal,
        30_000,
        64_000,
        line => {
          if (output.length >= headLimit) return false;
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return true;
          }
          const match = matchSchema.safeParse(raw);
          const context = match.success ? undefined : contextSchema.safeParse(raw);
          const data = match.success ? match.data.data : context?.success ? context.data.data : undefined;
          if (!data || !searchablePath(data.path.text, includeRuntime)) return true;
          const file = resolve(cwd, data.path.text);
          const shown = displayPath(base, file);
          const text = data.lines.text.trimEnd().slice(0, 2000);
          if (match.success) output.push(args['-n'] === false ? shown + ': ' + text : shown + ':' + data.line_number + ': ' + text);
          else output.push(shown + '-' + data.line_number + '- ' + text);
          if (output.length >= headLimit) {
            reached = true;
            return false;
          }
          return true;
        }
      );
      if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'rg search failed');
      return {
        text: (output.join('\n') || 'No matches found.') + (reached ? '\n(Display limit reached, search stopped)' : ''),
        isError: false,
      };
    }

    const flag = mode === 'count' ? '--count' : '--files-with-matches';
    const result = await runProcess(
      rg,
      [...commonArgs(args, includeRuntime), flag, '--regexp', args.pattern, '--', canonicalPath],
      cwd,
      signal,
      30_000,
      64_000
    );
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'rg search failed');
    const items: string[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (mode === 'count') {
        const separator = line.lastIndexOf(':');
        const file = separator > 0 ? line.slice(0, separator) : line;
        const count = separator > 0 ? line.slice(separator + 1) : '';
        const canonical = await realpath(resolve(cwd, file)).catch(() => undefined);
        if (!canonical || !searchablePath(file, includeRuntime) || !searchablePath(canonical, includeRuntime) || !inside(canonicalPath, canonical)) continue;
        items.push(displayPath(base, canonical) + ':' + count);
      } else {
        const canonical = await realpath(resolve(cwd, line)).catch(() => undefined);
        if (!canonical || !searchablePath(line, includeRuntime) || !searchablePath(canonical, includeRuntime) || !inside(canonicalPath, canonical)) continue;
        items.push(displayPath(base, canonical));
      }
      if (items.length >= headLimit) break;
    }
    return {
      text: (items.join('\n') || 'No matches found.') + (items.length >= headLimit ? '\n(Display limit reached, search stopped)' : ''),
      isError: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || String(error).includes('ENOENT')) {
      return executeJsGrep(args, canonicalPath, cwd, includeRuntime, signal);
    }
    throw error;
  }
}

export const metadata: import('../metadata.js').ToolMetadataInput = {name: 'Grep', category: 'core', roles: 'all', terminalVisibility: 'card', description: 'Regex search in file contents via built-in ripgrep'};
