# 使用 Logox

本文是用户手册：从首次连接模型、配置、提交任务，到会话、权限、扩展和全部命令。安装步骤见[项目 README](../README.md)，快捷键与鼠标操作见[终端操作](UI-SPEC.md)。正式对话需要交互式终端；目前没有 headless、JSON 输出或 `--prompt` 模式。

## 首次连接模型

首次安装时没有预先选好的模型，也不会自动安装或下载本地模型。第一次启动且尚未选择模型时，会自动打开设置向导；设置向导开头有一个可选步骤“What should Logox call you?”，输入称呼后回车；直接回车或按 `Esc` 跳过，向导继续。已经完成过首次引导的用户升级后不会再被询问，可随时用 `/name` 设置。之后可随时用 `/setup` 重新打开。也可以直接输入：

```text
/login
/model
```

`/login` 打开提供商向导，`/login deepseek` 直接进入指定提供商：没设置过就是它的添加流程，已设置就是它的编辑菜单。向导没有“新增/编辑”之分，根是两种登录方式（各两行）：`API key`（Sign in with a URL and an API key）和 `Account sign-in`（Authorize in the browser with a provider account）。

**API key 列表**：

- **顺序**：全部列出的内置模板（按模板顺序），然后是你自己的提供商（自定义记录、配置文件里声明的提供商，也包括曾经作为模板的本地代理，例如已有记录的 `antigravity`），再然后是没有对应记录的孤立凭据，最后一项固定是 `Custom endpoint`。
- **每一项两行**：第一行左边是名称，右边靠右对齐一个状态徽标，由“来源 · 状态”组成：来源是 `built-in` 或 `custom`；状态是 `✓ signed in`（已保存 API key）、`✓ env key`（只有模板的环境变量提供密钥）、`✓ local`（有记录的无需密钥的本地端点），尚未设置则只有来源。账号登录的提供商在这张列表里算“未设置”，只显示来源。`✓` 部分用主题的成功色，其余为暗色；孤立凭据显示警告色的 `credential only`。第二行是暗色说明：模板是一句简短描述，自定义提供商是 base URL，`Custom endpoint` 是 “Any OpenAI- or Anthropic-compatible URL with an API key”。终端很窄时先截断名称，再去掉来源，徽标始终可见。鼠标：单击选择，悬停高亮，滚轮滚动。
- **选没设置过的模板**：直接进入添加流程：地址（模板的官方地址已预填，直接回车即保留，也可以改成自己的地址）、key（只有无需密钥的模板可留空）、模型、确认保存。一个提供商名只有一份凭据：如果它当前是账号登录，保存 key 会替换账号登录，确认框的说明行末尾会写 `Replaces the account sign-in`。
- **选已设置的提供商（内置或自定义）**：进入它的编辑菜单：`API key`、`Base URL`、`Wire protocol`、`Model list`，以及 `Delete provider`（没有可删内容时不显示，例如只靠环境变量的模板）。每个有记录的提供商都可改地址和协议。删除需再次确认。如果有人在用这家提供商的模型（当前会话、某个角色的默认模型、Automa 的专用模型），确认框会列出 `In use by: session, techne, ...`；确认删除后这些角色或 Automa 的绑定会被清除，不会被悄悄改成别的模型，并发出一条提示列出需要重新指定的角色（用 `/model <角色>`）。没有绑定的角色沿用会话模型；如果会话模型本身在被删的提供商上，会话回到“未选择模型”，需要用 `/model` 重新选。
- **选孤立凭据**：只能删除。
- **选 `Custom endpoint`**：路由名、key（可留空）、地址或端口与协议（Chat Completions、Responses 或 Anthropic Messages）、模型、确认保存。路由名不能与列表里已有的重复。本地代理（如 antigravity）也从这里添加。

**Account sign-in 列表**：列出支持账号登录的模板（由模板的 `account` 属性决定，目前只有 `openai`），同样两行并带徽标：账号登录的显示 `built-in · ✓ account`，其余只显示来源。选尚未账号登录的会启动浏览器授权；如果它当前保存着 API key，会先确认一次，说明行写 `Replaces the saved API key`（同一个名字只有一份凭据）。选已账号登录的会进入它的菜单：`Sign in again`（重新授权）、`Model list`、`Delete provider`（同样的使用情况确认），没有 API key、地址或协议项。`✓ account` 只出现在这张列表里，其余状态只出现在 API key 列表里。没有任何模板支持账号登录时提示 “not supported”。

**模板与提供商**：模板是内置的快捷方式，只包含名称、固定的官方地址和协议（`openai`、`anthropic`、`deepseek`），本身不是提供商。本地代理 `antigravity` 不再是模板，而是一个用户自己的自定义端点：程序仍认识它的默认地址和 Claude 路由，已有记录照常工作，在列表里显示为 `custom · ✓ local`。提供商是你设置过的东西，每个提供商在 `~/.logox/custom-providers.json` 里有一条记录；模板只负责预填：新增时地址默认取模板的官方地址，之后记录自己拥有地址、协议和 `api`，你可以随时在编辑里修改，启动时不会再用模板覆盖。基于模板的记录带 `catalog: true`，模板只补记录里没存的东西：密钥环境变量，以及仅当记录的地址仍是模板官方地址时才生效的 `model_kinds` 路由。账号登录（OAuth）是提供商的一种凭据类型，哪些模板支持由模板的 `account` 属性决定，目前只有 `openai`。旧的 `openai-compatible` 模板已移除（它与 `openai` 地址和环境变量完全相同）：旧配置或已保存选择里仍写着这个名字（且没有自己的 `base_url`）时，会静默按 `openai` 解析，不会出现在任何列表里；全新安装的默认提供商现在是 `openai`。

列表中的“提供商”依次包括：已保存的记录、配置文件里声明的 `[providers.<name>]`、已设置对应密钥环境变量的模板（零配置可用），以及当前选中的提供商。没有设置过的模板不会出现在提供商列表、`/model` 和 `--list-providers` 的主列表里，只出现在 `/login` 列表里（以及 `--list-providers` 末尾的 Templates 小节）。保存 key 或完成账号登录时会自动创建记录；启动时，`auth.json` 中名称是模板、却没有记录的凭据会补写一条记录。名称既不是模板、记录也不是配置提供商的凭据不会被自动改动或删除，在列表里显示为 `credential only`（说明 Saved credential without an endpoint），只能删除。删除提供商会同时删除记录和凭据。

保存确认前取消不会写入任何内容。密钥只留在本地表单和认证存储中，不进入工具问答、会话账本或模型上下文。向导不会扫描其他工具的凭据文件。登录期间聊天草稿仍可编辑，但暂时不能提交聊天或其他命令。表单内的按键见[终端操作](UI-SPEC.md)。

