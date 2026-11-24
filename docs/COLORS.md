# 配色设置

Logox 的系统颜色来自主题 JSON，角色身份色与卡片底色来自角色配置。界面只读取语义色，动画只在配置色之间插值。想改颜色的最短路径：找到主题文件，复制一份，改几个值，在 `/theme` 里预览并选中。

## 文件在哪里

| 内容 | 位置 |
|---|---|
| 完整系统基准色 | `src/config/themes/logox-dark.json` |
| 其他内置主题 | `src/config/themes/*.json`，通过 `base` 继承 |
| 发布后的主题数据 | `dist/src/config/themes/*.json` |
| 用户主题 | `~/.logox/themes/*.json`，同名文件替换对应内置主题定义 |
| 当前主题选择 | `~/.logox/ui-preferences.json` |
| 状态栏独立配色预设 | `src/config/statusbar-palettes.json`，构建后同名复制到 `dist/src/config/` |
| 状态栏风格、配色与模块组合 | `~/.logox/statusbar.json` |
| 角色默认配色模板 | `src/actors/profiles/<id>/config.yaml` |
| 已安装的个人角色配色 | `~/.logox/actors/<id>/config.yaml` |

`~` 表示用户主目录。项目角色层仍遵循[角色模块](modules/actors.md)的优先级。仓库默认值不一定等于个人已安装的值；构建不会同步覆盖用户目录。

内置主题有 `logox-dark`（默认，完整基准）、`abyss-lantern`、`antigravity`、`antigravity-light`、`catppuccin-mocha`、`celadon-pine`、`claude-warm`、`copper-ink`、`marginalia`、`monokai-pro`、`nord-polar`、`tokyo-night`。除默认主题外都通过 `base` 继承 `logox-dark`，只写差异；别名在继承与覆盖合并之后解析，所以继承来的 `$muted`、`$fg` 会自动跟随子主题改过的颜色。`abyss-lantern` 是深海灯笼配色：墨绿黑打底、生物荧光青绿标记焦点、灯笼橙留给用户；`antigravity` 以深空曜石蓝黑打底，Gemini 星芒蓝标记焦点，星云兰粉用于用户轨，星云紫与轨道青承担提问与链接，呼应 Antigravity / Gemini 的星芒光谱；`antigravity-light` 是对应的浅色版本，以云瓷浅底搭配宝石蓝焦点、兰粉用户轨与星云紫提问色，并自动将深色角色卡片转为浅色柔雾底以保持可读；`catppuccin-mocha` 采用 Catppuccin Mocha 暗调粉彩（深紫灰底、锦葵紫焦点、蜜桃橙用户轨）；`celadon-pine` 以松烟墨绿打底，青瓷釉色标记焦点，柿木暖橙用于用户轨；`copper-ink` 以暖石墨色打底，琥珀铜色标记焦点，青蓝色用于链接。

`claude-warm`、`monokai-pro`、`nord-polar`、`tokyo-night` 是四套各自带完整底色家族的系统主题（不再沿用 `logox-dark` 的石板蓝），连同 `logox-dark`、`marginalia` 与 `abyss-lantern` 都通过可读性检查（没有低于阈值的项，也没有易混淆的语义色对）。配色取自各自的公开调色板，对比度或色相不够处按“可读性优先于还原度”调整：

