<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img src="assets/banner.svg" alt="LOGOX: A terminal coding ensemble" width="920"/>
  </picture>
</p>

<p align="center">
  <b>终端里的编程剧团</b>：一位导演，三位搭档，一位记性很好的守夜人。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kurios/logox"><img src="https://img.shields.io/npm/v/@kurios/logox?color=7DA1DE&label=npm" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A5%2022-7FAE99" alt="Node.js 22+"></a>
  <img src="https://img.shields.io/badge/react%2019%20%C2%B7%20ink%208-B3A0D4" alt="React 19 · Ink 8">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-E5C07B" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#快速上手">快速上手</a> ·
  <a href="docs/USAGE.md">使用手册</a> ·
  <a href="docs/UI-SPEC.md">终端操作</a> ·
  <a href="docs/COLORS.md">主题</a> ·
  <a href="#参与开发">参与开发</a>
</p>

<p align="center">
  <img src="assets/stage.svg" alt="Logox 的主舞台：导演把需求拆给三位搭档，各自的卡片实时显示进度" width="880"/>
</p>

## 为什么是剧团

大多数编程助手是一个人在和你对话。Logox 是一个常驻的小团队：导演 **Logox** 听你说完需求，小事自己动手，大事拆开派给擅长的搭档；搭档们并行干活、直接互相通气，做完把报告交回导演，由导演验收后再交给你。

你看到的是一个舞台：每位角色一张卡片，副标题实时显示它正在运行的工具或思考状态，旁边带计时。想单独找谁，用 `@techne 重构这个函数`，或双击底部角色条进入它的独立窗口。

## 角色

| | 角色 | 擅长 |
| :--- | :--- | :--- |
| `◈` | **Logox** · 导演 | 理解意图、拆解任务、统筹进度、验收交付 |
| `⊞` | **Techne** · 构建者 | 架构与实现、重构、测试；先交付能跑的骨架再迭代 |
| `✧` | **Kalon** · 审美官 | 界面与交互节奏、视觉与 SVG、排版配色、文字打磨 |
| `◎` | **Aletheia** · 审计者 | 调用链追踪、根因定位、独立审查、评估影响范围 |
| `◇` | **Anamnesis** · 守夜人 | 你离开时写下进度便条，空闲时把值得长期记住的事整理成记忆 |

此外还有 **Automa**：无状态的并行工人，任何角色都可以派它去做批量的机械活，权限只会比派它的角色更窄。每位角色可以单独选模型和思考强度。角色的完整说明见 [docs/modules/actors.md](docs/modules/actors.md)。

## 亮点

**协作**
- **并行而不踩踏**：同一文件的写入自动排队；基于过期内容的覆盖会被拦下，并告诉你是谁先改了它。
- **派工有回执**：导演派出的每项任务都有回执、负责范围和验收标准，报告附带运行时记录（实际改了哪些文件、跑了哪些命令）。
- **任务不设轮数上限**：任务自然收敛，直到完成，或你按 `Esc` / `Ctrl+C` 中止。原地打转时由运行时提醒，而不是砍掉预算。

**记忆**
- **回来时有便条**：会话空闲几分钟后，Anamnesis 写一张"做到哪、还差什么、下一步"的卡片。
- **长期记忆**：空闲更久时，它回顾对话，把你的偏好、纠正过的做法、项目约定存成 Markdown 记录（`.logox/memory/` 与 `~/.logox/memory/`）。下个会话的每位角色一开始就知道。你也可以直接说"记住……"。
- 用 `/anamnesis` 立即回顾、立即入梦、浏览和删除记忆，或给它换一个便宜的模型。

**可见与可控**
- **花了多少一目了然**：`/usage` 按角色、模型和类别列出费用与 token（含缓存命中），以及订阅额度。
- **三档权限**：`default` 逐项审批、`auto` 由审查模型代为判断、`creative` 放开开发权限；规则可按项目或全局保存。
- **改错了能撤回**：`/undo` 撤销最近一轮的文件改动，`/rewind` 回退到任意一轮。
- **每个角色一个浏览器**：做网页和界面时，各角色用自己独立的 Playwright 实例操作、检查和截图。

