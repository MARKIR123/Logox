import {readFileSync} from 'node:fs';
import {immutable} from '../runtime/contracts.js';
import {parseActorProfile, type ActorDefinition} from './definitions.js';

/** 人设与摘要契约原样取自 profiles/<id>/，各角色自成一篇，不再拼接共用段落。 */
const profile = (id: string, name: string) => new TextDecoder('utf-8', {fatal: true})
  .decode(readFileSync(new URL('./profiles/' + id + '/' + name, import.meta.url))).trim();
function optionalProfile(id: string, name: string): string | undefined {
  try {return profile(id, name) || undefined;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
}
function role(id: string, name: string, title: string, symbol: string, description: string, tools: number, skills: string[] = []): ActorDefinition {
  const execution = optionalProfile(id, 'execution.md'), collaboration = optionalProfile(id, 'collaboration.md');
  const prompt = profile(id, 'persona.md'), compression = profile(id, 'compression.md');
  // Only visual defaults come from YAML here; preserve the builtin behavior/context contract.
  // Installed user profiles still take precedence when ActorCatalog loads them.
  const {color, cardClosed, cardOpen} = parseActorProfile({config: profile(id, 'config.yaml'), persona: prompt, compression,
    ...(execution ? {execution} : {}), ...(collaboration ? {collaboration} : {})});
  return immutable({id, name, title, symbol, color, description, prompt, compression,
    ...(execution ? {execution} : {}), ...(collaboration ? {collaboration} : {}),
    ...(cardClosed ? {cardClosed} : {}),
    ...(cardOpen ? {cardOpen} : {}),
    context: {keep_recent_rounds: id === 'logox' ? 2 : 0, keep_recent_tools: tools}, skills});
}
export const builtinActors: readonly ActorDefinition[] = immutable([
  role('logox', 'Logox', '执导者', '◈', '承接用户对话，拆解目标、调度剧团、汇总结果，也直接完成简单任务。', 2),
  role('aletheia', 'Aletheia', '澄明 · 侦察者', '◎', '调查代码、日志与资料，追踪调用链、核实来源，交付可查证的事实地图。', 2,
    ['investigate-first', 'diagnosing-bugs', 'research']),
  role('techne', 'Techne', '精工 · 构建匠人', '⊞', '推理、构建模块、修复根因，用实际验证闭合实现。', 2,
    ['tdd', 'safe-refactor', 'surgical-patch', 'codebase-design', 'lean-build']),
  role('kalon', 'Kalon', '雅正 · 审美官', '✧', '打磨界面、文案、提示词与代码表达，让结构与形式恰如其分。', 0,
    ['ui-ux-pro-max', 'impeccable', 'ui-styling', 'minimalist-ui', 'high-end-visual-design', 'design-system']),
]);