| 主题 | 底色与文字 | 语义色 | 相对公开调色板的调整 |
|---|---|---|---|
| `nord-polar` | `bg #2E3440`，`surface #353B49`，卡片 `#3B4252`，`fg #D8DEE9`，`muted #A5B0C4` | 焦点 Frost `#88C0D0`，用户 Aurora 橙 `#D08770`，成功 `#A3BE8C`，警告 `#EBCB8B`，提问 `#B48EAD` | 错误色由 `#BF616A` 偏向粉红 `#C9677A`（与用户橙拉开色相）；链接取更蓝的 `#84A4D8`（Frost 蓝 `#81A1C1` 与焦点色相差仅 17 度）；`muted` 比 Polar Night `#4C566A` 亮得多才能在卡片上达标；`surface` 是 `bg` 与 `#3B4252` 之间的派生色 |
| `tokyo-night` | `bg #1A1B26`，`surface #24283B`，卡片 `#2F3549`，`fg #C0CAF5`，`muted #9AA5CE` | 焦点 `#7AA2F7`，用户 `#FF9E64`，成功 `#9ECE6A`，警告 `#EBD07A`，错误 `#F7768E`，提问 `#BB9AF7`，链接 `#2AC3DE` | 警告色由 `#E0AF68` 偏向柠檬黄（否则与橙色用户色相差 13 度）；链接用 `#2AC3DE`（原 `#7DCFFF` 与焦点色相差 19 度）；边线取注释色 `#565F89` 的提亮版 `#626D9E` |
| `monokai-pro` | `bg #2D2A2E`，`surface #373538`，卡片 `#403E41`，`fg #FCFCFA`，`muted #AEACAD` | 焦点青 `#78DCE8`，用户橙 `#FC9867`，成功 `#A9DC76`，警告 `#FFD866`，错误 `#FF6188`，提问 `#AB9DF2` | 链接用调色板里没有的蓝 `#6FB2EE`（青色已给焦点）；灰 `#939293` 提亮到 `#AEACAD` 才能在 `#403E41` 卡片上达标，边线用 `#7C7A7C` |
| `claude-warm` | `bg #262624`（几乎中性的炭灰），`surface #2F2E2B`，卡片 `#3A3935`，`fg #EFEDE4`（奶油），`muted #A9A598` | 焦点赤陶 `#D97757`，用户鼠尾草绿 `#A8B98A`，成功 `#7FCBA8`，警告 `#E3B65C`，错误 `#DB6C85`，提问 `#B8A4D8`，链接 `#7DB4C8` | 用户色原先与警告色相同，改为鼠尾草绿；与 `copper-ink`（更暗的暖棕底、琥珀焦点、玫瑰用户色）和 `marginalia`（冷石墨底、朱红焦点、青金石用户色）的区别在于：底色更亮且几乎中性、焦点是偏红的赤陶、次要色相是绿与青而不是粉与蓝 |

`logox-dark` 为通过检查只做了最小调整：`muted` 由 `#8D95A6` 提到 `#969EB0`（卡片上达标），`borderMuted` 由 `#3E4758` 提到 `#636F83`，`link` 由 `#8FB4F0` 移向青色 `#7DC4D8`（原先与焦点色相差 1 度）。

默认主题 `logox-dark` 已合并原 `mist-dark` 的配色：Logox 的角色身份色为雾蓝 `#7DA1DE`，用户身份色为 Claude 橙 `#D77757`。角色色由角色 YAML 持有，系统 `accent` 恰好同为雾蓝，但两者互不控制。旧选择名 `mist-dark`（含 `Mist Dark`、`mist_dark`）及旧 `base` 仍可解析到 `logox-dark`；如果用户有同名主题文件，优先使用用户文件。

## 新建一套主题

1. 在 `~/.logox/themes/` 新建 `my-dark.json`（目录不存在就先建）。文件名去掉 `.json` 就是主题名。
2. 想从现成主题改起，把 `src/config/themes/` 里的某个文件（如 `nord-polar.json`）复制过来改名；最小写法是继承 `logox-dark`，只写要改的颜色：

```json
{
  "base": "logox-dark",
  "colors": {
    "fg": "#E8E6E0",
    "muted": "#8D95A6",
    "strong": "#FFFFFF",
    "accent": "#7DA1DE",
    "system": "$muted",
    "checkedFg": "$strong",
    "selectionFg": "$fg",
    "panelLabel": "$muted",
    "directorIntervention": "$accent"
  }
}
```

3. 运行 `/theme`（或在 `/settings` 的 Appearance 分组打开 `Theme` 一行），在列表里找到 `my-dark`（用户主题带 `· user`），移动高亮即可预览，按 Enter 保存。每次打开 `/theme` 都会重新读取主题文件，所以新增或改过的文件不必重启；写坏的文件会出现在列表末尾并说明原因。已经保存并在使用的主题，改动要重新打开 `/theme` 选一次或重启才会生效。

## 主题页与可读性检查

`/theme` 页面左边是主题列表，右边是样例，样例下面是可读性检查（详细操作见[用户手册](USAGE.md)“主题页”）。预览不写文件：移动高亮时只是把该主题应用到当前调色板，页面按打开时的调色板快照在任何关闭路径上还原；Enter 或点击才经偏好文件保存。

样例使用真实的时间线构建器（用户消息、Logox 发言头与回复、运行中的角色卡片及其子标题和计时、折叠的工具行、展开的工具卡片与 Edit 差异、搜索高亮、路径、链接、展开的 Anamnesis 角色卡片）；状态符号、思考档位与权限模式色字、选区、`cardExpanded` 上的提问卡（弱化文字和 `question` 色）以及输入框用同一批调色板字段直接绘制。样例画在该主题的 `bg` 上。

可读性检查把页面实际使用的颜色配对算 WCAG 对比度（相对亮度比，1 到 21）：

