/**
 * 剧团协作工具专属提示词
 * 参考 Claude Code 的 colocated tool prompts 设计：
 * 工具的说明、调用约束与使用准则集中管理，不与运行时调度逻辑混杂。
 */

export const DISPATCH_ROLE_PROMPT = {
  description: '派发角色任务，支持多角色并行并发推进；独立工作（如视觉与物理、探查与设计）应在同一批次中同时派发以最大化协作效率；结束本轮等待自动汇合回传。续做用 resumeTask 指定原失败活动；skills 可借阅。',
  usageNotes: `【派发协作准则】
- 并行推进：互不依赖的任务（如 Kalon 产出 SVG 骨架、Techne 编写算法脚本、Aletheia 审查基线）必须在同一次 dispatch_role 中同时派发；
- 结构化契约：明确 goal、constraints、minDeliverable（最小交付物）与 stopCondition（收尾条件）；
- 拒绝空泛委托：派发时给出具体文件路径、已知参数和坐标，避免子角色重复排查。`,
};

export const CRAFT_ACTOR_PROMPT = {
  description: '提交完整角色 Markdown：Frontmatter 配置＋第二人称人设，含渊源与信条、语风、微动作、关系和职责；协作用 request_assist，不自行派工。用户批准精确文件与正文后保存并重载。',
};

export const READ_ACTOR_PROMPT = {
  description: '按需读取角色当前有效分支的摘要与工作记录。',
};

export const BORROW_SKILL_PROMPT = {
  description: '为本任务借阅已有技能索引；需先读取对应 SKILL.md，任务结束即失效。',
};
