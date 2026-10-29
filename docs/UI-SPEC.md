# 终端操作

Logox 使用 React/Ink 的全屏界面。正式模式需要 stdin 和 stdout 都连接到交互式终端；不同终端对鼠标、修饰键和剪贴板的支持可能不同。启动与命令见[使用指南](USAGE.md)。

## 对话与角色窗口

主窗口显示 Logox 的回复和角色任务卡。每个角色都有独立窗口、输入草稿和阅读位置；在主窗口使用 `@actor` 派发不会自动切换窗口。自定义角色复用相同交互。

角色卡收起时显示任务与状态，展开后可查看目标、报告、实际模型和执行过程。角色结束后更新原卡片，不追加一份重复报告。Thinking 与工具调用使用内联卡片，各自保留状态和耗时；失败、拒绝和取消会明确显示。

MCP 调用沿用 `服务名.工具名(参数) · 结果摘要 · 耗时`，每次调用独立一行。参数最多预览三项，长内容和复杂结构紧凑显示，敏感字段遮蔽；展开可查看有长度限制的参数与结果。结果摘要来自实际返回内容和执行状态，不额外调用模型推断业务是否成功；`Done` 仅表示调用完成。窄屏优先保留结果与耗时。遮蔽只作用于展示，不改写原始账本。

点击卡片可折叠或展开，双击角色卡进入其窗口。拖选优先于点击，不会因为选择文字而停止任务。运行任务的停止入口只作用于对应任务；停止 Logox 不连带取消所有 Actor。

审批和提问显示在所属任务内。新请求会展开一次，之后可以手动折叠；稍后回答不会丢失请求，主输入仍可编辑。界面只提交回答，是否执行由运行时权限检查决定。

提问卡支持四种可选呈现，均由请求数据决定、不新增界面：`detail` 在正文下加一行说明，`link` 加一行链接，`secret` 把输入行按码点渲染成 `•`（提交的仍是原文），`hideCustomInput` 在存在选项时隐藏自由输入行——本地向导（如 `/login`）用它把问题变成纯选项。没有这些字段时行为与之前完全一致。

## 键盘

| 操作 | 按键 |
|---|---|
| Queue later work or confirm the focused option | Enter |
| Steer the selected live task without cancelling it | Ctrl+T |
| 换行 | Shift+Enter、Alt+Enter 或 Ctrl+J |
| 命令候选选择；无候选时移动输入光标 | ↑ / ↓ |
| 补齐命令；无候选时切换输入与问题焦点 | Tab |
| 关闭菜单、稍后回答、返回主窗口 | Esc，按当前焦点处理 |
| 主窗口停止 Logox 当前循环 | Esc，优先关闭当前界面或清除选区 |
| 轮换角色窗口 | Ctrl+G |
| 进入当前角色卡（普通输入栏） | Ctrl+Enter |
| 切换卡片 / 展开详情 | Ctrl+N / Ctrl+O |
| 历史翻页 | PageUp / PageDown |
| 回到底部并跟随输出 | Ctrl+E |
| 取消聚焦的请求 | Ctrl+X |
| 复制选区 | Ctrl+C |
| 无选区时退出 | 1.5 秒内连续按两次 Ctrl+C |

Queue and Steer are separate operations. The footer shares one line between configured status modules and the pending human-task count/input action, using a compact `Q<count>` badge when necessary. Ctrl+N or a card click selects the owning activity, and the footer identifies the steering target. A stale explicit selection retains the draft instead of falling back to another activity. In a window with one live task and no explicit selection, Ctrl+T targets that task. Shift/Alt+Enter, question answers and Stop controls keep their existing behavior.

复制不计入退出次数。输入框从一行增长到最多五行，超出后滚动输入视口；Home/End 移动到当前视觉行两端，Ctrl+Home/Ctrl+End 移动到草稿两端。

### 全屏草稿编辑

