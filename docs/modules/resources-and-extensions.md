# 资源与扩展

模型除了对话还需要项目规范、可复用的技能和命令模板，也要能调用外部程序。这个模块管这些“资源”的加载，以及 MCP 与 hooks 两种接入外部程序的方式。角色人设不在这里，见[角色与协作](actors.md)。

## 核心概念

- **规范**：项目里的 `LOGOX.md`、`AGENTS.md`、`CLAUDE.md`，告诉模型这个项目怎么做事。
- **技能**：放在 `skills/` 下的 Markdown 流程说明，按需读取。
- **命令模板**：`.logox/commands/` 里的模板，展开后作为任务输入。
- **MCP**：用 stdio 子进程接入的外部工具服务。
- **hooks**：把事件的 JSON 送给你配置的命令，只用于观察。

## 规范

规范从用户目录和项目的各级祖先目录加载。项目每一层按 `LOGOX.md`、`AGENTS.md`、`CLAUDE.md` 的优先级选一个，用户和项目的 `.logox` 目录也参与。按真实路径去重；单个文件上限 64 KiB，总量上限 128 KiB，编码无效、超限或读取失败的会报告并跳过。

## 技能

技能按内置 → 用户 → 项目的顺序扫描，同名的后者覆盖前者。目录支持递归的 Markdown，也兼容 `<name>/SKILL.md`：

```text
.logox/skills/
  public/
    agent.md
    review-checklist.md
  techne/
    agent.md
    engineering/
      testing.md
```

- 可见性默认由路径决定：`public/` 下的技能所有角色共享，`techne/` 下的只给 Techne。frontmatter 里的 `actors`、`level`、`category` 可以显式覆盖。
- `agent.md` 是分类路标，不是待执行的技能。
- 披露是分层的：模型先看到名称、描述和路径，正文通过 `Read` 按需读取，不会把整个技能库塞进每次请求。
- 角色的 `skills` 列表、显式分配和 `BorrowSkill` 借阅都能扩大可见范围，借阅在任务结束后失效。技能不授予工具权限。

首次加载资源时会补入缺失的内置用户技能。旧版浏览器技能只有在内容与已知分发版本完全一致时才刷新，用户定制保持不变。构建只复制分发资产，不写用户目录，见[使用指南](../USAGE.md)。

## 命令模板

用户或项目的 `.logox/commands/` 里的模板会展开成任务输入。参数占位符只替换一次，不递归解析参数里的模板，也不直接执行 Shell；模板不能占用内置命令名。

## 重载

`/reload` 只在空闲时执行，重新扫描规范、技能、模板和角色。普通任务和手动 compact 使用同一份资源快照。重载后提示前缀变了，旧的 token 估算会作废，但账本和累计用量不受影响。它不会切换运行中的模型，也不会重启已有的 MCP 服务。

## MCP

当前只支持 stdio 子进程，没有 HTTP transport。

1. 第一次列出或调用时启动进程并握手，之后复用连接；`new`/`resume`/`rewind` 不会重复启动同一个项目服务。
2. 调用前用完整的 JSON Schema 校验参数，再经过权限裁决；被拒绝时不会发出远端调用。
3. 结果写入同一份工具账本，没有隐形的执行路径。
4. 取消、超时、坏消息或关闭都会解除等待并清理进程，再次调用时按状态重连。

- 默认注册随依赖安装的本地 Playwright MCP，可以关闭，或用同名配置覆盖；页面操作和截图共享同一个浏览器会话。配置和[离线准备](../USAGE.md#浏览器验证与离线运行)见使用指南。
- 图片块保留为模型工具消息里的图片；缺少图片数据或类型不支持会返回错误。单条响应上限 16 MiB。
- MCP 目录里的元数据不是可信指令。
- Shell 和 MCP 获准后的操作有真实副作用，`/undo` 只恢复文件工具的改动。

## hooks

Hooks 把明确事件的 JSON 写入配置命令的 stdin，也可以发现用户或项目 hooks 目录里的脚本。建议用显式可执行文件加参数数组，比 Shell 字符串更容易审查；启用脚本前请先看清它做什么。

事件只用于观察，不替代权限裁决，也不含完整的用户正文或工具参数。队列、输出和历史都有上限；hook 失败只产生诊断，不会把成功的任务改判为失败。

## 生命周期

`ProjectExtensions` 拥有资源、MCP 和 hooks，跨会话复用，最终关闭时回收自己创建的资源；调用方注入的外部扩展由调用方关闭。目前没有通用的磁盘插件加载器，也不兼容旧的 Python 插件。

## 源码入口

- [manager.ts](../../src/resources/manager.ts)：规范扫描、层级技能和模板。
- [reload.ts](../../src/resources/reload.ts)：重载报告与前缀变化。
- [skill-defaults.ts](../../src/resources/skill-defaults.ts)、[builtin-skills](../../src/resources/builtin-skills/agent.md)：内置技能的分发与旧默认内容刷新。
- [mcp.ts](../../src/extensions/mcp.ts)、[mcp-client.ts](../../src/extensions/mcp-client.ts)：目录、schema、调用和进程连接。
- [playwright.ts](../../src/extensions/playwright.ts)：内置浏览器服务的注册。
- [hooks.ts](../../src/extensions/hooks.ts)：事件发现、运行与诊断。
- [runtime.ts](../../src/extensions/runtime.ts)：项目级扩展的生命周期。

细节见[资源路标](../../src/resources/AGENTS.md)。测试入口：[资源](../../tests/resources.test.ts)、[层级技能](../../tests/hierarchical-skills.test.ts)、[扩展](../../tests/extensions.test.ts)。配置见[示例](../../config.example.toml)。
