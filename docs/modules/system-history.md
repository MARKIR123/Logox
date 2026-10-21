# 系统历史与环境通知

命令结果、程序错误和环境变更不是助手回复，也不都应该送入模型。本模块把**展示、持久化、模型输入**分开，避免界面通知污染对话或冒充人工授权。

## 保存与展示

系统事件带稳定 ID、时间、类别、会话、角色和可选活动身份。它们用独立系统样式显示，仍归属正确的角色窗口。任务错误关联原任务的折叠详情，不在后续回复里反复追加整份诊断。

临时空白会话先缓冲系统事件，首次正式任务登记后保存；正式会话按队列写入，关闭时等待收尾。保存失败保留缓冲并报告，而不是假装已落盘。欢迎信息、复制提示和退出提醒等短暂 UI 状态不都写入历史。

Journal 的会话哈希 `.events.json` 及分支记录用于实际恢复，系统事件不混入 user/assistant/tool 原始模型账本。另有 `sessions/<sessionId>/events.json` 等可读镜像；镜像是便于人工检查的副本，不应当成唯一权威来源。恢复按事件 ID 去重，回退只过滤对应活动，原始记录保留。

## 哪些内容进入模型

| 内容 | 模型如何处理 |
|---|---|
| 普通本地命令结果、页面与命令错误 | 展示/保存，不自动变成模型消息 |
| 模板展开后的任务 | 作为正式任务输入 |
| 工具失败 | 保留与调用配对的 tool result |
| Actor 报告与故障交接 | 按角色来源携带必要状态，不当成人工新增授权 |
| 实际执行环境变化 | 下一次请求按角色补充最新状态 |

执行环境包括实际任务模型、思考档位、权限模式、目录、工具/MCP、资源版本和技能可见性。EnvironmentState 比较前后快照，连续设置变化在下一次请求合并为最终值；只打开设置页面或更改选项不会自动启动任务。

故障预算耗尽是当前任务的执行限制，不应伪造成整个工具环境永久消失；下一任务也不应因此收到虚假的“工具恢复”通知。

## 状态栏

应用提供当前窗口的真实状态，TUI 负责布局和裁剪。运行中的 Actor 显示本任务实际模型，空闲时显示其默认选择；排队任务不会遮住正在运行的模型身份。

布局和 motion 偏好主文件为 `~/.logox/statusbar.json`，保留兼容目录读取。保存成功才发布新设置，失败保留旧状态。状态栏字段本身不决定模型上下文、权限或账单。

## 源码入口

- [system-events.ts](../../src/runtime/system-events.ts)：系统事件格式。
- [system-history.ts](../../src/store/system-history.ts)：缓冲、保存与恢复。
- [journal.ts](../../src/store/journal.ts)：权威事件、分支与可读镜像。
- [environment.ts](../../src/context/environment.ts)：请求环境变化。
- [application-status.ts](../../src/application-status.ts)、[statusbar-preferences.ts](../../src/config/statusbar-preferences.ts)：窗口状态与用户偏好。

测试入口：[系统历史](../../tests/system-history.test.ts)、[角色状态](../../tests/application-status.test.ts)、[界面控制](../../tests/stage-controls.test.tsx)。操作见[终端操作](../UI-SPEC.md)。