普通输入栏保留原来的横线、最多五行和状态栏，只在右侧增加无括号的 `⛶` 四角展开图标；悬停时前景读取现有中性亮色 `strong`，不借用品牌强调色 `accent`，移开恢复 `muted`，不加背景色、圆角矩形或右侧边框，也不改变文字与光标位置。透明命中留白不随悬停变化，极窄终端优先保留输入空间。点击后把当前角色的同一份草稿和光标展开为整屏编辑，不创建第二份待同步副本。使用 Logox 原有主题与横线，不引入上游的圆角框、vim 模式或任务调度规则。

| 全屏内操作 | 按键或入口 |
|---|---|
| 插入换行，不发送 | Enter、Shift+Enter、Alt+Enter、Ctrl+J |
| 按原 Queue 语义发送并收起 | Ctrl+Enter 或右下角 Send |
| 收起并保留草稿、光标与时间线阅读位置 | 右上角 Collapse；Esc 有选区时先清选区，再按一次收起 |
| 移动、扩展选区 | 方向键、Home/End、Ctrl+Home/End；按住 Shift 扩选 |
| 词跳与删除 | Ctrl/Alt+←→；Ctrl+U/K/W 删除当前视觉行前部、后部或前一个词 |
| 全选、复制、剪切 | Ctrl+A、Ctrl+C、Ctrl+X |
| 缩进 | Tab 插入四个空格 |

多行粘贴直接进入可编辑文本，软折行不会改写提交原文；鼠标点击定位、拖动选择，滚轮可独立浏览长草稿，继续编辑或键盘移动后恢复光标跟随。全屏内 Ctrl+T 仍定向补充原先选中的活动，Ctrl+D 仍退出；没有选区时 Ctrl+C 仍遵循原来的二次退出规则。全屏不是登录密钥或工具回答的编辑入口，不改变角色归属、权限或任务执行。发送失败保留草稿，返回普通输入栏显示错误。

## 阅读与复制

回复支持标题、列表、引用、代码、链接和表格。窄终端会折行或将表格转为纵向字段显示。用户输入与工具原文按字面显示。

滚轮和翻页保留阅读锚点；回到底部后恢复跟随。拖到视口边缘可以继续选择和滚动。复制的是当前显示文本：保留真实换行、连接软折行，并包含可见表格框线，不还原原始 Markdown 标记。原始内容仍保存在账本中。

## 模型与命令界面

输入 `/` 打开命令候选；继续键入可过滤。Tab 补齐，Enter 确认，Esc 关闭并保留草稿。独立面板仅保留上下横线，输入区上方的命令候选与停靠选择器仅保留上横线；不使用圆角或左右包围线。未选中描述使用主题灰色，选中项与描述使用系统主题高亮色（`accent`），不跟随角色颜色。模型选择器标题写成 `Select Model for <角色>`，保留顶部外框线，内部仅用两条分区线分成三段：页眉为标题与供应商标签页（`Tab`/`Shift+Tab` 切换），两者之间不加线；页面包含 `Search:`、一行留白、该供应商的模型列表与思考档位，列表和档位之间用空白而非横线；页脚为快捷键说明。两条内部分区线与顶部外框统一读取配置色表的 `accent`，不使用更深的 `line` 或写死颜色；短屏优先保留可选模型并压缩装饰。标签页与搜索都只影响当前供应商的列表；档位只显示当前模型支持的选项。打开管理页本身不会启动模型任务。

`/login` 的密钥输入独立遮罩，不使用普通聊天输入保存凭据。提供商管理只保留 `/providers` 管理页；切换模型使用 `/model`。

Slash 操作不再统一追加时间线回执：模型与思考档位切换直接看状态栏，登录取消或无变化静默关闭；设置保存只短暂提示。`/skills`、`/models`、`/help`、`/commands` 等长查询使用只读结果面板，↑↓/PgUp/PgDn/Home/End 或滚轮阅读，Ctrl+C 复制原始全文，Esc 返回并保留输入草稿与阅读位置。结果面板中的 Ctrl+C 不取消任务、不退出应用，复制反馈仅留在面板页脚。局部错误留在当前表单；必要全局错误保留摘要与可展开详情。保存与模型上下文策略独立，不因展示降噪删除原始事件。

