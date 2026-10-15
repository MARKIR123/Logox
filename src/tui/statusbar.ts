import stringWidth from 'string-width';
import type {StageStatus} from '../runtime/stage-status.js';
import {defaultStatusbar, type StatusbarId, type StatusbarModule} from '../config/statusbar-preferences.js';
import {permissionModes} from '../runtime/permission-mode.js';

function moduleText(id: StatusbarId, status: StageStatus): string {
  switch (id) {
    case 'role': return status.name;
    case 'model': return status.model ? status.model.provider + '/' + status.model.model : '模型未配置';
    case 'effort': return '思考 ' + (status.effort ?? '不支持');
    case 'permission': return '权限 ' + (status.permission ?? '未统计');
    case 'context': return status.context ? '上下文 ' + Math.round(status.context.tokens / Math.max(1, status.context.window) * 100) + '%' : '上下文未统计';
    case 'state': return status.state;
    case 'tokens': return 'Token ' + (status.tokens === undefined ? '未统计' : status.tokens.toLocaleString('en-US'));
    case 'cost': return status.cost === undefined ? '费用未统计' : '费用 ' + (status.costCurrency ? status.costCurrency + ' ' : '') + status.cost.toFixed(4);
    case 'session': return '会话 ' + (status.session ?? '未保存');
    case 'project': return status.project ?? '目录未统计';
  }
}

/** 模块顺序同时决定窄屏优先级，整项收起，不截出半个字段。 */
export function statusbarText(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar): string {
  return statusbarParts(status, width, modules).map(part => part.text).join(' · ');
}
export function statusbarParts(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar): {text: string; color?: string}[] {
  const parts: {text: string; color?: string}[] = [];
  for (const module of modules) {
    if (!module.enabled) continue;
    const part = moduleText(module.id, status);
    if (stringWidth([...parts.map(item => item.text), part].join(' · ')) > width) break;
    const mode = status.permission;
    const color = module.id === 'permission' && mode && Object.hasOwn(permissionModes, mode) ? permissionModes[mode as keyof typeof permissionModes].color : undefined;
    parts.push({text: part, ...(color ? {color} : {})});
  }
  return parts;
}
