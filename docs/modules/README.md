# 当前模块与源码地图

核对日期：2026-10-12。描述当前实现。使用方法见 [USAGE](../USAGE.md)，剩余工作见 [STATUS](../development/STATUS.md)，行为选择与验收按[专题索引](../README.md#专题设计与复盘)查阅。

## 从入口找到职责

| 职责 | 源码入口 | 作用 | 验证入口 |
|---|---|---|---|
| 正式启动与装配 | [cli.tsx](../../src/cli.tsx)、[application.ts](../../src/application.ts)、[config.ts](../../src/config/config.ts) | 加载配置、恢复会话、连接模型与剧团，处理命令 | [config.test.ts](../../tests/config.test.ts)、[agent.test.ts](../../tests/agent.test.ts) |
| 提供商选择与认证 | [registry.ts](../../src/providers/registry.ts)、[auth.ts](../../src/providers/auth.ts)、[login.ts](../../src/providers/login.ts) | 持久凭据、无密钥登录阶段、请求认证、提供商切换与检查 | [login.test.ts](../../tests/login.test.ts)、[providers.test.ts](../../tests/providers.test.ts) |
| 命令界面生命周期 | [surfaces.ts](../../src/commands/surfaces.ts)、[command-surface.ts](../../src/runtime/command-surface.ts)、[command-pane.tsx](../../src/tui/command-pane.tsx)、[picker.tsx](../../src/tui/picker.tsx)、[tabbed-page.tsx](../../src/tui/tabbed-page.tsx) | 共享容器、搜索/导航、页签与查询取消；公开快照不含业务回调或密钥 | [command-surfaces.test.ts](../../tests/command-surfaces.test.ts)、[command-panels.test.tsx](../../tests/command-panels.test.tsx) |
| 模型协议与传输 | [messages.ts](../../src/runtime/messages.ts)、[http.ts](../../src/providers/http.ts) | 独立于厂商的消息、流事件、结束原因和工具身份 | [agent.test.ts](../../tests/agent.test.ts) |
| 上下文与预算 | [上下文模块](context.md)、[manager.ts](../../src/context/manager.ts) | 有效视图、随轮摘要、工具归档、自动/手动整理、用量与窗口保护 | [context.test.ts](../../tests/context.test.ts)、[context-extra.test.ts](../../tests/context-extra.test.ts) |
| Agent 循环 | [agent.ts](../../src/kernel/agent.ts) | 模型与工具往返、截断保护、重试、额度和中断收尾 | [agent.test.ts](../../tests/agent.test.ts) |
| 工具、文件恢复与进程 | [tools.ts](../../src/tools/tools.ts)、[snapshots.ts](../../src/tools/snapshots.ts)、[process.ts](../../src/tools/process.ts) | 参数校验、路径审查、审批、实际文件和命令副作用 | [agent.test.ts](../../tests/agent.test.ts) |
| 活动与异步请求 | [contracts.ts](../../src/runtime/contracts.ts)、[activities.ts](../../src/runtime/activities.ts)、[interactions.ts](../../src/runtime/interactions.ts)、[store.ts](../../src/runtime/store.ts) | 身份、合法状态转换、回答校验、不可变快照 | [interactions.test.ts](../../tests/interactions.test.ts) |
| 持久角色与账本 | [ensemble.ts](../../src/actors/ensemble.ts)、[journal.ts](../../src/store/journal.ts) | 批次合并、串行队列、独立历史、保存与恢复 | [ensemble.test.ts](../../tests/ensemble.test.ts)、[agent.test.ts](../../tests/agent.test.ts) |
| 入梦生命周期 | [service.ts](../../src/anamnesis/service.ts) | 空闲资格、暂停、同活动续做与关闭，当前由 demo 接入 | [anamnesis.test.ts](../../tests/anamnesis.test.ts) |
| 终端呈现与输入 | [app.tsx](../../src/tui/app.tsx)、[stage.ts](../../src/tui/stage.ts)、[scene.ts](../../src/tui/scene.ts)、[cards.tsx](../../src/tui/cards.tsx)、[editor.ts](../../src/tui/editor.ts)、[completion.ts](../../src/tui/completion.ts)、[command-menu.tsx](../../src/tui/command-menu.tsx)、[metrics.ts](../../src/tui/metrics.ts)、[viewport.ts](../../src/tui/viewport.ts) | 真实舞台与 demo 共用卡片行、颜色、编辑和鼠标 | [app.test.tsx](../../tests/app.test.tsx)、[ui-layout.test.ts](../../tests/ui-layout.test.ts)、[tui.test.tsx](../../tests/tui.test.tsx) |
| 独立 demo | [demo.ts](../../src/demo.ts)、[portfolio.ts](../../src/demo/portfolio.ts)、[scene-state.ts](../../src/tui/scene-state.ts) | 作品集样本投影和脚本任务，不冒充模型或文件执行 | [demo.test.ts](../../tests/demo.test.ts) |

## 一次真实任务怎样执行

`application` 创建配置、模型适配器、Tools、Journal、Ensemble 和 RuntimeStore。`Ensemble.dispatch` 接受任务时先创建排队活动并发布用户输入；轮到该任务时加载对应角色历史、保存输入，再调用同一个 Agent 执行器。

`ProviderRegistry` 将配置、认证与接口选择集中在 providers。认证每次请求读取，LOGOX 登录凭据优先，再读环境及显式 pi 文件后备；HTTP 请求与模型列表使用同一选择。跨提供商切换不继承旧模型、地址或认证。application 只处理舞台命令和运行中禁止切换的边界，UI 不读取认证文件，只暂存用户本次输入的遮罩草稿。

`AuthStorage` 独立保存用户认证，锁定后重新读取最新记录，再用临时文件原子替换；损坏文件不覆盖。`LoginFlow` 快照只含提供商和阶段，密钥由 TUI 的独立遮罩编辑器直接提交给保存调用。登录不使用普通交互回答或 Journal；关闭等待已提交保存收尾。

`Provider.respond` 接收系统指令、模型消息和工具定义，返回完整 Assistant 消息及真实结束原因；增量只负责实时显示。OpenAI 工具参数分片按 index 组装，Anthropic 原生流保存思考签名。外部事件先校验，HTTP 失败不会把响应正文或密钥带到诊断中。

Agent 只在正常 tool-use 结束且全批参数完整时执行工具。截断或一条参数不完整使整批不执行，每个调用仍收到失败结果。每条完整 Assistant 消息和 Tool 结果立即保存，随后继续请求模型。正常完成必须有自然结束原因和面向用户的正文；未知结束、仅思考或空正文不能冒充成功。

暂时连接错误只在尚无可见增量时重试。达到往返额度后通过现有提问协议询问续做；拒绝进入未完成的失败终态。取消传播到模型、进程和审批等待，保留已显示回复，并补齐批次中缺失的工具结果。

当前所有工具按模型顺序执行；只读批次并发待实现。每次请求前经[上下文模块](context.md)校验窗口与输出额度，达到水位时复用摘要、归档和有界汇总；批次完整落账后才整理，普通收尾不另发摘要请求。

## 工具、审批与撤销

Tools 是实际工具执行入口。先严格校验参数、解析真实路径，再判断是否需要审批。普通目录内读取允许；敏感路径、目录外读取、所有 write/edit 和 Shell 等待许可。扫描过滤敏感路径和链接逃逸，不读取 legacy 材料。永久权限规则尚未迁移。

write/edit 保存原字节与目标结果哈希，备份失败不修改。准备与写入前分别核对当前字节，避免等待期间覆盖已变文件；编辑保留 UTF-8 BOM 与 CRLF。每个文件使用同目录临时文件替换。

Snapshots.undo 对最近活动的修改倒序模拟恢复，整批核对哈希后执行。同一文件多次修改可恢复到该轮开始前；新建文件删除。手工后续修改会阻止撤销。多文件写入不是操作系统事务，Shell 副作用也没有文件工具快照。

Process 在 Windows 隐藏运行子进程，超时或取消时终止进程树，等待 close 后返回。stdout/stderr 有界保存；rg 通过参数数组启动，按 JSON 行读取，达到全局结果上限即停止并回收进程。

## 角色协作与恢复

每个会话的每个角色拥有独立 Journal 文件。批次中同角色任务合并，所有角色串行登场；等待许可时仍可接收输入并排队。Director 与 Actor 使用同一循环，角色差异由提示词和工具可见性表达。

仅 Logox 能调用 dispatch_role。它排入 Actor 任务并先结束自己的回合，待批次全部结束后自动接收结果，避免串行队列自我等待。协作链限制三次派发往返；Director 运行期间取消会取消已派发子任务。完整技能路由、人物定义和双向协助桥尚未迁移。

Journal 保存完整模型消息、工具身份、活动和来源窗口，以会话/角色哈希生成文件名。加载时校验格式与身份；损坏记录报错。恢复展示历史，但不重放工具或续跑任务。未配对调用在下一次执行前补成失败结果。轮次终态、摘要和来源绑定另存，恢复后展示真实终态；旧账本没有终态时标为“历史记录”。有效压缩视图和工具归档在恢复时校验原文绑定，不重放工具。排队/待回答检查点与完整会话分支回退尚未接入。

## 活动、异步交互与舞台

Activities 管理合法状态转换；Interactions 管理 requestId、活动归属、全部问题覆盖与选项校验。错误身份、漏题和重复回答不解除等待。取消请求、取消任务或关闭释放相关等待。

共享 [commands.ts](../../src/commands.ts) 维护命令名称、用途与参数类别，同时供帮助和 TUI 补全使用；application 保留执行分支并提供公开候选。模型查询结果按提供商缓存，UI 只消费公开名称，键入时不发网络请求。/model 无参数查询已认证提供商及已配置无需认证接口的统一目录，以提供商 + 模型 ID 区分同名模型；某一家查询失败或超时保留其他结果。/models 继续只查询当前提供商。补全替换按原草稿光标位置处理，保留后缀；布局测量只在高度实际变化时更新状态。

CommandSurfaces 拥有命令 picker/page 的公开不可变快照、查询取消和确认回调。application 提供候选和状态/配置/命令页签，选择时重新检查忙碌状态，确认成功才更新模型并显示通知；取消不写 Journal 或调用 Agent。TUI 的 CommandPane 维护共享留白和视口，Picker 维护搜索与选项导航，TabbedPage 维护页签与各自滚动位置；命令界面打开时隔离主编辑器和审批按键，返回后保留原状态。LoginFlow 仅将无密钥的提供商阶段交给 Picker，密钥仍使用独立遮罩编辑器。

RuntimeStore 为流式消息保留稳定 ID，并发布不可变快照。TUI 只消费快照、提交回答和命令，不执行文件工具、不维护另一份许可结果。

真实 stage 与 demo 使用 scene 的同一个行构建器和角色卡。stage 根据实际消息/活动生成行，不读取作品集样本。审批与多问题内联到所属角色卡；自由答案使用现有输入编辑器。折叠、悬停、窗口草稿和阅读位置属于界面状态。颜色与布局的当前规则见 [UI-SPEC](../UI-SPEC.md)。

[markdown.ts](../../src/tui/markdown.ts) 将 Assistant 正文的标题、列表、引用、围栏及行内强调/代码/链接转换为带样式的字形行，并保存显示列到原文位置（UTF-16 索引）的映射。[markdown-table.ts](../../src/tui/markdown-table.ts) 识别表格、分配列宽、对齐和折行，窄屏纵向呈现；复制合并同一原文行的映射，保留源语法并排除填充。stage 使用 WeakMap 按不可变 Message 缓存正文和工具卡布局，每条消息最多保存两个布局；流式消息替换后只重建变化项，活动与所属消息按身份索引。viewport 只取可见行，阅读锚点用消息和原文位置；表格折行通过单元格字形映射定位，避免跨列原文范围重叠导致回跳。运行时消息、账本和模型协议没有新增字段。

[terminal.tsx](../../src/tui/terminal.tsx) 是 CLI 全屏输出边界，串行衔接 Ink 写出和 [TerminalPlane](../../src/tui/terminal-plane.ts) 会话画布。Ink 保留固定高度的空白历史区域，继续负责输入、状态栏与对话框；App 在提交阶段交接区域，各窗口用引用累计滚轮锚点，纯滚动不更新 React。画布缓存行样式，以独立帧调度和局部 SU/SD 平移旧内容，只补新行；Ink 重画、缩放和区域大小变化后恢复画布，整页命令界面交还区域时先清空，退出取消调度并移除监听。鼠标命中和复制读取当前画布。非全屏、非交互及屏幕阅读器使用 Ink 正文路径。回归入口为 [terminal-scroll.test.tsx](../../tests/terminal-scroll.test.tsx)、[stage-reading.test.ts](../../tests/stage-reading.test.ts) 与现有 App/命令界面测试。

## 入梦与依赖方向

Anamnesis 目前提供生命周期：有新材料且前台空闲时符合启动资格，草稿只刷新空闲时间，前台提交暂停；进程内续做复用活动身份。runner 只获得身份、取消信号和阶段汇报。只读研究、来源核验、持久检查点和长期档案提交仍待迁移，正式模型入口暂未装配入梦 runner。

依赖方向为：CLI/装配 → Agent、剧团、模型、工具和持久化；这些模块 → runtime 协议。TUI → runtime 快照和呈现数据。demo 单独装配脚本执行器，不能成为真实工具或模型逻辑的依赖。
