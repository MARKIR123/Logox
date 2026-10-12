# 使用 LOGOX TS

本页说明正式入口的配置、命令和文件操作。界面操作见 [UI-SPEC](UI-SPEC.md)，验收步骤见 [TESTING](development/TESTING.md)。

## 配置模型

先配云端，再配本地。模型查询和生成请求使用同一份认证；配置示例见 [config.example.toml](../config.example.toml)。

### 云端登录

启动后在输入区输入 /login，按 ↑↓ 选择提供商、Enter 继续，然后输入或粘贴 API key，Enter 保存。也可以直接输入 /login deepseek。

登录区会临时替换普通输入区。选中项使用 ❯ 与 LOGOX 高亮色；密钥显示为遮罩。Esc / Ctrl+C 取消未提交的输入；保存完成或取消后回到对话，原来的草稿保留。

凭据保存在用户目录 ~/.logox/auth.json，例如 C:/Users/Administrator/.logox/auth.json。重新打开对话或切换项目时自动读取，不需要再次输入；重新 /login 同一提供商可更新密钥。认证文件与聊天账本分开，密钥不进入消息、模型正文、日志或项目配置。保存成功只表示密钥已落盘，接口连接可用 /check-provider 检查。

当前开发机默认选择 deepseek-flash；默认配置已移除借用 pi 的 auth_file，首次使用请自己完成 /login。输入 /model 打开已登录提供商的统一模型列表，也可以用 /model 名称直接选择当前提供商的模型。登录后切到该提供商；若尚无模型则提示选择。提供商和模型选择重启仍以配置为准，已保存的 API key 保留。

```powershell
npm run build
npm start
```

在舞台中依次输入 /login、选择并保存密钥，再用 /check-provider 验证。重启后也可直接运行 npm start -- --check-provider；它真正请求模型并确认完整回复。--check-config 只检查选择与认证是否存在；--list-providers / --list-models 查询提供商和模型。

### 认证的后备来源

登录保存的 LOGOX 凭据优先，其次是 api_key_env 指定的环境变量，最后是显式 auth_file 指定的只读 pi API key 文件。普通用户只需 /login；环境与外部文件用于已有自动化或迁移配置，不自动复制 pi 密钥。

可选 auth_file 支持 pi 的 api_key 记录、原始密钥与完整 $ENV / ${ENV} 引用，每次请求重新读取。OAuth、!命令取密钥和混合模板尚未支持。没有保存的凭据时也可提供 DEEPSEEK_API_KEY；--auth-file 可临时指定后备文件。示例见 [config.example.toml](../config.example.toml)。

### 接口与分层配置

| name | 协议 | 默认地址 | 密钥环境变量 |
|---|---|---|---|
| deepseek | OpenAI 兼容 | https://api.deepseek.com | DEEPSEEK_API_KEY |
| openai-compatible | OpenAI 兼容 | https://api.openai.com/v1 | OPENAI_API_KEY |
| anthropic | Anthropic 原生 | https://api.anthropic.com/v1 | ANTHROPIC_API_KEY |
| ollama | OpenAI 兼容 | http://127.0.0.1:11434/v1 | 不需要 |
| lm-studio | OpenAI 兼容 | http://127.0.0.1:1234/v1 | 不需要 |

只有 DeepSeek 已在本机通过真实云端验收；Google 原生协议和 OAuth 未接入。

加载顺序：默认值 → 用户 ~/.logox/config.toml → 工作目录各层祖先项目的 .logox/config.toml（由远到近）→ LOGOX__ 环境变量 → CLI。字段合并，同一物理文件只加载一次。改换 provider.name 会清除上一家的模型、地址与认证选择，保留 temperature/max_tokens/timeout；新提供商从自己的定义或预设取值。同一覆盖层的结果不受字段排列顺序影响。

自定义服务使用 [providers.work] 配置 kind、base_url、api_key_env、可选 auth_file/auth_provider/default_model，再选择 [provider] name="work"。provider.base_url、api_key_env、auth_file、auth_provider、kind 可以覆盖所选定义；auth_provider 指定认证文件中的名称，默认与提供商名称相同。URL 不包含用户名、密码、查询参数或片段。

