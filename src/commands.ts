export const commandCatalog = [
  {name: 'help', usage: '/help', description: '查看命令和快捷键', argument: 'none'},
  {name: 'login', usage: '/login [提供商]', description: '登录并保存 API key', argument: 'loginProvider'},
  {name: 'providers', usage: '/providers', description: '选择可用提供商', argument: 'none'},
  {name: 'provider', usage: '/provider [名称] [模型]', description: '切换提供商', argument: 'provider'},
  {name: 'model', usage: '/model [提供商/模型]', description: '选择已登录提供商的模型', argument: 'model'},
  {name: 'models', usage: '/models', description: '查询可用模型', argument: 'none'},
  {name: 'check-provider', usage: '/check-provider', description: '检查真实模型连接', argument: 'none'},
  {name: 'effort', usage: '/effort [档位]', description: '选择模型支持的思考档位，重启保留', argument: 'none'},
  {name: 'usage', usage: '/usage', description: '查看当前角色任务和汇总用量、静态费用', argument: 'none'},
  {name: 'status', usage: '/status', description: '查看模型、会话和任务', argument: 'none'},
  {name: 'config', usage: '/config', description: '查看当前生效配置', argument: 'none'},
  {name: 'cast', usage: '/cast 任务', description: '将任务交给三个角色', argument: 'text'},
  {name: 'actors', usage: '/actors [model 角色]', description: '查看剧团职能、压缩参数与默认模型', argument: 'none'},
  {name: 'compact', usage: '/compact', description: '扬弃：整理当前角色上下文，保留原始账本', argument: 'none'},
  {name: 'new', usage: '/new', description: '创建并切换到新会话', argument: 'none'},
  {name: 'resume', usage: '/resume [会话 ID]', description: '选择历史会话或按 ID 恢复', argument: 'none'},
  {name: 'clear', usage: '/clear', description: '清空对话显示，保留模型上下文和文件', argument: 'none'},
  {name: 'rewind', usage: '/rewind', description: '选择轮次，回退对话和文件工具修改', argument: 'none'},
  {name: 'undo', usage: '/undo', description: '撤销最近一轮文件工具修改', argument: 'none'},
  {name: 'permissions', usage: '/permissions [mode/add/revoke]', description: '查看权限、切换模式、显式新增或撤销规则', argument: 'text'},
  {name: 'reload', usage: '/reload', description: '重新扫描人设、规范、技能和模板命令', argument: 'none'},
  {name: 'skills', usage: '/skills', description: '查看技能名称、描述和路径', argument: 'none'},
  {name: 'commands', usage: '/commands', description: '查看内置与自定义命令', argument: 'none'},
] as const;

/** 仅含公开名称；TUI 不读取认证、不在键入时请求外部接口。 */
export interface CommandContext {
  readonly providers: readonly string[];
  readonly loginProviders: readonly string[];
  readonly models: readonly string[];
  readonly customCommands?: readonly {name: string; description: string}[];
}
export const emptyCommandContext: CommandContext = {providers: [], loginProviders: [], models: []};
export function commandHelp(): string {
  return commandCatalog.map(command => command.usage + '：' + command.description).join('\n');
}
