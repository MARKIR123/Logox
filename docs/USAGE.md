# 使用 Logox

安装步骤见[项目 README](../README.md)，键盘与鼠标操作见[终端操作](UI-SPEC.md)。正式对话需要交互式终端；当前不提供 headless、JSON 输出或 `--prompt` 模式。

## 首次连接模型

启动后依次输入：

```text
/login
/model
```

`/login` 打开提供商选择与认证流程，也可以直接输入 `/login deepseek`。API key 输入会被遮罩；OpenAI 还支持浏览器 OAuth。取消未提交的输入不会保存，完成后返回对话并保留原草稿。自定义服务可在向导中添加，或使用下面的 TOML 配置。

认证保存在用户目录 `~/.logox/auth.json`，与项目聊天账本分开。优先使用 Logox 保存的认证，其次是指定的密钥环境变量，最后是显式配置的只读认证文件。`auth_file` 支持兼容的 API key 记录和完整环境变量引用，不支持执行命令取密钥；它与 Logox 自己的 OAuth 登录是不同入口。

`/model` 查询已认证或已配置服务的模型目录，列表按提供商区分同名模型。一家服务查询失败不代表其他服务也不可用。`/models` 只查询当前提供商。也可以直接选择：

```text
/model provider/model-id
```

将 `provider/model-id` 换成目录中的实际身份。模型简称可能根据缓存匹配到其他提供商；想明确指定服务时使用完整形式。

- `/check-provider` 会发送真实请求，可能计费。
- `--check-config` 只展示配置与认证是否存在，不证明远端可用。
- 首次安装没有预先选好的模型，也不会自动安装或下载本地模型。

## 配置

通常先用交互命令即可。需要固定参数时，可参考 [config.example.toml](../config.example.toml)，放到用户 `~/.logox/config.toml` 或项目 `.logox/config.toml`。

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

## 常用命令

输入 `/` 可打开命令候选，↑/↓ 选择，Tab 补齐。完整行为以命令界面与当前实现为准。

| 用途 | 命令 |
|---|---|
| 帮助与状态 | `/help`、`/status`、`/config`、`/usage`、`/commands` |
| 登录与模型 | `/login [provider]`、`/model [provider/model]`、`/model <actor> [provider/model]`、`/models` |
| 思考档位 | `/effort [level]`，别名 `/thinking`、`/think` |
| 服务管理 | `/providers`、`/provider [name] [model]`、`/check-provider`、`/providers logout <name>` |
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

`npm run build` 不只生成 `dist`：当前资源复制脚本还会同步内置技能到用户 `.logox-ts/skills/`，并在对应用户 Actor 目录已存在时同步内置角色档案，可能覆盖内置同名文件。定制内容应另存，自动化构建应隔离用户 home。首次资源加载还会将缺失的内置技能种入主目录，行为与构建同步不完全相同。
