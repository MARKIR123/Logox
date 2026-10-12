export const commandCatalog = [
  {name: 'help', usage: '/help', description: '查看命令和快捷键', argument: 'none'},
  {name: 'login', usage: '/login [提供商]', description: '登录并保存 API key', argument: 'loginProvider'},
  {name: 'providers', usage: '/providers', description: '选择可用提供商', argument: 'none'},
  {name: 'provider', usage: '/provider [名称] [模型]', description: '切换提供商', argument: 'provider'},
  {name: 'model', usage: '/model [提供商/模型]', description: '选择已登录提供商的模型', argument: 'model'},
  {name: 'models', usage: '/models', description: '查询可用模型', argument: 'none'},
  {name: 'check-provider', usage: '/check-provider', description: '检查真实模型连接', argument: 'none'},
  {name: 'status', usage: '/status', description: '查看模型、会话和任务', argument: 'none'},
  {name: 'config', usage: '/config', description: '查看当前生效配置', argument: 'none'},
  {name: 'cast', usage: '/cast 任务', description: '将任务交给三个角色', argument: 'text'},
  {name: 'compact', usage: '/compact', description: '扬弃：整理当前角色上下文，保留原始账本', argument: 'none'},
  {name: 'undo', usage: '/undo', description: '撤销最近一轮文件工具修改', argument: 'none'},
] as const;

/** 仅含公开名称；TUI 不读取认证、不在键入时请求外部接口。 */
export interface CommandContext {
  readonly providers: readonly string[];
  readonly loginProviders: readonly string[];
  readonly models: readonly string[];
}
export const emptyCommandContext: CommandContext = {providers: [], loginProviders: [], models: []};
export function commandHelp(): string {
  return commandCatalog.map(command => command.usage + '：' + command.description).join('\n');
}
