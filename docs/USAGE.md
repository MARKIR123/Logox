# 使用 Logox

安装步骤见[项目 README](../README.md)，键盘与鼠标操作见[终端操作](UI-SPEC.md)。正式对话需要交互式终端；当前不提供 headless、JSON 输出或 `--prompt` 模式。

## 首次连接模型

启动后依次输入：

```text
/login
/model
```

`/login` 打开正式提供商向导，`/login deepseek` 仍直接进入指定提供商的快捷登录。菜单分为 **Add a new provider / Edit an existing provider**。新建包含内置 API、自定义接口和账号登录三支：内置 API 选择提供商 → 遮罩 key → 默认/覆盖地址 → 模型 → 保存确认；自定义接口按路由名 → 遮罩 key（可留空）→ 同批地址/协议 → 模型 → 保存确认。协议支持 Chat Completions、Responses 和 Anthropic Messages。账号直接启动 OpenAI/ChatGPT 浏览器授权，不重复询问 API key。编辑先选已配置提供商，再修改单个字段；自定义服务可改 key、地址、协议、模型或删除，内置服务可改 key、模型或删除；删除需再次确认。

表单自动获得焦点，Space 勾选模型、Enter 提交，连接页可左右切题，Ctrl+K 折叠/恢复草稿（登录期间聊天草稿可编辑，但暂不能提交聊天或其他命令）。Esc 在同批后续问题返回前题，在首题结束该批；保存确认前取消不写入。密钥留在本地表单与认证存储中，不进入普通工具问答、会话账本或模型上下文。默认 `/login` 不扫描 dsh-tui/Codex 的凭据文件，也不在 Add/Edit 菜单混入 Import。也可使用下面的 TOML 配置。

认证保存在用户目录 `~/.logox/auth.json`，与项目聊天账本分开。优先使用 Logox 保存的认证，其次是指定的密钥环境变量，最后是显式配置的只读认证文件。`auth_file` 支持兼容的 API key 记录和完整环境变量引用，不支持执行命令取密钥；它与 Logox 自己的 OAuth 登录是不同入口。

`/model` 查询已认证或已配置服务的模型目录。面板标题写成 `Select Model for <角色>`，从上到下固定分区：供应商标签页（`Tab` 下一家、`Shift+Tab` 上一家）、`Search:`、一行留白、该供应商的模型列表、分隔线、思考档位、快捷键说明。模型行不再重复拼服务名，同名模型归属由标签页区分；每个模型行显示自己的上下文窗口与档位，档位滑条只作用于当前选中的模型。一家服务查询失败不代表其他服务也不可用。`/models` 只查询当前提供商。也可以直接选择：

```text
/model provider/model-id
```

将 `provider/model-id` 换成目录中的实际身份。模型简称可能根据缓存匹配到其他提供商；想明确指定服务时使用完整形式。

- `/check-provider` 会发送真实请求，可能计费。
- `--check-config` 只展示配置与认证是否存在，不证明远端可用。
- 首次安装没有预先选好的模型，也不会自动安装或下载本地模型。

## 配置

通常先用交互命令即可。`/settings` 打开可编辑的 Settings 与 Statusbar 页面，用于主题、光标、动画及状态栏偏好；`/animations` 保留为 `/settings` 的旧别名。`/config` 打开单页只读的 Effective Configuration，查看当前生效的模型、思考档位、Base URL、Automa 和执行限制，不提供外观开关或配置修改；`/status` 则查看运行状态与用量。需要固定参数时，可参考 [config.example.toml](../config.example.toml)，放到用户 `~/.logox/config.toml` 或项目 `.logox/config.toml`。

### 加载顺序

从低到高为：默认值 → 用户配置 → 项目祖先目录配置（从远到近）→ 已保存模型偏好 → `LOGOX__` 环境变量 → CLI 参数。

当前还会加载 `.logox-ts` 兼容目录：同一层先读 `.logox/config.toml`，再读 `.logox-ts/config.toml`。因此兼容目录中重名字段可能覆盖主目录，不应同时维护两份配置。同一物理文件只加载一次。

切换提供商不会继承上一家的地址、模型或认证设置。已保存的选择以项目状态为主；部分组件仍读取兼容目录中的用户偏好，不应依赖跨项目全局模型选择完全一致。

