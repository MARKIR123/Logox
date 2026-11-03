<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img src="assets/banner.svg" alt="LOGOX: A terminal coding ensemble" width="920"/>
  </picture>
</p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg" alt="Node.js Version"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/react-19-blue.svg" alt="React 19"></a>
  <a href="https://github.com/vadimdemedes/ink"><img src="https://img.shields.io/badge/ink-8.0-9cf.svg" alt="Ink 8"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/typescript-7.0-blue.svg" alt="TypeScript"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-purple.svg" alt="License"></a>
</p>

---

## Logox 是什么

Logox 是一个全屏终端里的 AI 编程助手，基于 TypeScript、React 19 与 Ink 8。它不是单个代理，而是一个常驻的小团队：导演 Logox 负责理解需求、拆分任务、验收结果，三位搭档 Techne、Kalon、Aletheia 各管一块，并行干活、互相通气。

直接提问或做小改动，Logox 自己就处理了；任务大了，它会把活儿派给合适的搭档。你也可以用 `@角色名`（如 `@techne 重构这个函数`）直接找某个人。

## 角色

| 角色 | 定位 | 擅长 |
| :--- | :--- | :--- |
| `◈ Logox` | 导演，编排者 | 理解意图、拆解任务、统筹进度、验收交付 |
| `⊞ Techne` | 构建者 | 架构与代码实现、重构、测试，先交付可运行的骨架再迭代 |
| `✧ Kalon` | 审美官 | 界面与交互节奏、SVG 与视觉设计、排版配色、文字打磨 |
| `◎ Aletheia` | 审计者 | 调用链追踪、根因定位、独立 Review、评估改动影响范围 |

搭档都拥有完整的工具权限，并会自己验证改动。各角色的详细说明见 [docs/modules/actors.md](docs/modules/actors.md)。

## 核心特点

- **多角色并行，互不踩踏**：多个角色同时改文件时，对同一文件的写入会排队；如果某个角色基于过期内容覆盖了别人的修改，会被拦下并提示是谁写入了新内容。
- **进度一目了然**：角色开工时先用一行 `⏵` 写下正在做什么，Logox 把它提取成任务卡片的副标题，并从聊天正文中去掉，所以你随时能看到每个人在忙什么。
- **底部角色条**：状态栏显示各角色的实时状态，鼠标悬停高亮，单击跳到该角色最新的任务卡片，双击进入该角色的独立对话窗口（`Esc` 返回）。
- **每个角色一个独立浏览器**：做网页、SVG 和界面验证时，各角色使用自己独立的 Playwright 浏览器实例，可以在同一个页面会话里操作、检查并截图。
- **改错了能撤回**：`/undo` 撤销最近一轮对话中的文件改动，`/rewind` 可以选择回退到某一轮。
- **任务不设轮数上限**：任务自然收敛，直到完成或你按 `Esc` / `Ctrl+C` 中止。

## 快速上手

需要 Node.js 22 或更高版本。

```bash
npm install -g @kurios/logox
logox
```

想先看看效果，不需要任何 API Key：

```bash
npx @kurios/logox --demo   # 离线演示多角色协作舞台
npm run demo:actor-bar     # 在源码仓库中体验底部角色条的悬停、单击与双击
```

从源码运行：

```bash
git clone https://github.com/MARKIR123/Logox.git
cd Logox
npm ci --ignore-scripts
npm run build
npm start
```

需要浏览器自动化时，联网执行一次 `npm run browser:install` 安装 Chromium。

如果启动后行为异常，先运行 `logox --doctor`（源码仓库中为 `npm run doctor`）。它会检查 Node 版本、终端能力、内置 ripgrep、Playwright Chromium、角色配置和模型凭据，并指出缺什么；在应用内输入 `/doctor` 效果相同。

## 接入模型

Logox 支持 OpenAI 兼容接口、Anthropic、DeepSeek，以及 Ollama、LM Studio、vLLM 等本地服务。三种方式任选其一：

**1. 交互式登录。** 启动后输入 `/login`，按提示选择提供商并填入 API Key 或自定义地址，再用 `/model` 选择模型。首次启动没有可用模型时也会引导你完成这一步，之后可用 `/setup` 重新走一遍。

**2. `.env` 文件。** 启动时会自动加载当前目录下的 `.env`，写入任意一个即可：

```env
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-...
```

**3. 配置文件。** 在 `~/.logox/config.toml` 或项目内的 `.logox/config.toml` 中声明服务，例如连接本地模型：

```toml
[providers.local]
kind = "openai_compat"
base_url = "http://127.0.0.1:11434/v1"
default_model = "qwen2.5-coder:32b"

[provider]
name = "local"
```

完整示例见 [config.example.toml](config.example.toml)，配置加载顺序和全部选项见 [docs/USAGE.md](docs/USAGE.md)。

## 终端与字体

状态栏和角色图标使用了 Powerline 与 Nerd Font 字形，请使用支持真彩色的终端（Windows Terminal、iTerm2、Ghostty、WezTerm、Alacritty 等），并把终端字体设为带 Nerd Font 字形的等宽字体，推荐 [Maple Mono NF CN](https://github.com/subframe7536/maple-font/releases)（中英文与图标一款覆盖），也可以用 [JetBrainsMono Nerd Font](https://www.nerdfonts.com/font-downloads)。没有安装 Nerd Font 时，这些字形会显示为方块。

## 常用命令与快捷键

| 操作 | 作用 |
| :--- | :--- |
| `/login`、`/model` | 配置模型服务、切换模型与思考档位 |
| `/resume` | 从历史会话中接续 |
| `/undo` | 撤销最近一轮的文件改动 |
| `/settings` | 调整主题、光标、动画与状态栏 |
| `Enter` / `Shift+Enter` | 提交 / 换行 |
| `Ctrl+G` | 在主舞台与各角色窗口之间轮换 |
| `Esc` | 返回主舞台，或中止当前任务 |

全部斜杠命令见 [docs/USAGE.md](docs/USAGE.md)，快捷键与鼠标操作见 [docs/UI-SPEC.md](docs/UI-SPEC.md)。

## 文档

- [文档导航](docs/README.md)
- [使用手册](docs/USAGE.md)：配置、模型服务、会话、权限、命令
- [终端交互规范](docs/UI-SPEC.md)：快捷键、鼠标、面板
- [主题与配色](docs/COLORS.md)
- [模块说明](docs/modules/README.md)：面向开发者的实现说明

## 参与开发

```bash
npm run check   # 类型检查与文档校验
npm test        # 文档校验、构建并运行测试
npm run demo    # 构建并启动离线演示
```
