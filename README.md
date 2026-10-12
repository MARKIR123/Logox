# LOGOX TS

LOGOX 的 TypeScript 迁移项目。当前先迁移基本功能，再迁移 Anamnesis 入梦，最后实现完整 subagent；具体范围和进度见 [STATUS](docs/development/STATUS.md)。界面沿用已确认的全屏 demo，正式入口已接入真实模型和编程工具。

## 启动

需要 Node.js 24 和 `rg`（ripgrep，搜索工具使用）。在项目目录执行：

```powershell
npm ci --ignore-scripts
npm run build
npm start
```

程序读取用户及项目的 `.logox/config.toml`。已有配置可以直接使用；首次配置参考 [config.example.toml](config.example.toml) 和[使用说明](docs/USAGE.md)。首次在舞台输入 `/login`，选择提供商并保存 API key；重启后自动读取用户目录的认证文件。

```powershell
npm start -- --check-config
npm start -- --list-models
npm start -- --check-provider
npm start -- --resume
```

当前开发机默认使用已通过真实验收的 DeepSeek。换本地服务时先启动服务，再使用 `--provider ollama --model 名称`。`--check-config` 只显示接口、模型和是否配置凭据，不调用模型、不显示密钥。

`npm run demo` 仍是独立作品集演示，不调用模型或执行文件工具。

## 现在能做什么

- 流式对话：OpenAI 兼容接口与 Anthropic 原生接口。
- 编程工具：读取、写入、精确编辑、文件查找、正则搜索和 Shell。
- 交互：写入和 Shell 等待本次审批；Agent 可提出多问题和自由回答。
- 剧团：`@角色` 直接派发、同批任务合并、串行登场、独立历史；Logox 可主动派发并接收结果。
- 恢复与撤销：保存模型和工具消息，指定会话或恢复上次会话；`/undo` 撤销最近一轮文件工具修改。

Anamnesis 的完整研究与长期记忆提交、上下文压缩、MCP 和旧 Python 会话导入仍待迁移。当前机制见[模块地图](docs/modules/README.md)，后续工作见 [STATUS](docs/development/STATUS.md)。

Enter 提交，Shift+Enter 换行，Tab 聚焦审批/提问，Esc 稍后回答，Ctrl+G 切换角色窗口，Ctrl+C 先取消任务，Ctrl+D 退出。角色卡、内联交互、颜色、留白和鼠标规则见 [UI-SPEC](docs/UI-SPEC.md)。

## 开发与验收

```powershell
npm run check
npm test
```

[开发流程](docs/development/WORKFLOW.md)规定设计、实现和文档收尾；[验证指南](docs/development/TESTING.md)包含可直接执行的功能验收步骤。整体目标见[迁移总览](docs/development/designs/2026-10-11-typescript-migration.md)，功能设计与复盘按[专题导航](docs/README.md#专题设计与复盘)查阅。类型检查和测试同时执行文档检查。

原项目 `../Logox` 保持不变。当前迁移代码尚未提交。
