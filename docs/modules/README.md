# 模块总览

Logox 将终端显示、任务执行、模型请求和持久化分开。使用方法见[使用指南](../USAGE.md)；这里说明各部分怎样配合，以及从哪里读代码。

## 一次任务的路径

1. CLI 加载配置、模型服务和项目资源，创建或恢复会话。
2. 输入交给 Logox 或指定角色，运行时创建带身份和来源的活动。
3. Agent 准备有效上下文，请求模型，再校验和执行模型提出的工具调用。
4. 工具经过参数、路径与权限检查；结果和原始消息落账，界面订阅运行时快照。
5. 任务结束保存状态与摘要；角色成果交回协调者，后续请求按预算读取历史。

同一角色的任务串行，不同角色可以并发；它们共享文件系统。界面不直接执行工具，也不维护第二套权限或历史。

## 按主题阅读

| 模块 | 说明 |
|---|---|
| [角色与协作](actors.md) | 角色定义、任务队列、消息、技能与取消边界 |
| [任务模型](task-models.md) | 会话模型、Actor 默认模型、确认转用与恢复 |
| [上下文](context.md) | 原始账本、请求投影、摘要、工具归档与预算 |
| [资源与扩展](resources-and-extensions.md) | 规范、层级技能、模板、MCP 与观察 hooks |
| [系统历史](system-history.md) | 系统事件、环境变更、状态栏与模型输入的区别 |
| [终端操作](../UI-SPEC.md) | 输入、角色窗口、卡片、滚动与复制 |

## 主要源码入口

| 职责 | 入口 |
|---|---|
| 启动与装配 | [cli.tsx](../../src/cli.tsx)、[application.ts](../../src/application.ts)、[application-sessions.ts](../../src/application-sessions.ts) |
| 配置与模型服务 | [config.ts](../../src/config/config.ts)、[registry.ts](../../src/providers/registry.ts)、[http.ts](../../src/providers/http.ts) |
| 模型与工具循环 | [agent.ts](../../src/kernel/agent.ts)、[tools.ts](../../src/tools/tools.ts)、[工具注册](../../src/tools/index.ts) |
| 活动与交互状态 | [contracts.ts](../../src/runtime/contracts.ts)、[store.ts](../../src/runtime/store.ts) |
| 权限与文件快照 | [engine.ts](../../src/permissions/engine.ts)、[snapshots.ts](../../src/tools/snapshots.ts) |
| 会话与原始记录 | [sessions.ts](../../src/store/sessions.ts)、[journal.ts](../../src/store/journal.ts) |
| 终端显示 | [app.tsx](../../src/tui/app.tsx)、[scene.ts](../../src/tui/timeline/scene.ts)、[terminal-plane.ts](../../src/tui/terminal/terminal-plane.ts) |

## 存储与恢复的边界

项目 `.logox/state/` 保存会话索引、记录、检查点与用量。`Journal` 的哈希命名原始文件及分支记录是恢复读取的依据；`sessions/<sessionId>/` 中另有便于阅读的 `director.jsonl`、`tasks.json`、`events.json` 和 `subagents/` 镜像，镜像写入失败不会取代权威记录。

恢复会话不会自动重放工具。`/clear` 仅清显示；`/undo` 与 `/rewind` 基于文件工具快照，不回滚任意 Shell/MCP 副作用。删除会话先写入回收备份；进程租约阻止多个实例同时操作同一会话。

基础工具包括文件读写、精确编辑、搜索、Shell、提问与网页读取；图片可通过 `Read` 读取。当前没有 PDF/Notebook 专门读取契约。权限模式是应用内裁决，不是操作系统沙箱。

入梦模块目前提供生命周期和 demo 接入，正式模型入口尚未装配长期后台研究管线；磁盘插件也没有正式加载器。

## 开发验证

运行 `npm run check` 检查类型和公开文档，`npm test` 构建并运行测试。分组入口见[测试路标](../../tests/AGENTS.md)，各目录边界见[根路标](../../AGENTS.md)。自动化运行应隔离用户 home，避免构建资源同步影响真实配置。
