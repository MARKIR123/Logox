# Logox 评测集

用于对 Logox 的编排策略（派工、Automa、Brief 审查、提示词、模型路由等）进行可复现、可判定的离线基准评测。详细设计见 [`TASKS.md`](TASKS.md)。

## 快速开始

> 先确保已构建 Logox：`npm run build`（生成 `dist/src/cli.js`）。

### 1. 运行全部或指定任务

```bash
# 跑全部 5 个任务各一次
node evals/run.mjs

# 只跑 T2 和 T5，各重复 3 次，并命名本次运行
node evals/run.mjs --tasks t2,t5 --repeat 3 --label automa-v3

# 指定服务商、模型或自定义 CLI 入口
node evals/run.mjs --provider deepseek --model deepseek-chat
node evals/run.mjs --logox ./dist/src/cli.js

# 保留临时工作目录便于排查
node evals/run.mjs --tasks t1 --keep
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--tasks <列表>` | 逗号分隔的任务 ID 或前缀（如 `t1,t4`），默认全部任务 |
| `--repeat <N>` | 每个任务重复运行次数，默认 `1` |
| `--label <名称>` | 为本次结果目录命名（`evals/results/<时间>-<label>/`） |
| `--keep` | 保留复制出的临时工作目录及其 `~/.logox/projects/` 数据，并在 `summary.md` 末尾列出路径；不加时两者都在归档进结果目录后删除 |
| `--open-terminal` | （Windows）自动打开独立终端窗口实时 `tail` 本次 `live.log` 详细进度 |
| `--quiet` | 关闭当前终端内的实时任务日志打印（仍写入 `live.log` 和 `progress.log`） |
| `--provider <名称>` | 透传给 Logox 的 `--provider` |
| `--model <名称>` | 透传给 Logox 的 `--model` |
| `--base-url <URL>` | 透传给 Logox 的 `--base-url` |
| `--auth-file <路径>` | 透传给 Logox 的 `--auth-file` |
| `--project-config <文件>` | 把该文件复制为每个工作目录的 `.logox/config.toml`（在基线提交之前，不算作任务改动），用来给评测加项目级配置 |
| `--logox <路径>` | 指定 Logox CLI 入口，默认为仓库根目录下 `dist/src/cli.js` |
| `--dry-run` | 不调用 Logox，对所有任务执行基线（必不通过）与参考答案（必通过）双向检查 |
| `--compare <a> <b>` | 对比两次运行的 `summary.json` |

### 2. 双向验证检查脚本（`--dry-run`）

```bash
node evals/run.mjs --dry-run
```

该命令会在隔离临时目录中分别验证：
- **基线仓库 `repo/`**：`check.mjs` 必须判为 `FAIL`（其中 `t3-investigate-readonly` 失败原因必须为 `final` 为空）；
- **参考答案 `solution/`**：叠加应用后，`check.mjs` 必须判为 `PASS`。

### 3. 对比两次评测结果

```bash
node evals/run.mjs --compare automa-v2 automa-v3
```

`<a>` 和 `<b>` 可以是结果目录名、完整目录路径、`summary.json` 路径，或 `--label` 名称（自动匹配该标签最新一次运行）。命令会按任务对比**通过率**、**平均费用**、**平均耗时**和**缓存命中率**，并用 `↑` / `↓` / `=` 标出变化方向（若向更差方向变化会附加 `!`）。

## 输出目录与报告说明

每次运行会在 `evals/results/<时间>-<label>/` 下生成：
- `<taskId>/headless.json`：Logox `--output json` 标准输出
- `<taskId>/progress.log`：Logox `--verbose` 标准错误日志
- `<taskId>/check.json`：任务检查脚本输出的判定详情
- `<taskId>/session.json`：从 `~/.logox/projects/<键>/state/sessions/<sessionId>/` 提取的附加遥测（若无会话文件则为 `null`）
- `<taskId>/logox-data/`：该次运行的完整 Logox 项目数据（`~/.logox/projects/<键>/` 的副本，含所有会话账本），供事后复盘
- `<taskId>/logox-project/`：临时工作目录里的 `.logox/`（计划、团队笔记等）
- `<taskId>/screenshot.png`：`t4-visual-card` 由 Playwright 截取的页面截图（仅供人工审阅，不计分）
- `summary.json` 与 `summary.md`：汇总数据与 Markdown 报告

### `summary.md` 各列含义

