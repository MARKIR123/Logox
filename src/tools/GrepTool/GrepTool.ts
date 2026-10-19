import {realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {pathArg, type ToolResult} from '../types.js';
import {runtimePath, searchablePath, searchExclusions} from '../../permissions/paths.js';
import {runProcess} from '../process.js';

export const grepSchema = z.object({
  pattern: z.string().min(1),
  path: pathArg.default('.'),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().optional(),
});

export type GrepArgs = z.infer<typeof grepSchema>;

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
}

export async function executeGrep(
  args: GrepArgs,
  canonicalPath: string,
  originalPath: string,
  cwd: string,
  signal: AbortSignal = new AbortController().signal
): Promise<ToolResult> {
  const includeRuntime = runtimePath(originalPath) || runtimePath(canonicalPath);
  const matchSchema = z.object({
    type: z.literal('match'),
    data: z.object({
      path: z.object({text: z.string()}),
      line_number: z.number(),
      lines: z.object({text: z.string()}),
    }),
  });
  const rawMatches: z.infer<typeof matchSchema>[] = [];

  const result = await runProcess(
    'rg',
    [
      '--json',
      '--no-config',
      '--hidden',
      '--no-ignore',
      '--max-count',
      String(args.limit),
      ...searchExclusions(includeRuntime).flatMap(pattern => ['--iglob', '!' + pattern]),
      '--regexp',
      args.pattern,
      '--',
      canonicalPath,
    ],
    cwd,
    signal,
    30_000,
    64_000,
    line => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return true;
      }
      const match = matchSchema.safeParse(raw);
      if (match.success && searchablePath(match.data.data.path.text, includeRuntime)) {
        rawMatches.push(match.data);
      }
      return rawMatches.length < args.limit;
    }
  );

  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr || 'rg search failed');
  }

  const matches: string[] = [];
  for (const item of rawMatches) {
    const file = resolve(cwd, item.data.path.text);
    const canonical = await realpath(file);
    if (!searchablePath(file, includeRuntime) || !searchablePath(canonical, includeRuntime) || !inside(canonicalPath, canonical)) {
      continue;
    }
    matches.push(relative(cwd, file) + ':' + item.data.line_number + ': ' + item.data.lines.text.trimEnd().slice(0, 2000));
    if (matches.length >= args.limit) break;
  }

  return {
    text: (matches.join('\n') || 'No matches found.') + (rawMatches.length >= args.limit ? '\n(Display limit reached, search stopped)' : ''),
    isError: false,
  };
}