认证保存在 `~/.logox/auth.json`，与项目聊天账本分开。读取优先级是：Logox 保存的认证，其次是指定的密钥环境变量，最后是显式配置的只读认证文件。`auth_file` 支持兼容的 API key 记录和完整的环境变量引用，不支持执行命令取密钥，也不同于 Logox 自己的 OAuth 登录。

`/model` 查询已认证或已配置服务的模型目录，并按提供商分标签页展示；每个模型行显示自己的上下文窗口和思考档位，档位滑条只作用于当前选中的模型。某一家查询失败不影响其他服务。`/models` 只列出当前提供商的模型。也可以直接指定：

```text
/model provider/model-id
```

把 `provider/model-id` 换成目录中的实际名称。只写模型简称时，可能按缓存匹配到别的提供商；要明确服务，请使用完整形式。

两个检查手段的区别：

- `/check-provider` 会发送一次真实请求，可能计费。
- `--check-config` 只显示配置和认证是否存在，不证明远端可用。

遇到环境问题（Node 版本、终端能力、Playwright 浏览器、角色档案、凭据）时，运行 `npm run doctor` 或 `--doctor`，在会话内也可输入 `/doctor`。`/doctor` 已登记在命令列表中，`/help` 和候选菜单里都能看到；面板内的结果按主题颜色着色，不再输出原始 ANSI。

## 配置

通常用交互命令即可：

- `/settings`：按分组列出外观、启动页和对话偏好，并可进入状态栏、权限、模型与价格、快捷键页面（`/animations` 是旧别名）。详见下文“设置页”。
- `/config`：只读的生效配置，包括当前模型、思考档位、Base URL 和执行限制。
- `/status`、`/usage`：运行状态与用量。

需要固定参数时，参考 [config.example.toml](../config.example.toml)，放到用户级 `~/.logox/config.toml` 或项目级 `.logox/config.toml`。

### 加载顺序

从低到高依次为：

1. 默认值
2. 用户配置：`~/.logox/config.toml`
3. 项目祖先目录配置，从远到近
4. 当前项目 `.logox/config.toml`
5. 已保存的模型偏好
6. `LOGOX__` 环境变量
7. CLI 参数

高层覆盖低层，同一物理文件只加载一次。旧目录 `~/.logox-ts` 已不再读取，`logox --doctor` 会提示迁移。模型偏好以项目状态为主，其次是 `~/.logox`。切换提供商不会继承上一家的地址、模型或认证设置。

环境变量用双下划线分层，例如 `LOGOX__PROVIDER__MODEL`、`LOGOX__KERNEL__MAX_ITERATIONS`。启动时会尝试读取当前目录的 `.env`。配置文件不接受直接保存 `api_key`，请用 `/login` 或 `api_key_env`。

### 内置服务与自定义接口

| 名称 | 协议 | 默认地址 | 密钥环境变量 |
|---|---|---|---|
| `openai` | OpenAI 兼容 / 特定 OAuth 路由 | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `deepseek` | OpenAI 兼容 | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `anthropic` | Anthropic 原生 | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `antigravity`（不在模板列表，经 `Custom endpoint` 添加；已知端点） | 本地代理：默认 OpenAI 兼容，`claude-*` 模型走 Anthropic 原生 `/v1/messages` | `http://127.0.0.1:8045/v1` | 通常无需配置 |

同一个提供商可以按模型切换协议：`model_kinds` 把模型名模式（`*` 匹配任意字符，不区分大小写，先匹配先用）映射到 `openai_compat` 或 `anthropic`，未命中的模型保持提供商自身的 `kind`。`antigravity` 预置了 `{"claude-*" = "anthropic"}`：同一地址和端口，Claude 模型发往 `/v1/messages`（思考、缓存断点、用量都按 Anthropic 协议），Gemini 等仍走 `/chat/completions`。预置只对预置地址生效；自定义时写在 `[providers.<name>]` 或 `[provider]` 下，写 `{}` 可关闭。`[provider] kind` 显式设置时整体固定为该协议。

```toml
[providers.work]
kind = "openai_compat"
base_url = "http://127.0.0.1:8045/v1"
model_kinds = { "claude-*" = "anthropic" }
```

使用 `reasoning-effort` 思考协议（如 antigravity 的 Gemini）的 OpenAI 兼容请求不再把历史思考作为 `reasoning_content` 回传，避免代理把正文误标为思考后被当作示范。DeepSeek 等需要回传的提供商不受影响。

Ollama、LM Studio 等本地服务需要显式定义。先启动本地服务，再在项目配置中添加：

```toml
[providers.local]
kind = "openai_compat"
base_url = "http://127.0.0.1:11434/v1"
default_model = "your-model-id"

[provider]
name = "local"
```

把 `your-model-id` 换成实际可用的模型。Logox 不会启动该服务，也不会验证本地模型实际分配的上下文是否与声明一致。

### 窗口、输出与超时

- `provider.max_tokens` 是请求输出上限，还会按模型能力和剩余窗口裁剪。
- `provider.timeout` 默认 600 秒，表示连续没有有效模型进展的期限，不是整个任务的最长时间。正文、思考和工具参数都会刷新期限，空心跳不会。
- `kernel.max_iterations = 0`（默认）不限制模型往返次数；设为正数时，达到额度会询问是否继续。取消随时可用。
- 模型窗口来自配置、目录或能力推断，未知能力需显式配置。以服务实际窗口为准。
- 图片：每张进入历史的图片都有磁盘文件（`Read` 用源文件路径，浏览器截图等写入调用者草稿区的 `images/`），路径写在工具结果文本里，之后不再改变。请求里图片原样内联，没有滑动窗口。整理上下文时，被归档部分的图片变成 `[image: 路径]` 文字，只有保留的近期部分仍内联。
- `max_images`（可写在 `[provider]` 或 `[models."p/m"]`，可选）是单次请求的图片上限；Anthropic 协议默认 100（官方上限），其他协议默认不设，只在服务拒绝“图片过多”时处理。超限时一次性把最旧的图片换成 `[image: 路径]`，直到约剩上限的一半，并保存这个决定，之后的请求保持字节一致；服务拒绝时同样降一半后重试一次。旧配置没有这个键，行为不变。
- 工具结果超过 32768 字符落盘到 `tool-results/` 并只留预览；同一轮并行工具结果合计超过 200000 字符时，按从大到小继续落盘，直到总量不超过上限。两项都在结果产生时决定一次，不会事后改写。
- `/effort`（别名 `/thinking`、`/think`）选择当前模型支持的思考档位；不支持的档位不会因此可用。
- `/usage` 的费用按每百万 token 的静态价格估算（先看 `[models."p/m".prices]`，再查[内置模型表](modules/model-table.md)；自建网关用 `[catalogs.<name>]` 指定对应目录），不是提供商账单；服务未返回的 usage 不会被补造。

### 网络

生成请求与模型目录共用网络层。可在启动终端前设置 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 等代理变量；未设置环境代理时，还可能读取 settings 里的 `httpProxy`。

