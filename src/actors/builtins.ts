import {readFileSync} from 'node:fs';
import {immutable} from '../runtime/contracts.js';
import type {ActorDefinition} from './definitions.js';

/** 人设与摘要契约原样取自 profiles/<id>/，各角色自成一篇，不再拼接共用段落。 */
const profile = (id: string, name: string) => new TextDecoder('utf-8', {fatal: true})
  .decode(readFileSync(new URL('./profiles/' + id + '/' + name, import.meta.url))).trim();
function role(id: string, name: string, title: string, symbol: string, color: string, description: string, tools: number, skills: string[] = [], cardClosed?: string, cardOpen?: string): ActorDefinition {
  return immutable({id, name, title, symbol, color, description, prompt: profile(id, 'persona.md'), compression: profile(id, 'compression.md'),
    ...(cardClosed ? {cardClosed} : {}),
    ...(cardOpen ? {cardOpen} : {}),
    context: {keep_recent_rounds: id === 'logox' ? 2 : 0, keep_recent_tools: tools}, skills});
}
export const builtinActors: readonly ActorDefinition[] = immutable([
  role('logox', 'Logox', '执导者', '◈', '#d97757', '承接用户对话，拆解目标、调度剧团、汇总结果，也直接完成简单任务。', 2, [], '#4d3227', '#613e31'),
  role('aletheia', 'Aletheia', '澄明 · 侦察者', '◎', '#7ee7c4', '调查代码、日志与资料，追踪调用链、核实来源，交付可查证的事实地图。', 2,
    ['investigate-first', 'diagnosing-bugs', 'research'], '#2c473d', '#395c4f'),
  role('techne', 'Techne', '精工 · 构建匠人', '⊞', '#e5b567', '推理、构建模块、修复根因，用实际验证闭合实现。', 2,
    ['tdd', 'safe-refactor', 'surgical-patch', 'codebase-design', 'lean-build'], '#483c27', '#5c4d32'),
  role('kalon', 'Kalon', '雅正 · 审美官', '✧', '#e8a8dc', '打磨界面、文案、提示词与代码表达，让结构与形式恰如其分。', 0,
    ['ui-ux-pro-max', 'impeccable', 'ui-styling', 'minimalist-ui', 'high-end-visual-design', 'design-system'], '#544359', '#66526c'),
]);
