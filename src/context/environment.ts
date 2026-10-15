import {createHash} from 'node:crypto';

export interface ExecutionEnvironment {
  model: string; effort: string; permission: string; directory: string;
  tools: readonly string[]; skills: readonly string[]; rules: string; services: readonly string[];
}
const labels: Record<keyof ExecutionEnvironment, string> = {
  model: '实际任务模型', effort: '思考档位', permission: '权限与行动边界', directory: '工作目录',
  tools: '当前可用工具', skills: '角色可用技能', rules: '当前规范版本', services: '服务连接状态',
};
/** 当前状态每次入请求；界面变更按角色去重，不保存重复的模型消息。 */
export class EnvironmentState {
  private readonly states = new Map<string, ExecutionEnvironment>();
  update(ownerId: string, next: ExecutionEnvironment): {text: string; changes: string} {
    const previous = this.states.get(ownerId);
    const keys = Object.keys(labels) as Array<keyof ExecutionEnvironment>;
    const show = (key: keyof ExecutionEnvironment) => labels[key] + '：' +
      (Array.isArray(next[key]) ? (next[key] as readonly string[]).join('、') || '无' : next[key]);
    const changed = previous ? keys.filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key])) : [];
    this.states.set(ownerId, structuredClone(next));
    return {text: keys.map(show).join('\n'), changes: changed.map(show).join('\n')};
  }
}
export function environmentVersion(text: string): string {return createHash('sha256').update(text).digest('hex').slice(0, 12);}
