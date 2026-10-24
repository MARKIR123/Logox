# 资源与扩展

Resources 为模型提供项目规范、技能索引和命令模板；MCP 与 hooks 接入外部程序。角色人设由[角色目录](actors.md)管理，不在资源扫描中另拼一套人设。

## 规范、技能与模板

规范从用户目录及项目祖先目录加载。项目每层按 `LOGOX.md`、`AGENTS.md`、`CLAUDE.md` 的优先级选择；用户和项目的 `.logox`、`.logox-ts` 兼容目录也参与候选。真实路径去重，单文件上限 64 KiB，规范总量上限 128 KiB；无效编码、超限或读取失败会报告并跳过。

技能按内置 → 用户 → 项目扫描，同名项由后者覆盖。目录支持递归 Markdown，也兼容 `<name>/SKILL.md`。例如：

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

技能 frontmatter 提供名称与描述，可显式声明 `actors`、`level` 和 `category`；未声明时可由角色路径推断默认值。`public` 路径的技能供角色共享，其他角色路径提供对应可见性。`agent.md` 用于分类路标，不是普通待执行技能。

模型先获得名称、描述与路径；核心原则与领域分类分层披露，正文通过 `Read` 按需读取，而不是把整库展开到每个请求。角色的 `skills`、显式分配和本次借阅可扩展可见性；借阅在任务结束后失效。技能内容不会授予工具权限。

用户/项目 `.logox/commands/` 中的模板展开为任务输入。参数占位符只替换一次，不递归解释参数中的模板，也不直接执行 Shell；模板不能抢占内置命令名。

首次资源加载会补入缺失的内置用户技能。旧版浏览器技能仅在内容哈希与已知分发版本完全一致时刷新，用户定制保持不变；兼容目录中的相同旧默认内容也参与刷新。构建只复制分发资产，不写入用户目录，见[使用指南](../USAGE.md)。

## 重载

`/reload` 只在空闲时执行，重新扫描规范、技能、模板和角色。普通任务与手动 compact 使用同一资源快照；提示前缀变化会使旧 token 估计失效，但不清空原始账本或累计用量。

重载不直接切换运行中模型，不重启现有 MCP 服务，也不把新的配置文件等同于已生效的整个应用配置。

## MCP

当前支持 **stdio 子进程**，不提供 HTTP MCP transport。首次 list/call 启动进程并握手，后续请求复用连接；`new/resume/rewind` 不反复启动同一个项目服务。

默认注册随依赖安装的本地 Playwright MCP；配置和[离线准备](../USAGE.md#浏览器验证与离线运行)见使用指南。页面操作与截图共享浏览器会话，产物默认进入隔离的临时工作目录。内置浏览器可关闭，也可通过同名服务配置覆盖。

MCP 图片块保留为模型工具消息中的图片，不转换为仅有占位文字的结果；缺失图片数据或不支持的图片类型会返回错误。单条响应上限为 16 MiB，文本单独裁剪；图片不混入文本日志。

目录元数据不是可信指令。调用前使用完整 JSON Schema 校验参数，再经过权限裁决；拒绝时不会发送远端调用。目录查询也遵守显式 deny。结果通过同一工具账本保存，不另建隐形执行路径。

取消、超时、坏消息或关闭会解除等待并清理进程；重新调用可按状态重连。Shell/MCP 获准后的操作具有真实副作用，文件工具的 undo 不负责恢复远端系统。

## 观察 hooks 与生命周期

Hooks 将明确事件的 JSON 送入配置命令的 stdin，也可发现用户/项目 hooks 目录中的脚本。显式可执行文件与参数数组比 Shell 字符串更容易审查；启用脚本前应核对它的实际操作。

事件用于观察，不替代权限裁决。队列、输出和历史有界，hook 失败会诊断但不把成功任务改判成失败；hook 自身诊断不递归触发 notification。事件不包含完整用户正文或工具参数。

ProjectExtensions 拥有 Resources、MCP 与 Hooks，跨会话复用，最终关闭时回收自己创建的资源。调用方注入的外部扩展由调用方负责关闭。当前没有通用磁盘插件或旧 Python 插件加载器。

## 源码入口

- [manager.ts](../../src/resources/manager.ts)：规范扫描、层级技能和模板。
- [reload.ts](../../src/resources/reload.ts)：重载报告与前缀变化。
- [mcp.ts](../../src/extensions/mcp.ts)、[mcp-client.ts](../../src/extensions/mcp-client.ts)：目录、schema、调用和进程连接。
- [hooks.ts](../../src/extensions/hooks.ts)：事件发现、运行与诊断。
- [runtime.ts](../../src/extensions/runtime.ts)：项目级扩展的生命周期。

测试入口：[资源](../../tests/resources.test.ts)、[层级技能](../../tests/hierarchical-skills.test.ts)、[扩展](../../tests/extensions.test.ts)。配置见[示例](../../config.example.toml)。
