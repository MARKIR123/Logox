import {basename, dirname, isAbsolute, resolve} from 'node:path';
import type {PermissionTarget} from './engine.js';

/** Project roots a path is judged against; `undefined` means no project is known and the whole `.logox` tree stays protected. */
export type ProjectRoots = string | readonly string[] | undefined;
/** The user home directories (as typed and canonical) whose `.logox/memory` folder holds user-level memory records. */
export type UserHomes = string | readonly string[];
const parts = (path: string) => path.split(/[\\/]/).map(part => part.toLowerCase());
const fileKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
/**
 * Exactly `<project>/.logox/bulletin.md` (the team's shared notebook) is an ordinary project file.
 * The comparison is on the normalized path only: a nested `.logox`, the user-level one or any other file in the tree does not match,
 * and a symlinked target is judged by its canonical path, which is not this file.
 */
export function isProjectBulletin(path: string, roots: ProjectRoots): boolean {
  if (roots === undefined) return false;
  return (typeof roots === 'string' ? [roots] : roots).some(root => fileKey(resolve(root, path)) === fileKey(resolve(root, '.logox', 'bulletin.md')));
}
/**
 * A Markdown record directly inside `<project>/.logox/memory/` or `<home>/.logox/memory/` (the long-term memory Anamnesis keeps and any actor may write on request).
 * Exact like the bulletin: the normalized path must be `<base>/.logox/memory/<file>.md`; a subfolder, another extension, a sibling such as `memory-x`
 * and a `..` route to anything else do not match, and a symlinked target is judged by its canonical path. The home is only compared as an absolute path.
 */
export function isMemoryRecord(path: string, roots: ProjectRoots, home?: UserHomes): boolean {
  const record = (base: string, full: string) => /\.md$/i.test(basename(full)) && basename(full).length > 3 &&
    fileKey(dirname(full)) === fileKey(resolve(base, '.logox', 'memory'));
  const projects = roots === undefined ? [] : typeof roots === 'string' ? [roots] : roots;
  const homes = home === undefined ? [] : typeof home === 'string' ? [home] : home;
  return projects.some(root => record(root, resolve(root, path))) || (isAbsolute(path) && homes.some(base => record(base, resolve(path))));
}
// '.logox-ts' is retained below for stale legacy directories that may still hold credentials.
export function runtimePath(path: string, roots?: ProjectRoots, home?: UserHomes): boolean {
  return parts(path).some(part => part === '.logox' || part === '.logox-ts') && !isProjectBulletin(path, roots) && !isMemoryRecord(path, roots, home);
}
/** Fixed diagnostic code for runtime-record writes; creative (development) mode allows it, and credential and repository protection are unaffected. */
export const RUNTIME_WRITE_DANGER = 'Modifies runtime state or history records';
/** Runtime records may be inspected; real credential and repository protection cannot be lifted by a directory read. */
export function pathDanger(path: string, effect: PermissionTarget['effect'], roots?: ProjectRoots, home?: UserHomes): string | undefined {
  const segments = parts(path);
  if (segments.some(part => ['.aws', '.ssh'].includes(part) || part.startsWith('.env') ||
    /^(?:auth\.json|credentials(?:\.json|\.toml)?|id_rsa|id_ed25519)(?:$|\.)/.test(part))) return 'Target involves credentials or private keys';
  if (segments.some(part => part === '.git')) return 'Target involves repository internals';
  if (effect === 'write' && runtimePath(path, roots, home)) return RUNTIME_WRITE_DANGER;
  return;
}
export function riskyPath(path: string, effect: PermissionTarget['effect'], roots?: ProjectRoots, home?: UserHomes): boolean {
  return !!pathDanger(path, effect, roots, home) || effect !== 'read' && runtimePath(path, roots, home);
}
export function searchablePath(path: string, includeRuntime: boolean): boolean {
  return !pathDanger(path, 'read') && !parts(path).includes('legacy') && (includeRuntime || !runtimePath(path));
}
export function searchExclusions(includeRuntime: boolean): readonly string[] {
  return ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/.env*', '**/.aws/**', '**/.ssh/**',
    '**/auth.json*', '**/credentials', '**/credentials.*', '**/id_rsa*', '**/id_ed25519*', '**/legacy/**', '**/LEGACY/**',
    ...(includeRuntime ? [] : ['**/.logox/**', '**/.logox-ts/**'])];
}