provider.timeout 是单次请求总超时秒数，max_tokens 是输出上限。kernel.max_iterations 是任务的模型往返额度，到达后询问续做；max_retries 只在尚无可见增量时重试暂时连接错误。环境变量例如 LOGOX__PROVIDER__MODEL、LOGOX__KERNEL__MAX_ITERATIONS，CLI 支持 --provider、--model、--base-url。

### 本地服务

当前开发机已有 logox-qwen3.8:27b 别名（共享原 qwen3.8:27b 权重，8192 上下文）。自然语言与隔离 read 工具闭环均通过。本轮启动的 Ollama 服务保留运行；项目仍以 DeepSeek 为默认，切换本地可以执行：

```powershell
npm start -- --provider ollama --check-provider
npm start -- --provider ollama
```

舞台内输入 /provider ollama 使用项目配置的 default_model；/provider deepseek 切回云端。若服务未运行，先在另一个终端执行 ollama serve。LOGOX 不会自动拉取模型或启动服务。

别的机器可以用自己已有模型执行 --provider ollama --model 实际名称 --check-provider。原 qwen3.8:27b 固定的 num_ctx=98304 在本机未通过，服务环境变量没有覆盖模型参数。本机用以下 Modelfile 新建别名，原模型保持不变：

```text
FROM qwen3.8:27b
PARAMETER num_ctx 8192
```

保存后运行 ollama create logox-qwen3.8:27b -f 文件路径；项目 [providers.ollama] 设置 kind="openai_compat"、base_url="http://127.0.0.1:11434/v1"、default_model="logox-qwen3.8:27b"。8192 是本轮小任务的已验收配置；长对话预算与压缩已接入，实际服务的长任务验收仍待完成；在 [models."ollama/logox-qwen3.8:27b"] 中填写 context_window=8192，使用服务实际配置的窗口。上下文设置方法见 [Ollama 文档](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)。

## 任务与命令

正式舞台输入 `/` 即显示命令与用途，继续键入按前缀过滤。↑↓ 选择，Tab 补齐，Enter 确认；可无参数执行的命令会直接执行或打开界面；/cast 等必填参数命令先留在输入区。参数候选按 Enter 只补齐，再按 Enter 提交。Esc 收起菜单并保留草稿，编辑后再次联想；Shift/Alt+Enter 仍换行。无候选时 Tab 仍聚焦审批或提问。

`/login ` 与 `/provider ` 可联想已配置的提供商；`/model ` 联想当前模型、已查询模型及“提供商/模型”目录候选。切换提供商后候选同步更新。键入时只筛选本地候选；打开 `/model` 才刷新已认证云端及已配置本地接口的模型目录，`/models` 仍只查询当前提供商。登录密钥区与自由回答区不显示命令菜单。

直接输入任务由 Logox 执行；用 `@aletheia`、`@techne`、`@kalon` 后接任务可直接派发。角色窗口中的普通输入交给当前角色。每个角色维护独立历史，多项任务串行登场。

Logox 可以调用 `dispatch_role` 派发任务。它先结束当前回合，让排队角色登场；全部结果返回后自动继续核对原任务。每条协作链最多三次派发往返，避免在同一队列里等待自己。

| 命令 | 用途 |
|---|---|
| /help | 打开页签页面的“命令”页 |
| /login [提供商] | 选择提供商、输入并保存 API key，重启自动读取 |
| /providers | 打开提供商选择器，与 /provider 相同 |
| /provider [名称] [模型] | 无参数打开选择器；带参数切换提供商，未给模型时使用其 default_model |
| /check-provider | 请求真实模型，验证完整回复 |
| /status | 打开页签页面的“状态”页，查看模型、会话与活动任务数 |
| /config | 打开“配置”页，查看当前生效参数 |
| /models | 查询当前服务的模型列表 |
| /model [提供商/模型] | 无参数打开统一模型选择器；带名称切换模型，可指定提供商 |
| /cast 任务 | 把同一任务交给三个角色，串行执行 |
| /compact | 扬弃：整理当前窗口角色的上下文，保留原始账本 |
| /undo | 撤销最近一轮文件工具修改 |

