# LOGOX TS 文档导航

当前说明回答“现在怎样使用、怎样实现”，专题设计回答“某项功能的方案和取舍”，复盘回答“某个问题怎样定位和验证”。文档以工作树为基准，当前尚未提交。

## 日常入口

| 要做什么 | 读哪里 |
|---|---|
| 启动真实模型或 demo | [项目 README](../README.md) |
| 配置、任务、命令与恢复 | [USAGE](USAGE.md) |
| 开发与文档维护 | [WORKFLOW](development/WORKFLOW.md) |
| 找当前职责与源码 | [模块地图](modules/README.md)、[上下文管理](modules/context.md) |
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
| [Agent、工具与文件恢复](development/designs/2026-10-12-agent-tools.md) | 模型/工具闭环、结束判断、审批、快照与取消怎样收尾？ |
| [提供商与持久登录](development/designs/2026-10-12-provider-login.md) | 认证保存、请求选择、失败边界及真实服务验收是什么？ |
| [上下文预算与压缩](development/designs/2026-10-12-context-compaction.md) | 轮次摘要、工具归档、窗口计量和恢复怎样共用？ |
| [持久角色与模型](development/designs/2026-10-12-persistent-actors.md) | 角色定义、独立模型、协作和确认式转用如何接入？ |
| [Slash 交互](development/designs/2026-10-12-slash-interactions.md) | 补全、picker、页签、完成和取消怎样复用？ |
| [连续回复布局循环复盘](development/reviews/2026-10-12-ink-update-loop.md) | 更新深度错误的触发、定位、修复与回归证据是什么？ |

[Gemini UI 交接](development/handoffs/2026-10-11-ui-gemini/HANDOFF.md)和[离线 HTML](development/handoffs/2026-10-11-ui-gemini/logox-ui-demo.html)保留交接时的场景，当前 UI 查 UI-SPEC。

文件归属、随功能推进的整理时机与交付检查由 WORKFLOW 维护。新主题建立独立入口，同一主题原地修订；正式说明独立可读。LEGACY/legacy 和明确标为 legacy 的材料不参与开发读取与验证。
