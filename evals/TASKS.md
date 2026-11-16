# Logox 评测集任务书

建立日期：2026-11-16。本文是交给实现者的任务书：照着它在 `evals/` 下建好 5 个固定仓库、各自的检查脚本和一个汇总运行器。Logox 本身的代码不在本任务范围内，除非第 8 节列出的阻塞问题需要改。

## 1. 目的与约束

每次改动 Logox 的编排方式（派工、Automa、审查、提示词、模型路由）后，用同一组任务跑一遍，比较成功率、耗时、费用和缓存命中率，判断改动是变好还是变差。

- **小**：每个任务的固定仓库源码不超过约 300 行（不含测试），全套 5 个任务在常用模型上一次跑完，目标在 20 分钟和几美元以内。每次迭代都要跑得起。
- **覆盖面**：五个任务合起来覆盖导演直接处理、单线修复、Automa 铺开、浏览器验证、主创之间对齐接口这几种情况（见第 3 节的表）。
- **可判定**：通过与否由检查脚本判定，不靠人看。主观部分（比如页面好不好看）只存截图供人参考，不计入通过率。
- **可复现**：固定仓库不依赖网络，不安装第三方依赖，只用 Node.js 22 自带的能力（`node:test`、`node:assert` 等）。前端任务的检查使用本仓库已有的 Playwright。
- **防作弊**：隐藏测试和参考答案放在复制给 Logox 的目录之外，Logox 看不到。

## 2. 目录结构

```
evals/
  TASKS.md                 本文
  README.md                使用说明（中文）
  run.mjs                  汇总运行器
  lib/                     运行器和检查脚本共用的小工具（可选）
  tasks/
    <id>/
      meta.json            元数据（见下）
      task.md              交给 Logox 的任务原文（中文，就是用户会说的话）
      repo/                固定仓库：复制到临时目录后交给 Logox
      hidden/              隐藏测试和检查用的数据，不复制给 Logox
      solution/            参考答案：在 repo/ 上应用后能通过检查的文件（同样不复制给 Logox）
      check.mjs            检查脚本
  results/                 运行结果（加入 .gitignore）
```

`meta.json`：

```json
{
  "id": "t2-refactor-fanout",
  "title": "把旧日志接口换成新接口",
  "scenario": ["automa-fanout", "mechanical-edit"],
  "permissionMode": "auto",
  "timeoutMinutes": 15,
  "expect": {"maxCostUsd": 1.0, "director": "dispatch", "automa": "expected"}
}
```

- `expect` 只用于报告里标注"偏离预期"，不影响通过与否。
- `director` 取值：`direct`（导演应自己做完）、`dispatch`（应派给主创）、`any`。
- `automa` 取值：`expected`、`unexpected`、`any`。

### 检查脚本约定

`node check.mjs <工作目录> <headless-json 路径>`：

- 只读工作目录，不修改。
- stdout 输出一个 JSON：`{"pass": true|false, "checks": [{"name": "...", "pass": true|false, "detail": "..."}]}`。
- 所有检查都通过时，`pass` 为 true。
- 退出码：0 表示检查执行完毕（不论通过与否），非 0 表示检查脚本自己出错。

## 3. 五个任务

| 任务 | 主要覆盖 | 预期的导演行为 | Automa |
|---|---|---|---|
| T1 多文件 bug 修复 | 单线调试、跑测试、不越界修改 | 自己做，或派一位主创 | 不预期 |
| T2 跨文件机械重构 | Automa 铺开、写入授权、不漏改 | 派工 | 预期 |
| T3 只读调查 | 证据 `path:line`、不改文件、成本低 | 自己做 | 可有可无 |
| T4 小型可视页面 | Kalon、浏览器验证、离线单文件 | 派工 | 不预期 |
| T5 需要对齐接口的小功能 | 两位主创协作、派工审查、验收 | 派工 | 可有可无 |

### T1 `t1-bugfix-chain`：多文件 bug 修复

**固定仓库**：一个小型库存或订单计算模块，约 4 个源文件，例如：

- `parse.mjs`：解析订单行；
- `pricing.mjs`：单价、折扣；
- `tax.mjs`：按地区计税并取整；
- `index.mjs`：汇总。

附带 `test/*.test.mjs`，其中 3 个测试失败。

**埋好的 bug**：失败表现在汇总上，根因分散在两个文件里，必须都修对：

1. 折扣按百分比和按固定额的分支写反；
2. 计税时先取整再相乘，导致分位误差。

**`task.md`**：

> `npm test` 有三个测试挂了，帮我修好。不要改测试。

（固定仓库里提供 `package.json`，其 `test` 脚本为 `node --test test/`。）

**检查**：

- 原有测试全部通过；
- 隐藏测试（`hidden/` 里另外 6 个边界用例，比如零数量、100% 折扣、负数输入应报错）全部通过；
- `test/` 下的文件与原样一致（逐个比较哈希）；
- 改动只落在 `*.mjs` 源文件上，没有新增文件。

### T2 `t2-refactor-fanout`：跨文件机械重构

**固定仓库**：12 个小模块（每个 10–25 行），用旧接口 `log(level, message)` 打日志，`level` 是字符串 `'info' | 'warn' | 'error'`。另有：