连接中断和无进展超时会有限次重试。模型只返回思考或空回复时，运行时先用一条固定提醒（“Your previous reply was empty. Continue the task: call a tool or give your answer.”）自动重试一次，之后才进入原有的恢复与失败流程。已完成的工具不会因恢复而重放，写到一半的工具参数不会执行。重试耗尽后历史和失败状态都会保留，由你处理原因或明确继续；认证、额度、协议类错误不会一律自动换模型。

### 工具发现

模型默认直接可用 `Read`、`Write`、`Edit`、`Glob`、`Grep`、`Shell`、`ShellJob`、`AskUserQuestion`、`WebFetch`，其余工具在需要时通过 `LoadTools` 加载。加载只是让模型看到工具契约，不会执行工具，也不授予权限。

`Write` 拒绝整体改写已有的大文件（超过 20 KB 或 400 行）：被拒绝的内容会先保存到调用者自己的 scratchpad（`rejected-writes/` 目录），拒绝信息里给出保存路径，并建议改用 `Edit`；确实需要整体替换时再传 `overwrite: true`。

### 后台命令

服务器、监视器这类不会退出的命令用 `Shell` 的 `run_in_background: true` 启动：命令脱离本次调用，立即返回任务 id（如 `job-1`）、pid 和启动阶段的初始输出，不会占满前台超时。之后用 `ShellJob({id})` 读取自上次读取以来的新输出（超过 32 KB 的旧输出会丢弃），`ShellJob({id, stop: true})` 结束整个进程树。后台任务随启动它的任务一起结束（完成、失败或被取消），应用退出时全部结束；因此要在需要它的那个任务里启动。Automa 工作者不能使用后台模式。

`tool_discovery` 可取 `auto`、`none`、`anthropic`、`openai-responses`，在 `[provider]`、`[providers.<name>]` 或 `[models."provider/model"]` 下设置，范围越具体优先级越高，默认 `auto`。`auto` 只对明确登记的官方端点和模型启用原生协议；代理、别名和兼容服务一律使用普通完整工具集。显式选择原生协议表示你确认服务兼容，Logox 不会探测远端。

`prompt_cache_key` 为布尔值，设置位置与优先级同 `tool_discovery`。官方 `https://api.openai.com/v1` 默认开启：每个会话与角色发送固定的不透明键（`prompt_cache_key`），帮助 OpenAI 把同一前缀的请求路由到同一缓存；其他兼容网关默认不发送该字段，确认服务接受后可设为 `true`。键只影响路由，不保证命中。

### 提示缓存保留与保活

`cache_retention` 取 `short` 或 `long`，在 `[provider]`、`[providers.<name>]` 或 `[models."provider/model"]` 下设置，范围越具体优先级越高，默认不设置。它决定 Anthropic 提示缓存的生命周期：`long` 在每个断点写入 `cache_control: {type: "ephemeral", ttl: "1h"}`（一次请求只用一种生命周期，写入价 2 倍），`short` 保持默认 5 分钟（写入价 1.25 倍）。未设置时按角色取默认值：Director（logox）为 `long`，因为它要长时间等待派出的任务；其他角色为 `short`，因为它们在紧凑的工具循环里，更长的生命周期只增加写入成本。单个角色可在自己的 `config.yaml` 里写 `cache_retention: long`（或 `short`），优先于模型设置和角色默认值，优先级为：角色 > 模型 > 提供商 > 角色默认。

OpenAI 不受角色默认值影响：只有在提供商或模型上显式写 `cache_retention = "long"` 才会发送保留字段，Director 默认的 `long` 不会自动开启 OpenAI 的 2.5 倍写入选项。GPT-5.5 及更早的 `gpt-*` 模型发送 `prompt_cache_retention: "24h"`；GPT-5.6 及以后在 Responses 请求里发送 `prompt_cache_options: {"ttl": "12h"}`（写入价 2.5 倍）。其他提供商不受影响。

`cache_ttl_seconds`（正数，单位秒）可选，设置位置与优先级同 `cache_retention`。它告诉 Logox 这个网关的提示缓存大约保留多久，用来判断 Logox 的缓存是否已过期、是否可以免费折叠旧轮次（见[上下文管理](modules/context.md)）。设置了就以它为准。没有设置时，Anthropic 协议按 `cache_retention` 对应的时长计算；OpenAI 和其他服务不公开时长，视为未知，即永不过期，此时只在上下文达到高水位一半或越过水位线时折叠。设得比真实时长长，折叠只会晚一点发生；设得更短，则可能白付一次缓存写入。

```toml
[models."anthropic/claude-sonnet-5-5"]
cache_retention = "long"   # 该模型的所有角色都用 1 小时缓存，除非角色自己覆盖

[kernel]
cache_keepalive = true     # 默认开启
```

`cache_keepalive`（`[kernel]`，默认 `true`）在角色空闲、但必然会被再次唤醒时保活短缓存。必然唤醒只有两种情形：Director 的某个根任务下还有排队或运行中的派发工作（没有等待人类的交付），或某个角色在等待 `ask` 的回复且对方正在运行。等待人类时从不保活。保活重放该角色上一次请求（同样的工具、系统提示、消息和思考配置），只把 `max_tokens` 设为 1，不重试，在缓存生命周期的 90%（或剩余 10 秒，取较早者）时发出，直到角色被唤醒、工作结束或满 1 小时。只有 `missCost - warmCost >= $0.05` 才发送，价格未知则不保活；Anthropic `long`（1 小时缓存已覆盖等待）、预算式思考（`budget_tokens` 随 `max_tokens` 变化，无法重放）以及 OpenAI 默认保留都会跳过。保活请求不进入历史和时间线，用量以 `keepalive` 类别记入 `usage.jsonl`，`scripts/score-session.mjs` 为每个角色单列一行。

价格表里 `cache_write` 是 5 分钟写入价，1 小时写入价默认取输入价的 2 倍，可用 `cache_write_1h` 覆盖；用量中 `cache_creation.ephemeral_1h_input_tokens` 按 1 小时价计费，其余写入按 5 分钟价。

### 请求转储（调试）

设置环境变量 `LOGOX_DUMP_REQUESTS=1` 后，每个发给模型的请求体（经最终序列化器，与实际发送的字节一致）会写入 `.logox/state/sessions/<会话>/requests/<角色>/<序号>-<时间>.json`；缓存保活请求带 `-keepalive` 后缀。只写请求体，不含请求头、密钥或认证信息，但请求体本身包含对话内容，分享前请检查。

`node scripts/diff-requests.mjs <requests 目录或单个角色目录> [--context N] [--keepalive]` 对同一角色的相邻请求打印首个不同字节的偏移，以及两侧各约 200 个字符的上下文（默认跳过保活请求）。用它定位为什么前缀缓存没有命中：前缀应当逐字节不变，差异出现得越靠前，缓存损失越大。

