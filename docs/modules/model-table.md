# 内置模型表

Logox 自带一张只读的模型表：上下文窗口、最大输出、思考档位、输入类型和每百万 token 的价格。它由公开项目 `@oh-my-pi/pi-catalog`（MIT，版权 Can Bölük 与 Stencil Labs, Inc.，仓库 github.com/can1357/oh-my-pi）的模型目录裁剪生成，只作为兜底数据，配置和在线查询永远优先。

## 查询顺序

窗口与最大输出按下列顺序取第一个有值的来源：

1. `[provider]` 里的 `context_window`、`max_output_tokens`
2. `[models."provider/model"]`
3. 模型列表接口返回的在线数据
4. 内置模型表（精确、别名、规范化匹配）
5. 手写的 `model-capacities.ts`（表里没有的 id）
6. 按名称推断的默认值（如 Gemini、Claude 的通用窗口）
7. 内置表的低可信匹配（只按裸模型名在其他目录里找到）

价格先看 `[models."provider/model".prices]`，没有再查内置表。思考协议仍由 Logox 自己推断；表里的档位只在官方端点或已声明镜像目录的 `reasoning-effort` 模型上，用来取代通用的档位列表。上游的 `xhigh` 记为 `max`、`minimal` 记为 `low`（Logox 的档位里没有这两个名字）；上游标明必须带档位（`requiresEffort`）的模型没有 `off`；推理但没有档位控制的模型不给出档位。

## 自建网关怎样对应目录

网关的名字不在表里时，用 `[catalogs.<provider>]` 说明它转发的是哪家的目录，并为表里没有的名字写别名：

```toml
[catalogs.my-gateway]
mirror = "google"            # 也可以写数组，如 ["google", "anthropic"]
subscription = false         # 可选；true 表示按订阅计费，价格只是 API 等价估算

[catalogs.my-gateway.aliases]
"some-private-name" = "gemini-4-argon"
```

匹配依次是：别名、目录内精确 id、规范化 id（忽略厂商前缀、`:variant`、日期、`-minimal/-low/-medium/-high/-xhigh/-max/-thinking/-tiered` 后缀和点号/连字符差异）。都找不到时，会按裸模型名在其他目录里找，这类结果标记为低可信（`inferred`），窗口只在没有别的来源时使用，思考档位不采用。

别名只匹配完整的模型 id（不区分大小写），所以一个模型有 `-low`、`-high`、`-xhigh` 等档位变体时，通常不需要别名：规范化时 `-xhigh` 和 `-max` 一样被忽略，`gemini-4-hydrogen-xhigh` 与 `gemini-4-hydrogen` 按同一价格查询。

### 内置默认镜像

隐藏的已知端点 `antigravity`（本机代理，同时转发 Gemini 与 Claude）不需要写 `[catalogs.antigravity]`：它默认依次查 `google-antigravity`、`google`、`anthropic` 三个目录，先找到的先用（代理自己的 Claude 价格排在官方之前）。例如 `antigravity/gemini-4-hydrogen-high` 经规范化落到 `google` 目录的 `gemini-4-hydrogen`。用户写了 `[catalogs.antigravity]` 时以用户为准，默认镜像完全不参与。默认镜像只影响价格、窗口和输出上限的查询；`reasoning-effort` 的档位列表仍只在声明了 `mirror` 时才取自表。

## 没有价格的模型

内置表和 `[models."p/m".prices]` 都查不到价格时，该模型没有价格：`/usage` 的费用只算有价格的部分并标为 partial，页面会列出无价格的模型（含调用次数），并给出可粘贴的配置；Models & pricing 页把它显示为暗色的 `no price`。修法是直接写价格：

```toml
# 美元 / 每百万 token；cache_read、cache_write 可省略
[models."my-gateway/some-private-name"]
prices = {input = 0.0, output = 0.0}
```

用量页不再建议把模型别名到“同系列”的内置模型：同一系列的模型价格可能差很多（例如 `gemini-4-hydrogen` 比 `gemini-4-argon` 便宜约三分之一），别名会让费用悄悄算错。别名仍可手写，用于窗口、思考档位等价格以外的对应关系，或确实计价相同的网关名。

