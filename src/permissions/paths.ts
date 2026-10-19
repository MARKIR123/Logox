import type {PermissionTarget} from './engine.js';

const parts = (path: string) => path.split(/[\\/]/).map(part => part.toLowerCase());
export function runtimePath(path: string): boolean {return parts(path).some(part => part === '.logox' || part === '.logox-ts');}
/** 运行记录写入的固定诊断码；creative（开发）模式据此放行，凭据与版本库保护不受影响。 */
export const RUNTIME_WRITE_DANGER = '修改运行状态或历史记录';
/** 运行记录可以诊断；真实认证与版本库保护不能由目录读取一起解除。 */
export function pathDanger(path: string, effect: PermissionTarget['effect']): string | undefined {
  const segments = parts(path);
  if (segments.some(part => ['.aws', '.ssh'].includes(part) || part.startsWith('.env') ||
    /^(?:auth\.json|credentials(?:\.json|\.toml)?|id_rsa|id_ed25519)(?:$|\.)/.test(part))) return '目标涉及凭据或私钥';
  if (segments.some(part => part === '.git')) return '目标涉及版本库内部资料';
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