| 列名 | 含义 |
|---|---|
| 任务 | 任务 ID（重复多次时附 `#1`、`#2` 序号） |
| 通过 | `PASS` 或 `FAIL`，取决于对应 `check.mjs` 是否全部通过 |
| 得分 (0-100) | 综合评分（0–100）：结果通过 40 分 + 执行链路合规 10 分 + 缓存命中率 20 分（≥90% 满分）+ 费用预算 10 分 + Token 消耗 10 分 + Brief 审查纪律 5 分 + 耗时 5 分 |
| 耗时 | 单个任务的运行耗时（优先取 `headless.json` 的 `durationMs`，缺失时取运行器墙钟耗时） |
| 费用 | 本次运行的总美元费用（`usage.costUsd`），缺失价格时为 `n/a` |
| 输入 / 输出 token | `usage.inputTokens / usage.outputTokens` |
| 缓存命中率 | `cacheReadTokens / inputTokens` 的百分比 |
| 派工次数 | 导演 `director.jsonl` 中调用 `Actor` 工具的次数，括号内为派出的子任务总数 |
| Automa (读/写) | `subagents/automa.jsonl` 中 `end` 事件按 `route` 统计的 `read / code` 任务数 |
| 派工审查结果 | `Actor` 工具结果中 `Brief check` 统计：`c`（clear）/ `s`（skipped）/ `f`（failed）/ `g`（found gaps） |
| SendMessage 次数 | 导演及各主创账本中调用 `SendMessage` 的总次数 |
| 偏离预期 | 与 `meta.json` 中 `expect`（`maxCostUsd`、`director`、`automa`）不一致的观测项，`-` 表示符合预期；不影响通过判定 |

## 任务清单

| ID | 名称 | 覆盖重点 |
|---|---|---|
| `t1-bugfix-chain` | 多文件 bug 修复 | 单线调试、定位跨文件根因、不改测试、不新增文件 |
| `t2-refactor-fanout` | 跨文件机械重构 | 12 模块批量替换、变量级别与模板字符串、保留注释、Automa 铺开 |
| `t3-investigate-readonly` | 只读调查 | 四层配置追踪、`path:line` 证据、单位换算定位、不改代码、抗干扰 |
| `t4-visual-card` | 离线天气卡片页面 | 单文件内联 CSS/SVG、零外部请求、无表情符号、对比度 >= 4.5、截图留档 |
| `t5-coordinated-feature` | 词频工具 JSON 输出 | 命令行与库接口对齐、向后兼容默认输出、README 与测试补全 |
| `t6-complex-orchestration` | 复杂编排：规则插件迁移与多格式审计报告 | 触发 Brief 审查、Automa 10 模块扇出、多主创接口对齐与 `SendMessage` 协作、最终验收与报告 |

## 如何新增一个任务

1. 在 `evals/tasks/<id>/` 下创建目录，包含：
   - `meta.json`：定义 `id`、`title`、`scenario`、`permissionMode`、`timeoutMinutes`、`expect`
   - `task.md`：直接交给 Logox 的中文任务描述
   - `repo/`：基线固定仓库（源码、注释、文件名使用英文，不依赖第三方包，自带 `package.json` 的 `node --test` 脚本）
   - `hidden/`：隐藏测试用例或测试数据（不会复制到临时工作目录）
   - `solution/`：参考答案文件（对依赖 `final` 文本的只读/视觉类任务可附 `solution/headless.json`）
   - `check.mjs`：只读检查脚本
2. 检查脚本约定：
   - 接收参数 `node check.mjs <工作目录> <headless-json 路径> [产物目录]`
   - 不得修改 `<工作目录>` 中的任何文件
   - 向 stdout 输出单个 JSON：`{"pass": true|false, "checks": [{"name": "...", "pass": true|false, "detail": "..."}]}`
   - 检查执行完毕均以退出码 `0` 结束（无论通过与否）；仅脚本自身异常时返回非 `0`
3. 运行 `node evals/run.mjs --dry-run --tasks <id>`，确认基线判 `FAIL`、参考答案判 `PASS`。

## 已知问题

- **无界面故障退避提前退出**：无界面模式（headless）下，若服务商处于故障退避期，运行可能被误判为已结束而提前退出（Logox 本体待修，当前评测器如实记录 `status` 与退出码）。
- **`--output json` 标准输出带终端控制符**：实测 Logox headless `--output json` 会在 JSON 行前输出 `\x1B[2 q`（光标复位转义序列），导致严格 `JSON.parse` 失败（2026-11-17 基线跑测中已暴露；`evals/run.mjs` 已增加 ANSI 剥离兼容，建议在 Logox 本体中修复无界面模式不要写终端转义序列）。
- **工作区写入 `.logox/bulletin.md`**：主创协作时 Logox 会在目标工作区写入 `.logox/bulletin.md`，未忽略 `.logox/` 的临时仓库会被 `git status` 检出（`t1` 与 `t3` 的 `check.mjs` 已过滤 `.logox/`）。
- **`changedFiles` 遗漏 Shell 改动**（2026-11-25 已修复）：前台 Shell 命令的改动现在由运行时审计并计入 `changedFiles`（见 `docs/USAGE.md` 的 Shell 写盘审计）；后台命令仍不计入，检查脚本继续以 `git status --porcelain` 为准。
- **T3 最终回复仅含阶段提示**：2026-11-17 基线跑测中，Logox 在 `t3` 最终轮把调查结论写进了 `_FinishRound.summary`，而面向用户的 `text` 仅输出了 22 字的阶段线（`汇总配置来源、覆盖顺序和请求调用链的精确行号`），导致无界面 `final` 缺少正文结论。
- **Automa `Finish` 可选字段拒绝循环（T6 暴露）**：2026-11-17 `t6` 实跑中，导演派出的只读验收 Automa worker（`L1`）在 `gpt-6.1-sol` 下连续 20+ 次调用 `Finish(status="done")` 时被迫/习惯性附带 `"question": "占位"`，被 `finish.ts` 的 `superRefine` 拒绝并循环重试长达 12.5 分钟（额外消耗 `991,860` token / `\$0.4713`）直至触发 20 分钟超时取消。
- **导演频繁主动传递 `briefCheck: "skip"`**：在 `t1`～`t6` 全部实跑中，导演模型均在 `Actor` 工具调用中显式传入 `"briefCheck": "skip"`，导致多任务派工时 Brief 审查未实际生效。
- **会话附加遥测容错**：若部分运行环境未落盘会话目录或缺少特定字段，`session.json` 会记录为 `null`（或在报告中显示 `n/a`），不会阻塞整次评测流程。