环境变量使用双下划线分层，例如 `LOGOX__PROVIDER__MODEL` 和 `LOGOX__KERNEL__MAX_ITERATIONS`。配置文件不接受直接保存 `api_key`，请使用 `/login` 或 `api_key_env`。

### 内置服务与自定义接口

| 名称 | 协议 | 默认地址 | 密钥环境变量 |
|---|---|---|---|
| `openai-compatible` | OpenAI 兼容 | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openai` | OpenAI 兼容 / 特定 OAuth 路由 | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `deepseek` | OpenAI 兼容 | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `anthropic` | Anthropic 原生 | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `antigravity` | 本地 OpenAI 兼容代理 | `http://127.0.0.1:8045/v1` | 通常无需配置 |

Ollama、LM Studio 等需要显式定义兼容服务。例如，先启动本地服务，再在项目配置中添加：

```toml
[providers.local]
kind = "openai_compat"
base_url = "http://127.0.0.1:11434/v1"
default_model = "your-model-id"

[provider]
name = "local"
```

把 `your-model-id` 换成实际可用的模型。Logox 不启动该服务，也不验证本地模型实际分配的上下文与声明一致。

### 窗口、输出与超时

- `provider.max_tokens` 是请求输出上限，还会受模型能力和剩余窗口裁剪。
- `provider.timeout` 默认 600 秒，表示连续没有有效模型进展的期限，不是整个任务的最长时间。正文、思考和工具参数可刷新期限，空心跳不能。
- `kernel.max_iterations = 0` 默认不设模型往返次数上限；正数在达到额度后询问是否继续。取消仍可随时结束任务。
- 模型窗口来自配置、目录或能力推断；未知能力需显式配置。以服务实际窗口为准，不把缓存展示或型号推断当成保证。
- `/effort` 选择当前模型支持的思考档位；模型不支持的档位不会因此变得可用。
- `/usage` 的费用按配置中的每百万 token 静态价格估算，不是提供商账单。未返回的 usage 不会被补造。

### 工具发现与原生协议

系统提示按 `Persona`、`Execution Rules`、`Team Collaboration`、`Tools & Skills`、`Current Environment` 五个主题装配。工具参数定义是请求中的独立字段，不是系统提示中的重复清单。

通常即时提供 Read、Write、Edit、Glob、Grep、Shell、AskUserQuestion、WebFetch；`_FinishRound` 是必备内部例外。原生渐进披露模式下，分类目录仍列出每个可发现工具的名称和简短说明，模型通过 `LoadTools` 精确批量加载契约（Responses 中编码为 client tool search），之后另行调用工具。加载不会执行工具，也不会授予权限；Git 状态仍由模型按需请求。

基础工具的几个边界：Read 默认最多读取 2,000 行，保留所选行的完整内容；UTF-8 文本结果超过 256 KiB 会明确报错，可缩小行范围，单条超长行则需有界提取。文件上限仍为 32 MiB，图片上限为 10 MiB。Shell 为兼容旧调用，将正数且不超过 600 的 `timeout` 按秒解释，超过 600 的值按毫秒解释，省略时为 120,000 毫秒；这与模型服务的 `provider.timeout` 是两个参数。WebFetch 的可选 `prompt` 仅作为返回标题中的上下文目标，不会执行提取或摘要，也不会额外调用模型。

`provider.tool_discovery`、`providers.<name>.tool_discovery` 或 `models."provider/model".tool_discovery` 支持 `auto`、`none`、`anthropic`、`openai-responses`。优先级为模型覆盖 → 当前 provider → 对应 providers 条目 → auto。Auto 仅对明确登记的官方端点/模型开启原生能力；当前 Anthropic 包括 Opus/Sonnet 4.6 与 5.5，OpenAI 包括官方端点上 OAuth 的 gpt-5.4。API-key auto 模式不会为发现功能切换原有 Chat 路由。未知代理、别名和兼容服务使用普通完整合法工具集；显式选择原生协议表示你确认服务兼容，不会触发远端探测。

```toml
[provider]
tool_discovery = "none" # 保守使用普通工具；原生兼容端点可显式选择对应协议
```