```toml
[provider]
tool_discovery = "none" # 保守使用普通工具集
```

`.logox/tools.json` 可按角色设置工具的 `roles`、`loading` 和 `terminalVisibility`，项目级覆盖用户级。`_FinishRound` 是必备的内部工具，不能被禁用。协议编码、渐进披露和缓存相关的细节见[上下文模块](modules/context.md#系统提示与工具披露)。

## 提交任务与角色

直接输入任务交给 Logox，也可以用 `@` 指定角色：

```text
@aletheia 查找这个问题的相关实现并核对原因
@techne 修改代码并运行相关测试
@kalon 整理这段说明，让它更容易阅读
```

在角色窗口里输入的普通内容交给当前角色。每个角色有独立的历史：**同一角色的任务串行，不同角色可以并发**。它们共享同一份项目文件，不是隔离的工作树。`/cast <task>` 把同一个任务同时交给三个内置角色。

`/ensemble` 打开角色总览（见下节）；`/model <actor>` 设置该角色的默认模型，未设置时继承会话模型。在角色窗口里输入 `/model` 也是设置该角色的默认值。角色定义与技能覆盖见[角色模块](modules/actors.md)，单任务的模型确认与转用见[任务模型](modules/task-models.md)。

### 排队与插话

一条输入有三种去向：

| 方式 | 触发 | 行为 |
|---|---|---|
| 发送 | Enter | 目标（Logox，或当前聚焦的角色窗口）空闲时立即开始新一轮。目标正在运行时消息排队：它不写进时间线，而是显示在输入框上方的待发送列表（每条一行，行尾 `Queued · Send now  ×`），本轮结束后按顺序作为后续轮次送出并离开列表。斜杠命令和 `/skill` 展开不排队 |
| 立即发送（Send now） | 点击行尾 `Send now`，或输入框为空时按 Ctrl+T（发送最新一条） | 把该条待发送消息在目标下一个步骤边界（当前模型回复或当前工具批次结束之后、下一次模型请求之前）注入正在运行的一轮，并附一条静态提示，让模型知道这是工作中途收到的消息，可能改变方向。不会中止正在运行的工具。它随后作为该轮内带淡色 `· steered` 的用户行出现在时间线，并离开待发送列表 |
| 精确插话（Steer） | 有草稿时按 Ctrl+T | 把草稿直接在选中活动的下一次模型请求边界补充进去，页脚会写明目标；用于同一窗口有多个活动时指定其一，或目标正在等待回答时 |

待发送行的 `×` 把消息取回输入框（草稿非空则追加到末尾）。待发送列表只保存在当前进程内，退出或切换会话时未送出的消息不会保留。

引导消息写入对应角色的追加式账本（`source` 为 `steered`），恢复会话时仍显示为 `· steered` 行，模型看到的账本保留提示前缀。在 Logox 窗口里输入 `@角色 内容` 时，如果该角色正在运行，同样进入待发送列表（行首标 `→ 角色`），可对它 Send now。按 `Esc` 取消的语义不变，恢复到输入框的仍是原始请求，而不是引导消息。

精确插话的规则：

- 目标用 Ctrl+N 选择，可以选任务，也可以选属于该任务的工具或思考卡片；点击卡片同样会选中它所属的活动。没有显式选择时，如果窗口里恰好只有一个进行中的活动，就用它。
- 选择绑定到活动本身：目标结束后草稿保留在输入框，不会发给别的任务。
- 插话不会取消请求或进程，也不会回答待处理的提问，不能执行斜杠命令或 `@角色` 路由。命令和另行指派的任务请直接用 Enter。取消仍用 `Esc` 和角色的停止控制。

在 Logox 窗口里 `Esc` 分两级：第一次只停止 Logox 当前回合（若它派出的角色仍在工作，通知行会列出它们并提示再按一次 Esc）；约 2 秒内再按一次，停止 Logox 派出的全部角色、排队任务、Automa 工人和它们的后台 Shell 任务。你在某个角色窗口里亲自发起的任务不会被停止，角色窗口里的 `Esc` 仍只是返回 Logox。
- 普通输入栏右侧的 `⛶` 可展开全屏草稿编辑，其中 Ctrl+Enter 与 Enter 同样发送，Ctrl+T 为 Send now / 精确插话，详见[终端操作](UI-SPEC.md)。

### Logox 的协调

Logox 向角色正式派工后，各角色的结果通过持久化的优先队列回到 Logox：失败和求助先于普通报告，同优先级按先后顺序。Logox 忙时，相关事件在它下一次请求前进入；空闲时会被唤醒。用户的显式停止不会被通知撤销。

- Logox 只在存在相关的角色工作或协调事件时，才收到一份有限的事实快照；`ListActors` 提供更多细节，包括自定义角色和近期的工具结果。命令执行完或角色自述状态，都不等于任务通过验收。
- 派工使用 `Actor` 工具：`title` 与 `prompt`（写给没看过对话的同事的完整说明）之外，可选 `owns`（可修改的路径，同时驱动文件归属提示）、`acceptance`（验收标准，随报告一并回到 Logox）和 `after`（依赖的角色 ID 或活动 ID）。`owns` 与 `acceptance` 会被渲染为角色任务中的一段 `Brief`。设置 `after` 后，运行时会让该任务排队（卡片显示 `Waiting on <角色>`），待所依赖的任务完成后，连同其报告一并交付；依赖失败或被停止时，该任务不会启动。派工成功后，结果末尾可能附带提示（仅提醒，不拒绝）：并行角色的 `owns` 重叠且无 `after` 关系、多角色派工中某角色缺少 `owns`、有 `owns` 却没有 `acceptance`。
- 每份交给 Logox 的报告（和失败记录）后面，运行时会追加一段“运行时记录”：该活动的 Edit/Write 改动了哪些文件、超出 `owns` 的文件、最近五条 Shell 命令及退出码、轮次由模型还是运行时关闭，以及 Logox 当初写的验收标准。它由账本直接生成，不调用模型，也不进入角色自己的记录；Logox 据此对照角色的自述，只复核两者留下疑问的部分。
- 你与某个角色的直接对话彼此独立，包括其本地失败。明确请求 Logox 协助时，可以让该对话进入协调，但不会移交整段对话或授予新权限。
- 重启后队列数据和历史保留，但被中断的工作不会自动重跑，工具也不会重放；绑定的插话不会重新指向别的目标，未完成的任务会显示为中断。协调消费失败时可能用稳定的事件 ID 重新投递，这不是"恰好一次"的执行语义。
- Logox 不做周期性轮询，没有读取次数上限，也不会自动判定任务停滞。派工结果本身会告诉 Logox：角色在后台工作，报告会自动唤醒它，期间不要预测结果、也不必重复检查；运行时不会因它重复读取而收回工具。由协调事件唤醒 Logox 的消息以一行“自动事件，并非人类消息”开头，不代表人类确认或批准了任何事。

投递与恢复的实现见[角色模块](modules/actors.md#消息与投递)。

### Automa：角色的并行工人

角色（包括 Logox）可以用 `Automa` 工具一次派出最多 8 个无状态工人，处理可以并行的独立调查或修改（例如"各模块里是否都成立"、"把同一处改动应用到这几个文件"、只需要结论的长测试）。一两次调用就能完成的小事不用它。工人的原始输出不进入角色的上下文，角色只收到回执。

- **最小写法**：`{"jobs": [{"brief": "列出 parseConfig 的所有调用点"}]}`。只有 `brief` 必填；`title` 缺省取 brief 开头，`writes` 可选。同时接受 `tasks`、字符串数组、`task` 字段，旧字段 `files`（等同 `writes`）、`persistence`、`instance`，并忽略 `n/a`、`none`、`new` 这类占位值。已退役的 `preset`、`commands`、`read`、`output` 和其他未知字段会被忽略并在回执末尾附一条说明，不会让整个派遣失败。
- **工人默认能做什么**：读取派遣者能读的一切；可以运行 Shell 命令；可以在派遣者自己的草稿区子目录（`<tmp>/logox-scratchpad/<cwdHash>/<sessionId>/<派遣者>/`）里写临时脚本和笔记。所有读取和命令都以派遣者的名义经过权限引擎，按当前模式裁决，与派遣者自己调用完全一样（`auto` 模式下例行命令放行，有风险的进入复核或询问），所以工人永远不会超出派遣者的权限，也不存在按预设的命令白名单。
- **`writes`**：只读工作不需要写任何授权。需要修改工作区文件时，在作业上列出 `writes`（路径或 glob），工人只能改这些路径。`writes` 不能是整个工作区，作业之间不能重叠，也不能与同伴正在进行的任务或作业重叠；写入同伴持有的文件时该作业被拒绝并指明持有者，其余作业照常运行。指向工作区之外的条目会被丢弃并说明；指向派遣者草稿区的条目直接允许，不是错误。
- **路径比较**：每个路径在与范围比较之前先规范化（解析链接、Windows 8.3 短名与长名、Windows 上忽略大小写、统一斜杠），所以 `C:/Users/Administrator/...` 与 `C:\Users\ADMINI~1\...` 视为同一路径。
- **拒绝与重复调用**：只有两种情况会整体拒绝：`writes` 写成整个工作区，或作业之间的 `writes` 重叠；错误信息给出具体的修正办法，例如"只读工作不需要 `writes`，去掉它"。被拒绝后，完全相同的调用（规范化之后）会立即得到同样的回答，不再规划或运行。
- **回执**：每个工人按固定结构收尾：`Verdict`（结论，必须能由证据推出）、`Evidence`（`path:line`，或命令加关键输出）、`Not verified`（没有核实或做不到的部分），总计不超过 600 字，超出部分按整行截断并注明。回执紧凑地显示这三段，并附 `changed`（运行时对真实写入的测量，含增删行数，不采信工人自述；不包含 Shell 命令改动的文件）、`ran`（运行过的命令）和 `denied`（被拒绝的调用）。
- **保留工人**：默认用完即弃。后续步骤依赖工人已读取的材料时（例如反复修改并跑测试直到通过），在作业上写 `keep: true`，回执的 `kept:` 行会给出运行时生成的 id，之后用 `continue: "<id>"` 加下一步的 brief 续跑。工人随派遣者的任务结束而结束，也可以用 `release: ["<id>"]` 提前结束。只有运行时返回的、属于本派遣者的有效 id 才生效；其余的 id 会被忽略，回执里附一条说明，作业按全新的单次作业运行，不报错。保留的工人沿用创建时的 `writes`，每个角色最多 2 个（超出的作业照常运行但不保留，并有说明）；作业失败或取消、进程重启、上下文达到 64000 输入 token 时也会自动结束。
- **工人风格**：角色 `config.yaml` 的 `automa` 块定义风格（`styles`），例如 Techne 的 `scout`/`edit`、Aletheia 的 `scout`/`probe`、Kalon 的 `scout`/`variant`。风格只决定工人系统提示的口吻（`flavor`）、模型（`model`）和并发（`parallel`），不授予任何权限。运行时自动选择：默认用 `default_style`，作业带 `writes` 时用 `write_style`（如有）；模型也可以用 `style` 指名一个，但从不必须。`exclusive` 列出的命令前缀（如 `npm test`）在同一派遣的各作业之间一次只跑一个。旧的 `default_preset` / `presets` 写法仍可读取（权限字段被丢弃）。已安装到 `~/.logox/actors/` 的旧配置需要运行 `npm run sync:profiles`。
- **模型**：优先级为 `/model automa` > 风格 `model` > 角色 `automa.model` > 会话模型。用 `/model automa` 选定后，所有角色的工人都用它；`/model automa inherit` 取消选择，回到风格。风格里的名称可以是 `provider/model`、完整模型 id，或当前服务商下的模型族（如 `haiku`）；当前账户没有该模型时自动使用下一级。
- **并发**：单次派遣默认 4 个（风格的 `parallel` 可覆盖），可在 `[automa] max_parallel` 调整，派遣时也可以指定，上限 8。同一服务地址的请求共用一个闸门，遇到限流会自动降速。
- **记录**：完整过程写入 `state/sessions/<sessionId>/subagents/automa.jsonl`，费用计入派遣者，在其 `/usage` 中显示为 `automa` 类别。写入有快照，可用 `/undo` 回退。进程重启时未完成的作业标记为 `interrupted`，不会自动重放。

## 会话、整理与回退

普通启动会恢复最近的正式会话。没有历史或执行 `/new` 时，先进入临时空白会话，首次提交任务才登记；只打开设置不会留下空白聊天记录。恢复会话只展示历史，不会自动续跑工具或重新发请求。会话被占用或已损坏时会报告原因，不会悄悄改选另一段历史。

| 命令 | 作用与边界 |
|---|---|
| `/new` | 新建临时空白会话 |
| `/resume [id]` | 打开会话列表，或恢复指定会话 |
| `/clear` | 清理当前显示，不删除模型历史 |
| `/compact` | 整理当前角色的有效上下文，保留原始账本；必要时调用汇总模型 |
| `/undo` | 撤销受支持的文件工具造成的近期修改，不覆盖你之后的手工改动 |
| `/rewind` | 回退有效对话分支和相应的文件快照；原始记录仍保留 |

会话列表中按 Ctrl+X 进入删除确认，默认取消。当前会话和被其他进程占用的会话不能删除；删除前内容会备份到项目的 `.logox/state/trash/`。

`/undo` 与 `/rewind` **不会回滚 Shell、MCP 或其他外部系统的副作用**。多文件恢复也不是操作系统事务，部分失败时需要按提示处理。上下文整理与存储边界见[上下文模块](modules/context.md)。

## 权限

`/permissions` 打开权限页：

- **模式行**：`←` `→`（或 Space / `m`）只改页内草稿并标记 `unsaved`，下方一行说明所选模式的实际后果；Enter 才保存并提示 “Permission mode set to …”，Esc 离开且不应用。
- **规则列表**：按作用域（`user` / `project` / `session`）分组，每条显示决定（`allow` 绿、`ask` 琥珀、`deny` 红）、工具、匹配模式、命中次数和最近命中时间。`↑` `↓` 选择，`d` 或 Del 删除（行内 `y / n` 确认），`a` 打开新增表单（决定、工具、模式、作用域；输入会先校验，shell 模式必须是静态词元前缀）。
- **This run**：本次运行的审批统计（审批次数、询问你的次数、审查模型次数、审查用的 token）。

权限模式是用户级选择，所有项目共用：在任何项目里切换一次，保存到 `~/.logox/permission-mode.json`，其他项目下次启动时沿用。启动时的优先级：用户级已保存的模式，其次旧版本留在项目 `.logox/permissions.json` 里的 `mode`（仅在用户级还没有值时读取，且不再写入），再其次配置文件的 `[permissions] mode`，最后是内置默认值 `auto`。目前没有命令行参数。两个同时运行的实例互不实时同步，切换在对方下次启动时生效。规则和允许列表仍按作用域保存（项目规则在 `.logox/permissions.json`），只有模式移到了用户级。

也可以用 `/permissions mode [default|auto|creative]` 直接选择，或用 `/permissions add <session|project|user> <allow|ask|deny> <工具> <模式>`、`/permissions revoke <id>` 管理规则。

| 模式 | 默认行为 |
|---|---|
| `default` | 普通只读操作走安全快路，其余需要人工授权 |
| `auto`（默认） | 读取、工作区内的编辑与写入、常见开发命令（构建、测试、lint、项目内装依赖、`git status/diff/log/add/commit`、运行项目脚本）直接执行；只有真正有风险的操作（工作区外写入或删除、`curl`/`sudo` 一类无法确认影响的命令、内联代码执行、外部 MCP 调用等）交给审批模型，凭据与 `.git` 等危险类仍询问人工 |
| `creative` | 在显式拒绝和危险过滤之后，其他操作默认允许 |

没有保存过模式的项目（新安装）使用 `auto`；显式保存的模式永远优先。

### 审批卡

请求审批的卡片显示 `<角色符号> <名称> wants to run · <工具>` 与右侧的 `Awaiting approval`；Shell 以 `$ 命令` 展示，其他工具展示紧凑的路径或 URL，不显示原始 JSON。风险行 `▲ <原因>` 后面是当前模式（弱化）。选项与单键快捷键：

| 选项 | 键 |
|---|---|
| Allow once | `y` |
| Allow `<前缀>` for this session | `s` |
| Always allow `<前缀>` in this project | `a` |
| Deny and tell `<角色>` why… | `n`（打开单行说明，Enter 发送，Esc 返回；说明会随拒绝一起返回给模型） |

`↑` `↓` 选择、Enter 确认、Esc 稍后回答；鼠标单击选项即作答（Deny 先打开说明）。前缀取自静态词元前缀（如 `npm ci`），不可编辑；复合或动态命令、危险类没有可生效的规则，因此不提供会话/项目授权。

### 规则

规则有三种决定：`allow`、`ask`（即使模式或允许规则会放行也一定询问你）、`deny`。优先级与作用域无关：**`deny` > `ask` > `allow`**；`forbidden` 命令和 `creative` 对凭据的拒绝仍在其上。作用域有三层：`user`（`~/.logox/user-permissions.json`，所有项目共享）、`project`（`.logox/permissions.json`）、`session`（仅内存）。规则对所有角色一视同仁，不存在按角色的规则；Automa 的授权仍只收窄派遣者已有的权限。每条规则记录命中次数和最近命中时间（项目和用户规则会落盘，会话规则只在内存）。

项目规则绑定项目的真实路径，所以移动项目后不能把旧路径当作同一个安全身份。会话临时目录（scratchpad）内的操作自动放行；`ask` 规则同样适用于它。

`creative` 允许写运行目录，但凭据和 Git 内部文件仍有独立保护。项目外访问、符号链接和 Shell 的实际影响仍要经过入口检查；获准执行的进程拥有当前系统用户的真实能力。这是应用内的权限机制，**不是操作系统级沙箱**。

## 资源与扩展

- 规范：按目录加载 `LOGOX.md`、`AGENTS.md`，或你自备的 `CLAUDE.md`。
- 技能：内置库、用户 `.logox/skills/`、项目 `.logox/skills/` 按名称覆盖。支持递归的 Markdown、角色目录和 `agent.md` 分类路标，正文按需读取。`/skills` 列出可用技能。
- 命令模板：在用户或项目的 `.logox/commands/` 下定义，展开成任务输入，不直接执行 Shell。
- `/reload`：空闲时重新加载规范、技能、模板和角色定义；不会替换运行中的提供商，也不会重启 MCP。
- MCP：目前支持 stdio 子进程，首次使用时启动，调用要经过 schema 与权限检查。
- Hooks：观察事件并执行配置的命令。启用前请检查脚本，它们不是沙箱内的纯数据。

格式、覆盖规则和生命周期见[资源与扩展](modules/resources-and-extensions.md)。

## 浏览器验证与离线运行

默认提供本地 `playwright` MCP 服务，按需启动；不使用 `npx` 临时下载，也不连接远程浏览器。首次在有网络时执行：

```bash
npm run browser:install
```

服务依赖随 `npm ci` 安装，浏览器需要提前准备并保留其用户缓存。之后浏览器本身可以离线运行，但网页的 CDN、远程字体和接口，以及云端模型，仍各有网络需求。换机器或升级 Playwright 后，需要重新准备匹配的浏览器。

模型在同一个页面会话里导航、观察、点击、输入和截图。MCP 返回的图片直接进入视觉输入，只有返回图片文件路径时才需要 `Read`。导航或点击的结果有时只给快照文件链接，此时调用不带文件名的 `browser_snapshot` 即可直接拿到页面内容和当前元素引用。截图默认写入隔离的临时工作目录。多个角色同时验证时，应约定一位浏览器操作者，避免互相切换页面。

本地页面建议通过本机 HTTP 预览访问；默认不开放不受限制的 `file://` 和项目外文件访问。服务使用独立的临时浏览器上下文，不复用日常浏览器的登录资料，调用仍遵守 MCP 权限检查。

需要自定义浏览器时，可设置 Playwright 官方的 `PLAYWRIGHT_MCP_EXECUTABLE_PATH` 环境变量，或在 `[mcp.servers.playwright]` 中显式覆盖服务配置。关闭内置浏览器：

```toml
[mcp]
playwright = false
```

修改 MCP 配置后需要重启 Logox，`/reload` 不会重启服务。

## 设置页

`/settings` 是一页数据驱动的列表：每一行来自 `src/config/settings-definitions.ts` 里的一条定义（标签、说明、分组、类型、可选值、默认值，以及保存和预览的方式）。右侧显示当前值：选项行是 `‹ 值 ›`，开关行是 `[✓]` / `[ ]`，文本行直接显示文字（空值显示 `(none)`）。选中行有一行说明，页面够高时说明可折成两行。

| 分组 | 设置项 | 效果与保存位置 |
|---|---|---|
| Appearance | Theme | 主题；草稿阶段就实时预览，丢弃时还原。保存到 `~/.logox/ui-preferences.json` |
| | Cursor | 光标形状（Block / Underline / Bar） |
| | Animations | 动效开关，与 `statusbar.json` 里的 `motion` 是同一份 |
| | Tool card tint | `none` / `subtle` / `standard`：展开卡片的底色强度，把三档嵌套深度的混色比例按 0 / 0.5 / 1 缩放 |
| | Context bar、Context bar width | 上下文仪表开关与宽度（8 到 24 格，步长 4），与状态栏编辑器共用 `statusbar.json` |
| Splash | Start page | 空会话是否显示带徽标的欢迎页；关闭后只显示普通欢迎文字 |
| | Emblem size | `auto`（按空间取最大）/ `small 26`（不画 52 像素大徽标）/ `large 52`（尽量用大徽标，放不下时回退） |
| | Tagline | `fixed`（A terminal coding ensemble）或 `rotate daily`（按本地日期从一份静态英文列表轮换，含 λόγος 一行） |
| Conversation | Your name | 与 `/name` 同一份存储（`user-profile.json`），保存后时间线标签立即更新 |
| | Thinking display | `folded`（一行，默认）/ `preview`（已完成的思考默认展开，只显示 3 行，其余在 `… N more lines` 后）/ `full`（默认完整展开）。进行中的思考始终折叠；点击单张卡片仍可单独折叠或展开 |
| | Diff layout | `auto (by width)`（卡片宽度小于 72 列时用无行号的紧凑版）/ `unified`（带行号）/ `compact`（始终无行号） |
| | Notify when done | `off` / `when unfocused` / `always`：一轮工作（从出现活动到没有活动）超过 30 秒后响铃，终端为 iTerm2、WezTerm、Ghostty 时发 OSC 9 通知。焦点来自终端的焦点上报（DECSET 1004）；终端不上报时一律视为失焦 |
| | Enter key | `send`（默认：Enter 发送，Shift+Enter / Alt+Enter / Ctrl+J 换行）/ `newline`（Enter 换行，Ctrl+Enter 或 Ctrl+S 发送；Ctrl+Enter 只在能区分它的终端里可用，Ctrl+S 处处可用）。页脚提示随之变化 |
| | Default thinking | 当前模型的思考档位，与 `/effort` 同一个保存路径，可选项随模型而定 |
| | Default mode | 权限模式，与 `/permissions` 写同一个设置 |
| Pages | Status bar、Permissions、Models & pricing、Shortcuts | 回车或单击打开子页面，Esc 返回，设置页上的草稿保持不变。Models & pricing 是只读表：每个已配置的供应商下列出模型的窗口、最大输出、每百万 token 价格，以及价格来源（`config` 是你自己写的 `prices`，否则是内置目录的匹配度 `exact` / `alias` / `normalized` / `inferred` 加目录名）；网关镜像其他厂商时用 `[catalogs.<provider>]` 声明，见[模型表](modules/model-table.md)。Shortcuts 是只读的按键分组表，暂不支持改键 |

操作：↑↓（或 Tab）选择，←→ 改值，Space 翻转开关或前进一个选项，Enter 保存全部改动并关闭（通知行显示 `✓ Settings saved`；没有改动时 Enter 等同于关闭），`/` 搜索（按标签、说明和分组过滤，标题右侧显示 `匹配数/总数`，Enter 回到列表，Esc 清除过滤）。文本行按 Enter 进入编辑，再按 Enter 提交，Esc 放弃；页面行与文本行用 Ctrl+S 保存。标题 `Settings · N unsaved` 的 N 是与已保存值不同的行数（大于 0 时为警告色）。有未保存改动时按 Esc 会在页内询问 `Discard N unsaved changes?`，`y` 丢弃，`n` 或 Esc 继续编辑，两个选项都可以点击。

保存失败（例如偏好文件损坏）时页面和草稿保留，错误写在页脚，同时以 `✗` 进入通知行；已经保存成功的行不会重复保存，修复原因后再按 Enter 即可重试。界面偏好用带锁的原子写入，不会覆盖损坏的文件。

## 状态栏

### 角色总览 /ensemble

每个角色（Logox、Kalon、Techne、Aletheia，不含 Automa）一个标签页，标签与页面边线使用该角色的颜色。`←` `→` / `Tab` 或点击标签切换角色。每页是一张可滚动的页面（`↑` `↓`、`PgUp` `PgDn`、滚轮）：

- **参数**：模型（`<model> · <thinking>`，标明 `set for <Name>` 或 `follows session`；`m` 或点击打开 `/model <actor>`）、上下文（用真实窗口和水位写成一句话，例如 `keeps 0 rounds and 2 tool results · compacts at 84% (167k)`）、角色档案路径（项目层扩展用户层时标 `+ project` 并列出两处路径）。
- **Tools · N / Skills · N**：以 `›` 结尾的两行，`Enter` 或点击进入子页，`Esc` 返回。
- **This session**：仅当前会话的任务、工具调用、审批、Token 与费用。
- **提示词**：Persona、Execution、Collaboration、Memory priorities 完整渲染为 Markdown，各带文件名；项目层角色档案存在时，Persona 显示合并后的生效内容并标 `+ project`。

工具子页与 `src/tools` 目录同构：根层是该角色实际可用的核心工具（`名称  简述`），再是每个分类目录一行（`▸ coordination · 3`）和每个 MCP 服务一行（`▸ mcp:playwright · N`，工具清单在该服务首次被列出后才有）。`Enter` 进入目录（面包屑 `Tools › coordination`），再按 `Enter` 打开工具详情：模型实际看到的完整描述、参数表（名称、类型、必填、说明）以及角色、加载方式和可见性。技能子页按来源（Built-in / User / Project）和目录分组，详情页渲染技能文件并显示来源路径。

`e` 用外部编辑器打开当前视野内的文件（提示词所在文件，或技能文件）：先 `$VISUAL`，再 `$EDITOR`，否则用系统默认打开方式（`start` / `open` / `xdg-open`）；编辑从不发生在界面内，终端内编辑器（如 vim）不适用。资源没有文件监听，保存后运行 `/reload` 才会生效。页脚提示 `←→ actor · ↑↓ scroll · Enter open · m model · e edit · Esc back` 可逐项点击，窄屏按重要性丢弃，子页里只显示适用的提示。

`/statusbar` 打开状态栏编辑器，`/settings` 的 Pages 分组里的 Status bar 是同一个入口（Esc 回到设置页）。可以选择风格（Pipes：彩色字段加竖线和上下文仪表；Starship：彩色底段加 Powerline 连接符），并独立选择 theme / gruvbox / dracula 配色和上下文仪表宽度，开关各模块并调整显示顺序。默认显示角色、模型、思考档位、权限、上下文仪表和缓存命中率，Git 与费用需要手动打开。

页脚有两行：上面是状态行，下面是通知行。通知行平时显示弱化的按键提示；鼠标悬停在任一模块（含右侧的 Actor 胶囊）上时显示它的详情，例如上下文各类别的用量和压缩水位、模型窗口与价格；操作结果（保存、复制等）会以 ✓ / ▲ / ✗ 短暂占用这一行。点击模型、思考档位或权限模块分别打开 `/model`、`/effort`、`/permissions`。终端高度小于 8 行时只保留状态行。窄屏下按“角色 > 权限 > 上下文仪表 > 模型 > 缓存 > Git > 费用”的优先级整项取舍，不会出现被截断的半截文字。实时预览不写盘，Enter 保存，Esc 丢弃未保存的草稿。从 `/settings` 进入时，保存后停留在状态栏页，Esc 回到设置页；独立的 `/statusbar` 保存后会收起。

先安装带 Nerd Font 字形的等宽字体并在终端中选用，推荐 [Maple Mono NF CN](https://github.com/subframe7536/maple-font/releases)，也可以用任意 [Nerd Font](https://www.nerdfonts.com/font-downloads) 的 Mono 变体，例如 `JetBrainsMono NFM`。偏好保存在 `~/.logox/statusbar.json`，旧布局自动兼容。按键与布局细节见[终端操作](UI-SPEC.md)。

## 全部斜杠命令

输入 `/` 打开命令候选，↑/↓ 选择，Tab 补齐；`/help`（或 `/commands`）查看当前可用命令，包括自定义模板。

| 分类 | 命令 | 作用 |
|---|---|---|
| 帮助与状态 | `/help`、`/commands` | 查看命令和快捷键 |
| | `/status` | 查看模型、用量、权限和会话状态 |
| | `/usage` | 直接打开用量页 |
| | `/doctor` | 检查环境、终端、浏览器、角色档案和凭据（与 `--doctor` 等价，结果面板按主题着色） |
| | `/setup` | 重新打开首次设置向导 |
| | `/name [称呼 \| --reset]` | 查看、设置或清除 Logox 对你的称呼（最多 32 个显示单元，立即生效；时间线用户标题显示该称呼而不是 `You`，模型在环境信息中得知并用它称呼你） |
| 配置 | `/config` | 只读查看生效配置 |
| | `/settings`（旧别名 `/animations`） | 外观、启动页、对话偏好，以及状态栏、权限、模型与价格、快捷键页面 |
| | `/statusbar` | 状态栏模块、顺序、风格和配色 |
| 登录与模型 | `/login [provider]` | 登录、保存 API key、管理自定义接口 |
| | `/model [provider/model]` | 选择模型；`/model <actor> [provider/model]` 设置角色默认模型 |
| | `/models` | 列出当前提供商的模型 |
| | `/effort [level]`（别名 `/thinking`、`/think`） | 选择思考档位 |
| | `/providers` | 查看提供商与模型 |
| | `/providers <name> [model]` | 切换提供商 |
| | `/providers check`、`/check-provider` | 发送真实请求检查当前提供商，可能计费 |
| | `/providers logout <name>`（同 `unregister`） | 删除已保存的提供商 |
| 角色 | `/ensemble` | 每个角色一个标签页：模型、上下文、工具、技能、本会话用量和提示词 |
| | `/cast <task>` | 把同一任务交给三个内置角色 |
| | `@actor <task>` | 交给指定角色 |
| 会话与上下文 | `/new`、`/resume [id]`、`/clear` | 新建、恢复、清屏 |
| | `/compact`、`/rewind`、`/undo` | 整理上下文、回退、撤销文件改动 |
| 资源与权限 | `/skills` | 查看技能 |
| | `/reload` | 重新加载规范、技能、模板和角色 |
| | `/permissions`、`/permissions mode [mode]` | 查看规则并切换模式 |
| | `/permissions add ...`、`/permissions revoke <id>` | 添加或撤销规则 |

此外，`.logox/commands/` 下的命令模板会作为自定义斜杠命令出现在候选中。

## CLI 启动参数

```bash
npm start -- <参数>
```

`npm start` 不会自动构建，改过代码后先运行 `npm run build`。

| 参数 | 作用 |
|---|---|
| `--help` | 显示帮助 |
| `--demo` | 运行离线的角色演示，不连接模型（也可用 `npm run demo`） |
| `--doctor` | 诊断环境、字体和凭据，有失败项时退出码为 1（也可用 `npm run doctor`） |
| `--install-profiles` | 把默认角色档案安装到 `~/.logox/actors/` |
| `--session <id>` | 打开或恢复指定会话 |
| `--resume` | 恢复最近的会话 |
| `--provider <name>` | 指定提供商或自定义提供商名 |
| `--model <id>` | 指定模型 |
| `--base-url <url>` | 覆盖接口地址 |
| `--auth-file <path>` | 指定只读认证文件 |
| `--check-config` | 查看当前配置与认证是否存在，不暴露密钥 |
| `--check-provider` | 发送真实请求验证当前提供商，可能计费 |
| `--list-providers` | 列出可用提供商 |
| `--list-models` | 列出当前提供商的模型 |

`--check-config`、`--check-provider`、`--list-providers`、`--list-models` 执行后直接退出，不进入界面。

## 数据位置与构建

| 位置 | 内容 |
|---|---|
| `~/.logox/` | 认证、自定义提供商、模型目录、角色模型绑定、状态栏偏好、首次引导状态、称呼（`user-profile.json`）及用户资源 |
| 项目 `.logox/` | 配置、权限、角色覆盖、技能、模板与 bulletin |
| 项目 `.logox/state/` | 会话索引、原始账本、上下文检查点、用量和删除备份 |
| 系统临时目录的 `logox-scratchpad/` | 按项目与会话隔离的临时工作资料；每个角色（含 Director）在会话目录下有自己的子目录，互不覆盖，彼此仍可读取 |

不要把认证和运行目录提交到公共仓库。项目会话可能包含源码、工具输出和任务内容，保存或分享前请先检查。

`npm run build` 只生成 `dist` 并复制角色与技能分发资产，不改写用户 home。资源加载时会补入缺失的内置技能，并刷新内容与已知旧版本完全一致的浏览器技能；你改过的文件保持不变，旧版自定义的截图流程需要自行更新。角色的安装与迁移同样只更新已知且未修改的分发默认内容。