`/settings` 包含 Settings 与 Statusbar 两个标签，Tab/Shift+Tab 或鼠标切换；切页与后台刷新保留各自未保存草稿。`/animations` 保留为 `/settings` 的旧别名。Settings 中主题、光标、动画三项顺序固定：↑↓ 聚焦；主题与光标用 ←/→ 或 Space 改值；动画用 ← 关闭、→ 开启、Space 翻转。Enter 只应用当前标签并留在页面，另一标签的草稿不会丢失；Esc 关闭并丢弃尚未应用的修改。独立 `/statusbar` 打开同一个编辑器，Enter 保存后收起。保存中立即锁定键盘、鼠标与重复提交；失败保留草稿与错误，修复后可重试。

`/config` 是单页只读的 Effective Configuration，查看当前生效的模型、思考档位、Base URL、Automa 和执行限制；不包含外观开关，也不编辑或保存配置。它与可编辑偏好的 `/settings`、查看运行状态与用量的 `/status` 分开。

所有可切换、单选和多选控件保留标准中括号：未选中为 `[ ]`，已选中为 `[■]`，使用较大的实心方块，标记宽度仍为三格。多选与布尔开关严格区分状态：已选未聚焦为白色，当前聚焦为配置中的系统高亮色（`accent`），未选且未聚焦才为灰色；聚焦优先，方块独立表示是否勾选。括号、文字和描述跟随对应状态。`❯` 仅表示键盘焦点，移动焦点不会自动勾选多选项；禁用状态保持灰色。该规范同时用于设置开关、提问选项、许可选择、思考档位与独立预览，不替换运行状态图标或快捷键提示。

### 候选菜单与独立预览

正式输入区的 slash 命令、参数和角色候选共用 `src/tui/commands/command-suggestions.tsx` 中的 `CommandSuggestions`，查询匹配位于同目录的 `query-match.ts`；基础列表框位于 `src/tui/components/list-frame.tsx`。它保留五行居中窗口、查询命中提亮、名称列预算、隐藏项计数，边界与颜色按上述 Logox 规范适配。方向键或菜单内滚轮选择、鼠标点击聚焦、Tab 补齐、Esc 关闭并保留草稿；命令替换范围、参数确认和 Enter 执行仍由 Logox 原有补全逻辑负责。极短终端优先保留所选候选与输入栏，必要时隐藏候选计数。

运行 `npm run build`，再运行 `node scripts/preview-slash.mjs` 可打开同一组件的独立预览。预览实现位于 `src/tui/previews/`，使用固定样本，不读取凭据、不调用模型；Enter 仅显示所选命令，不会真正执行，Ctrl+C 退出。候选与提问界面按已确认的交互规范独立实现；业务模块按职责命名，独立实现输入与替换边界见下文目录约定。

### 提问面板与正式 /login

所有问题均在原有交互入口 `node scripts/preview-questions.mjs` 中使用同一排版：分类与题号合并在上横线，宽屏显示 `Question 2/3` 形式的计数，空间不足时收为 `2/3`；正常高度时问题、选项组、`My view` 和操作提示之间保留分组空行；终端变矮时先收紧空行和次要描述，保留聚焦选项、输入行与必要操作。单选、多选、自由输入以及登录向导中的每一步都适用，不使用写死单题的布局替身。上下键选择、Space 多选、Enter 提交、左右切题、鼠标和折叠恢复仍由原面板负责。`scripts/preview-density.mjs` 仅保留为该入口的兼容别名。

构建后运行 `node scripts/preview-questions.mjs` 查看单选、多选、附加文字与自由输入；运行 `node scripts/preview-questions.mjs --scene login` 查看同一面板驱动的提供商向导。面板共用 `src/tui/interactions/question-panel.tsx`，只保留上下横线，边线使用系统 `line`，聚焦行使用系统 `accent`；多选已勾选但未聚焦的内容使用白色，其余未勾选行使用灰色。Space 切换多选，Enter 提交；文字直接写入末行，可同时提交选项与补充说明。普通问题的自由回答行显示 `My view`（我的观点），不使用常驻图标，仅在聚焦时显示 `❯`；登录表单使用中性的 `Input`，不把密钥、地址等表单值称为观点。←/→ 在选项上或输入光标边缘切题，逐题草稿保留。长正文可用 Alt+↑/↓ 阅读。Ctrl+K 折叠后恢复预览主输入，再展开时恢复答题草稿，保持 Logox 的异步交互。