`.logox/tools.json` 可独立设置 `roles`、`loading`、`terminalVisibility`；用户级主目录覆盖兼容目录，项目覆盖用户。角色范围为 `all`、`director`、`actors` 或名称数组。`loading` 不决定执行权限或终端显示。旧的非 hidden `promptVisibility` 值仍可读取，但不控制目录详略或原生加载；hidden 排除工具，不能禁用必备的 `_FinishRound`。

技能仍按原有核心条目/领域目录展示，通过 Glob 与 Read 按需读取正文，不随工具加载自动注入。实际模型、权限等变更作为带程序来源的历史记录追加，原始系统基线不因每次实时更新重写。回合结束不清除已发现工具；压缩与恢复保留真实发现证据，回退会排除被移除分支的发现状态。

本地测试证明编码与状态边界，不证明远端模型合规或缓存命中率；缓存节省需另行授权测量。详见[上下文模块](modules/context.md)。

### 网络

生成请求与模型目录共用网络层。可在启动终端设置 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 等代理变量；未设置环境代理时还可能读取 settings 中的 `httpProxy`。代理失效时的本地端口探测不等于自动发现任意系统代理。

连接中断和无进展超时会有限重试。已完成工具不会因恢复而重放，半截工具参数不会执行。重试耗尽后保留历史和失败状态，需要你处理原因或明确继续；认证、额度、协议错误不会一律自动切换模型。

## 提交任务与角色

直接输入任务交给 Logox；也可以指定角色：

```text
@aletheia 查找这个问题的相关实现并核对原因
@techne 修改代码并运行相关测试
@kalon 整理这段说明，让它更容易阅读
```

角色窗口的普通输入交给当前角色。每个角色维护独立历史；**同角色任务串行，不同角色可以并发**，它们仍共享项目文件，不是隔离工作树。Logox 可以派发任务并接收结果，`/cast <task>` 则向三个内置 Actor 提交同一任务。

`/actors` 查看定义；`/model <actor>` 设置角色默认模型，未指定时继承会话模型。在 Actor 窗口输入 `/model` 也设置该角色默认值。角色定义与技能覆盖见[角色模块](modules/actors.md)，单任务确认转用见[任务模型](modules/task-models.md)。

## Queue, Steer and Director coordination

