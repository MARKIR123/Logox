# 验证与测试

维护日期：2026-10-12。本文维护执行方法；某次测试数量、耗时和截图留在对应设计的验收记录中。

## 执行入口

环境与脚本以 [package.json](../../package.json)、[锁文件](../../package-lock.json) 和 [tsconfig.json](../../tsconfig.json) 为准。在仓库根目录执行：

```powershell
npm ci --ignore-scripts
npm run check
```

已有依赖满足锁文件时无需每次重装。定向检查先构建，再运行实际测试文件，例如：

```powershell
npm run build
node --test dist/tests/ui-layout.test.js dist/tests/app.test.js
```

公共协议、身份、取消、调度和生命周期改动通常影响多个模块，需要全量回归：

```powershell
npm test
```

`npm test` 已包含构建；同一代码状态下无需为了形式再运行一次构建或全量测试。定向通过后，只在新修改、失败或影响范围仍不明确时扩大验证。

## 文档检查

`npm run check:docs` 运行 [文档检查器](../../scripts/check-docs.mjs)，检查本地链接与 Markdown 章节、代码围栏、末尾换行、专题状态与导航可达性，以及当前说明中的日期流水账/更新记录标题。已接入 `npm run check` 和 `npm test`，失败返回非零退出码；不访问网络或读取私人运行目录。