## 分日期价格

上游偶尔会给出带生效日期的价格卡（例如 Gemini 4 Argon 在 2026-12-01 之前每百万 token 输入 $2、输出 $10，之后 $4、$20）。生成的行里，`rates` 是最早一张价格卡，后面的卡放在 `dated`（`[生效时间(毫秒), 输入, 输出, cacheRead, cacheWrite]`）。查价时取生效时间不晚于“查询时刻”的最新一张卡：`tablePrice()` / `ModelTable.price()` 的 `at` 选项（默认当前时间）。

用量记录（`UsageRecord`）不带时间戳，所以费用在“计算的那一刻”按当时有效的价格卡计价：生效日之后重新打开 `/usage`，更早的用量也会按新价格显示。这是已知的近似；需要精确历史时，请用 `[models."p/m".prices]` 固定价格。

分时电价（`peakWindows`、`offPeakMultiplier`）被忽略，表里只保留标价；`longContext` 转成 `tiers`（超过某个提示长度后的费率，`/usage` 目前不使用，`inputThresholdInclusive` 也被忽略）。

## 订阅与 OAuth

`openai-codex`（ChatGPT 登录）和 `github-copilot` 的目录带订阅标记，对应的价格是“按 API 计价的等价金额”，不是实际扣费。`modelPrice()` 的结果带 `subscription` 字段，调用方可据此显示为估算或隐藏。`isSubscriptionProvider()` 给出同一判断。Logox 的 `openai` 提供商用 ChatGPT 登录时，调用方传入 `oauth: true` 即可。

## 刷新数据

数据在 `src/providers/model-table.generated.ts`，不要手改。需要新模型或新价格时：

```bash
npm run sync:models              # 使用脚本里固定的版本
npm run sync:models -- --latest  # 取最新发布版本
npm run sync:models -- --version 18.20.0
npm run sync:models -- --from <已解压的包目录>   # 离线
npm run sync:models -- --check   # 只检查是否已是最新，过期则退出码为 1
```

脚本用 `npm pack` 下载压缩包（不是 `npm install`）并解压到临时目录，只把 `src/models.json` 和 `LICENSE` 当数据读取，不会导入、`require` 或执行包里的任何文件，也不使用包自带的解码器：`models.json` 是紧凑编码，脚本里的 `decodeCatalog()` 自己解码（值是原始类型或 `[节点号]`，节点是数组或带布尔位掩码的对象，提供商行是 `[id, [节点号], delta?]`，`delta` 只含传输层兼容数据，忽略）。输出按提供商和模型 id 排序，同一版本重复生成结果一致。生成文件头部记录来源包、版本和 MIT 声明（版权行取自包里的 `LICENSE`，读不到时使用已知的 `Copyright (c) 2025-2026 Can Bölük`）。升级固定版本时修改脚本里的 `PINNED_VERSION`，再运行 `npm run build` 和测试。

上游提供商名与 Logox 目录名不同时在脚本的 `UPSTREAM_NAMES` 里映射（目前只有 `moonshotai` ← 上游 `moonshot`）。保留的目录见 `KEEP_PROVIDERS`；没有上下文窗口的条目会被丢弃，缺少最大输出的条目记为 0（未知）。

建议在新模型或新价格出现、或每隔一两个月刷新一次，并检查 diff 里窗口和价格是否合理；脚本会列出带分日期价格卡的模型。

## 边界

- 表里的价格是公开标价，不含地区、批量折扣、分时电价或账户协议价；分段价格放在 `tiers` 里，`/usage` 目前不使用它。
- 表只收录与 Logox 相关的提供商（见脚本的 `KEEP_PROVIDERS`）；OpenRouter 的条目带厂商前缀，参与裸名匹配但排在一手厂商之后。
- 自建网关实际限制可能比官方更小；窗口以 `[models."provider/model"]` 的声明为准。
