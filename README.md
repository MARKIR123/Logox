# Logox

Logox 是一个终端 AI 编程助手，使用 TypeScript、React 和 Ink 构建。

它支持多角色协作：Logox 协调任务，Aletheia 调查与核验，Techne 编写和修改代码，Kalon 处理设计与表达。你也可以直接与某个角色对话，或配置自己的角色。

## 启动

需要 Node.js 24+ 和交互式终端。代码搜索需要 [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`）在 PATH 中。

```sh
git clone https://github.com/MARKIR123/Logox.git
cd Logox
npm ci --ignore-scripts
npm run build
npm start
```

首次启动后，用 `/login` 配置模型服务，再用 `/model` 选择模型。支持 OpenAI 兼容接口和 Anthropic 原生接口；也可以连接本地兼容服务。

输入任务即可开始。使用 `@techne` 等前缀可以直接交给指定角色。会话保存在项目目录中，支持恢复、上下文整理和文件修改回退。

可用 `npm run demo` 查看不连接真实模型的演示。需要直接运行 `logox` 时，在构建后执行一次 `npm link`。

> 文件、Shell 和 MCP 工具会产生真实副作用。权限模式不是操作系统沙箱，撤销也不能恢复任意外部操作。构建会同步内置资源到用户兼容目录，详见使用指南。

## 文档

- [使用与配置](docs/USAGE.md)
- [配置示例](config.example.toml)
- [模块说明](docs/modules/README.md)
- [终端操作](docs/UI-SPEC.md)

## 开发

```sh
npm run check
npm test
```