| 项 | 前景 / 背景 | 阈值 |
|---|---|---|
| `text` / `muted` | `fg` / `muted` 对 `bg` | 4.5 |
| `text on card` / `muted on card` | `fg` / `muted` 对 `cardExpanded` | 4.5 |
| `selection` | `selectionFg` 对 `selectionBg` | 4.5 |
| `diff +` / `diff −` | 新增/删除文字对各自底色 | 3.0 |
| `border` | `borderMuted` 对 `bg` | 3.0 |

4.5 是 WCAG 对正文文字的要求，3.0 用于图形和边线。第一行写 `Legible` 或 `<n> below threshold`；达标的对用 `success` 色，不达标的用 `warning` 色；比值向下截断到两位小数，显示 `4.50` 即达标。另外，`accent`、`user`、`success`、`warning`、`error`、`question`、`link` 中色相相差不足 20 度的两种颜色会各列一行（如 `accent ≈ warning`）。纯函数在 `src/config/theme-legibility.ts`（`contrastRatio`、`confusablePairs`、`legibilityReport`）。

内置主题当前的检查结果：

| 主题 | 低于阈值的项 | 易混淆的色对 |
|---|---|---|
| `logox-dark` | 无 | 无 |
| `abyss-lantern` | 无（`border` 3.87） | 无 |
| `antigravity` | 无 | 无 |
| `antigravity-light` | 无 | 无 |
| `catppuccin-mocha` | 无 | 无 |
| `celadon-pine` | 无 | 无 |
| `claude-warm` | 无 | 无 |
| `copper-ink` | 无（`border` 3.62） | 无 |
| `marginalia` | 无 | 无 |
| `monokai-pro` | 无 | 无 |
| `nord-polar` | 无 | 无 |
| `tokyo-night` | 无 | 无 |

通过检查的主题由 `tests/theme-legibility.test.ts` 覆盖。`copper-ink` 用更亮的暖灰棕画边线，用浅柠檬黄区分警告和铜色焦点；`abyss-lantern` 把边线提亮到 `#5C7682`，并把用户橙移到 `#F08A46`、警告金移到 `#EACF6E`，两者色相差约 23°。旧梦境卡片的 `dream text` / `dream muted` 两项检查已随该卡片退役。

颜色值写 `#RRGGBB` 或 `$token`（引用另一个字段）。引用在所有继承与覆盖合并之后才解析，所以子主题改了 `fg`，继承来的 `selectionFg: "$fg"` 也会跟着变；显式写的十六进制值是独立的。

规则与出错时的行为：

- `base` 可省略，省略的字段取 `logox-dark` 的值；继承最多 16 层。
- 未知基主题、未知引用和循环引用会被报告；有问题的用户主题文件被跳过，同名覆盖失效时恢复对应内置主题。启动不会因此中断。
- 未知颜色字段会被报告并忽略；解析失败不会留下只应用了一半的颜色。

## 基础元素

日常配色先看这 14 个基础元素。它们是入口，不代表所有专用场景都得同色。

| 分组 | 字段 | 含义 |
|---|---|---|
| 文字 | `fg`、`muted`、`strong` | 正文、弱化说明、强文字 |
| 交互 | `accent` | 焦点、菜单高亮 |
| 系统 | `system` | 系统消息文字与轨道，默认引用 `muted` |
| 用户 | `user` | 用户身份与轨道 |
| 结构 | `bg`、`surface`、`line` | 背景基准、通用工具衬底、边线 |
| 状态 | `success`、`warning`、`error` | 成功、警告、失败 |
| 文本选区 | `selectionBg`、`selectionFg` | 拖选背景与文字，独立于焦点和勾选 |

默认情况下，深色主题保持终端背景透明（`bg` 仅作混色基准和对比度计算依据），浅色主题则将 `bg` 铺满整个画布，使浅色主题在深色半透明终端上依然清晰；可在 `/theme` 中按 `b`（或点击页脚 `b background: on` / `off`）逐主题切换是否绘制背景，按主题保存在 `~/.logox/ui-preferences.json` 的 `themeBackgrounds` 中。终端原生光标和 emoji 字形仍由终端控制。

## 专用语义色

以下字段可单独覆盖，或用 `$token` 绑定到基础色。部分默认值特意保持独立，因为它们表达的含义不同。完整字段以 `src/config/theme-palette.ts` 的 `themeColorKeys` 为准。

