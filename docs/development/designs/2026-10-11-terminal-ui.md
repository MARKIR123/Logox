# 终端舞台与卡片设计

建立日期：2026-10-11。维护日期：2026-10-12。状态：已确认 UI 已接入 demo 与正式舞台；实际终端观感待现场验收。

本文保留界面分工与关键取舍。当前布局、配色语义和快捷键维护在 [UI-SPEC](../../UI-SPEC.md)，具体色值维护在源码；slash 界面另见[交互设计](2026-10-12-slash-interactions.md)。

## 基线与舞台归属

以 npm run demo 的实际 React/Ink 全屏终端为基线，截图作为视觉参考。舞台与输入区透出终端背景；正文沿身份轨道展示，当前窗口与快捷键收在底部状态区。保留自然、克制的角色措辞和轻量括号动作。

Logox 回复与受其派发的 Actor 卡共用 Logox 轨道；明确 @角色的任务按角色归属展示。普通正文直接排列，工具、可展示思考和角色任务可折叠。角色独立窗口显示详细历史，主窗口强调任务概览。

## 卡片、留白与选项的取舍

直接输出角色背景 RGB，避免额外与黑底或父卡混色；终端透明合成由终端负责。角色底色保留自身色相与透亮感，展开/悬停更亮。入梦采用白日梦雾白灰背景和深色文字；白色主题指底色。

Logox 的思考/工具无背景，Actor 内部工具和已答记录透出父卡底色。移入收起卡片时提示可点击：有背景卡切换为展开底色，所有可折叠标题使用所属角色高亮色；移开恢复，悬停不展开、不改变答案。

左右各 2 列，正文与长任务完整折行；上下对称。场景角色卡顶部 ▄、底部 ▀ 构成各半行视觉留白，卡片间隙独立于命中范围。选用 BMP 半块字符，依据是实机字体缺少扩展平面块字形。展开正文按分组与细分隔线组织。

选择统一使用 ❯ 和角色高亮文字，说明与标签正文对齐，普通选择使用 Logox 绿色。保留 Claude Code 的导航方式，视觉沿用 LOGOX 自身主题。

## 窗口、输入与复制

@角色快速派发后保持当前窗口；双击卡片、Ctrl+Enter 或 Ctrl+G 进入角色窗口。各窗口独立保存草稿与阅读锚点，主窗口与角色窗口消费同一活动和请求状态。

输入按字形编辑，中文、组合字和 emoji 不拆开。硬换行保留原文，软折行只影响视图；上下移动保留理想列。输入从 1 行增长至最多 5 行，超出后滚动输入视口，矮窗口收缩；确认、换行与问题焦点按 UI-SPEC。

轨道、名牌、封边与填充是装饰，不进入正文复制。SGR 鼠标报告区分移动、单击、双击和拖选；正文选区拼接软折行并保留硬换行，通过 OSC 52 复制。退出恢复鼠标、备用屏和输入模式。

## 实现、参考与验收

入口：[cards](../../../src/tui/cards.tsx)、[scene](../../../src/tui/scene.ts)、[stage](../../../src/tui/stage.ts)、[editor](../../../src/tui/editor.ts)、[viewport](../../../src/tui/viewport.ts)、[App](../../../src/tui/app.tsx)。真实舞台与 demo 共用行构建器和主题，业务状态由[运行时](2026-10-11-runtime-interactions.md)提供。

Claude Code 参考 theme、PermissionDialog、PromptInput、useTextInput 和 Cursor；PI 参考[编辑器的视觉行映射](https://github.com/badlogic/pi-mono/blob/main/packages/tui/src/components/editor.ts)。曾交付的 [Gemini 交接](../handoffs/2026-10-11-ui-gemini/HANDOFF.md)与[离线 HTML](../handoffs/2026-10-11-ui-gemini/logox-ui-demo.html)保留当时场景，当前规则查 UI-SPEC。

2026-10-12 已有自动检查覆盖纯色输出、对称留白、标题换行、嵌套复制、悬停往返、点击/双击、窗口草稿、中文字形、五行输入、缩放和退出清理；检查过宽窄实际 Ink 模拟输出。测试入口为 [tui](../../../tests/tui.test.tsx)、[ui-layout](../../../tests/ui-layout.test.ts)、[app](../../../tests/app.test.tsx)。连续回复测量问题见[复盘](../reviews/2026-10-12-ink-update-loop.md)。

真实 Windows Terminal 的字体、透明度、中文输入法候选位置和系统剪贴板仍需现场验证，步骤见 [TESTING](../TESTING.md)。
