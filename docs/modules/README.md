# 当前模块与源码地图

核对日期：2026-10-13。描述当前实现。使用方法见 [USAGE](../USAGE.md)，剩余工作见 [STATUS](../development/STATUS.md)，行为选择与验收按[专题索引](../README.md#专题设计与复盘)查阅。

## 从入口找到职责

| 职责 | 源码入口 | 作用 | 验证入口 |
|---|---|---|---|
| 正式启动与装配 | [cli.tsx](../../src/cli.tsx)、[application.ts](../../src/application.ts)、[config.ts](../../src/config/config.ts) | 加载配置、恢复会话、连接模型与剧团，处理命令 | [config.test.ts](../../tests/config.test.ts)、[agent.test.ts](../../tests/agent.test.ts) |
| 提供商选择与认证 | [registry.ts](../../src/providers/registry.ts)、[auth.ts](../../src/providers/auth.ts)、[login.ts](../../src/providers/login.ts) | 持久凭据、无密钥登录阶段、请求认证、提供商切换与检查 | [login.test.ts](../../tests/login.test.ts)、[providers.test.ts](../../tests/providers.test.ts) |
| 命令界面生命周期 | [surfaces.ts](../../src/commands/surfaces.ts)、[command-surface.ts](../../src/runtime/command-surface.ts)、[command-pane.tsx](../../src/tui/command-pane.tsx)、[picker.tsx](../../src/tui/picker.tsx)、[tabbed-page.tsx](../../src/tui/tabbed-page.tsx) | 共享容器、搜索/导航、页签与查询取消；公开快照不含业务回调或密钥 | [command-surfaces.test.ts](../../tests/command-surfaces.test.ts)、[command-panels.test.tsx](../../tests/command-panels.test.tsx) |
| 模型协议与传输 | [messages.ts](../../src/runtime/messages.ts)、[http.ts](../../src/providers/http.ts) | 独立于厂商的消息、流事件、结束原因、工具身份及无进展超时 | [agent.test.ts](../../tests/agent.test.ts)、[providers.test.ts](../../tests/providers.test.ts) |
| 上下文与预算 | [上下文模块](context.md)、[manager.ts](../../src/context/manager.ts) | 有效视图、随轮摘要、工具归档、自动/手动整理、用量与窗口保护 | [context.test.ts](../../tests/context.test.ts)、[context-extra.test.ts](../../tests/context-extra.test.ts) |
| 提示词工程与静态宪章 | [boundary.ts](../../src/prompts/boundary.ts)、[charter.ts](../../src/prompts/charter.ts)、[director-tools.ts](../../src/prompts/director-tools.ts) | 静态切片、Prompt Caching 缓存分水岭、行动宪章、定量约束与高内聚工具说明 | [prompts.test.ts](../../tests/prompts.test.ts) |
| Agent 循环 | [agent.ts](../../src/kernel/agent.ts) | 模型与工具往返、截断保护、重试、额度和中断收尾 | [agent.test.ts](../../tests/agent.test.ts) |
| 资源与基础扩展 | [资源模块](resources-and-extensions.md)、[manager.ts](../../src/resources/manager.ts)、[runtime.ts](../../src/extensions/runtime.ts) | 人设、规范、技能、模板、重载、MCP 与观察 hooks | [resources.test.ts](../../tests/resources.test.ts)、[extensions.test.ts](../../tests/extensions.test.ts) |
| 工具、文件恢复与进程 | [tools.ts](../../src/tools/tools.ts)、[snapshots.ts](../../src/tools/snapshots.ts)、[process.ts](../../src/tools/process.ts) | 参数校验、路径审查、审批、实际文件和命令副作用 | [agent.test.ts](../../tests/agent.test.ts) |
| 步骤与输入来源 | [steps.ts](../../src/runtime/steps.ts)、[provenance.ts](../../src/runtime/provenance.ts) | 每次 Thinking/tool 独立起止、等待与耗时，步骤保存 groupId/groupState 供连续思考归组；真人授权与角色数据分开 | [runtime-steps.test.ts](../../tests/runtime-steps.test.ts) |
| 活动与异步请求 | [contracts.ts](../../src/runtime/contracts.ts)、[activities.ts](../../src/runtime/activities.ts)、[interactions.ts](../../src/runtime/interactions.ts)、[store.ts](../../src/runtime/store.ts) | 身份、合法状态转换、回答校验、不可变快照 | [interactions.test.ts](../../tests/interactions.test.ts) |
| 系统历史与状态栏 | [系统历史模块](system-history.md)、[system-history.ts](../../src/store/system-history.ts)、[application-status.ts](../../src/application-status.ts) | 灰色系统事件、保存边界、请求环境与当前角色状态 | [system-history.test.ts](../../tests/system-history.test.ts)、[application-status.test.ts](../../tests/application-status.test.ts)、[stage-controls.test.tsx](../../tests/stage-controls.test.tsx) |
| 会话管理与回退 | [application-sessions.ts](../../src/application-sessions.ts)、[sessions.ts](../../src/store/sessions.ts)、[session-trash.ts](../../src/store/session-trash.ts)、[file-lock.ts](../../src/store/file-lock.ts)、[journal.ts](../../src/store/journal.ts)、[ApplicationStage](../../src/tui/application.tsx) | 默认恢复、临时空白、项目服务复用、租约、候选切换、回收删除、检查点及分支回退 | [session-lifecycle.test.ts](../../tests/session-lifecycle.test.ts)、[sessions.test.ts](../../tests/sessions.test.ts)、[session-leases.test.ts](../../tests/session-leases.test.ts)、[session-integration.test.ts](../../tests/session-integration.test.ts)、[session-ui.test.tsx](../../tests/session-ui.test.tsx)、[session-delete.test.tsx](../../tests/session-delete.test.tsx) |
| 持久角色与账本 | [ensemble.ts](../../src/actors/ensemble.ts)、[journal.ts](../../src/store/journal.ts) | 批次合并、串行队列、独立历史、保存与恢复 | [ensemble.test.ts](../../tests/ensemble.test.ts)、[agent.test.ts](../../tests/agent.test.ts) |
| 角色定义、协作与技能 | [角色模块](actors.md)、[services.ts](../../src/actors/services.ts)、[collaboration.ts](../../src/actors/collaboration.ts) | 定义覆盖、/actors、塑造审批、短摘要交接、协作渠道与本次技能借阅 | [actor-definitions.test.ts](../../tests/actor-definitions.test.ts)、[actor-collaboration.test.ts](../../tests/actor-collaboration.test.ts)、[actors-integration.test.ts](../../tests/actors-integration.test.ts) |
| 独立任务模型 | [任务模型模块](task-models.md)、[task-models.ts](../../src/actors/task-models.ts) | 固定身份、确认转用、预算/计量、无凭据检查点与安全接续 | [task-models.test.ts](../../tests/task-models.test.ts) |
| 入梦生命周期 | [service.ts](../../src/anamnesis/service.ts) | 空闲资格、暂停、同活动续做与关闭，当前由 demo 接入 | [anamnesis.test.ts](../../tests/anamnesis.test.ts) |
| 终端呈现与输入 | [app.tsx](../../src/tui/app.tsx)、[stage.ts](../../src/tui/stage.ts)、[scene.ts](../../src/tui/scene.ts)、[cards.tsx](../../src/tui/cards.tsx)、[editor.ts](../../src/tui/editor.ts)、[completion.ts](../../src/tui/completion.ts)、[command-menu.tsx](../../src/tui/command-menu.tsx)、[metrics.ts](../../src/tui/metrics.ts)、[viewport.ts](../../src/tui/viewport.ts) | 真实舞台与 demo 共用卡片行、颜色、编辑和鼠标 | [app.test.tsx](../../tests/app.test.tsx)、[ui-layout.test.ts](../../tests/ui-layout.test.ts)、[tui.test.tsx](../../tests/tui.test.tsx) |
| 会话画布与选区 | [terminal-plane.ts](../../src/tui/terminal-plane.ts)、[row-presentation.ts](../../src/tui/row-presentation.ts)、[selection.ts](../../src/tui/selection.ts)、[thinking-groups.ts](../../src/tui/thinking-groups.ts) | 连续 Thinking 与内联工具归组，可见字符绘制与高亮、内容端点、局部动画及边缘拖选；精确命中与松开操作由 Scene/App 接入 | [stage-interaction.test.tsx](../../tests/stage-interaction.test.tsx)、[terminal-scroll.test.tsx](../../tests/terminal-scroll.test.tsx)、[thinking-groups.test.ts](../../tests/thinking-groups.test.ts)、[terminal-transaction.test.tsx](../../tests/terminal-transaction.test.tsx) |
| 独立 demo | [demo.ts](../../src/demo.ts)、[portfolio.ts](../../src/demo/portfolio.ts)、[scene-state.ts](../../src/tui/scene-state.ts) | 作品集样本投影和脚本任务，不冒充模型或文件执行 | [demo.test.ts](../../tests/demo.test.ts) |

## 一次真实任务怎样执行

`application-sessions` 创建项目共享 Registry、偏好状态文件、PermissionEngine、Tools、UsageLedger 和 ProjectExtensions；`createSessionApplication` 为每个会话创建 Journal、Ensemble、ContextManager 和 RuntimeStore。`Ensemble.dispatch` 接受任务时先创建排队活动并记录输入来源；真人输入与派工即时显示，Actor 自动报告只更新原卡片；轮到该任务时加载对应角色历史、保存输入，再调用同一个 Agent 执行器。

`ProviderRegistry` 将配置、认证与接口选择集中在 providers。认证每次请求读取，LOGOX 登录凭据优先，再读环境及显式 pi 文件后备；HTTP 请求与模型列表使用同一选择。跨提供商切换不继承旧模型、地址或认证。application 只处理舞台命令和运行中禁止切换的边界，UI 不读取认证文件，只暂存用户本次输入的遮罩草稿。

`AuthStorage` 独立保存用户认证，锁定后重新读取最新记录，再用临时文件原子替换；损坏文件不覆盖。`LoginFlow` 快照只含提供商和阶段，密钥由 TUI 的独立遮罩编辑器直接提交给保存调用。登录不使用普通交互回答或 Journal；关闭等待已提交保存收尾。

`Provider.respond` 接收系统指令、模型消息和工具定义，返回完整 Assistant 消息及真实结束原因；增量只负责实时显示。OpenAI 工具参数分片按 index 组装，Anthropic 原生流保存思考签名。外部事件先校验，HTTP 失败不会把响应正文或密钥带到诊断中。

Agent 只在正常 tool-use 结束且全批参数完整时执行工具。截断或一条参数不完整使整批不执行，每个调用仍收到失败结果。原始 Assistant 与 Tool 结果保存，畸形批次用 toolsExcluded 标记；请求投影保留合法正文，剔除该批工具与未执行结果。Thinking 在每次请求开始时建立独立身份和计时，工具同级且独立计时；排队和审批不累计执行耗时。正常完成必须有自然结束原因和面向用户的正文，未知结束、仅思考或空正文不能冒充成功。

[TaskProgress](../../src/runtime/task-progress.ts) 通过 update_task_progress 登记计划、当前阶段、修订和成果，Steps 创建时领取阶段快照；Journal 检查点保存计划，resumeTaskId 续做继承原阶段。舞台只按真实记录呈现，不从思考推断用途。输出无交付或截断按[阶段与恢复设计](../development/designs/2026-10-14-task-progress-and-reasoning-recovery.md)有界接续：Actor 一次自纠偏、Director 一次调整；正文和工具截断共用两次接续。根预算与真实进展由 ActorRecovery 保存，网络故障另计；明确用户继续可以授权新组，重派和重启不增加次数。

模型请求与模型列表通过 [transport.ts](../../src/providers/transport.ts)共用应用级 Undici 服务，读取 HTTP_PROXY / HTTPS_PROXY / NO_PROXY，应用关闭后回收连接。网络层数据空闲期限为 5 分钟，模型有效进展期限仍按配置计时，两者各自生效。

已识别的连接中断或无进展超时优先在当前请求中退避重试，与 Actor 接管共用根任务同一故障两次补救预算。此前工具结果不重跑，未完整的新工具参数不执行；失败尝试标记 contextExcluded，原步骤与系统提示保存供阅读，模型视图和摘要不使用这份半段输出。其它暂时故障只在尚无可见增量时重试。达到往返额度后通过现有提问协议询问续做；拒绝进入未完成的失败终态。取消传播到模型、进程和审批等待，保留已显示回复，并补齐批次中缺失的工具结果。

连续 read/glob/grep 按配置以 1–8 的有界并发执行，结果按模型顺序落账；其他工具和未知扩展串行。整批执行前校验原生参数及扩展 JSON Schema。每次请求前经[上下文模块](context.md)校验窗口与输出额度，达到水位时复用摘要、归档和有界汇总；批次完整落账后才整理，普通收尾不另发摘要请求。

## 工具、审批与撤销

Tools 校验参数、原始与真实路径、敏感目标和等待后的文件版本，再经 PermissionGuard 统一裁决。PermissionEngine 支持 default/auto/creative、deny 优先及 session/project 规则；auto 安全快路不发模型，不确定操作独立审查；creative 仅规则过滤危险，其余默认允许。MCP 完整 schema 后裁决，ActorServices 同样接入，未知扩展不参加只读并发。审批失败重试一次后通过角色卡暂停，模式切换后重新判断；拒绝记录按当前用户授权去重。审批只取来源明确的真人输入和继承的原任务授权，Director 派工、Actor 报告及协作数据不作为新增授权。审批用量作为独立类别进入原账本。项目规则与模式锁内重读并原子保存，保存失败不更新内存。接口、颜色与验收见[权限与调度](../development/designs/2026-10-12-permissions-and-scheduling.md)。

[paths.ts](../../src/permissions/paths.ts) 区分真实凭据、运行记录读取和运行状态修改；原始/真实路径共同检查，扩展越界比较使用真实项目根，兼容 Windows 短路径。read 及显式运行目录的 grep/glob 可查普通账本，项目根搜索继续默认跳过运行记录；凭据过滤在执行入口及搜索结果中同时生效。Shell 按实际写入/删除动作判断运行状态风险，不因出现运行目录就拒绝读取。

write/edit 保存原字节与目标结果哈希，备份失败不修改。准备与写入前分别核对当前字节，避免等待期间覆盖已变文件；编辑保留 UTF-8 BOM 与 CRLF。每个文件使用同目录临时文件替换。

Snapshots.undo 只筛选当前会话，对最近活动的修改倒序模拟恢复，整批核对哈希后执行。同一文件多次修改可恢复到该轮开始前；新建文件删除。手工后续修改会阻止撤销。多文件写入不是操作系统事务，Shell 副作用也没有文件工具快照。

Process 在 Windows 隐藏运行子进程，超时或取消时终止进程树，等待 close 后返回。stdout/stderr 有界保存；rg 通过参数数组启动，按 JSON 行读取，达到全局结果上限即停止并回收进程。

## 角色协作与恢复

每个会话的每个角色拥有独立 Journal 文件。批次中同角色任务合并，所有角色串行登场；等待许可时仍可接收输入并排队。Director 与 Actor 使用同一循环，角色差异由提示词和工具可见性表达。

仅 Logox 能调用 dispatch_role。它排入 Actor 任务并先结束自己的回合，正常批次完成后接收标题/报告，避免串行队列自我等待。技术异常立即交 Logox，同批后续暂停；同一根任务的同一故障最多自动补救两次。停止 Logox 不取消 Actor，晚到结果保存并等待下一次正式输入；卡片停止仅取消对应 Actor，禁止自动补做被用户停止的工作。完整接管、队列恢复与持久交接见[角色模块](actors.md)，固定模型与确认转用见[任务模型模块](task-models.md)。

Journal 保存完整模型消息、工具身份、活动和来源窗口，以会话/角色哈希生成文件名。加载时校验格式与身份；损坏记录报错。恢复展示历史，但不重放工具或续跑任务。未配对调用在下一次执行前补成失败结果。轮次终态、摘要和来源绑定另存，恢复后展示真实终态；旧账本没有终态时标为“历史记录”。有效压缩视图和工具归档在恢复时校验原文绑定，不重放工具。排队、运行和待回答任务保存检查点，重启标为中断。Journal 原始账本不改写，分支清单排除回退活动，轮次和压缩状态按分支保存；实际物理行号从有效原文范围计算。

SessionManager 按项目真实路径维护正式会话索引和 host/PID/token 长期租约。普通启动恢复最近正式会话；没有历史或 /new 时打开临时空白，首次提交用户或 Actor 任务前才登记，失败/取消的正式任务仍保存。列表依据原始用户输入或任务检查点识别历史，忽略仅配置操作的旧空白，清理无人持有的空白索引并保留文件。最近会话被占用或损坏时说明原因并打开恢复列表，提供新建临时会话入口；显式 ID 保留明确错误，不自动选择其它历史。

SessionManager.remove 在租约内确定会话所属文件，SessionTrash 完整备份、校验哈希后原子发布 deleted 标记，再清理与备份一致的原文件；文件变化或清理失败保留原文并报告。副本在 `.logox/state/trash`，清单保留原路径，支持退出后的手动恢复。列表、默认最近恢复与显式恢复识别删除标记，残留账本不重新出现；项目文件、模型偏好、规则与其他会话保持。/resume 的 Ctrl+X 确认默认取消，当前会话及其他活进程占用项不可删除。

申请与释放共用 withFileLock 短期锁，租约原子发布。只有不存在或确认同机进程死亡时才能申请，释放仅删除自己的身份；临时会话也持有租约，保护首次登记到检查点保存之间的窗口。application-sessions 先锁定、准备候选，正式候选更新元数据，临时候选延迟登记；失败保留旧会话及规则，成功关闭旧运行时、清理会话规则、释放旧租约，再发布版本。候选创建前 flush 用量，再按会话/角色恢复计数；回退保留已消费用量。项目资源、MCP、权限和模型选择复用，只有最终关闭才回收自有 ProjectExtensions。

ApplicationStage 订阅会话版本，切换后重新挂载 App，清理各窗口草稿、焦点与画布；公开 sessionId/store/ensemble/contexts 等 getter 指向当前运行时。状态订阅在会话发布时解除旧运行时监听，转接当前窗口真实数据。/clear 仅清显示；/rewind 按活动筛选文件快照，全批预检、逐文件恢复，全部成功才提交有效对话分支。未完成回退持久保存 pending，重启后可重试同目标，禁止新任务。具体规则见[会话专题](../development/designs/2026-10-12-session-management.md)。

## 活动、异步交互与舞台

Activities 管理合法状态转换；Interactions 管理 requestId、活动归属、全部问题覆盖与选项校验。错误身份、漏题和重复回答不解除等待。取消请求、取消任务或关闭释放相关等待。

共享 [commands.ts](../../src/commands.ts) 维护命令名称、用途与参数类别，同时供帮助和 TUI 补全使用；application 保留执行分支并提供公开候选。模型查询结果按提供商缓存，UI 只消费公开名称，键入时不发网络请求。/model 无参数查询已认证提供商及已配置无需认证接口的统一目录，以提供商 + 模型 ID 区分同名模型；某一家查询失败或超时保留其他结果。/models 继续只查询当前提供商。补全替换按原草稿光标位置处理，保留后缀；布局测量只在高度实际变化时更新状态。

CommandSurfaces 拥有命令 picker/page 的公开不可变快照、查询取消和确认回调。application 提供候选和状态/配置/用量/命令页签，选择时重新检查忙碌状态，确认保存成功才更新模型并显示通知；取消不写 Journal 或调用 Agent。/effort 共用 picker，/usage 共用页签页面。TUI 的 CommandPane 维护共享留白和视口，Picker 维护搜索与选项导航，TabbedPage 维护页签与各自滚动位置；命令界面打开时隔离主编辑器和审批按键，返回后保留原状态。LoginFlow 仅将无密钥的提供商阶段交给 Picker，密钥仍使用独立遮罩编辑器。

[model-preferences.ts](../../src/config/model-preferences.ts) 维护项目无密钥模型偏好与原子状态文件；loadConfig 在环境和 CLI 之前叠加上次选择。Registry 的 candidate/adopt 在应用空闲、保存成功后替换选择；思考档位和协议能力见[模型偏好与用量](../development/designs/2026-10-12-model-preferences-and-usage.md)。TokenMeter 是任务/汇总唯一计数入口，[UsageLedger](../../src/context/usage.ts) 按会话/角色保存，恢复不重算历史，费用按配置中的每百万 token 静态价格计算。

RuntimeStore 为流式消息保留稳定 ID，并发布不可变快照。TUI 只消费快照、提交回答和命令，不执行文件工具、不维护另一份许可结果。

系统事件以独立身份保存、按时间恢复，任务错误在原位置折叠。命令结果不自动混入模型消息；有效环境按受影响角色在下一请求中传递最新状态。单行状态栏用统一用户布局显示各窗口的真实数据，具体入口和保存边界见[系统历史模块](system-history.md)。

真实 stage 与 demo 使用 scene 的同一个行构建器和角色卡。stage 根据实际消息/活动生成行，不读取作品集样本；普通运行活动不另外追加过程正文，模型往返次数保留在内部活动诊断，失败及取消结果仍展示。审批与多问题内联到所属角色卡；自由答案使用现有输入编辑器。折叠、悬停、窗口草稿和阅读位置属于界面状态。颜色与布局的当前规则见 [UI-SPEC](../UI-SPEC.md)。

[markdown.ts](../../src/tui/markdown.ts) 将 Assistant 正文的标题、列表、引用、围栏及行内强调/代码/链接转换为带样式的字形行，并保存显示列到原文位置（UTF-16 索引）的映射；代码围栏保留单行语言标签并补满上下横线。[markdown-table.ts](../../src/tui/markdown-table.ts) 识别表格、按内容分配列宽、绘制完整上下框线、对齐和折行，内容放得下时不拉伸，窄屏纵向呈现；原文映射供阅读锚点定位；复制取可见字符，包含框线和格式化文字，连接纯软折行并保留真实换行。stage 使用 WeakMap 按不可变 Message 缓存正文和工具卡布局，每条消息最多保存两个布局；流式消息替换后只重建变化项，活动与所属消息按身份索引。viewport 只取可见行，阅读锚点用消息和原文位置；表格折行通过单元格字形映射定位，避免跨列原文范围重叠导致回跳。

[terminal.tsx](../../src/tui/terminal.tsx) 是 CLI 全屏输出边界，统一管理 Ink 与 [TerminalPlane](../../src/tui/terminal-plane.ts) 的输出事务。Ink 的同步起止区间内暂停画布独立提交，把界面更新和历史恢复合并后再结束同步区间，避免嵌套结束指令暴露清空中间帧。Ink 保留固定高度的空白历史区域，继续负责输入、状态栏与对话框；App 在提交阶段交接区域，各窗口用引用累计滚轮锚点，纯滚动不更新 React。画布缓存行样式，以独立帧调度和局部 SU/SD 平移旧内容，只补新行；Ink 重画、缩放和区域大小变化后恢复画布，整页命令界面交还区域时先清空，退出取消调度并移除监听。鼠标命中和复制读取当前画布。非全屏、非交互及屏幕阅读器使用 Ink 正文路径。回归入口为 [terminal-scroll.test.tsx](../../tests/terminal-scroll.test.tsx)、[stage-reading.test.ts](../../tests/stage-reading.test.ts) 与现有 App/命令界面测试。

## 入梦与依赖方向

Anamnesis 目前提供生命周期：有新材料且前台空闲时符合启动资格，草稿只刷新空闲时间，前台提交暂停；进程内续做复用活动身份。runner 只获得身份、取消信号和阶段汇报。只读研究、来源核验、持久检查点和长期档案提交仍待迁移，正式模型入口暂未装配入梦 runner。

依赖方向为：CLI/装配 → Agent、剧团、模型、工具和持久化；这些模块 → runtime 协议。TUI → runtime 快照和呈现数据。demo 单独装配脚本执行器，不能成为真实工具或模型逻辑的依赖。