- 普通输入栏右侧的 `⛶` 四角图标展开当前草稿（悬停高亮，不增加外框）；全屏内 Enter/Shift+Enter 换行，Ctrl+Enter 或 Send 按原 Queue 语义发送，Esc/Collapse 收起不丢稿。全屏 Ctrl+T 仍是 Steer，详细编辑操作见[终端操作](UI-SPEC.md#全屏草稿编辑)。
- **Enter / Queue** submits later work. If the same Actor is busy, that work stays out of its active model request and waits for its own activity. Pending human task rows carry a `Queued` label; the footer shows the pending human-task count (all Actors in the main window, the current Actor in an independent window). Very narrow footers use `Q<count>` so configured status information can remain visible.
- **Ctrl+T / Steer** supplements the selected live activity at its next model-request boundary. The footer names the target. Ctrl+N selects a task or a tool/thinking card belonging to that task; clicking a card also selects its owning activity. Without an explicit selection, a window with exactly one live activity uses that activity. Selection is bound to its activity ID: if it ends, the draft is retained rather than sent to another task.
- Steer does not cancel a request or process, answer a pending question, or execute slash commands / actor-routing syntax. Use Queue for commands and separately addressed work. Existing Esc and Actor Stop controls still cancel explicitly.
- Formal Director assignments deliver full reports through a durable priority queue. Failures and assistance requests precede ordinary reports; equal-priority messages remain FIFO. Relevant events enter a busy Director before its next request, or wake an idle Director. An explicit human stop is never undone by a notification.
- Director receives a bounded facts snapshot only when relevant child work or coordination events exist. `ListActors` provides detail, including custom roles and recent tool outcomes. A completed command or self-reported label is not task acceptance.
- Direct human/Actor conversations remain independent, including local failures. An explicit message requesting Director assistance can enter coordination without transferring the whole conversation or granting new authority.
- Restart retains queue data and history but does not restart interrupted work or replay tools. Bound steering is not retargeted after restart; unfinished human task checkpoints remain visible as interrupted work. Failed coordination consumption may be redelivered with stable event IDs: this is not exactly-once execution. Rewind excludes removed delivery ancestry while retaining raw ledgers.
- There is no periodic Director polling, read-count limit or automatic stagnation verdict.

## 会话、整理与回退

普通启动恢复最近的正式会话。没有历史或执行 `/new` 时先打开临时空白，首次提交任务才登记；只打开设置不会产生空白聊天记录。会话恢复展示历史，不自动续跑工具或重新发请求。占用或损坏的会话会报告原因，不静默改选另一段历史。

| 命令 | 作用与边界 |
|---|---|
| `/new` | 新建临时空白会话 |
| `/resume [id]` | 打开会话列表或恢复指定会话 |
| `/clear` | 清理当前显示，不删除模型历史 |
| `/compact` | 整理有效上下文，保留原始账本；必要时调用汇总模型 |
| `/undo` | 撤销受支持文件工具的近期修改，不覆盖手工后续改动 |
| `/rewind` | 回退有效对话分支与相应文件快照；原始记录仍保留 |

会话列表可用 Ctrl+X 进入删除确认，默认取消。当前会话和其他活进程占用的会话不可删除；删除内容先备份到项目 `.logox/state/trash/`。

`/undo` 与 `/rewind` **不回滚 Shell、MCP 或其他外部系统的副作用**。多文件恢复也不是操作系统事务；发生部分失败时需按提示处理。上下文整理与存储边界见[上下文模块](modules/context.md)。

## 权限

使用 `/permissions` 查看规则，`/permissions mode` 选择模式：

| 模式 | 默认行为 |
|---|---|
| `default` | 普通只读走安全快路，其余需要人工授权 |
| `auto` | 常规安全操作直接执行，不确定操作交审批模型，必要时仍询问人工 |
| `creative` | 显式拒绝和危险过滤后，其他操作默认允许 |

显式 `deny` 优先于允许规则。规则可按 `session` 或 `project` 保存，项目规则与模式保存在 `.logox/permissions.json` 并绑定项目真实路径。移动项目后不能直接把旧路径当成同一安全身份。

`creative` 允许写运行目录，但凭据和 Git 内部文件仍有独立保护。项目外访问、符号链接和 Shell 的实际影响仍经过入口检查；获准执行的进程拥有当前系统用户的真实能力。这是应用内权限机制，**不是 OS 级沙箱**。

## 资源与扩展

- 规范：按目录加载 `LOGOX.md`、`AGENTS.md` 或用户自备的 `CLAUDE.md`。
- 技能：内置库、用户 `.logox/skills/`、项目 `.logox/skills/` 按名称覆盖。支持递归 Markdown、角色目录和 `agent.md` 分类路标；正文按需读取。
- 模板：用户或项目 `.logox/commands/` 下定义，展开为任务输入，不直接执行 Shell。
- `/reload`：空闲时重新加载规范、技能、模板和角色定义；不替换运行中的提供商或重启 MCP 配置。
- MCP：当前支持 stdio 子进程，首次使用时启动，调用经过 schema 与权限检查。
- Hooks：观察事件并执行配置的命令；启用前检查脚本，它们不是沙箱内的纯数据。

`.logox-ts` 中的兼容资源仍可能参与加载，避免放置冲突副本。格式、覆盖规则和生命周期见[资源与扩展](modules/resources-and-extensions.md)。

## 浏览器验证与离线运行

默认提供本地 `playwright` MCP 服务，按需启动；不使用 `npx` 临时下载，也不连接远程浏览器服务。首次在有网时执行：

```bash
npm run browser:install
```

服务依赖随 `npm ci` 安装，浏览器需提前准备并保留其用户缓存。之后浏览器本身可以离线运行，但网页的 CDN、远程字体和接口，以及云端模型仍有独立的网络需求。移动到另一台机器或更新 Playwright 版本后，需要重新准备匹配的浏览器。

模型通过同一个 MCP 页面会话导航、观察、点击、输入和截图。导航或点击结果可能只提供快照文件链接；调用不带文件名的 `browser_snapshot` 可直接获取页面内容及当前元素引用。MCP 返回的图片直接进入视觉输入；仅返回图片文件路径时才需要 `Read`。默认截图产物写入隔离的临时工作目录。多角色应约定一位浏览器操作者，避免互相切换页面。普通截图不保证固定动画时刻或字节一致。

本地页面建议通过本机 HTTP 预览访问；默认不开放无限制的 `file://` 和项目外文件访问。需要自定义浏览器时，可用 Playwright 官方的 `PLAYWRIGHT_MCP_EXECUTABLE_PATH` 环境变量，或在 `[mcp.servers.playwright]` 中显式覆盖服务配置。

关闭内置浏览器：

```toml
[mcp]
playwright = false
```

修改 MCP 配置后重启 Logox；`/reload` 不重启服务。浏览器调用仍遵守现有 MCP 权限检查。服务使用独立的临时浏览器上下文，不复用日常浏览器的登录资料。

## 状态栏组合与风格

`/statusbar` 打开模块编辑器；`/settings` 的 Statusbar 标签是同一个入口。选择 Pipes（彩色字段、竖线、上下文进度条）或 Starship（彩色底段、Powerline 连接符），独立选择 theme / gruvbox / dracula 配色。↑↓ 聚焦，Space 开关模块，←→ 调整模块顺序；风格和配色行的箭头只改选项。实时预览不写盘，Enter 保存，Esc 丢弃未保存草稿。`/settings` 中 Enter 应用当前标签后保留页面及另一标签草稿；独立 `/statusbar` 保存后收起。

先安装 [Nerd Font](https://www.nerdfonts.com/font-downloads) 并在终端选择 Mono 字体，例如 `JetBrainsMono NFM`。偏好保存在 `~/.logox/statusbar.json`，旧布局自动兼容。细节见[模块化状态栏](UI-SPEC.md#模块化状态栏)。

## 常用命令

输入 `/` 可打开命令候选，↑/↓ 选择，Tab 补齐。完整行为以命令界面与当前实现为准。

| 用途 | 命令 |
|---|---|
| 帮助与状态 | `/help`、`/status`、`/usage`、`/commands` |
| 生效配置（只读） | `/config` |
| 外观与状态栏偏好 | `/settings`，旧别名 `/animations` |
| 状态栏组合 | `/statusbar`，也可从 `/settings` 切到 Statusbar 标签 |
| 登录与模型 | `/login [provider]`、`/model [provider/model]`、`/model <actor> [provider/model]`、`/models` |
| 思考档位 | `/effort [level]`，别名 `/thinking`、`/think` |
| 服务管理 | `/providers [name] [model]`、`/check-provider`、`/providers logout <name>` |
| 角色 | `/actors`、`/ensemble`、`/cast <task>`、`@actor <task>` |
| 会话与上下文 | `/new`、`/resume [id]`、`/clear`、`/compact`、`/rewind`、`/undo` |
| 资源与权限 | `/skills`、`/reload`、`/permissions` |

CLI 支持 `--help`、`--demo`、`--session <id>`、`--resume`、`--provider <name>`、`--model <id>`、`--base-url <url>`、`--auth-file <path>`、`--check-config`、`--check-provider`、`--list-providers`、`--list-models`。例如 `npm start -- --help`；`npm start` 不会自动构建。

## 数据位置与构建

| 位置 | 内容 |
|---|---|
| `~/.logox/` | 认证、自定义提供商、模型目录、角色模型绑定、状态栏偏好及用户资源 |
| 项目 `.logox/` | 配置、权限、角色覆盖、技能、模板与 bulletin |
| 项目 `.logox/state/` | 会话索引、原始账本、上下文检查点、用量和删除备份 |
| 系统临时目录的 `logox-scratchpad/` | 按项目与会话隔离的临时工作资料 |

不要把认证和运行目录提交到公共仓库。项目会话可能包含源码、工具输出和任务内容；保管与分享前自行检查。

`npm run build` 只生成 `dist` 并复制角色与技能分发资产，不改写用户 home。资源加载会补入缺失的内置技能，并刷新内容完全匹配已知旧版本的浏览器技能；用户修改过的文件保持不变，旧版自定义截图流程需自行更新。角色安装与迁移也只更新已知且未修改的分发默认内容。