选择器支持键入搜索、↑↓、Home/End 和分页，Enter 确认；页签页面用 ←→ 或 Tab 切换，↑↓ 和分页浏览。Esc/Ctrl+C 返回原舞台并保留草稿与审批焦点，Ctrl+D 退出。取消选择不改变模型；命令页面不触发模型请求。

提供商和模型切换只影响当前进程；重启使用配置文件。任务仍在运行时拒绝切换，先等待或取消。

`read` 的 offset 从 1 开始；`edit` 使用精确的 old_text/new_text，匹配不唯一时不修改。UTF-8 BOM 和已有换行保留。`grep` 使用实际 rg，无 Shell 字符串拼接，达到全局结果上限后停止搜索。扫描忽略依赖、版本库、运行状态与敏感目录。

普通工作区读取可直接执行；敏感路径、目录外读取、文件写入和 Shell 请求本次许可。Shell 运行在工作目录中，Windows 使用 PowerShell；批准后按命令实际能力执行。它的任意文件改动不属于文件工具快照，`/undo` 只恢复受支持的 write/edit 修改。

许可默认拒绝。Tab 聚焦，方向键选择，Enter 确认；自由回答通过输入区编辑。Esc 只稍后回答，Ctrl+X 取消当前交互，Ctrl+C 取消当前任务。拒绝、取消和参数错误都会作为工具结果返回模型，不会当成执行成功。

## 上下文与扬弃

默认保留最近两轮已结束对话和最近两条工具调用原文；当前工作轮独立。任务收尾保存一句话标题和简短报告，格式缺失时本地兜底，不增加总结请求。达到模型水位后复用这些摘要整理历史；较大工具原文归档后可按真实路径和行号回读。

/compact 在空闲时强制整理当前窗口角色；Ctrl+C 取消，Ctrl+D 关闭并等待收尾。整理期间先等待或取消，再提交任务或切换模型。归档、汇总或落盘失败保留原文；仍超安全水位时不发送超预算请求。

模型窗口从当前能力目录或显式配置取得。未知模型会提示配置 context_window；自定义/本地模型填写真实窗口，例如：

```toml
[models."ollama/logox-qwen3.8:27b"]
context_window = 8192
max_output_tokens = 2048

[context]
keep_recent_rounds = 2
keep_recent_tools = 2
reserve_tokens = 32768
low_watermark_ratio = 0.5
```

provider.max_tokens 仍是独立输出上限，请求会按模型能力及剩余空间进一步裁剪。可用 max_budget_tokens/target_budget_tokens 压低高/低水位；target 必须小于 max。summary_provider/summary_model 可覆盖最终历史汇总，未配置时使用当前模型及已有登录认证。字段与完整示例见 [config.example.toml](../config.example.toml)。

/status 查看当前角色最近请求的输入占用、水位、输出额度和本进程已记录用量。重启保留摘要视图，重新计算用量锚点；累计统计从本进程开始。机制与失败恢复见[上下文模块](modules/context.md)。

## 保存、恢复与撤销

模型回复与每条工具结果在执行过程中保存到项目 `.logox/state/sessions`；目录不进入 Git。默认开启新会话，`--session 标识` 可恢复指定会话，`--resume` 恢复最近打开的会话：

```powershell
npm start -- --session morning-check
npm start -- --resume
```

恢复只加载历史。进程中断留下的未配对调用，在下一轮补成失败结果，不重放工具，也不自动续跑排队任务。目前恢复的是本项目 TS 账本，尚未导入原 Python 会话。

write/edit 在修改前保存原字节；备份失败或文件等待期间发生变化时不执行修改。`/undo` 按最近活动倒序核对结果，再恢复文件；新建文件会删除。如果用户在这之后手工修改了文件，撤销停止并保留用户内容。任务仍运行时先取消或等待完成，再撤销。