登录预览使用 Add/Edit 入口。新增自定义服务按名称 → 遮罩 key → 同批 URL/协议 → 模型选择 → 最终确认推进；只有确认后才记录一次内存中的模拟变更，编辑按字段处理，删除另行确认。协议包含 Chat Completions、Responses、Anthropic Messages。内置目录与模型发现均为固定样本；账号分支仅展示明确标记的已登录模拟状态及重新登录/退出，真实 OAuth 插件界面、模型能力编辑器和保存后切换模型不在本轮预览内。

预览不读取认证文件、不发现远程模型、不打开浏览器、不写入配置；请只输入假 key。输入按码点遮罩，不进入 Logox 的运行时快照、账本或模型上下文。Ctrl/Alt+V 仅在主动按键时读取剪贴板文本，终端粘贴也可使用；取消后的延迟读取结果不会再次写入问题。Ctrl+D 退出。正式提问已复用该排版；正式 `/login` 使用同一个交互面板，但由独立的本地表单会话驱动，不借普通工具问答传递密钥。首屏为 Add/Edit，新建包含内置 API、自定义接口和账号授权；账号直接启动 OAuth。自定义接口的 URL/协议为同批两题，支持左右切换和草稿恢复；模型选择后统一确认才保存。编辑只处理所选字段，删除另行确认。表单自动拥有焦点，空的可选密钥可提交；Ctrl+K 折叠后聊天草稿可编辑，再展开保留表单草稿（登录期间提交聊天或其他命令仍被拦截）。正式界面会按用户操作发现模型、授权和保存配置；预览继续仅使用假数据。模型能力编辑器与保存后自动切换确认尚未纳入当前实现，不能把本地回归等同于真实远端授权验收。

## 状态、主题与动效

状态栏显示当前窗口的模型、思考档位、权限、上下文与任务状态等信息。运行中的角色显示本任务实际模型，空闲时显示下一任务的默认选择。用量和费用不是模型上下文窗口，也不是提供商账单。

### 模块化状态栏

`/statusbar` 或 `/settings` 的 Statusbar 标签编辑同一份组合。先选 Style（Pipes / Starship）与 Palette（theme / gruvbox / dracula），再用 ↑↓ 聚焦模块、Space 开关、←/→ 或 `[ ]` 前后排序；鼠标点击行切换，行末箭头排序。样式和配色本身只改值，不参与模块排序；窄屏隐藏箭头时，行内点击仍是开关。预览直接使用正式渲染器，只修改本地草稿，不发布偏好、不调用模型。

Pipes 使用 Nerd Font 图标、彩色字段、弱化的 `|` 和上下文进度条；Starship 使用彩色背景段与 Powerline 连接符。只保留这两种风格，切换风格不重置组合。模块包括角色、模型、思考档位、权限、上下文、运行状态、Token、费用、会话和项目目录。模块按用户顺序优先占用可用宽度，先使用紧凑表达，再整项隐藏，不截出半个分段或连接符。上下文百分比明确标记 USED，不能误当剩余容量；缺失用量与价格不伪装成零。

配色与风格独立：theme 跟随系统语义色，另两套使用内置色表；角色身份色与权限模式色始终保留自己的来源。运行中 Actor 胶囊继续独立靠右、保持原有激活顺序与双击定位，不被样式切换接管。状态栏复制按显示格与字素选择，使用拖选开始时的可见文本，不复制 ANSI 或右侧 Actor 胶囊。

偏好主文件为 `~/.logox/statusbar.json`；旧 `~/.logox-ts/statusbar.json` 在主文件缺省时兼容读取。v1 布局读取后保留模块顺序、开关和动效，补默认 Pipes/theme，下一次保存升级为 v2。布局、风格与配色在一次原子保存成功后才发布，动效保存也不会覆盖组合。模块不触发外部查询，`/status` 继续仅用于查看运行状态与用量。

