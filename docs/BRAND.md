# 品牌规范

LOGOX 的标志是一朵像素花：上下两片雾蓝花瓣、左右两片骨白花瓣，围着一个内凹的菱形花心。它只承担标志的功能，不代表任何角色。所有文件都在 `assets/` 下，由源数据生成。

## 文件

| 文件 | 用途 |
|---|---|
| `assets/banner.svg`、`assets/banner-light.svg` | README 横幅（1280 × 400），README 按 GitHub 的深浅主题自动切换 |
| `assets/logo.svg`、`assets/logo-light.svg` | 横版组合：标志加字标 |
| `assets/wordmark.svg`、`assets/wordmark-light.svg` | 字标：Cinzel 的 LOG 与 X，第二个 O 换成像素花心 |
| `assets/logo-mark.svg`、`assets/logo-mark-light.svg` | 标志母版（52 格），带克制的边缘光影 |
| `assets/logo-mark-mono.svg`、`assets/logo-mark-reversed.svg` | 单色墨版与反白版，不带光影 |
| `assets/logo-mark-16.svg`、`assets/logo-mark-16-light.svg` | 16 格手绘小尺寸版本 |
| `assets/app-icon.svg` | 应用图标，深色圆角底 |
| `assets/favicon.svg`、`assets/favicon-32.svg` | 16 px 与 32 px 网站图标 |

后缀带 `-light` 的文件用于浅色背景。浅底上骨白花瓣会消失，所以浅色版把它们换成深墨色。

## 尺寸与版本

- 64 px 及以上用 52 格母版，花心的内凹在这个尺寸才看得出来。
- 26 到 48 px 用 26 格原稿（`assets/brand/draft-26.json`），花心是平直的菱形。TUI 启动页和 32 px 图标用的就是它。
- 16 到 24 px 用 16 格手绘版本，每片花瓣保留一个镂空。
- 像素图只按整数倍缩放，否则边缘会发虚。

## 配色

| 名称 | 深色背景 | 浅色背景 |
|---|---|---|
| 背景 | `#121722` | `#F5F3EE` |
| 花瓣蓝（高光 / 基色 / 阴影） | `#97B5E8` / `#7DA1DE` / `#6688C8` | `#6487CF` / `#4A6FBA` / `#3A5CA3` |
| 侧瓣与文字 | 骨白 `#E8E4DA` | 深墨 `#2B3447` |

光源在左上方，只在边缘留一像素高光和阴影，没有相同色调邻居的孤立像素会退回基色，避免画面显脏。

## 字体

- 字标：[Cinzel](https://fonts.google.com/specimen/Cinzel) Medium，字距 0.12 em。
- 横幅标语：[EB Garamond](https://fonts.google.com/specimen/EB+Garamond) 斜体（A terminal coding ensemble）与正体（λόγος · reason, word, account）。
- 两款都是 OFL 许可。所有文字都已转成轮廓，不依赖系统字体。
- 终端字体只是推荐，见[终端操作](UI-SPEC.md)。

## 修改与重新生成

1. 用浏览器打开 `scripts/brand-pixel-editor.html`，把 `assets/brand/` 里的 JSON 粘进文本框导入，编辑后导出 JSON 覆盖原文件。`b` 是蓝，`w` 是骨白。
2. 运行 `node scripts/brand-assets.mjs`，重新生成 `assets/` 下全部 SVG。光影在生成时计算，源数据只画平涂。
3. 改了 `assets/brand/draft-26.json` 后，同步更新 `src/tui/appearance/emblem.ts` 里的 `EMBLEM_PIXELS`；`npm test` 会检查两者一致。
4. 只有改字标字母或横幅文字时，才需要运行 `scripts/brand-outlines.py` 重新提取轮廓，它依赖 fontTools 和上面两款字体。

## 不要这样用

- 不要拉伸、旋转标志，或给它加描边、投影、渐变。
- 不要把深色版放在浅色背景上，反之亦然；不确定时用单色版。
- 不要在标志里加入角色符号或颜色。
