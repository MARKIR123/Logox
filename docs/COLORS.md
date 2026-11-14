# 配色设置

Logox 的系统颜色来自主题 JSON，角色身份色与卡片底色来自角色配置。界面只读取语义色，动画只在配置色之间插值。想改颜色的最短路径：找到主题文件，复制一份，改几个值，在 `/settings` 里选中。

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

内置主题有 `logox-dark`（默认，完整基准）、`abyss-lantern`、`catppuccin-mocha`、`celadon-pine`、`claude-warm`、`copper-ink`、`marginalia`、`monokai-pro`、`nord-polar`、`tokyo-night`。除默认主题外都通过 `base` 继承 `logox-dark`，只写差异；别名在继承与覆盖合并之后解析，所以继承来的 `$muted`、`$fg` 会自动跟随子主题改过的颜色。`abyss-lantern` 是深海灯笼配色：墨绿黑打底、生物荧光青绿标记焦点、灯笼橙留给用户；`catppuccin-mocha` 采用 Catppuccin Mocha 暗调粉彩（深紫灰底、锦葵紫焦点、蜜桃橙用户轨）；`celadon-pine` 以松烟墨绿打底，青瓷釉色标记焦点，柿木暖橙用于用户轨；`copper-ink` 以暖石墨色打底，琥珀铜色标记焦点，青蓝色用于链接。

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

3. 重启 Logox，在 `/settings` 的 Appearance 分组选择 `Theme`，用左右方向键切到 `my-dark`，按 Enter 保存。修改主题文件后需要重启才会生效。

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

`bg` 不会重设终端的整屏背景。未绘制区域、终端原生光标和 emoji 字形仍由终端控制，主题只管 Logox 实际绘制的颜色。

## 专用语义色

以下字段可单独覆盖，或用 `$token` 绑定到基础色。部分默认值特意保持独立，因为它们表达的含义不同。完整字段以 `src/config/theme-palette.ts` 的 `themeColorKeys` 为准。

| 分组 | 字段 |
|---|---|
| 输入编辑区 | `composerFg` 控制文字，`composerBorder` 控制全屏编辑器的边框。终端提供背景，选区单独填色。 |
| 系统卡片 | `toolExpanded`、`cardBase`、`cardCollapsed`、`cardExpanded` |
| Anamnesis | `anamnesis`、`dreamCollapsed`、`dreamExpanded`、`dreamText`、`dreamMuted` |
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

- 主题键共 59 个；旧写法 `dream_collapsed`、`dream_expanded` 仍被接受。
- TOML `[theme]` 的四色兼容入口保留，默认值取自同一份基准数据；它不是覆盖当前已选预设的通用叠加层。
- 主题解析集中在 `src/config/theme-palette.ts`，TUI 通过 `src/tui/appearance/theme.ts` 读取同一调色板；角色身份与卡片底色读取位于 `src/tui/appearance/actor-style.ts`。完整系统字段以 `themeColorKeys` 为准。
- 新增颜色先添加语义字段和基准 JSON，再由界面读取；业务 TS/TSX 不直接写十六进制、固定 RGB、命名颜色或固定彩色 SGR。
- `tests/color-literals.test.ts` 扫描源码中的常见字面颜色；它是有词法覆盖边界的防回归检查，不是完整 CSS 分析器。`tests/theme-colors.test.ts` 验证引用、覆盖、独立角色和缓存刷新，真实终端观感仍需人工确认。