| 分组 | 字段 |
|---|---|
| 输入编辑区 | `composerFg` 控制文字，`composerBorder` 控制全屏编辑器的边框。终端提供背景，选区单独填色。 |
| 系统卡片 | `toolExpanded`、`cardBase`、`cardCollapsed`、`cardExpanded` |
| Anamnesis | `anamnesis`：Anamnesis 的角色身份色，卡片与其他角色卡片一样用它作轨道、名称和展开底色来源（不再有独立的浅色卡片） |
| 其他结构 | `borderMuted`、`panelSeparator`、`panelLabel` |
| 交互与提问 | `checkedFg`、`question` |
| 角色标签缺省 | `actorPillBg`、`actorPillFg` |
| 思考档位 | `effortOff`、`effortLow`、`effortMedium`、`effortHigh`、`effortMax`、`effortAuto` |
| 权限模式 | `permissionDefault`、`permissionAuto`、`permissionCreative` |
| 新增差异 | `diffAdded`、`diffAddedBg`、`diffAddedGutter` |
| 删除差异 | `diffRemoved`、`diffRemovedBg`、`diffRemovedGutter` |
| 差异上下文 | `diffContext` |
| 协作干预 | `directorIntervention` |
| 机械工作者 | `automa`（保留的语义槽，目前无独立着色消费点） |
| OAuth 完成页 | `oauthBg`、`oauthFg`、`oauthSuccess` |
| 工具卡片：路径与文件名 | `path` |
| 工具卡片：搜索命中高亮 | `highlight` |
| 工具卡片：链接（始终带下划线） | `link` |
| 工具卡片：代码片段的关键字、字符串、数字（注释使用淡化的 `muted`） | `syntaxKeyword`、`syntaxString`、`syntaxNumber` |

聚焦使用 `accent`；已勾选但未聚焦使用 `checkedFg`；禁用项使用 `muted`，不会因为已经勾选而继续突出。默认主题中勾选色是白色。

协作干预消息的颜色由 `directorIntervention` 控制，默认是橙色；想让它跟随系统高亮，设为 `"$accent"`。

Markdown 正文读取 `fg`，链接的弱化部分读取 `muted`；行内代码和代码块沿用所在轨道的颜色，没有独立的语法高亮。Diff 保留文字、底色、行号三层语义。

## 状态栏配色

Logox 主窗口的时间线标题、普通输入框和状态栏共用主题的 `accent`。伙伴角色窗口共用各自配置的 `color`。普通输入框的上下横线将窗口强调色按 45% 混入 `bg`，`❯` 按 90% 混入。

在 `/statusbar` 中，Style 选择 Pipes 或 Starship，Palette 选择 `theme`、`gruvbox` 或 `dracula`。角色段跟随窗口强调色，权限段跟随权限模式的语义色。`theme` 配色下，上下文仪表的已用格由窗口强调色派生。Pipes 用粗体显示角色，在普通信息段使用 `muted`。Starship 为各段绘制底色，角色段用窗口强调色与 `bg`、`strong` 混色。右下角的活动角色胶囊使用各自的角色色。

## 角色配色

角色 `config.yaml` 保留三个独立字段：

```yaml
color: "#7DA1DE"
card_closed: "#242B3A"
card_open: "#2E3850"
```

系统主题不覆盖它们。角色省略卡片底色时，由身份色变暗派生。缺失角色样式的标签使用系统 `actorPillBg` / `actorPillFg`。内置角色的回退颜色也读取仓库 YAML。角色颜色表示“是谁”，状态色表示“发生了什么”，两者不混用。

## 兼容与开发约束

- 主题键共 55 个。旧的 `dreamCollapsed`、`dreamExpanded`、`dreamText`、`dreamMuted`（主题文件）和 `dream_collapsed`、`dream_expanded`（TOML `[theme]`）已退役：旧主题文件和旧配置里仍可带着它们，加载时被接受并忽略，不报错也不会被写回。
- TOML `[theme]` 的四色兼容入口保留，默认值取自同一份基准数据；它不是覆盖当前已选预设的通用叠加层。
- 主题解析集中在 `src/config/theme-palette.ts`，TUI 通过 `src/tui/appearance/theme.ts` 读取同一调色板；角色身份与卡片底色读取位于 `src/tui/appearance/actor-style.ts`。完整系统字段以 `themeColorKeys` 为准。
- 新增颜色先添加语义字段和基准 JSON，再由界面读取；业务 TS/TSX 不直接写十六进制、固定 RGB、命名颜色或固定彩色 SGR。
- `tests/color-literals.test.ts` 扫描源码中的常见字面颜色；它是有词法覆盖边界的防回归检查，不是完整 CSS 分析器。`tests/theme-colors.test.ts` 验证引用、覆盖、独立角色和缓存刷新，真实终端观感仍需人工确认。