### 字体要求

安装 Nerd Font 并在实际运行 Logox 的终端中选用其 Mono 变体；仅下载或安装而未切换终端字体，不会修复缺字。推荐 [JetBrainsMono Nerd Font Mono](https://www.nerdfonts.com/font-downloads)（部分字体菜单显示为 `JetBrainsMono NFM`），重开终端后检查图标与 Powerline 接缝。这里默认使用 Nerd Font 字形，不把 ASCII 回退当作正式样式。

主题是数据文件而非代码常量：内置主题在 `src/config/themes/*.json`（构建时复制到 `dist/src/config/themes/`），用户在 `~/.logox/themes/*.json` 新增文件或同名覆盖即可改色。每个文件声明可选的 `base`（继承另一套主题）与 `colors`（十六进制色或 `$token` 引用，键名见 `src/config/theme-palette.ts` 的 `themeColorKeys`，完整默认值在 `logox-dark.json`）；损坏的用户主题文件会被跳过并在启动时记录，不会中断启动。`/settings` 的 `Theme preset` 列出所有已加载主题，选择结果保存到 `~/.logox/ui-preferences.json`。

Slash 菜单的边线、选中高亮、描述与查询命中颜色均直接读取独立的系统主题（`src/tui/appearance/theme.ts`），不接受角色配色覆盖；切换角色窗口不变色，切换系统主题才变色。输入框上下线与 popup 上线统一使用 `line`，popup 标题和选中内容保持 `accent`，未选中描述保持 `muted`。系统色与某个角色碰巧同色，不代表两者存在继承关系。配色分组、引用和兼容规则见[配色设置](COLORS.md)。

角色的主题色与卡片底色属于角色配置，不随主题切换：`~/.logox/actors/<id>/config.yaml` 的 `color`、`card_closed`、`card_open` 是唯一来源，渲染层只在缺省时按 `color` 推导。`config.toml` 的 `[theme]` 仍可做四色覆盖，见[配置示例](../config.example.toml)和[角色模块](modules/actors.md)。

系统命令结果与错误使用独立的系统身份展示，不冒充助手回复。展示、保存和送入模型是三件不同的事，详见[系统历史](modules/system-history.md)。

## 目录组织

已确认的整理范围与分类原则：

- 目录整理限于 `src/tui`；五处独立替换另含下文明确列出的提供商向导编排。源码整理不改变界面、交互和运行行为，不扩展为全仓库重构。
- 除原子通用控件外，按职责类型归档，例如输入编辑、终端渲染、命令菜单、问答交互；同一职责的类型、状态处理与渲染尽量靠近，不按 `hooks/types/utils/views` 横向拆散。
- `components` 仅收纳不理解角色、提供商、会话或业务流程的基础控件；允许控件内部维护焦点等局部状态。被多个页面复用本身不构成原子性的依据，完整问答面板与登录向导不归入此类。

- 通用控件可以处理自身的点击、滚轮、键盘与焦点，通过回调上报意图；选择后执行的业务由外层负责，不为纯渲染而强拆事件代码。
- 独立验收预览集中放在 `previews/`，负责样本与演示宿主并复用正式界面；正式功能不依赖预览。
- 允许完成分类所必需的最少职责拆分，并同步外部引用、测试与启动脚本；不顺手重写业务流程，也不增加只为保留旧路径而存在的转发层。

### 目录与职责

| 目录 | 文件与职责 |
|---|---|
| TUI 根目录 | 保留 `app.tsx`、`application.tsx` 两个真实入口：主界面编排与应用接线；不建立 `app/` 或仅作转发的根入口 |
| `components/` | `card.tsx`、`panel-frame.tsx`、`list-frame.tsx`、`toggle-marker.ts`：仅含基础控件及其自身交互 |
| `commands/` | `completion.ts`、`command-menu.tsx`、`command-suggestions.tsx`、`query-match.ts`：命令候选与搜索匹配 |
| `panels/` | `picker.tsx`、`tabbed-page.tsx`、`toggle-list.tsx`：复合选择器与管理页；现有 ToggleList 含命令字段与状态栏标签语义，不作为原子控件整体收纳 |
| `interactions/` | `question-panel.tsx`、`production-question.tsx`、`interaction-card.tsx`、`choice-style.ts` 与答题草稿契约：问答及权限交互呈现，`QuestionPanel` 不属于原子控件 |
| `login/` | `login.tsx`、`login-wizard.tsx`：本地登录表单与向导界面接线；认证执行与存储仍归 providers |
| `input/` | `editor.ts`、`input-delivery.ts`：输入编辑、草稿与提交提示 |
| `timeline/` | `stage.ts`、`scene.ts`、`scene-state.ts`、`thinking-groups.ts`、`viewport.ts`、`selection.ts`、`row-presentation.ts`、`tool-ui.ts`、`markdown.ts`、`markdown-table.ts`、`activity-card.tsx`、`actor-location.ts`：舞台消息、卡片、排版、阅读与角色行定位 |
| `terminal/` | `terminal.tsx`、`terminal-plane.ts`、`mouse.ts`、`metrics.ts`；剪贴板读取/OSC52 归 `clipboard.ts`，SGR 鼠标解析归鼠标协议文件；文字净化与通用裁切归 `text.ts`，避免基础控件依赖舞台业务 |
| `appearance/` | `theme.ts`、`actor-style.ts`、`colors.ts`、`animation.ts`：统一外观读取及跨视图动画标记，不转移系统主题数据或角色配置的所有权 |
| `status/` | `statusbar.ts`、`actor-pills.tsx`：状态栏与运行中角色提示；角色行定位辅助逻辑位于 `timeline/actor-location.ts` |
| `previews/` | 保留命令、问答和提供商向导的独立预览；脚本入口仍在 `scripts/` |

TUI 根目录保留两个真实入口与导航规范。指定旧适配实现及其单独归属文件已随独立替换移出源码与发布产物；项目其他第三方依赖及其许可不受影响。功能类型的专用类型与辅助逻辑和其实现同目录，不设全局 `utils/` 或 `types/` 收纳桶。共享基础能力不反向依赖具体页面或业务卡片；没有业务代码放入 `components`，也没有正式界面导入 `previews`。重排涉及的外部 import 与构建残留会同步更新，但不扩展修改外部业务。

五处显式适配已依据已确认的界面/交互规范、公开接口契约及项目行为测试重新实现。独立作者未读取旧实现体、旧归档、旧编译实现或安装的上游源码；旧实现先移出源码，不作为逐行改写模板。核查包括作者输入记录、限定源码的引用与职责审查、实际 Ink 行为回归，而非仅删除来源注释。该过程不等于法律上的原创性鉴定，也不把正常第三方库或真实外部凭据格式兼容误认为移植代码。

补充安全回归：本地问答忽略键盘释放事件，避免 Enter/Space 双动作；自定义 Add 拒绝已有 route 名称，防止更换地址后隐式沿用旧凭据；显式空 key 继续表示新服务的匿名模型发现，不回退到未注册服务的凭据。

已批准的五处替换范围为候选列表、候选容器与提问面板，以及提供商向导预览和 `src/providers/login-wizard.ts`。候选容器归入基础 `components/list-frame.tsx`，候选列表归 `commands/command-suggestions.tsx`，提问面板归 `interactions/question-panel.tsx`；认证存储、OAuth 执行和其他 provider 业务不扩展修改。

## 实现入口

- [app.tsx](../src/tui/app.tsx)：输入、焦点、窗口与选择交互。
- [application.tsx](../src/tui/application.tsx)：应用与 TUI 接线。
- [scene.ts](../src/tui/timeline/scene.ts)：对话行与任务卡呈现。
- [terminal-plane.ts](../src/tui/terminal/terminal-plane.ts)：全屏历史区域绘制与滚动。
- [panel-frame.tsx](../src/tui/components/panel-frame.tsx)：选择器与管理页的基础容器。
- [question-panel.tsx](../src/tui/interactions/question-panel.tsx)：问答交互面板。
