import {execFile} from 'node:child_process';
import {readdir, realpath, stat} from 'node:fs/promises';
import {join, relative} from 'node:path';

/**
 * Which workspace files a foreground Shell command changed: a cheap state before and after the command, compared.
 *
 * In a git work tree the state is `git status` (every file that differs from HEAD, untracked ones included, ignored ones not) plus the mtime and
 * size of each listed file: a file the command touched either newly appears in the list or keeps its place with another mtime or size. Outside git
 * the workspace is walked (skipping dependency and build folders) up to `WALK_LIMIT` files; a larger tree is not audited (`undefined`), because a
 * slow command is a worse error than a missing record. Paths are workspace-relative with `/`.
 */
export type WorkspaceState = ReadonlyMap<string, string>;

/** Files a walk may stat before the audit gives up on a workspace that is not a git work tree. */
export const WALK_LIMIT = 5000;
const SKIPPED_DIRS = new Set(['.git', '.logox', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', '.cache']);

function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', [...args], {cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(signal ? {signal} : {})}, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

async function fingerprint(cwd: string, path: string): Promise<string> {
  try {
    const info = await stat(join(cwd, path));
    return info.isFile() ? info.mtimeMs + ':' + info.size : 'dir';
  } catch {return 'missing';}
}

async function walk(cwd: string): Promise<string[] | undefined> {
  const files: string[] = [], pending = [''];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries;
    try {entries = await readdir(join(cwd, dir), {withFileTypes: true});} catch {continue;}
    for (const entry of entries) {
      const path = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {if (!SKIPPED_DIRS.has(entry.name)) pending.push(path);}
      else if (entry.isFile()) {
        files.push(path);
        if (files.length > WALK_LIMIT) return undefined;
      }
    }
  }
  return files;
}

/** Each workspace's git work tree root (null outside git), asked once: a process spawn costs more than the status itself on Windows. */
const workTrees = new Map<string, string | null>();

/** Paths `git status` reports (both sides of a rename), or undefined outside a git work tree. */
async function gitListed(cwd: string): Promise<string[] | undefined> {
  if (!workTrees.has(cwd)) workTrees.set(cwd, (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() ?? null);
  const root = workTrees.get(cwd);
  if (!root) return undefined;
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (out === undefined) return undefined;
  const paths: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]!;
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C') i++; // the source path of a rename or copy follows as its own field
  }
  // git reports paths from the work tree root; the audit speaks of the workspace.
  return paths.map(path => relative(cwd, join(root, path)).replaceAll('\\', '/')).filter(path => path && !path.startsWith('../'));
}

/** The project folder Logox keeps for itself and the user (`src/config/project-data.ts`); never audited. */
const RUNTIME_DIR = '.logox';

/** Workspaces outside git found too large to walk: they are not walked again for the rest of the process. */
const tooLarge = new Set<string>();

/** The workspace's state now, or undefined when it cannot be taken cheaply (no git and too many files). */
export async function workspaceState(workspace: string): Promise<WorkspaceState | undefined> {
  // git names paths from the real work tree root: a short 8.3 path or a link to the workspace would never match them.
  const cwd = await realpath(workspace).catch(() => workspace);
  const listed = await gitListed(cwd) ?? (tooLarge.has(cwd) ? undefined : await walk(cwd));
  if (!listed) {tooLarge.add(cwd); return undefined;}
  // `.logox/` is the runtime's and the user's (bulletin, config, actors): what the runtime writes there during a command is never the command's.
  const audited = listed.filter(path => !path.startsWith(RUNTIME_DIR + '/'));
  return new Map(await Promise.all(audited.map(async path => [path, await fingerprint(cwd, path)] as const)));
}

/**
 * Files that differ between two states. In a git tree a file absent from one listing is as it is in HEAD: it changed when it appears, and also
 * when it disappears (a command reverted it to HEAD). Sorted, without duplicates.
 */
export function changedBetween(before: WorkspaceState, after: WorkspaceState): string[] {
  const changed = new Set<string>();
  for (const [path, mark] of after) if (before.get(path) !== mark) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}