- `logger.mjs`：已经提供新接口 `logger.info(message)`、`logger.warn(message)`、`logger.error(message)`，旧的 `log` 也还在；
- 每个模块对应一个简单测试。

部分调用需要注意：

- 2 处 `level` 是变量，不是字面量，要改写成 `logger[level](message)`；
- 1 处在模板字符串里拼接；
- 1 处注释里提到 `log(`，不应修改。

**`task.md`**：

> 把所有对旧 `log(level, message)` 的调用改成新的 `logger.<level>(message)`，改完把 `logger.mjs` 里旧的 `log` 删掉，测试要全过。

**检查**：

- 除注释外，源码里不再有 `log(` 调用（用简单的词法扫描，跳过注释和字符串）；
- `logger.mjs` 不再导出 `log`；
- 所有测试和隐藏测试通过（隐藏测试会实际调用每个模块，并截获 `logger` 的输出，核对级别和内容）；
- 注释原样保留。

**记录但不判定**：本次运行的 Automa 任务数和路由。这是判断"会不会铺开"的主要观测点。

### T3 `t3-investigate-readonly`：只读调查

**固定仓库**：约 20 个文件的小服务骨架，配置来源有四层：

1. `config/default.json`；
2. `config/<env>.json`；
3. 环境变量映射（`src/config/env.mjs`）；
4. 代码里的硬编码兜底。

请求超时最终是 30 秒，它来自第 3 层的一个映射，而这个映射把单位从毫秒换算错了。另外放两个干扰项：一个写着 `timeout: 30` 但从未被读取的旧文件，一个名字相近但用于另一种超时的配置。

**`task.md`**：

> 线上请求超时是 30 秒，我以为配置的是 30000 毫秒。帮我查清楚这个 30 秒到底从哪来、经过了哪些文件，给出具体文件和行号。只查，不要改代码。

**检查**：

- 工作目录没有任何改动：`git status --porcelain` 为空，`changedFiles` 为空；
- `final` 中按正则依次命中：
  - 生效链上的 3 个关键位置，形如 `src/config/env.mjs:<行号>`，行号允许 ±1；
  - 指出换算错误的关键词（比如"毫秒"与"秒"同时出现在同一句）；
- `final` 中没有把干扰文件说成来源：干扰文件名出现在否定语境之外即判失败。这一条宽松处理：只检查干扰文件名后面紧跟"是来源"这类肯定表述的情况。

### T4 `t4-visual-card`：小型可视页面

**固定仓库**：

- `data/weather.json`：城市名、温度、天气类型（晴、多云、雨三选一）、未来三天预报；
- `README.md`：写明需求。

**`task.md`**：

> 用 `data/weather.json` 做一个天气卡片页面 `index.html`：单文件，CSS 和 SVG 都内联，不能引用任何外部资源。卡片显示城市、当前温度、一个对应天气的 SVG 图标，下面一行显示未来三天。图标要自己画，不要用表情符号。做完在浏览器里看一下效果。

**检查**（用 Playwright 打开 `file://` 下的 `index.html`）：

- 页面没有任何对外网络请求（拦截记录为空）；
- 页面里能找到城市名、当前温度（数字与 JSON 一致）、3 个预报项；
- 至少 1 个 `<svg>` 且包含 path、circle 等绘图元素，不能只是一张内嵌的位图；
- 正文文字与背景的对比度不低于 4.5（取主要文字元素的计算样式）；
- 页面里没有天气类表情字符（☀ ☁ 🌧 等）；
- 截图存到结果目录，供人看，不计分。

### T5 `t5-coordinated-feature`：需要对齐接口的小功能

**固定仓库**：一个小型命令行工具，统计文本文件的词频：

- `src/count.mjs`：库，导出 `countWords(text)`，返回 `Map`；
- `src/cli.mjs`：命令行入口，目前只输出纯文本表格；
- `README.md`：用法说明；
- 对应测试。

**`task.md`**：

> 给这个工具加 JSON 输出：命令行加 `--format json`，输出按词频从高到低排好的数组；库里也要有一个能直接拿到这份数据的函数，方便别的程序调用。README 和测试都要补上。

任务故意不规定库函数的名字和返回结构，让负责库和负责命令行的两方需要对齐。

**检查**：

- 原有测试通过；
- 隐藏测试只通过命令行检查：
  - `--format json` 输出可解析，是 `[{"word": string, "count": number}]` 这样的数组，按 `count` 降序，同频按词的字母序；
  - 默认输出与改动前逐字一致；
  - 非法的 `--format` 值以非 0 退出并给出提示；
- `src/count.mjs` 新增了至少一个导出，并且 `src/cli.mjs` 确实调用了它（静态检查 import）；
- `README.md` 里出现 `--format json`；
- 新增或修改了测试文件，并且这些测试本身能通过。

**记录但不判定**：主创之间 `SendMessage` 的次数、派工审查的结果（通过、发现缺口、被跳过）。数据从会话文件里读，见第 5 节。

## 4. 运行器 `run.mjs`

