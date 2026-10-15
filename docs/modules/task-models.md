# Actor 任务模型与确认转用

本模块负责一次任务使用哪个模型、何时询问转用，以及恢复时怎样读取实际身份。角色定义加载与舞台呈现由调用方接入；实现入口是 [task-models.ts](../../src/actors/task-models.ts)，回归入口是 [task-models.test.ts](../../tests/task-models.test.ts)。

## 任务开始与实际模型

每个会话装配一个 `TaskModels`，传入共享 `ProviderRegistry` 和 `defaultModel(ownerId)` 回调。回调仅返回可选的提供商/模型 ID，不需要角色定义加载器。Actor 未配置默认模型时直接继承任务开始时的会话选择；Logox 使用自己的会话选择。

`AgentOptions.taskModels` 在任务开始调用 `begin(context)`，得到独立 `TaskModelScope`。scope 固定 Registry 配置与能力快照，认证仍在每次请求时从共享 `AuthStorage` 读取。任务不调用主 Registry 的 `select`，运行期间主选择改变不影响已固定身份。

`ContextManager.model` 接 `TaskModels.model(identity)`，`summarizer` 接 `TaskModels.summarizer(identity)`；Agent 检查准备后的预算身份与任务身份一致，避免用主模型窗口发送角色请求。汇总默认跟随该角色最近任务的实际模型，可用 `summaryModel(identity)` 覆盖；Logox 空闲后跟随当前会话选择。`provider(selection, provider)` 可包装已有 hooks，传入的 provider 已固定模型并共享认证。

计量沿用 `TokenMeter.observe` 与 `UsageLedger`，不建立第二份费用统计。现有 `configureUsage` 的汇总身份回调应返回 `TaskModels.summarizer(identity).model.identity`。转用使该角色的旧 usage 锚点失效，下一次 `prepare` 使用新窗口与实际输出能力重新投影和裁剪。

## 错误与确认

[ProviderError](../../src/providers/http.ts) 增加可选 `category`，原来的 message/retryable 调用兼容。HTTP 从有界错误正文读取结构化 code/type/message，结合状态码分类；已知公开余额信息保留 API 用语并补中文含义，其它未知回显使用固定诊断。转用问题直接复用同一份错误原因，不再另用泛化说明覆盖。整段响应正文、响应头与密钥不进入问题、活动详情或模型账本。

传输故障从异常 cause 链保留已知公开错误码及 connection/stream 阶段，简短原因进入活动和检查点；另记录请求耗时、最后模型进展及响应数据的间隔、接收字节数，供展开诊断。尚未收到 HTTP 响应时不虚构状态码；数据到达不替代有效进展刷新期限。连接关闭、无进展超时与协议格式错误使用各自诊断，未知底层原因不猜测成本地网络故障。

| 类别 | 处理 |
|---|---|
| model_missing | 只识别明确模型不可用代码；普通 404 不猜成模型不存在 |
| authentication | 401/403 或明确认证/权限错误类型 |
| quota | HTTP 402 或明确额度耗尽代码；402优先于泛化的invalid_request_error，保留公开API余额信息与处理方式，不把所有429都当额度耗尽 |
| temporary | 超时、连接中断、429/服务暂时故障、明确限流/过载类型；沿 Agent 现有有界重试 |
| capacity | 窗口未知，提示配置，不转用 |
| protocol | 未知参数、未知错误、协议格式等，不转用 |

仅明确配置默认模型的 Actor 提出转用；继承任务、Logox、已转用任务不重复询问。用户取消、工具失败、审批拒绝与输出截断也不进入转用流程。候选与失败模型相同则结束，不循环询问。

`scope.fallback(error)` 使用当前 `ActorContext.ask` 打开“转用/不转用”问题。只有 `task_model` 的 `switch` 选项表示同意，自由文本不作为同意；取消信号优先。确认前检查候选窗口但不发候选请求；确认后验证认证，候选改变则重新询问。转用只影响本任务，下一任务再次读取角色默认配置。

## 安全接续与工具接入

Agent 在失败请求收尾后询问；已显示正文/思考存入原角色记录，未完整响应的工具调用不执行也不保存为可执行调用。确认后回到模型请求循环，重新准备预算和投影。完整工具批次及结果已经落账，文件、Shell 和扩展副作用不会重放。

转用后的请求保留旧工具调用与结果，但去除原模型生成的签名思考；原始账本仍保留这些内容。替代模型后续生成的有效签名按原生协议继续回放，避免把原提供商的签名交给另一模型。

`AgentOptions.requestBase(context)` 可返回动态角色 system 与工具集；未配置时保留原行为。实际调用必须在这份工具集中，扩展仍使用 `extraTools` 的 schema 校验与 `executeExtra`，审批交接规则不变。调用方为 Actor 提供基础/MCP，过滤 Director 控制工具；提供基础工具时可复用 `agentRequestBase` 的结果再扩展或筛选。

## 检查点与恢复

可选 `TaskModelLedger(directory)` 按会话哈希路径保存 JSONL，内容只含会话、角色、活动、初始/实际模型、继承/转用标志与阶段。确认期间另保存候选和内部 `confirmationId`；它用于检查点关联，实际交互 `requestId` 仍由 Interactions 创建。`checkpoint(state)` 可让主会话同步自己的恢复记录。

Agent 自动保存开始、等待确认、转用及完成/失败/取消状态，scope 也提供 `snapshot`、`save`、`finish` 供其他执行器使用。`load(sessionId, validActivities)` 必须传入 Journal 当前有效分支的活动集合，过滤被回退的任务；不完整末行不读取，损坏完整行报错并保留原文件。`restore(states)` 恢复当前会话的实际模型展示及摘要身份，不恢复待回答问题、不自动续跑或重放工具。后续任务重新 `begin`。

## 接入与验证范围

模块回归使用真实本地 HTTP、Ensemble、Agent、ContextManager、独立模型账本和测试文件，覆盖跨提供商同名模型、确认前零替代请求、预算重算、取消/自由回答、候选变化重确认、替代失败不循环、每任务重新默认、未完整工具丢弃、副作用一次、认证共享、汇总覆盖与有效活动筛选。原 Agent/提供商测试验证基础工具、真实 Shell 与既有取消流程。

正式应用已装配 TaskModels、ContextManager 与 UsageLedger；公开 Activity.taskModel 和 Actor 卡片展示初始/实际身份及转用标记。恢复按 Journal 有效任务过滤模型账本，旧确认阶段标为中断。真实云端模型与 Windows Terminal 现场继续按 [TESTING](../development/TESTING.md)验收。