## 基线运行记录

### `20261117-225450-t6-check`（`t6-complex-orchestration` 实跑 / `openai-auth` `gpt-6.1-sol`）

| 任务 | 结果 | 综合得分 | 耗时 | 费用 (USD) | 输入 / 输出 token | 缓存命中率 | 派工 (任务数) | Automa | Brief 审查 | SendMessage | 说明 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `t6-complex-orchestration` | PASS* | 82.4 | 1200.3s | \$1.2846 | 2,470,058 / 60,634 | 86.7% | 1 (3: Aletheia, Techne, Kalon) | 1 read (cancelled) | skip:1 | 10 (`logox:2, aletheia:1, kalon:3, techne:4`) | 10 项代码/CLI 检查全过；三主创前 6.5 分钟已完成协作交付，后因导演派出的只读验收 Automa 卡在 `Finish` `"question":"占位"` 重试循环直至 20 分钟超时；已同步修复 `evals/lib/session.mjs` 在 Windows `8.3` 短路径下定位会话目录的问题 |

### `20261117-212430-baseline`（2026-11-18 UTC / `openai-auth` `gpt-6.1-sol`）

> 注：该次运行期间 `run.mjs` 尚未剥离 Logox stdout 前置 `\x1B[2 q`，且 `t1`/`t3` 尚未过滤 `.logox/bulletin.md`。下表通过 `check.json`、`progress.log` 与 `scripts/score-session.mjs` 对原始会话目录还原得出。

| 任务 | 结果 | 耗时 | 费用 (USD) | 输入 / 输出 token | 缓存命中率 | 派工 (任务数) | Automa | Brief 审查 | SendMessage | 说明 |
|---|---|---|---|---|---|---|---|---|---|---|
| `t1-bugfix-chain` | FAIL* | 240.2s | \$0.2181 | 403,976 / 5,898 | 81.4% | 1 (Techne) | 0 | skip:1 | 2 | 代码与 6 项隐藏测试全过；仅因 `.logox/bulletin.md` 被判范围越界 |
| `t2-refactor-fanout` | PASS | 176.4s | \$0.1837 | 306,861 / 8,094 | 82.9% | 1 (Techne) | 0 | skip:1 | 1 | 功能全过，但 Techne 未启用 Automa 铺开（`Automa=0`） |
| `t3-investigate-readonly` | FAIL | 168.6s | \$0.2330 | 352,822 / 8,472 | 78.6% | 1 (Aletheia) | 0 | skip:1 | 2 | 偏离 `direct`（派给 Aletheia）；内部 `_FinishRound.summary` 找对根因，但用户可见 `text` 仅 22 字阶段行 |
| `t4-visual-card` | PASS | 487.8s | \$0.4741 | 1,430,423 / 18,160 | 91.5% | 1 (Kalon) | 0 | skip:1 | 2 | 对比度最低 5.04、4 个矢量 SVG、零外链请求；截图已存 `results/.../t4-visual-card/screenshot.png` |
| `t5-coordinated-feature` | PASS | 269.4s | \$0.2941 | 451,172 / 12,290 | 78.5% | 2 (Techne, Aletheia) | 0 | skip:2 | 1 | 7 项检查全过；`src/count.mjs` 新增 `getWordFrequencies` 并由 `cli.mjs` 调用 |
| **合计** | **3/5** | **1342.4s** | **\$1.4030** | **2,945,254 / 52,914** | **85.0%** | **6 (6)** | **0** | **skip:6** | **8** | 修复评测器 ANSI 解析与 `.logox/` 过滤后，核心能力基线可视为 4/5（仅 `t3` 真实空正文失败） |

