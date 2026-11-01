import type {PermissionTarget} from './engine.js';

const parts = (path: string) => path.split(/[\\/]/).map(part => part.toLowerCase());
// '.logox-ts' is retained below for stale legacy directories that may still hold credentials.
export function runtimePath(path: string): boolean {return parts(path).some(part => part === '.logox' || part === '.logox-ts');}
/** Fixed diagnostic code for runtime-record writes; creative (development) mode allows it, and credential and repository protection are unaffected. */
export const RUNTIME_WRITE_DANGER = 'Modifies runtime state or history records';
/** Runtime records may be inspected; real credential and repository protection cannot be lifted by a directory read. */
export function pathDanger(path: string, effect: PermissionTarget['effect']): string | undefined {
  const segments = parts(path);
  if (segments.some(part => ['.aws', '.ssh'].includes(part) || part.startsWith('.env') ||
    /^(?:auth\.json|credentials(?:\.json|\.toml)?|id_rsa|id_ed25519)(?:$|\.)/.test(part))) return 'Target involves credentials or private keys';
  if (segments.some(part => part === '.git')) return 'Target involves repository internals';
  if (effect === 'write' && runtimePath(path)) return RUNTIME_WRITE_DANGER;
  return;
}
export function riskyPath(path: string, effect: PermissionTarget['effect']): boolean {
  return !!pathDanger(path, effect) || effect !== 'read' && runtimePath(path);
}
export function searchablePath(path: string, includeRuntime: boolean): boolean {
  return !pathDanger(path, 'read') && !parts(path).includes('legacy') && (includeRuntime || !runtimePath(path));
}
export function searchExclusions(includeRuntime: boolean): readonly string[] {
  return ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/.env*', '**/.aws/**', '**/.ssh/**',
    '**/auth.json*', '**/credentials', '**/credentials.*', '**/id_rsa*', '**/id_ed25519*', '**/legacy/**', '**/LEGACY/**',
    ...(includeRuntime ? [] : ['**/.logox/**', '**/.logox-ts/**'])];
}
