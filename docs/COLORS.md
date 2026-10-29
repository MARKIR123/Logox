# 配色设置

Logox 的系统颜色来自主题 JSON，角色身份色与卡片底色来自角色配置。界面读取语义色；动画只在配置色之间插值，不另藏一套 RGB。整理配色来源不会自动覆盖个人文件或重新设计现有主题。

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

`~` 表示用户主目录。项目角色层及旧 `.logox-ts` 兼容层仍遵循[角色模块](modules/actors.md)的优先级。仓库默认值不一定等于个人已安装的值；构建不会同步覆盖用户目录。

默认主题统一为 `logox-dark`，已合并原 `mist-dark` 的完整配色：Logox 的内置角色身份色为雾蓝 `#7DA1DE`，用户身份色为 Claude 橙 `#D77757`。角色色仍由 YAML 持有，系统 `accent` 当前同为雾蓝但不反向控制角色。旧选择名 `mist-dark`（含 `Mist Dark`、`mist_dark`）及旧 `base` 仍可解析，不再额外列出一套内置主题；若用户确实有同名自定义主题文件，优先使用用户文件。

## 新建一套主题

在 `~/.logox/themes/my-dark.json` 写入：

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

重启后，在 `/settings` 的 `Theme preset` 选择 `my-dark`。选择时会刷新界面缓存；直接编辑磁盘文件需要重新加载应用，不是文件监听热更新。

颜色值支持 `#RRGGBB` 或 `$token` 引用。所有继承与覆盖合并完后才解析引用，所以子主题修改 `fg`，继承的 `selectionFg: "$fg"` 也会更新。显式十六进制值则独立，不会因为恰巧同色就跟随另一个字段。

`base` 可省略；省略的字段回到完整基准。继承最多 16 层，未知基主题、未知引用和循环引用会被诊断。坏的用户主题被跳过；同名覆盖失效时恢复对应内置定义。未知颜色字段会报告并忽略。解析失败不会留下半套已应用颜色。

## 基础元素

日常设计先考虑这 14 个基础元素；这是配色入口，不代表所有专用场景都必须共享同色。

| 分组 | 字段 | 含义 |
|---|---|---|
| 文字 | `fg`、`muted`、`strong` | 正文、弱化说明、强文字 |
| 交互 | `accent` | 焦点、菜单高亮 |
| 系统 | `system` | 系统消息文字与轨道，默认引用 `muted` |
| 用户 | `user` | 用户身份与轨道 |
| 结构 | `bg`、`surface`、`line` | 背景基准、通用工具衬底、边线 |
| 状态 | `success`、`warning`、`error` | 成功、警告、失败 |
| 文本选区 | `selectionBg`、`selectionFg` | 拖选背景与文字，独立于焦点和勾选 |

`bg` 不会重设终端的整屏背景。当前未绘制区域、终端原生光标和 emoji 字形仍由终端控制；主题只控制 Logox 实际绘制的颜色。此轮保留原有背景透明/未填充行为。

## 专用语义色

以下字段可单独覆盖，或用 `$token` 绑定基础色。部分默认值特意保持独立，以保留原有视觉，而不是强行合并意义不同的颜色。

| 分组 | 字段 |
|---|---|
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

聚焦使用 `accent`；已勾选但未聚焦使用 `checkedFg`；禁用项使用 `muted`，不会因为已经勾选而继续突出。默认主题中勾选色仍是白色，但已不写死在控件里。

干预消息原先固定橙色，现在通过 `directorIntervention` 配置，默认保留原色。若希望它始终跟随系统高亮，设置为 `"$accent"`。

Markdown 正文读取 `fg`，弱化链接部分读取 `muted`；行内/代码块目前随所在轨道色，不是独立的关键字语法高亮系统。Diff 保留文字、底色、行号三层语义。

## 状态栏配色

`/statusbar` 与 `/settings → Statusbar` 的 Style 只决定 Pipes 或 Starship 的排版，Palette 决定信息段配色，切换任一项都保留模块组合。theme 使用当前系统语义色；gruvbox / dracula 使用独立的数据预设，不切换整个系统主题。角色段优先使用角色配置色，权限段使用各模式自己的语义色，不被装饰配色覆盖。上下文随已用容量读取 success / warning / error，Pipes 的分隔符使用 muted。Starship 只给信息段绘制固定底色，不改变终端整屏背景。

## 角色配色

角色 `config.yaml` 保留三个独立字段：

```yaml
color: "#7DA1DE"
card_closed: "#242B3A"
card_open: "#2E3850"
```

系统主题不覆盖它们。角色省略卡片底色时，沿用现有的身份色变暗派生规则；此轮没有改变亮度或动画算法。缺失角色样式的标签使用系统 `actorPillBg/Fg`，避免界面自行写灰底白字。

内置角色回退也从仓库 YAML 读取颜色，不再维护另一份旧色表。角色颜色控制“是谁”，状态色控制“发生了什么”，两者不混用。

## 兼容与开发约束

- 原有 26 个主题键保留；`dream_collapsed`、`dream_expanded` 继续兼容。
- TOML `[theme]` 的四色兼容入口保留，默认值取自同一份基准数据；它不是覆盖当前已选预设的通用叠加层。
- 主题解析集中在 `src/config/theme-palette.ts`，TUI 通过 `src/tui/appearance/theme.ts` 读取同一调色板；角色身份与卡片底色读取位于 `src/tui/appearance/actor-style.ts`。完整系统字段以 `themeColorKeys` 为准。
- 新增颜色先添加语义字段和基准 JSON，再由界面读取；业务 TS/TSX 不直接写十六进制、固定 RGB、命名颜色或固定彩色 SGR。
- `tests/color-literals.test.ts` 扫描源码中的常见字面颜色；它是有词法覆盖边界的防回归检查，不是完整 CSS 分析器。`tests/theme-colors.test.ts` 验证引用、覆盖、独立角色和缓存刷新，真实终端观感仍需人工确认。
