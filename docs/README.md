# LOGOX TS 文档导航

> **面向 Agent 探索的指引**：
> - 代码是事实（HOW），它回答“现在如何实现”；
> - 目录中的 `AGENT.md` 是第一优先级的快速路标，回答“代码在哪里、有什么刚性红线、如何导航”；
> - 本 `docs/` 目录是第二优先级的深度背景，回答“为什么这样设计（WHY）”以及“模块之间如何协同”。在遇到架构重构、权衡分歧或理解跨模块设计意图时，按需查阅对应的专题设计与复盘。

当前说明回答“现在怎样使用、怎样实现”，专题设计回答“某项功能的方案和取舍”，复盘回答“某个问题怎样定位和验证”。文档以当前工作树为基准；未完成或待集成工作见 STATUS。

## 日常入口

| 要做什么 | 读哪里 |
|---|---|
| 启动真实模型或 demo | [项目 README](../README.md) |
| 配置、任务、命令与恢复 | [USAGE](USAGE.md) |
| 开发与文档维护 | [WORKFLOW](development/WORKFLOW.md) |
| 找当前职责与源码 | [模块地图](modules/README.md)、[上下文管理](modules/context.md)、[角色定义与协作](modules/actors.md)、[任务模型](modules/task-models.md) |
| 核对当前布局与输入交互 | [UI-SPEC](UI-SPEC.md) |
| 验证代码、终端或文档 | [TESTING](development/TESTING.md) |
| 接手未完成事项 | [STATUS](development/STATUS.md) |
| 核对整体目标与阶段 | [迁移总览](development/designs/2026-10-11-typescript-migration.md) |
| 术语与常驻协作约束 | [GLOSSARY](../GLOSSARY.md)、[AGENTS](../AGENTS.md) |

## 专题设计与复盘

按当前任务选择专题，实施状态与未验证边界在各专题首部和验收部分说明。

| 主题 | 文档回答的问题 |
|---|---|
| [运行时活动与异步交互](development/designs/2026-10-11-runtime-interactions.md) | 活动、请求、角色队列、取消和 demo/入梦生命周期如何共用协议？ |
| [终端舞台与卡片](development/designs/2026-10-11-terminal-ui.md) | 轨道、卡片、窗口、输入和复制为何这样设计？ |
| [系统提示、历史与上下文](development/designs/2026-10-13-system-messages.md) | 命令结果、程序错误和短暂提示怎样显示、保存，以及哪些内容进入模型？ |
| [Agent、工具与文件恢复](development/designs/2026-10-12-agent-tools.md) | 模型/工具闭环、结束判断、审批、快照与取消怎样收尾？ |
| [提供商与持久登录](development/designs/2026-10-12-provider-login.md) | 认证保存、请求选择、失败边界及真实服务验收是什么？ |
| [前台模型偏好与用量](development/designs/2026-10-12-model-preferences-and-usage.md) | 思考档位、模型重启保留和真实用量费用如何配置？ |
| [会话管理与一致回退](development/designs/2026-10-12-session-management.md) | 会话切换、进程租约、原文分支和文件恢复怎样一致收尾？ |
| [上下文预算与压缩](development/designs/2026-10-12-context-compaction.md) | 轮次摘要、工具归档、窗口计量和恢复怎样共用？ |
| [持久角色与模型](development/designs/2026-10-12-persistent-actors.md) | 角色定义、独立模型、协作和确认式转用如何接入？ |
| [Slash 交互](development/designs/2026-10-12-slash-interactions.md) | 补全、picker、页签、完成和取消怎样复用？ |
| [资源与基础扩展](development/designs/2026-10-12-resources-and-extensions.md) | 人设、逐层规范、技能、模板命令、reload、MCP 与观察 hooks 如何接入？ |
| [连续回复布局循环复盘](development/reviews/2026-10-12-ink-update-loop.md) | 更新深度错误的触发、定位、修复与回归证据是什么？ |
| [只有思考、没有行动的复盘](development/reviews/2026-10-14-reasoning-without-action.md) | 输出耗尽为何重复推理？PI/CC 的接续、预算与任务拆分有什么不同？ |
| [剧团系统诊断与改进交接](development/reviews/2026-10-15-subagent-system-diagnosis.md) | 目标膨胀、Actor 探查失控、多模态缺口、串行调度、故障信息和恢复预算怎样共同造成脆弱与低效？包含无工具审阅者所需背景、关键代码、协作示例和验收要求。 |
| [任务推进与思考耗尽恢复](development/designs/2026-10-14-task-progress-and-reasoning-recovery.md) | 如何分阶段交付、处理无交付思考，并结合剧团接管和卡片体验？ |
| [剧团协作效能与视觉能力](development/designs/2026-10-15-subagent-efficiency-and-vision.md) | 参数错误精准原位自愈、预算重置、收尾契约、角色隔离并发与多模态视觉能力怎样接入？ |
| [提示词工程架构与缓存边界](development/designs/2026-10-15-prompt-engineering-architecture.md) | 静态切片、Prompt Caching 缓存分水岭、通用行为宪章与定量数值控制怎样设计？ |
| [确定性截图与 `browser-shot` 定位](development/designs/2026-10-19-browser-shot-determinism.md) | 虚拟时钟为什么要在导航前冻结？截图为何不做成一等公民工具？ |

[Gemini UI 交接](development/handoffs/2026-10-11-ui-gemini/HANDOFF.md)和[离线 HTML](development/handoffs/2026-10-11-ui-gemini/logox-ui-demo.html)保留交接时的场景，当前 UI 查 UI-SPEC。[角色人设交接](development/handoffs/2026-10-13-actor-personas/HANDOFF.md)保留人设重写前的诊断与蓝本，现行正文查角色模块。

文件归属、随功能推进的整理时机与交付检查由 WORKFLOW 维护。新主题建立独立入口，同一主题原地修订；正式说明独立可读。LEGACY/legacy 和明确标为 legacy 的材料不参与开发读取与验证。

[阶段流程与标题文案打磨任务](development/handoffs/2026-10-14-stage-flow-and-titles.md)保留需求与用户定案交接；方案与验收在[阶段与恢复设计](development/designs/2026-10-14-task-progress-and-reasoning-recovery.md)维护，已接入的界面规则查 UI-SPEC。

权限规则与只读调度见[专题设计](development/designs/2026-10-12-permissions-and-scheduling.md)。