内容审查逐项核对受影响行为、未验证边界与待办；文档更新时机由 [WORKFLOW](WORKFLOW.md#随开发推进的整理时机) 维护。检查器自身的行为用临时文档目录验证，入口为 [docs.test.ts](../../tests/docs.test.ts)。

## 按行为选择检查

| 修改 | 应观察的结果 | 当前测试入口 |
|---|---|---|
| 真实模型和文件链路 | HTTP 分片、工具身份与配对、拒绝/取消、恢复、实际文件、搜索及撤销 | [agent.test.ts](../../tests/agent.test.ts) |
| 分层配置 | 用户/项目/环境/命令覆盖；凭据不入配置；危险键与路径别名 | [config.test.ts](../../tests/config.test.ts) |
| 协议、活动和交互中心 | 活动身份不串线；终态不再更新；无效回答不解除等待；取消/关闭完成收尾 | [interactions.test.ts](../../tests/interactions.test.ts) |
| 角色调度 | 同批同角色合并；串行登场；等待时可接收任务；取消后可处理下一任务；历史归属正确 | [ensemble.test.ts](../../tests/ensemble.test.ts) |
| 作品集场景与运行时 | 排队无提前回复；两个窗口共享裁决；允许/拒绝不误报写入；自由回答、取消和关闭正确 | [demo.test.ts](../../tests/demo.test.ts)、[app.test.tsx](../../tests/app.test.tsx) |
| 入梦生命周期 | 草稿刷新空闲时间；前台提交暂停；续做复用活动；同步失败和关闭进入正确状态 | [anamnesis.test.ts](../../tests/anamnesis.test.ts) |
| 字形编辑、卡片与复制 | 中文/emoji 不拆开；软折行保留原文；装饰不进入复制；颜色与主题可读 | [tui.test.tsx](../../tests/tui.test.tsx)、[ui-layout.test.ts](../../tests/ui-layout.test.ts) |
| Ink 接线、焦点与鼠标 | 待回答期间主草稿可编辑；窗口草稿与焦点正确；悬停恢复；点击、拖选、缩放及退出正常 | [app.test.tsx](../../tests/app.test.tsx) |
| 持久登录 | /login 键盘选择、遮罩粘贴、取消与草稿；重建应用自动认证；凭据不进入终端/快照/账本；并发和失败保存 | [login.test.ts](../../tests/login.test.ts)、[app.test.tsx](../../tests/app.test.tsx) |
| 提供商与认证 | 实际厂商空用量帧不被拒绝；认证优先级、更新、缺失、取消和跨接口切换 | [providers.test.ts](../../tests/providers.test.ts)、[config.test.ts](../../tests/config.test.ts) |
| Slash 选择器与页签 | 搜索/翻页、跨提供商同名模型、页签/滚动、草稿/阅读/审批恢复、查询取消/部分失败、忙中确认与退出 | [command-surfaces.test.ts](../../tests/command-surfaces.test.ts)、[command-panels.test.tsx](../../tests/command-panels.test.tsx)、[agent.test.ts](../../tests/agent.test.ts) |
| 上下文预算与压缩 | 完整轮/单条工具保留、配对、归档与检查点失败、usage 失效、小窗口、取消和重启后的实际请求 | [context.test.ts](../../tests/context.test.ts)、[context-extra.test.ts](../../tests/context-extra.test.ts) |
| 文档和流程 | 链接和章节有效、当前说明按主题组织、新文档有导航；内容与实现及验证证据一致 | npm run check:docs；所属设计和当前说明审查 |

测试按真实触发路径选择，而不是只看文件是否邻近。新增功能覆盖正常结果和相关失败边界；修复回归放在能复现问题的接口层次。可逆的文案、配色或链接调整优先复用现有检查，不为修改本身创建镜像测试。

测试使用可控 runner、临时账本和模拟终端；新用例自行保证临时资源的清理。真实用户配置、会话、凭据和外部服务不作为默认离线测试输入。

## 实际终端与 UI

运行：

```powershell
npm run demo
```

demo 启动时重新构建。运行中的进程没有热更新；源文件修改后重新启动才能看见新样式。场景已接入 RuntimeStore、Interactions 和 Ensemble；执行器仍为脚本演示。检查排队、许可、自由回答和取消时，同时核对实际任务/请求终态。

Windows Terminal 人工检查按改动选择：

- 透明或不透明背景上的角色底色、入梦白底深色文字、收起/展开留白与标题折行。
- 鼠标移入移出、单击折叠、双击进入角色历史，以及正文框选复制。
- 中文输入法确认、Shift+Enter、多行粘贴、五行输入视口与光标定位。
- 宽屏、窄屏、矮窗口和长历史；阅读时新增消息是否保留位置。
- 待回答时继续编辑、稍后回答后再聚焦、切换角色草稿、取消与退出恢复终端。

模拟 TTY 的检查能验证 Ink 接线与输出，实际终端检查验证字体、透明度、鼠标报告、剪贴板和输入法效果；两类结果分别记录。

## 连续回复与命令补全回归

[stage-reading.test.ts](../../tests/stage-reading.test.ts) 验证正式行构建的 Markdown、原文复制、字形、流式未闭合结构、布局复用与缩放锚点；[tui-stream.test.tsx](../../tests/tui-stream.test.tsx) 同时验证实际 Ink 同批滚轮累加、阅读期间追加、翻页及到底恢复跟随。性能比较先构建，再运行 `node scripts/bench-stage.mjs`；可传入另一份已构建的 stage.js 以重放相同合成输入。该脚本测量行构建，Ink 接线与真实 Windows Terminal 现场分别验收。

[bench-scroll.mjs](../../scripts/bench-scroll.mjs) 重放完整 App/React/Ink/模拟 TTY 滚动，记录 React 更新、Ink 绘制、帧间隔、事件循环停顿和 stdout 字节；运行 `node scripts/bench-scroll.mjs`，可传入已构建的 app.js 和帧率上限做对照。CLI 使用独立会话画布后，historyDraw/historyFrameGaps 记录会话帧耗时和间隔，commits/inkDraw 只记录周边界面；纯滚动应为零，hardwareScrolls 记录使用局部滚动的次数。该脚本是性能诊断，不代替真实终端验收；结果归终端舞台设计。

[terminal-scroll.test.tsx](../../tests/terminal-scroll.test.tsx) 使用 VT 屏幕模型检查局部滚动后的可见内容、输入区稳定、页面空白无残影、缩放、原文复制、异步 stdout、屏幕阅读器和退出；[stage-reading.test.ts](../../tests/stage-reading.test.ts) 检查表格测宽/换行/对齐、流式补齐与复制映射。既有 App 和命令界面测试使用 CLI 的 renderTerminal 边界，悬停按实际屏幕背景色验证。

`tests/tui-stream.test.tsx` 有意不使用 React act：以正式全屏增量渲染重放同批思考/文本分片，检查更新深度错误、完整尾段、再次发送与缩放。原 act 测试保留验证审批和编辑；两者不能互相替代。`tests/completion.test.ts` 验证公开候选、替换光标与后缀、中文模型、查询缓存及提供商切换；`tests/app.test.tsx` 覆盖实际方向键、Tab/Enter/Esc、补全进入持久登录、审批焦点及窄屏。

Windows Terminal 现场重试：发送“你好”并等待完整回复，再发送第二条；输入 `/`、`/lo`、`/provider ` 和 `/model `，检查菜单、补齐/确认、Esc 与窗口缩放；登录遮罩不出现菜单。再用 /model 搜索并确认跨提供商模型，用 /provider 选择提供商，用 /status 的左右/Tab、分页和 Esc 检查返回；原草稿和审批焦点仍在，Ctrl+C 仅关闭命令界面，Ctrl+D 正常退出。模拟终端结果见[布局复盘](reviews/2026-10-12-ink-update-loop.md)与[slash 设计](designs/2026-10-12-slash-interactions.md)，真实终端保留现场验收。

## 正式入口功能验收

首次先进入舞台完成 /login，选择提供商并输入 API key。重启后无需再次输入，再通过非交互检查验证保存的认证；本地另启服务后再验收：

```powershell
npm run build
npm start
# 在舞台完成 /login 后退出，再验证自动读取：
npm start -- --check-config --list-models
npm start -- --check-provider
npm start -- --session morning-check
```

配置与命令见 [USAGE](../USAGE.md)。在独立测试目录或可撤销文件上按以下步骤检查：

1. 要求“读取 package.json，告诉我启动命令”。核对实际 read 结果及模型回复，不把思考当成完成。
2. 输入 `@techne 创建一个 acceptance.txt，内容为 LOGOX_READY`。批准前文件不存在；Tab 聚焦、选本次允许并确认后，文件实际存在。
3. 再要求编辑这个文件，选择拒绝。文件不变，角色收到拒绝结果；主草稿仍可编辑。
4. 请求一个多问题，例如“通过 ask_user 分别问我语言和排版要求”。按选项或自由文本逐项回答，核对完整结果。
5. 让角色执行长 Shell，批准后用 Ctrl+C 取消。子进程退出、任务进入取消状态，再发送普通读取任务仍能继续。
6. 用 Ctrl+G 或双击角色卡进入角色窗口，提交补充，核对角色与主窗口结果一致且各自草稿保留。
7. 退出后执行 `npm start -- --resume`。历史可见，不自动重放工具。另一个角色的模型上下文不包含前一角色的全部对话。
8. 等任务空闲时用 `/undo` 恢复最近一轮 write/edit。对已经手工后续修改的文件，撤销停止并保留内容。

本地 HTTP 测试服务、实际 rg/Shell/文件和 Ink 模拟 TTY 已纳入自动测试。真实厂商模型与真实终端按上述路径单独记录服务、模型、窗口尺寸和结果；默认测试不读取真实用户配置、会话或凭据。

MCP 和完整入梦尚未迁移，不属于当前正式入口的通过项。

## 怎样保存结果

每次重要验收在对应设计的结果段记录：

```text
日期与代码状态：提交/分支，或本次未提交工作树
目标与环境：涉及的行为、终端尺寸、模型/工具状态
方法：实际命令、输入步骤或人工检查方法
结果：通过 / 失败 / 未验证，以及可核对证据
剩余：下一步与关联文档
```

截图与临时诊断可放忽略的 `.logox/`；正式记录写清结论和复现方法，不把本机临时文件作为唯一依据。通过数量以本次实际输出为准。
