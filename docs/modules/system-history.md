# 系统历史与环境通知

本模块负责命令结果、程序错误和环境变化。操作见 [USAGE](../USAGE.md)，分类依据与源码参考见[系统提示专题](../development/designs/2026-10-13-system-messages.md)。

## 保存与展示

系统事件有稳定 ID、时间、类别、所属会话和角色，可关联活动。系统身份决定灰色文字与轨道，角色归属决定所在窗口；Actor 窗口里的命令提示也不会画成角色回复。

`SystemHistory` 先发布界面，再按会话保存边界写入 Journal。临时空白只缓冲；首次正式任务登记后一起保存。正式会话的系统事件立即排队保存，关闭等待写入完成；保存失败保留缓冲并显示提示，后续可重试。欢迎信息和短暂复制/退出提示不写历史。

Journal 将系统事件另存为会话哈希的 `.events.json`，不混入 user/assistant/tool 原始模型账本。恢复沿用事件 ID 去重，并按时间放回对话；回退过滤被排除活动的事件，原文件保留。任务失败的系统事件与原任务折叠详情共用位置，不在末尾再追加整份错误。

## 哪些内容进入模型

普通本地命令结果、命令错误和原始请求错误只显示并保存。模板命令生成的任务作为正式用户输入；工具失败继续保留配对的 tool result。Actor 故障由[角色恢复](actors.md)交接简短的任务状态、失败与进展。

每次模型请求从真实状态补充执行环境：实际模型、有效思考档位、权限与行动边界、目录、工具/MCP、规范版本和角色技能。`EnvironmentState` 按角色比较上一次请求与本次状态；连续设置变更在下一次请求合并为最终值，逐次命令结果仍保存在历史。只更新设置或打开页面不启动模型，也不恢复已停止的主循环。

恢复补救上限属于当前任务限制，不改变角色工具能力。应用先比较实际工具能力，再为耗尽预算的说明回合移除工具声明，并向模型明确说明本任务限制；因此不会产生“当前可用工具：无”的环境变更或在下一轮伪造工具恢复通知。失败原因与补救上限仍归原任务交接和系统历史。

正在执行的 Actor 使用其固定任务模型，空闲时状态栏展示下次默认模型。状态栏数据由应用生成，单行布局与用户偏好由 TUI 使用；显示字段不影响模型上下文。状态栏偏好文件同时保存 motion；/status 的“动效”页签原子保存后生效，失败保留当前设置，旧文件默认开启。

## 入口与验证

| 入口 | 职责 |
|---|---|
| [system-events.ts](../../src/runtime/system-events.ts) | 独立系统事件格式 |
| [system-history.ts](../../src/store/system-history.ts)、[journal.ts](../../src/store/journal.ts) | 缓冲、保存、恢复、分支过滤与去重 |
| [environment.ts](../../src/context/environment.ts)、[application.ts](../../src/application.ts) | 请求环境与命令/登录错误的实际接线 |
| [application-status.ts](../../src/application-status.ts)、[stage-status.ts](../../src/runtime/stage-status.ts) | 当前角色真实状态数据 |
| [statusbar-preferences.ts](../../src/config/statusbar-preferences.ts)、[statusbar.ts](../../src/tui/statusbar.ts) | 用户布局保存与单行裁剪 |

[system-history.test.ts](../../tests/system-history.test.ts) 验证临时缓冲、首次保存、重启去重、回退原文保留、系统与模型账本分离、命令/请求错误和连续环境变更的真实请求；[application-status.test.ts](../../tests/application-status.test.ts) 验证 Actor 转用后的实际模型、排队任务与空闲默认模型；[stage-controls.test.tsx](../../tests/stage-controls.test.tsx) 验证灰色轨道、原位置折叠、键鼠与状态栏设置。
