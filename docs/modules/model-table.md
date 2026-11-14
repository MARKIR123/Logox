# 内置模型表

Logox 自带一张只读的模型表：上下文窗口、最大输出、思考档位、输入类型和每百万 token 的价格。它由公开项目 `@earendil-works/pi-ai`（MIT）的模型目录裁剪生成，只作为兜底数据，配置和在线查询永远优先。

## 查询顺序

窗口与最大输出按下列顺序取第一个有值的来源：

1. `[provider]` 里的 `context_window`、`max_output_tokens`
2. `[models."provider/model"]`
3. 模型列表接口返回的在线数据
4. 内置模型表（精确、别名、规范化匹配）
5. 手写的 `model-capacities.ts`（表里没有的 id）
6. 按名称推断的默认值（如 Gemini、Claude 的通用窗口）
7. 内置表的低可信匹配（只按裸模型名在其他目录里找到）

价格先看 `[models."provider/model".prices]`，没有再查内置表。思考协议仍由 Logox 自己推断；表里的档位只在官方端点或已声明镜像目录的 `reasoning-effort` 模型上，用来取代通用的档位列表。

## 自建网关怎样对应目录

网关的名字（例如 `antigravity`）不在表里时，用 `[catalogs.<provider>]` 说明它转发的是哪家的目录，并为表里没有的名字写别名：

```toml
[catalogs.antigravity]
mirror = "google"            # 也可以写数组，如 ["google", "anthropic"]
subscription = false         # 可选；true 表示按订阅计费，价格只是 API 等价估算

[catalogs.antigravity.aliases]
"gemini-4-argon-high" = "gemini-4-argon"
```

匹配依次是：别名、目录内精确 id、规范化 id（忽略厂商前缀、`:variant`、日期、`-low/-medium/-high/-xhigh/-max/-thinking/-tiered` 后缀和点号/连字符差异）。都找不到时，会按裸模型名在其他目录里找，这类结果标记为低可信（`inferred`），窗口只在没有别的来源时使用，思考档位不采用。

别名只匹配完整的模型 id（不区分大小写），所以一个模型有 `-low`、`-high`、`-xhigh` 等档位变体时，每个 id 各写一条，或者让别名指向的目录里本来就有该系列。规范化时 `-xhigh` 和 `-max` 一样被忽略，`gemini-4-hydrogen-xhigh` 与 `gemini-4-hydrogen` 按同一价格查询。

## 没有价格的模型

内置表、别名和 `[models."p/m".prices]` 都查不到价格时，该模型没有价格：`/usage` 的费用只算有价格的部分并标为 partial，页面会列出无价格的模型（含调用次数），并给出可粘贴的配置；Models & pricing 页把它显示为暗色的 `no price`。修法有两种，任选其一：

```toml
# 1. 直接写价格（美元 / 每百万 token；cache_read、cache_write 可省略）
[models."antigravity/gemini-4-hydrogen"]
prices = {input = 0.0, output = 0.0}

# 2. 计价与某个内置模型相同时，用别名指过去（每个 id 一条）
[catalogs.antigravity.aliases]
"gemini-4-hydrogen" = "gemini-4-argon"
```

用量页只在内置表里恰好有一个同系列模型时才给出别名写法，否则只给第一种。

## 订阅与 OAuth

`openai-codex`（ChatGPT 登录）和 `github-copilot` 的目录带订阅标记，对应的价格是“按 API 计价的等价金额”，不是实际扣费。`modelPrice()` 的结果带 `subscription` 字段，调用方可据此显示为估算或隐藏。`isSubscriptionProvider()` 给出同一判断。Logox 的 `openai` 提供商用 ChatGPT 登录时，调用方传入 `oauth: true` 即可。

## 刷新数据

数据在 `src/providers/model-table.generated.ts`，不要手改。需要新模型或新价格时：

```bash
npm run sync:models              # 使用脚本里固定的版本
npm run sync:models -- --latest  # 取最新发布版本
npm run sync:models -- --version 1.5.2
npm run sync:models -- --from <已解压的包目录>   # 离线
npm run sync:models -- --check   # 只检查是否已是最新，过期则退出码为 1
```

脚本用 `npm pack` 下载压缩包并解压到临时目录，只把 `dist/providers/data/*.json` 当数据读取，不会导入或执行包里的任何代码；输出按提供商和模型 id 排序，同一版本重复生成结果一致。生成文件头部记录来源包、版本、上游目录日期和 MIT 声明（版权行优先从上游仓库的 LICENSE 读取，读不到时使用已知的 `Copyright (c) 2025 Mario Zechner`）。升级固定版本时修改脚本里的 `PINNED_VERSION`，再运行 `npm run build` 和测试。

建议在新模型或新价格出现、或每隔一两个月刷新一次，并检查 diff 里窗口和价格是否合理。

## 边界

- 表里的价格是公开标价，不含地区、批量折扣或账户协议价；分段价格（超过某个提示长度后的费率）放在 `tiers` 里，`/usage` 目前不使用它。
- 表只收录与 Logox 相关的提供商（见脚本的 `KEEP_PROVIDERS`）；OpenRouter 的条目带厂商前缀，参与裸名匹配但排在一手厂商之后。
- 自建网关实际限制可能比官方更小；窗口以 `[models."provider/model"]` 的声明为准。
