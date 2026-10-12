# Agent 循环、工具与文件恢复

日期：2026-10-12。状态：真实编程助手主链路已实现；完整基本功能仍在迁移。

本文覆盖自然语言 → 模型 → 工具 → 审批 → 结果续推 → 保存恢复的闭环。认证见[提供商设计](2026-10-12-provider-login.md)，上下文预算见[压缩设计](2026-10-12-context-compaction.md)。

## 职责与接口

一个 Agent 循环服务 Logox 和 Actor，角色差异由 prompt、上下文与工具权限表达。providers 转译中立消息和流事件；kernel 判断结束、驱动工具往返和错误收尾；tools 校验并执行；Journal 保存完整记录；application 装配；TUI 只呈现。

当前采用 LOGOX 自己的运行时、队列与账本，模型 adapter 可替换。参考原项目当前 Agent/工具/权限/会话模块、PI 的 [Agent 循环](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts)以及本机 CC 的 query、toolExecution 和工具实现，未同时引入 PI 会话存储。

## 模型与工具往返

支持 OpenAI 兼容与 Anthropic 原生流。外部事件先校验，保留 UTF-8/CRLF 分片、推理、思考签名、工具身份、真实结束原因和用量。

只有正常 tool-use 结束、全批参数完整时执行工具。截断或任一参数不完整时整批不执行；每条完整调用仍配对失败结果。完整 Assistant 与 Tool 消息即时落账，取消补齐未完成结果，下一次恢复不重放副作用。

自然结束且有面向用户的正文才算完成。暂时连接错误仅在没有可见增量时重试；部分输出保留并记录失败。达到往返额度询问是否续做；取消传递到模型、审批和子进程。

Director 调用 dispatch_role 后结束当前回合，让串行 Actor 登场，全部结果返回后继续核对；每条协作链最多三次派发往返，避免队列自我等待。完整协助桥见[持久角色设计](2026-10-12-persistent-actors.md)。

## 权限、文件与进程

read/write/edit/glob/grep/shell 和 ask_user 共用真实工具入口。参数先校验，再解析路径和审批；普通工作区读取允许，敏感或目录外读取、写入与 Shell 等待本次许可。拒绝与取消作为真实工具结果。

write/edit 写前备份，准备与执行前检查文件是否漂移；保留 UTF-8 BOM 与 CRLF。同目录临时文件替换。/undo 按最近活动倒序核对哈希并恢复，用户后续修改阻止撤销，多文件恢复没有操作系统事务保证。

grep 使用实际 rg、参数数组与 JSON 行，过滤依赖/敏感目录和路径逃逸，达到全局上限停止并回收进程。Shell 取消和超时在 Windows 回收进程树，等待退出后返回有界输出。

## 保存与恢复边界

每会话每角色独立账本，保存消息、工具身份、活动与来源窗口。指定会话或最近会话可恢复；旧记录显示“历史记录”，不自动续跑任务。未配对调用补失败结果，工具不重放。

活动终态、有效压缩视图、排队/待回答检查点、跨进程锁、历史分支与文件一致回退仍待迁移。原 Python 会话导入方式尚未确认。持久权限规则、只读批次并发、技能/MCP 与完整入梦业务见 [STATUS](../STATUS.md)。

## 验收与入口

2026-10-12 实际本地 HTTP、Node 子进程、PowerShell、rg、临时文件和 Ink 模拟 TTY 已验证模型分片、真实 read/write/edit、审批、工具回传、完整回复、恢复和撤销；另验证取消/截断/重试、文件等待期间漂移、同轮重复编辑、中文输入与窗口路由。

源码：[Agent](../../../src/kernel/agent.ts)、[模型消息](../../../src/runtime/messages.ts)、[HTTP](../../../src/providers/http.ts)、[Tools](../../../src/tools/tools.ts)、[Snapshots](../../../src/tools/snapshots.ts)、[Process](../../../src/tools/process.ts)、[Journal](../../../src/store/journal.ts)、[application](../../../src/application.ts)。测试：[agent](../../../tests/agent.test.ts)、[providers](../../../tests/providers.test.ts)、[config](../../../tests/config.test.ts)、[app](../../../tests/app.test.tsx)。

真实云端和本地传输记录归[提供商专题](2026-10-12-provider-login.md)，真实 Windows Terminal 与后续迁移按 [TESTING](../TESTING.md)和 [STATUS](../STATUS.md)验收。