**终端体验**
- **全程支持鼠标**：每个页面都能点击、悬停和滚轮，不只是键盘。
- **主题可预览**：`/theme` 打开实时预览页，每个主题都会做一遍可读性检查（WCAG 对比度与易混色），看得清是第一位的。

## 快速上手

需要 Node.js 22 或更高版本。

```bash
npm install -g @kurios/logox
logox
```

首次启动没有可用模型时，会自动打开设置向导。想先看看效果，不需要任何 API Key：

```bash
npx @kurios/logox --demo   # 离线演示多角色协作舞台
```

行为异常时先运行 `logox --doctor`，它会检查 Node 版本、终端能力、ripgrep、Playwright、角色配置和模型凭据，并告诉你缺什么。

## 接入模型

输入 `/login`，先选登录方式：

- **API key**：DeepSeek、OpenAI、Anthropic，或任意 OpenAI 兼容的自定义地址（Ollama、LM Studio、vLLM、本地代理等）。
- **Account sign-in**：用账号登录，目前支持 OpenAI 账号。

登录后用 `/model` 选择模型，`/effort` 调整思考强度；`/model techne <模型> high` 可以给单个角色指定模型和强度。

也可以不进向导：启动目录下的 `.env`（`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）会被自动读取；或者在 `~/.logox/config.toml`、项目内的 `.logox/config.toml` 里声明服务：

```toml
[providers.local]
kind = "openai_compat"
base_url = "http://127.0.0.1:11434/v1"
default_model = "qwen2.5-coder:32b"

[provider]
name = "local"
```

完整示例见 [config.example.toml](config.example.toml)，加载顺序和全部选项见[使用手册](docs/USAGE.md)。

## 终端与字体

请使用支持真彩色的终端（Windows Terminal、iTerm2、Ghostty、WezTerm、Alacritty 等），并把字体设为带 Nerd Font 字形的等宽字体。推荐 [Maple Mono NF CN](https://github.com/subframe7536/maple-font/releases)，中英文与图标一款覆盖；也可以用 [JetBrainsMono Nerd Font](https://www.nerdfonts.com/font-downloads)。没有 Nerd Font 时，状态栏的部分字形会显示为方块。

## 常用命令

| 命令或按键 | 作用 |
| :--- | :--- |
| `/login` · `/model` · `/effort` | 连接模型服务，切换模型与思考强度 |
| `/ensemble` | 每位角色一页：模型、上下文、工具、技能、本会话的用量 |
| `/anamnesis` | 回顾与记忆：立即运行、浏览记忆、选择模型 |
| `/usage` · `/status` | 费用与 token 明细；模型、权限与会话状态 |
| `/theme` · `/settings` | 主题预览；外观、状态栏与快捷键 |
| `/undo` · `/rewind` · `/resume` | 撤销改动、回退到某一轮、接续历史会话 |
| `@角色名 <任务>` | 直接把任务交给某位角色 |
| `Enter` / `Shift+Enter` | 提交 / 换行 |
| `Ctrl+G` | 在主舞台与各角色窗口之间轮换 |
| `Esc` | 返回主舞台，或中止当前任务 |

全部命令见[使用手册](docs/USAGE.md)，快捷键与鼠标操作见[终端操作](docs/UI-SPEC.md)。

## 文档

- [文档导航](docs/README.md)
- [使用手册](docs/USAGE.md)：配置、模型服务、会话、权限、命令
- [终端操作](docs/UI-SPEC.md)：快捷键、鼠标、面板
- [主题与配色](docs/COLORS.md) · [品牌规范](docs/BRAND.md)
- [模块说明](docs/modules/README.md)：面向开发者的实现说明

## 参与开发

```bash
git clone https://github.com/MARKIR123/Logox.git
cd Logox
npm ci --ignore-scripts
npm run build && npm start   # 从源码运行
npm run check                # 类型检查与文档校验
npm test                     # 文档校验、构建并运行全部测试
```

需要浏览器自动化时，联网执行一次 `npm run browser:install` 安装 Chromium。代码导航从 [AGENTS.md](AGENTS.md) 开始：每个子系统都有自己的路标文件，写明入口、常见改法和不能越过的边界。

## 名字

λόγος：理性、言说、道理。Logox 想做的，是让一群各有所长的模型，在你的终端里把一件事讲清楚、做完整。

## 许可

[MIT](LICENSE)
