import {glob, lstat, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {z} from 'zod';
import {pathArg, type ToolResult} from '../types.js';
import {runtimePath, searchablePath} from '../../permissions/paths.js';

export const globSchema = z.strictObject({
  pattern: z.string().min(1),
  path: pathArg.default('.'),
});

export type GlobArgs = z.infer<typeof globSchema>;

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
}

export async function executeGlob(
  args: GlobArgs,
  canonicalPath: string,
  originalPath: string,
  signal?: AbortSignal
): Promise<ToolResult> {
  if (isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes('..')) {
    throw new Error('pattern must be relative to target directory');
  }
  const results: string[] = [];
  const includeRuntime = runtimePath(originalPath) || runtimePath(canonicalPath) || runtimePath(args.pattern);

  for await (const candidate of glob(args.pattern, {
    cwd: canonicalPath,
    exclude: candidate =>
      !searchablePath(candidate, includeRuntime) ||
      candidate.split(/[\\/]/).some(part => ['node_modules', 'dist'].includes(part.toLowerCase())),
  })) {
    signal?.throwIfAborted();
    const full = join(canonicalPath, candidate);
    if (!searchablePath(full, includeRuntime) || !(await lstat(full)).isFile() || !inside(canonicalPath, await realpath(full))) {
      continue;
    }
    results.push(candidate);
    if (results.length >= 1000) break;
  }

  return {
    text: results.sort().slice(0, 200).join('\n') + (results.length > 200 ? '\n(Showing first 200 items)' : ''),
    isError: false,
  };
}
