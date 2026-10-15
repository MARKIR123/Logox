# 资源与基础扩展

本页维护当前资源扫描与扩展执行机制。使用方法见 [USAGE](../USAGE.md#资源与扩展)，方案与验收见[专题设计](../development/designs/2026-10-12-resources-and-extensions.md)。

## 资源与请求

[Resources](../../src/resources/manager.ts) 保存只读快照。角色人设完全由角色档案（`profiles/<id>/persona.md` 或角色定义文件）提供，不再从 Resources 拼接用户人设。Resources 负责人工规范、技能与模板：人工规范来自用户 `.logox/AGENTS.md` 或 `CLAUDE.md`，再按文件系统祖先由远到近加载项目规范。项目每层在目录及其 `.logox` 下按 `LOGOX.md`、`AGENTS.md`、`CLAUDE.md` 选择一个；真实路径去重。每份文件有 64 KiB 上限，规范合计 128 KiB；超限整份跳过，UTF-8 与读取失败分别诊断。legacy 路径及指向它的链接不加载。

技能与模板来自用户和当前项目 `.logox/skills`、`.logox/commands`，项目同名资源覆盖用户资源，目录最多处理 256 项。技能索引按角色过滤，仅含名称、描述和正文路径；read 按需读取且沿工具权限链。技能 YAML 可用 actors 列表声明角色，角色定义可用 skills 双向指定；未声明默认归 Logox，任务借阅不永久分配。规则见[角色模块](actors.md)。模板仍使用单行 name/description、单次参数替换和字节上限，不执行 Shell；内置命令重名项跳过。

[agentRequestBase](../../src/kernel/agent.ts) 的第四个可选参数接受 Resources。Application 中普通 Agent 和 /compact 传入同一快照；旧三参数调用仍有效。/reload 拒绝忙碌状态，完成扫描再替换快照，各类分别报告失败；配置只校验，不替换运行中提供商或扩展。提示变化清除 ContextManager 的计量前缀与旧请求统计，保留累计用量、Journal 与检查点。

## MCP 的执行和关闭

[Mcp](../../src/extensions/mcp.ts) 只注册 mcp 元工具，list 返回目录，call 执行远端调用。[McpClient](../../src/extensions/mcp-client.ts) 首次请求启动 stdio 子进程并握手，连接共用；HTTP 明确拒绝。消息最多 1 MiB，目录最多 256 个工具和 16 页。调用由 Ajv 校验完整 draft-07 或 2020-12 schema，包含嵌套、组合、范围与格式约束；目录展示内容不能替代校验。每份远端 schema 使用独立 Ajv 校验器，按当前工具目录缓存；成功刷新目录后旧校验器释放，同名 $id 不跨工具或服务共享，schema 内部 $ref 保留。

审批只有 `ExtensionApproval` 一个入口，参数包含 source、server、tool、arguments 和完整 inputSchema，第二参数是 ActorContext。独立默认实现对远端调用请求单次许可；正式应用注入三档裁决，目录 list 同样遵守 deny。请求包含明确 action，名为 list 的远端工具仍按 call 处理。拒绝不发送 tools/call，调用结果经 Agent.executeExtra 写入同一 Journal。取消、超时、坏消息、启动失败和关闭解除等待并回收进程；下次请求可重连，关闭幂等。输出最多 64000 字符，stderr 消耗但不回显。

## 观察事件与项目生命周期

[Hooks](../../src/extensions/hooks.ts) 接收明确事件并异步运行命令，JSON 通过 stdin 发送。显式配置提供 args 时使用可执行文件与参数数组，省略 args 时兼容 Shell 命令（Windows PowerShell、其他系统 sh）；启动时另按事件名发现当前项目和用户 `.logox/hooks` 脚本，每层每事件最多选择一份，真实路径去重。事件包含身份、工具名、结果状态与 token 数，不包含用户正文或工具参数。事件队列、输出和结果历史有界；超时/非零退出诊断不会改变任务结果。session_start、post_tool_use、pre_compact、stop 接入正式运行链，notification 由应用通知或调用方显式触发；hook 自身诊断不再次触发 notification。

[ProjectExtensions](../../src/extensions/runtime.ts) 拥有 Resources、Mcp 和 Hooks。application-sessions 默认创建项目扩展并在最终 close 收尾；new/resume/rewind 复用同一资源、MCP 和 hooks。也可 initialize 后从调用方注入，应用最终关闭不关闭外部扩展，由调用方拥有者 close。observeTools 在项目层只包装一次，observeTasks 装饰每个会话的执行入口，复用已装配的 Tools 和权限依赖，不改变 Agent 批次调度或 Journal 分支。

磁盘插件与旧 Python 插件没有加载器；语言和格式选择留在专题的待确认方案。生成背景档案与入梦管线留到入梦阶段。
