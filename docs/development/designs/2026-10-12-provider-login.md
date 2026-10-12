# 提供商接入与持久登录

日期：2026-10-12。状态：持久 API key 登录、提供商选择及两类协议已实现；其他厂商、OAuth 和 Google 原生协议待接入。

本文说明提供商选择、认证归属和登录失败边界。跨提供商模型 picker 的交互见[slash 设计](2026-10-12-slash-interactions.md)，用户操作见 [USAGE](../../USAGE.md)。

## 登录与认证

用户确认的流程是 /login → 选择提供商 → 输入 API key → 保存 → 返回编辑器。重建应用或切换项目自动读取用户目录 ~/.logox/auth.json；选择模型重启仍从配置加载。/login 名称直接进入该提供商输入。

AuthStorage 管理 api_key 记录、并发锁、重新读取和原子替换；LoginFlow 快照仅包含提供商、阶段和公开错误；TUI 的独立遮罩编辑器暂存输入并直接提交保存。密钥不进入普通草稿、RuntimeStore、交互回答、Journal、日志、角色文件或模型正文。

认证顺序：LOGOX 保存凭据 → api_key_env 环境变量 → 显式 auth_file 的只读 pi 后备。每次请求读取，模型列表与生成共用解析。后备支持原始 api_key 和完整 $ENV / ${ENV} 引用；OAuth、命令取密钥和混合模板尚未支持。

Esc/Ctrl+C 取消未提交输入；提交后显示保存中，避免重复提交，关闭等待保存收尾。空白、控制字符、异常长度拒绝；坏文件和保存失败保留原值，错误不显示密钥。运行中不允许登录或切换模型/提供商。

## 选择、配置与传输

Registry 集中模型选择、接口地址和认证。更换提供商清除旧模型、地址与认证配置，保留温度、输出上限和超时；同层环境覆盖与枚举顺序无关。默认模型取该提供商定义，当前进程内切换不改配置文件。

CLI 支持 --check-config、--list-providers、--list-models、--check-provider 和 --auth-file。/check-provider 真正请求模型并确认完整回复，保存成功只表示认证落盘。

参考已安装 PI 0.87.1 的 ModelRegistry、ProviderComposer、AuthStorage、handleLoginCommand 与 LoginDialogComponent，采用选择/输入/保存/返回的分工，保持 LOGOX 的队列和账本。角色专用模型如何共享认证见[持久角色设计](2026-10-12-persistent-actors.md)。

## 已定位的传输问题

- DeepSeek 首个事件可包含 usage:null；schema 已允许空用量，保留正常最终用量。
- 流阶段超时已明确报告请求超时，用户取消保留原原因；已显示增量由 Agent 保存。
- 原 qwen3.8:27b 元数据固定 num_ctx=98304，环境变量未覆盖，加载/流请求失败。保留原模型，建立共享权重的 logox-qwen3.8:27b 别名并配置 8192 上下文后，小任务成功。配置方法见 [Ollama](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)。

## 验收结果与边界

2026-10-12，Node.js 24.21.0 / Windows PowerShell，未提交工作树。用户指定先云端后本地，已记录以下实际成功：

| 环境 | 模型 | 结果 |
|---|---|---|
| DeepSeek 云端 | deepseek-flash | /models 返回 deepseek-flash 与 deepseek-v4-pro；CLI 返回 LOGOX_PROVIDER_READY |
| DeepSeek 工具 | deepseek-flash | 合成 hello.txt 的 read → 工具结果 → 完整回复 |
| Ollama 0.35.0 | logox-qwen3.8:27b | CLI 完整回复；ollama ps 确认 8192 上下文、100% GPU |
| 本地工具 | logox-qwen3.8:27b | 同一合成 read 闭环完成 |

云端完整应用首次外发被自动审批拒绝，按建议改为硬编码合成系统提示与合成 read 定义，发送前检查任务、路径和结果只来自 hello.txt。保留正式 Ensemble、Agent、Tools、Journal 和真实厂商 adapter；上述成功记录不包含项目系统提示外发。

持久登录使用合成凭据和本地 HTTP 验证了重建应用自动认证、不同提供商并发保存、坏文件保护与遮罩输入。实际 Ink 检查过 80×24 和 32×12；取消、缩放、主草稿恢复与密钥不进入终端/快照/账本均通过。未复制或修改 pi 凭据。

测试入口：[login](../../../tests/login.test.ts)、[providers](../../../tests/providers.test.ts)、[config](../../../tests/config.test.ts)、[app](../../../tests/app.test.tsx)。实现入口：[auth](../../../src/providers/auth.ts)、[LoginFlow](../../../src/providers/login.ts)、[Registry](../../../src/providers/registry.ts)、[登录 UI](../../../src/tui/login.tsx)。

真实 Windows Terminal 输入法/剪贴板、其他厂商和长上下文仍按 [STATUS](../STATUS.md)验收；本轮文档整理没有重新请求服务。