```bash
node evals/run.mjs                            # 跑全部任务一次
node evals/run.mjs --tasks t2,t5 --repeat 3   # 指定任务，各跑 3 次
node evals/run.mjs --label automa-v3          # 给这次运行起名，用于对比
node evals/run.mjs --compare automa-v2 automa-v3
node evals/run.mjs --dry-run                  # 不调用 Logox，只验证检查脚本（见第 6 节）
```

其余参数原样转给 Logox：`--provider`、`--model`、`--logox <cli 路径>`，默认用本仓库的 `dist/src/cli.js`。

**每个任务的流程**：

1. 把 `tasks/<id>/repo/` 复制到系统临时目录下一个新建的空目录。
2. `git init`，提交一次基线，这样之后能看出改了什么。
3. 运行：

   ```bash
   node <cli> --task-file <task.md> --output json --permission-mode <meta.permissionMode> --timeout <meta.timeoutMinutes>
   ```

   工作目录设为上面的临时目录。stdout 存成 `headless.json`，stderr 存成 `progress.log`，并加上 `--verbose`。
4. 运行 `check.mjs`，存成 `check.json`。
5. 读取本次会话的附加数据（见第 5 节），存成 `session.json`。
6. 默认删除临时目录，`--keep` 时保留，并在报告里写出路径。

**输出**：

- `evals/results/<时间>-<label>/` 下，每个任务一个子目录，放上面的各个文件；
- `summary.json`；
- `summary.md`：一张表，每个任务（重复运行时取各次）一行。列为：通过、耗时、费用、输入与输出 token、缓存命中率（`cacheReadTokens / inputTokens`）、派工次数、Automa 任务数（读/写各多少）、派工审查结果、`SendMessage` 次数、偏离预期的项。最后一行是合计。

**对比**：`--compare a b` 读两次运行的 `summary.json`，逐任务列出变化：通过率、平均费用、平均耗时、缓存命中率，用 ↑↓ 标注。

**任务之间串行运行**，避免争用同一个服务商的速率限制。

## 5. 从会话里读附加数据

`headless.json` 里有 `sessionId`。会话目录在 `~/.logox/projects/<键>/state/sessions/<sessionId>/`，`<键>` 是临时工作目录解析后的绝对路径把非字母数字换成 `-`，可以复用 `scripts/project-data.mjs` 里的函数。从中读取：

- **派工次数**：导演记录里 `Actor` 工具调用的次数，以及每次派出的任务数。
- **派工审查结果**：`Actor` 工具结果文本里 `Brief check: clear.`、`Brief check: skipped.`、`Brief check: failed`，以及 "Brief check found gaps" 各出现几次。
- **`SendMessage` 次数**：按发送方统计。
- **Automa**：`subagents/automa.jsonl` 里 `end` 事件的 `route`（read / code / vision）和 `status`。可以直接调用 `scripts/automa-outcomes.mjs` 的逻辑，或照它的格式读取。

读不到时记为 `null`，不让整次运行失败。

## 6. 实现者的验收标准

1. **`--dry-run` 双向验证**。对每个任务：
   - 在固定仓库原样（基线）上运行 `check.mjs`，必须判为**不通过**；T3 例外，基线上判"不通过"的原因是 `final` 为空。
   - 应用 `solution/` 之后运行，必须判为**通过**。对 T3 和 T4 这类判定依赖 Logox 输出的任务，`solution/` 里附一份伪造的 `headless.json`，内含参考答案的 `final`。

   `--dry-run` 打印每个任务这两项的结果。两项都对，才算这个任务做完。
2. 五个任务的固定仓库各自 `npm test` 能跑：基线上该失败的失败，参考答案上全过。
3. `run.mjs` 用一个假的 Logox 命令跑通一遍完整流程（`--logox` 指向一个脚本，它直接输出一份固定的 `headless.json`），能生成 `summary.md`。
4. 不给 Logox 本身加依赖。评测代码只用 Node.js 22 自带模块，加上本仓库已有的 `playwright`。
5. `evals/results/` 加入 `.gitignore`。
6. `README.md`（中文）写明：怎么跑、怎么对比、怎么新增一个任务、各列的含义。

## 7. 约定

- 固定仓库里的代码、注释和文件名用英文。交给 Logox 的 `task.md` 用中文，因为那是用户会说的话。
- 隐藏测试不要从文件名或注释上透露答案，例如不要叫 `discount-branch-swapped.test.mjs`。
- 每个任务的 bug 或需求只设计一个"正确解法族"。检查只判断结果，不要求特定写法：只要测试过、行为对，用什么实现都算对。
- 不要为了让检查好写而把任务说得过细，这样会测不出派工质量。

## 8. 已知可能需要改 Logox 的地方

实现时遇到以下情况，先记录在 `README.md` 的"已知问题"一节，不要自己改 Logox 源码，交回给我们处理：

- 无界面运行时，服务商处于故障退避期，可能被误判为已结束而提前退出。
- `changedFiles` 不包含 Shell 命令造成的改动。所以检查一律以 `git status` 为准，不要依赖 `changedFiles`。
- 从会话里读附加数据时发现缺字段，比如需要的信息只在日志的自由文本里。
