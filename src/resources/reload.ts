import type {Resources} from './manager.js';

export async function reloadResources(resources: Resources, validateConfig: () => Promise<unknown>) {
  const before = JSON.stringify(resources.prompt());
  const snapshot = await resources.reload();
  const prefixChanged = before !== JSON.stringify(resources.prompt());
  const labels = {guidelines: '人工规范', skills: '技能', commands: '模板命令'};
  const report = (Object.keys(labels) as (keyof typeof labels)[]).map(kind => {
    const issues = snapshot.issues.filter(item => item.kind === kind);
    const count = snapshot[kind].length;
    return labels[kind] + '：已加载 ' + count + ' 项' + (issues.length ? '；失败 ' + issues.length + ' 项\n' +
      issues.map(item => item.path + ' · ' + item.reason).join('\n') : '，扫描成功');
  });
  try {await validateConfig(); report.push('配置：校验成功，运行配置保持原值');}
  catch {report.push('配置：校验失败，请检查 config.toml；运行配置保持原值');}
  return {prefixChanged, text: report.join('\n') + '\n提供商、MCP、hooks 与扩展代码需要重启生效。' +
    (prefixChanged ? '\n系统提示已更新，用量估算前缀已失效；历史与检查点保留。' : '\n系统提示未变化。')};
}
